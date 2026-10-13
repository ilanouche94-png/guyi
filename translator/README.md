# Traduction automatique des produits — Joeve Paris

Dès qu'un produit est **publié** (ou modifié) dans Shopify, ce petit programme le traduit
en **français, espagnol, néerlandais et arabe** avec Claude (Sonnet 5.5) et enregistre
les traductions dans la boutique, environ 30 secondes plus tard.

- Ne retraduit que ce qui manque ou a changé (pas de double paiement).
- Ne touche pas aux tailles (XS, S, M…), au nom de la marque, ni au thème.
- Coût : environ 0,05 $ par produit pour les 4 langues. Hébergement Cloudflare : gratuit.

## Installation (une seule fois)

### 1. Clé Claude
1. Va sur https://console.anthropic.com → crée un compte.
2. **Billing** → ajoute un crédit (5 à 10 $ suffisent pour commencer).
3. **API Keys** → **Create Key** → copie la clé (elle commence par `sk-ant-`). Garde-la secrète.

### 2. Accès Shopify (Dev Dashboard)
1. Sur dev.shopify.com → **Apps** → **Create app** :
   - **App name** : Trad
   - **App URL** : laisser `https://example.com`, et **décocher** « Embed app in Shopify admin »
   - **Scopes** : `read_products,read_translations,write_translations,read_locales`
   - **Webhooks API version** : laisser la valeur proposée
   - **Create app**, puis **Release** (publier la version).
2. Installe l'app sur la boutique Joeve Paris (bouton **Install** / **Stores**).
3. Dans **Settings** de l'app, copie le **Client ID** et le **Client secret**.

### 3. Mise en ligne sur Cloudflare (gratuit, sans terminal)
1. Crée un compte sur https://dash.cloudflare.com (gratuit).
2. **Workers & Pages** → **Create** → **Create Worker** (modèle « Hello World ») → nom : `joeve-translator` → **Deploy**.
3. **Edit code** → efface tout le code, colle le contenu de `dist/worker.js` → **Deploy**.
4. **Settings** → **Variables and Secrets** → **Add**, type **Secret**, une par une :
   - `ANTHROPIC_API_KEY` = ta clé `sk-ant-api03-...`
   - `SHOPIFY_CLIENT_ID` = le Client ID de l'app
   - `SHOPIFY_CLIENT_SECRET` = le Client secret de l'app
5. Ouvre l'adresse du Worker (ex. `https://joeve-translator.xxx.workers.dev`) : la page indique quels réglages sont OK ou MANQUANT.

### 4. Prévenir Shopify à chaque produit
1. Admin Shopify → **Paramètres** → **Notifications** → tout en bas **Webhooks** → **Créer un webhook**.
2. Événement **Création de produit**, format **JSON**, URL = l'adresse de l'étape 3 → Enregistrer.
3. Recommence avec l'événement **Mise à jour de produit**.
4. En bas de la page, Shopify affiche une phrase « Vos webhooks seront signés avec … » suivie d'un code : copie ce code et lance
   ```bash
   npx wrangler secret put SHOPIFY_WEBHOOK_SECRET
   ```

C'est fini. Publie un produit test, attends 30 secondes et ouvre `joeveparis.com/fr/products/...`.

## Traduire les produits déjà en ligne (facultatif, une fois)

```bash
SHOP_DOMAIN=q0uptb-wj.myshopify.com SHOPIFY_CLIENT_ID=... SHOPIFY_CLIENT_SECRET=... ANTHROPIC_API_KEY=sk-ant-api03-... npm run backfill
```

## Voir ce qui se passe
`npx wrangler tail` affiche en direct chaque produit traduit (ou les erreurs).
