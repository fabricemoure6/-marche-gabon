# Marché Gabon

Galerie marchande : plusieurs boutiques, panier, paiement (Airtel Money / SingPay), reçu détaillé,
notifications aux gestionnaires, livreurs géolocalisés, discussion (messagerie + WhatsApp) et assistant.
Cloudflare Workers + D1 (même montage que Gabon Séjours). Le nom « Marché Gabon » se change dans Admin → Réglages.

## Mise en ligne
1. Créer un dépôt GitHub et y envoyer ce dossier.
2. Cloudflare → Workers & Pages → Create → Import a repository → ce dépôt (build : aucun, deploy : `npx wrangler deploy`).
3. Créer la base : Storage & Databases → D1 → `marche-gabon-db`, puis la lier au binding `DB` du Worker
   (ou laisser Cloudflare la créer automatiquement). Les tables se créent seules au premier appel.
4. Settings → Variables and Secrets → type **Secret** : `ADMIN_SETUP_CODE` (un code long que vous inventez).
5. Ouvrir `https://VOTRE-SITE/compte.html?setup=1` pour créer le compte administrateur (code + e-mail + mot de passe).
6. Admin → Réglages : numéro Airtel Money, frais de livraison, nom du site.

## Paiement en ligne SingPay (facultatif)
Secrets : `SINGPAY_CLIENT_ID`, `SINGPAY_CLIENT_SECRET`, `SINGPAY_WALLET` (+ `SINGPAY_DISBURSEMENT` en production).
URL de rappel à déclarer chez SingPay : `https://VOTRE-SITE/api/payments/singpay`.
Admin → Réglages → « Tester la configuration ». Sans SingPay, le client paie au numéro Airtel Money et saisit la référence
SMS ; l'administrateur valide dans l'onglet Paiements.

## Parcours
- Client : compte → boutiques → panier → adresse + position → paiement → suivi, discussion, reçu.
- Gestionnaire : inscription « boutique » → validation admin → produits, prix, stock → commandes (Préparer, Prête).
- Livreur : inscription « livreur » → se mettre disponible (partage de position) → accepter une course proche → récupérer → livré.
- Livraison : frais de base + prix au km (valeurs de départ, à ajuster). Les livreurs dans le rayon (15 km) sont notifiés.

## Développement local
`npm install` puis `npx wrangler dev --local --var ADMIN_SETUP_CODE:essai`.
