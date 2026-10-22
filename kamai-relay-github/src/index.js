// Kamai Pilot — relais API (Cloudflare Worker + Durable Object).
// Reçoit les appels REST/MCP, les transmet au navigateur connecté par WebSocket et renvoie le résultat.
//
//   WS   /connect?token=kpo_…                       connexion de l'extension
//   GET  /v1/{workspace}/actions/{id}                contrat de l'API (entrées / sorties)
//   POST /v1/{workspace}/actions/{id}/run            exécuter : {"input": {...}}
//   POST /mcp/{workspace}/{id}                       serveur MCP (Streamable HTTP, réponses JSON)

const RUN_TIMEOUT_MS = 120_000;
const RATE_PER_MIN = 30;
const VERSION = '0.3.0';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, mcp-session-id, mcp-protocol-version',
  'access-control-max-age': '86400'
};

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS, ...extra }
  });
}
const apiError = (status, code, message) => json({ error: { code, message } }, status);

async function sha256hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, '0')).join('');
}

const WS_ID = /^[a-f0-9]{24}$/;
const ACTION_ID = /^[A-Za-z0-9-]{1,64}$/;

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    const p = url.pathname.split('/').filter(Boolean);

    if (p.length === 0) return json({ name: 'Kamai Pilot relay', version: VERSION, ok: true });

    // Connexion de l'extension
    if (p[0] === 'connect' && p.length === 1) {
      const token = url.searchParams.get('token') || '';
      if (!/^kpo_[a-f0-9]{48}$/.test(token)) return apiError(401, 'INVALID_TOKEN', 'Jeton invalide.');
      const ws = (await sha256hex(token)).slice(0, 24);
      return stub(env, ws).fetch(new Request('https://do/connect', req));
    }

    // API REST
    if (p[0] === 'v1' && p[2] === 'actions' && (p.length === 4 || (p.length === 5 && p[4] === 'run'))) {
      const [, ws, , id, op] = p;
      if (!WS_ID.test(ws) || !ACTION_ID.test(id)) return apiError(404, 'NOT_FOUND', 'API introuvable.');
      return stub(env, ws).fetch(new Request(`https://do/action/${id}/${op || 'contract'}`, req));
    }

    // MCP
    if (p[0] === 'mcp' && p.length === 3) {
      const [, ws, id] = p;
      if (!WS_ID.test(ws) || !ACTION_ID.test(id)) return apiError(404, 'NOT_FOUND', 'API introuvable.');
      return stub(env, ws).fetch(new Request(`https://do/mcp/${id}`, req));
    }

    return apiError(404, 'NOT_FOUND', 'Route inconnue.');
  }
};

function stub(env, ws) {
  return env.WORKSPACE.get(env.WORKSPACE.idFromName(ws));
}

/* ---------- Un espace de travail = un navigateur ---------- */

export class Workspace {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.pending = new Map(); // runId -> resolve
    this.rate = new Map();    // actionId -> horodatages
  }

  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname.split('/').filter(Boolean);

    if (p[0] === 'connect') {
      if (req.headers.get('upgrade')?.toLowerCase() !== 'websocket') return apiError(426, 'UPGRADE_REQUIRED', 'WebSocket attendu.');
      for (const old of this.ctx.getWebSockets()) { try { old.close(4000, 'remplacé'); } catch (e) {} }
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    const action = await this.getAction(p[1]);
    if (!action) return apiError(404, 'NOT_FOUND', "API introuvable ou dépubliée.");
    const denied = await this.authorize(req, action);
    if (denied) return denied;

    if (p[0] === 'action') {
      if (p[2] === 'contract' && req.method === 'GET') return json(contract(action));
      if (p[2] === 'run' && req.method === 'POST') {
        let body;
        try { body = await req.json(); } catch (e) { return apiError(400, 'INVALID_JSON', 'Corps JSON invalide. Format : {"input": {...}}'); }
        const input = body && typeof body.input === 'object' && body.input ? body.input : {};
        const r = await this.run(action, input);
        return json(r.body, r.status);
      }
      return apiError(405, 'METHOD_NOT_ALLOWED', 'Méthode non autorisée.');
    }

    if (p[0] === 'mcp') return this.mcp(req, action);
    return apiError(404, 'NOT_FOUND', 'Route inconnue.');
  }

  async getAction(id) {
    const actions = (await this.ctx.storage.get('actions')) || {};
    return actions[id] || null;
  }

  async authorize(req, action) {
    const key = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
    if (!key || (await sha256hex(key)) !== action.keyHash) return apiError(401, 'UNAUTHORIZED', 'Clé API invalide.');
    const now = Date.now();
    const hits = (this.rate.get(action.id) || []).filter(t => now - t < 60_000);
    if (hits.length >= RATE_PER_MIN) return apiError(429, 'RATE_LIMITED', `Limite de ${RATE_PER_MIN} appels par minute atteinte.`);
    hits.push(now);
    this.rate.set(action.id, hits);
    return null;
  }

  run(action, input) {
    const ws = this.ctx.getWebSockets()[0];
    if (!ws) {
      return Promise.resolve({ status: 503, body: { status: 'failed', error: { code: 'BROWSER_OFFLINE', message: 'Le navigateur connecté est hors ligne. Ouvrez Chrome avec Kamai Pilot.' } } });
    }
    for (const k of action.inputs.map(i => i.key)) {
      if (input[k] === undefined || input[k] === null || String(input[k]).trim() === '') {
        return Promise.resolve({ status: 400, body: { status: 'failed', error: { code: 'MISSING_INPUT', message: `Entrée manquante : ${k}.` } } });
      }
    }
    const runId = crypto.randomUUID();
    const started = Date.now();
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(runId);
        resolve({ status: 504, body: { run_id: runId, status: 'timeout', error: { code: 'TIMEOUT', message: "Le navigateur n'a pas répondu à temps." } } });
      }, RUN_TIMEOUT_MS);
      this.pending.set(runId, msg => {
        clearTimeout(timer);
        this.pending.delete(runId);
        const duration_ms = Date.now() - started;
        resolve(msg.ok
          ? { status: 200, body: { run_id: runId, status: 'succeeded', duration_ms, result: msg.data } }
          : { status: 422, body: { run_id: runId, status: 'failed', duration_ms, error: msg.error } });
      });
      ws.send(JSON.stringify({ type: 'run', runId, actionId: action.id, input }));
    });
  }

  async webSocketMessage(ws, data) {
    let msg;
    try { msg = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data)); } catch (e) { return; }
    if (msg.type === 'ping') { ws.send('{"type":"pong"}'); return; }
    if (msg.type === 'sync') {
      const actions = {};
      for (const a of (msg.actions || []).slice(0, 200)) {
        const clean = sanitize(a);
        if (clean) actions[clean.id] = clean;
      }
      await this.ctx.storage.put('actions', actions);
      ws.send(JSON.stringify({ type: 'ack', reqId: msg.reqId, ok: true, count: Object.keys(actions).length }));
      return;
    }
    if (msg.type === 'result') this.pending.get(msg.runId)?.(msg);
  }

  webSocketClose(ws, code) {
    try { ws.close(code === 1005 ? 1000 : code, 'fermé'); } catch (e) {}
  }

  /* ----- MCP (JSON-RPC 2.0 sur HTTP, sans flux SSE) ----- */

  async mcp(req, action) {
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: { allow: 'POST', ...CORS } });
    let msg;
    try { msg = await req.json(); } catch (e) { return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
    const batch = Array.isArray(msg) ? msg : [msg];
    const out = [];
    for (const m of batch) {
      const r = await this.mcpOne(m, action);
      if (r) out.push(r);
    }
    if (!out.length) return new Response(null, { status: 202, headers: CORS });
    return json(Array.isArray(msg) ? out : out[0]);
  }

  async mcpOne(m, action) {
    if (!m || m.id === undefined || m.id === null) return null; // notification
    const ok = result => ({ jsonrpc: '2.0', id: m.id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id: m.id, error: { code, message } });
    const tool = toolName(action);
    switch (m.method) {
      case 'initialize':
        return ok({
          protocolVersion: m.params?.protocolVersion || '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'kamai-pilot', version: VERSION },
          instructions: `Outil « ${tool} » : ${action.description || action.name}. Exécuté dans le navigateur de l'utilisateur.`
        });
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: [{ name: tool, title: action.name, description: action.description || action.name, inputSchema: inputSchema(action) }] });
      case 'tools/call': {
        if (m.params?.name !== tool) return fail(-32602, `Outil inconnu : ${m.params?.name}`);
        const r = await this.run(action, m.params.arguments || {});
        const success = r.status === 200;
        const payload = success ? r.body.result : r.body.error;
        const res = { content: [{ type: 'text', text: JSON.stringify(payload) }], isError: !success };
        if (success && payload && typeof payload === 'object') res.structuredContent = payload;
        return ok(res);
      }
      default:
        return fail(-32601, `Méthode non prise en charge : ${m.method}`);
    }
  }
}

/* ---------- Contrats ---------- */

function sanitize(a) {
  if (!a || !ACTION_ID.test(a.id || '') || !/^[a-f0-9]{64}$/.test(a.keyHash || '')) return null;
  const str = (s, n) => String(s ?? '').slice(0, n);
  return {
    id: a.id,
    name: str(a.name, 120),
    description: str(a.description, 500),
    inputs: (a.inputs || []).slice(0, 20).map(i => ({ key: str(i.key, 40), label: str(i.label, 120), example: str(i.example, 200) })).filter(i => /^\w+$/.test(i.key)),
    outputs: (a.outputs || []).slice(0, 12).map(o => str(o, 40)).filter(o => /^\w+$/.test(o)),
    keyHash: a.keyHash
  };
}

function inputSchema(action) {
  const properties = {};
  for (const i of action.inputs) properties[i.key] = { type: 'string', description: i.label + (i.example ? ` (ex. ${i.example})` : '') };
  return { type: 'object', properties, required: action.inputs.map(i => i.key) };
}

function contract(action) {
  const result = action.outputs.length
    ? { type: 'object', properties: Object.fromEntries(action.outputs.map(o => [o, { type: ['string', 'null'] }])) }
    : { type: 'object', properties: { answer: { type: 'string' } } };
  return {
    id: action.id,
    name: action.name,
    description: action.description,
    method: 'POST',
    request: { type: 'object', properties: { input: inputSchema(action) }, required: ['input'] },
    example: { input: Object.fromEntries(action.inputs.map(i => [i.key, i.example || ''])) },
    result
  };
}

function toolName(action) {
  const base = action.name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
  return base || 'action';
}
