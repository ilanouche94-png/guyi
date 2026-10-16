# Récap complet — Boutique Joeve Paris (à donner à un autre Claude)

## 1. La boutique
- Marque : **Joeve Paris**, mode femme. Site : **joeveparis.com** (Shopify : q0uptb-wj.myshopify.com).
- Devise : USD. Paiement : Stripe. Langue principale : anglais. Langues publiées : fr, es, nl, ar.
- 40 produits actifs : 20 robes (12 maxi, 2 midi, 6 mini), 5 hauts, 3 bas, 3 ensembles, 9 manteaux/vestes.
- Thème : **paradise-1-2-5** (ID `gid://shopify/OnlineStoreTheme/206102659406`).
- Code du thème versionné sur GitHub : `ilanouche94-png/guyi`, branche `claude/product-variant-selector-style-xc3wc5`. Le dépôt ne contient qu'une partie des fichiers. Les templates JSON (`templates/index.json`, `templates/product.json`, `templates/collection.json`) n'y sont pas : ils sont modifiés directement sur le thème.

## 2. Règles techniques importantes (pour l'outil Shopify / MCP)
- **On ne peut modifier les fichiers du thème que s'il est DÉPUBLIÉ.** L'écriture sur le thème en ligne est bloquée : il faut demander à la propriétaire / au propriétaire de dépublier le thème, puis de le republier après.
- Gros fichiers : passer par `stagedUploadsCreate` (FILE, text/plain, POST), puis un envoi curl multipart vers le stockage Google, puis `themeFilesUpsert` avec `{type: URL, value: resourceUrl}`. Ensuite vérifier que le `checksumMd5` correspond au fichier local. Une URL du CDN Shopify échoue sans message d'erreur.
- `themeFilesDelete` et `bulkOperationRunMutation` sont bloqués. Utiliser des mutations avec alias, par lots.
- **`productUpdate` avec seulement `seo.description` efface `seo.title`.** Il faut toujours envoyer les deux. Format du titre SEO : « <nom long> | Joeve Paris ».
- `translationsRegister` demande le `translatableContentDigest`, qui est le sha256 de la valeur d'origine.
- Une requête GraphQL est limitée à 16 384 caractères : découper les grosses mutations.

## 3. Ce qui a été fait

### Design / thème
- **Panier sur téléphone :** il s'ouvre depuis le bas (`snippets/cart-mini.liquid`, xo-breakpoints 749 → bottom-center / slide-up).
- **Barre d'annonce :** plus fine (`sections/header-group.json`, `bar_padding: 3`).
- **« Complete your look » dans le panier :** cartes plus étroites, on voit le début du produit suivant (`snippets/joeve-cart-style.liquid`).
- **Page produit, téléphone uniquement** (`blocks/inventory-status.liquid`) :
  - bande collante en bas : point vert + texte de la promo d'automne (traduit en 5 langues) ;
  - sous le prix : point vert + « Livré entre le … et le … » (dates courtes) ;
  - en dessous : point orange + « Stock bientôt épuisé » ;
  - sur ordinateur : rien n'a changé.
- **Descriptions produits :** la ligne « Free shipping… » a été retirée de tous les produits et des descriptions SEO.
- **FAQ de la page produit :** 4 questions (taille, délai de livraison — partout dans le monde, 5 à 8 jours —, retours sous 30 jours, entretien), traduites.
- **Carrousel « Nos collabs » :** le défilement vertical de la page marche maintenant sur téléphone (`touch-action: pan-x pan-y`).
- **Pages collection :** la grande image a été retirée, remplacée par un titre simple en haut (section `sections/joeve-collection-title.liquid`, ajoutée en tête de `templates/collection.json`).

### Langues / traductions
- **Langue automatique** (`snippets/joeve-auto-language.liquid`) : sur la version anglaise, le site bascule dans la langue de l'appareil du visiteur, à chaque visite (le cookie a été retiré).
- **Traduction automatique des produits :** Cloudflare Worker `joeve-translator`, dossier `translator/` du dépôt.
  - Il est déclenché par les webhooks Shopify `products/create` et `products/update`.
  - Il traduit avec Claude Sonnet 5.5 uniquement les champs qui n'ont pas encore de traduction ou dont la traduction est périmée, en fr / es / nl / ar.
  - Les secrets sont stockés dans Cloudflare (jamais dans le code).
- **Traduction des avis clients** (application CWILL / Trustoo, avis « boutique » affichés sur tous les produits) :
  - route `/reviews` du même Worker (`translator/src/reviews.ts`), avec un cache Cloudflare KV `REVIEW_CACHE` (namespace `joeve-review-cache`) ;
  - côté thème : `snippets/joeve-review-translate.liquid`, appelé dans `layout/theme.liquid` ;
  - chaque avis n'est traduit qu'une fois par langue ; limite de 400 nouvelles traductions par jour.
- La page de statut du Worker indiquait que les 5 vérifications étaient OK.

### Collections (refaites à zéro)
Toutes sont des collections automatiques par tag, publiées sur Online Store + Shop, et traduites en fr / es / nl / ar (le menu aussi).

| Collection | Handle | Règle | Produits |
|---|---|---|---|
| SALE | sale | prix barré | 20 |
| NEW IN | new-arrivals | tag `new-in` (les 10 plus récents) | 10 |
| DRESSES | dress | tags dress / maxi / midi / mini | 20 |
| LONG DRESSES | long-dresses | maxi-dress ou midi-dress | 14 |
| MINI DRESSES | mini-dress | mini-dress | 6 |
| TOPS | tops | — | 5 |
| BOTTOMS | bottoms | — | 3 |
| SETS | sets | — | 3 |
| OUTERWEAR | outerwear | — | 9 |
| EVENING & OCCASION | evening-occasion | tag `edit-evening` | 13 |
| SUMMER ESCAPE | summer-escape | tag `edit-summer` | 11 |
| FALL–WINTER EDIT | fall-winter | tag `edit-fall-winter` | 16 |
| BEST-SELLERS | best-sellers | tag `best-sellers` | 8 |
| TRENDING NOW | trending | tag `trending` | 8 |

- **25 anciennes collections supprimées** (t-shirts, jeans, trench, chaussures, sacs, maillots…), avec des redirections 301 vers la nouvelle collection parente (exemple : /collections/jeans → /collections/bottoms).
- **Menu principal :** SALE · NEW IN · DRESSES (Long, Mini) · TOPS · BOTTOMS · SETS · OUTERWEAR · EDITS (Evening, Summer, Fall–Winter) · BEST-SELLERS.

### Page d'accueil — chaque photo mène à une collection
- Grand diaporama sur ordinateur (split-slideshow) → New In. Toute l'image est cliquable.
- Diaporama du téléphone (6 images) → New In. Toute l'image est cliquable.
- Duo 1 : Promo street style → Sale ; Balcon tops → Tops.
- Duo 2 : Robe coucher de soleil → Dresses ; Best-sellers street style → Best-Sellers.
- Duo 3 : Maillot de bain → Summer Escape ; Ensembles bleus plage → Sets.
- Listes de produits : Best-Sellers, New In, Trending, Sale.

## 4. À faire / points en suspens
1. **Republier le thème paradise.** Il est dépublié en ce moment pour permettre les modifications.
2. **Changer la clé API Claude.** Elle a été collée dans une conversation : la révoquer sur console.anthropic.com, en créer une nouvelle et la mettre dans les secrets du Worker Cloudflare (`ANTHROPIC_API_KEY`). Ne jamais coller de clé ou de mot de passe dans un chat.
3. **« Stock bientôt épuisé » s'affiche sur tous les produits.** Mieux vaut ne l'afficher que si le stock est réellement bas, pour éviter une pratique commerciale trompeuse. Même chose pour les « -50 % » : ils doivent correspondre à de vrais anciens prix.
4. **Langue automatique :** retenir le choix manuel du visiteur (un cookie seulement quand il change lui-même de langue), pour ne pas le rebasculer à chaque visite.
5. **Confiance :** ajouter une vraie page « À propos » et rendre les politiques de retour et de livraison bien visibles.
6. **Avant de lancer la pub :** passer une commande test complète (paiement, e-mail de confirmation, remboursement).

Note globale donnée au site : 7/10, et environ 8,5/10 une fois les points 3, 4 et 6 réglés.
