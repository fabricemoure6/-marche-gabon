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

## Promotions
- Le vendeur lance une promotion depuis Ma boutique → Produits → « Promotion » : remise en % ou prix promo, durée.
- Règles du marché (vérifiées par le serveur) : remise de 5 % à 70 %, durée de 1 à 30 jours (réglables dans Admin → Réglages),
  arrêt automatique à la date de fin, prix normal bloqué pendant la promotion (prix barré honnête), pas de promotion sans stock.
- Les produits en promotion s'affichent en tête de la page d'accueil (« Promotions du moment »), en tête de leur boutique,
  et les boutiques concernées portent un ruban « Promo ». Le panier et le paiement appliquent le prix promo.
- Accueil : les boutiques sont rangées par rayon ; les produits se voient dans chaque boutique (et dans la recherche).

## Sécurité de l'administration
- **Suspendre une boutique ou un compte** demande un motif et le mot de passe de l'administrateur (5 essais au plus par 15 minutes).
  Le gestionnaire reçoit le motif par notification. Valider ou réactiver se fait en un clic.
- **Journal des actions** (Admin → Vue d'ensemble) : suspensions, réactivations, validations, liens créés ou révoqués, avec date, motif et auteur.

## Liens d'inscription (invitations)
- Admin → Invitations : choisir le type de compte (boutique, livreur, client), pour qui, le nombre d'inscriptions (1, 5, 20, sans limite)
  et la durée (7, 30, 90 jours, sans fin). Pour une boutique, option « validation automatique ».
- Le lien `https://VOTRE-SITE/compte.html?invite=…` s'envoie par WhatsApp (bouton dédié) ou se copie. Le rôle est imposé par le lien.
- Admin → Réglages → « Qui peut créer un compte ? » : inscription libre, invitation obligatoire pour boutiques et livreurs, ou pour tous.

## Développement local
`npm install` puis `npx wrangler dev --local --var ADMIN_SETUP_CODE:essai`.
