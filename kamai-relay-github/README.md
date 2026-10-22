# Kamai Pilot — Relais API

Le relais est le petit serveur qui rend les API de vos utilisateurs accessibles depuis Internet. Il reçoit les appels (REST et MCP) et les transmet au Chrome de l'utilisateur concerné.

**Vous le déployez une seule fois.** Un seul relais sert tous vos utilisateurs, chacun dans un espace isolé. Vos utilisateurs n'ont jamais besoin de le voir ni de le configurer.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/VOTRE-UTILISATEUR/VOTRE-DEPOT)

> Ce bouton fonctionnera quand vous aurez remplacé `VOTRE-UTILISATEUR/VOTRE-DEPOT` par l'adresse de votre dépôt (voir l'étape 3). Vous pouvez aussi simplement coller l'adresse complète dans le navigateur.

---

## Déploiement sans terminal (15 minutes)

### 1. Créer deux comptes gratuits
- **GitHub** : github.com/signup
- **Cloudflare** : dash.cloudflare.com/sign-up (aucune carte bancaire demandée pour le relais)

### 2. Mettre ces fichiers sur GitHub
1. Sur GitHub, cliquez sur **+** en haut à droite, puis **New repository**.
2. Nom : `kamai-relay`. Choisissez **Public**. Cliquez sur **Create repository**.
3. Sur la page du dépôt, cliquez sur le lien **uploading an existing file**.
4. Ouvrez le dossier `kamai-relay` sur votre ordinateur et **glissez tout son contenu** dans la page : le dossier `src` et les fichiers `wrangler.toml`, `package.json`, `package-lock.json`, `README.md`. Les fichiers doivent se trouver à la racine du dépôt, pas dans un sous-dossier.
5. Cliquez sur **Commit changes**.

Le dépôt doit être **public** pour que le bouton de déploiement fonctionne. Il ne contient aucun secret : seulement le code du relais.

### 3. Déployer sur Cloudflare
1. Ouvrez cette adresse dans Chrome, en remplaçant les deux mots par les vôtres :
   `https://deploy.workers.cloudflare.com/?url=https://github.com/VOTRE-UTILISATEUR/kamai-relay`
2. Suivez les écrans : connectez votre compte GitHub et votre compte Cloudflare quand c'est demandé, gardez le nom `kamai-relay`, puis cliquez sur **Create and deploy**.
3. À la fin, Cloudflare affiche l'adresse du relais, de la forme :
   `https://kamai-relay.VOTRE-NOM.workers.dev`
   **Copiez-la.**

Les écrans de Cloudflare peuvent légèrement changer. L'important : le projet `kamai-relay` doit être créé dans votre compte, avec le Worker en ligne.

### 4. Vérifier
Ouvrez l'adresse du relais dans Chrome. Vous devez voir :
```json
{ "name": "Kamai Pilot relay", "version": "0.3.0", "ok": true }
```
Si c'est le cas, le relais fonctionne.

### 5. Brancher l'extension
1. Ouvrez le fichier `kamai-pilot/config.js` de l'extension avec le Bloc-notes (ou n'importe quel éditeur de texte).
2. Remplacez l'adresse d'exemple par la vôtre :
   ```js
   const KAMAI_CONFIG = {
     relayUrl: 'https://kamai-relay.VOTRE-NOM.workers.dev'
   };
   ```
3. Enregistrez.
4. Dans `chrome://extensions`, rechargez l'extension (icône **↻**) et ouvrez **Réglages**. Le statut doit afficher **● En ligne : vos API sont prêtes.**

### 6. Distribuer
Faites un clic droit sur le dossier `kamai-pilot` → **Compresser** (ou **Envoyer vers → Dossier compressé**), puis envoyez le `.zip` avec le dossier `docs`. Plus tard, publiez-la sur le Chrome Web Store.

---

## Mettre à jour le relais
Sur GitHub, ouvrez le fichier à modifier (par exemple `src/index.js`), cliquez sur le crayon, collez le nouveau contenu et cliquez sur **Commit changes**. Cloudflare redéploie automatiquement. Les API déjà publiées continuent de fonctionner : chaque extension renvoie sa liste d'API au relais quand elle se reconnecte.

## Suivre l'activité
Dans le tableau de bord Cloudflare : **Workers & Pages → kamai-relay**. Vous y voyez le nombre de requêtes et les erreurs.

## Une adresse à votre nom (optionnel)
Dans Cloudflare : **Workers & Pages → kamai-relay → Settings → Domains & Routes → Add**, puis votre domaine (par exemple `api.kamaihub.com`). Le domaine doit être géré par Cloudflare. Pensez ensuite à mettre à jour `config.js`.

## Coûts
L'offre gratuite de Cloudflare suffit pour démarrer : la bêta et les premiers clients. Au-delà, passez à l'offre payante de Workers. Vérifiez les limites et les tarifs actuels sur la page des prix Cloudflare, car ils évoluent.

## Points de vigilance avant de vendre
- **Abus :** n'importe qui ayant l'extension peut créer un espace sur votre relais. Pour une offre payante, ajoutez des comptes et des quotas par abonnement (prochaine étape du projet).
- **Responsabilité :** vos conditions d'utilisation doivent préciser que l'utilisateur est responsable des sites qu'il automatise et du respect de leurs conditions.
- **Confidentialité :** le relais voit passer les entrées et les résultats des API, mais jamais les cookies ni les mots de passe. Indiquez-le dans votre politique de confidentialité.

---

## Pour les développeurs
```bash
npm install
npx wrangler dev      # test en local sur http://127.0.0.1:8787
npx wrangler deploy   # déploiement en ligne de commande
```
Routes : `WS /connect`, `GET /v1/{espace}/actions/{id}`, `POST /v1/{espace}/actions/{id}/run`, `POST /mcp/{espace}/{id}`. Un Durable Object (`Workspace`) par navigateur gère la connexion WebSocket.
