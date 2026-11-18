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

## Comptabilité
- Vendeur (Ma boutique → Comptabilité) : période (ce mois, mois dernier, 30 jours, année, dates libres), ventes brutes,
  bons fidélité, commission du marché, recettes nettes, dépenses, bénéfice ; graphique des recettes par jour ou par mois ;
  solde (gagné sur les ventes livrées, déjà versé, reste à recevoir) ; meilleures ventes ; journal recettes / dépenses ;
  saisie des dépenses par catégorie ; export CSV pour Excel.
- Admin (Comptabilité) : ventes par boutique, commissions, frais de livraison, bons accordés, remboursements à faire,
  solde à verser par boutique et enregistrement des versements (la boutique est notifiée).
- Commission du marché réglable dans Admin → Réglages (0 % par défaut), enregistrée sur chaque commande au moment du paiement.

## Sons des notifications
- Mon compte → Sons des notifications : une sonnerie par événement (balafon, clochette, carillon, tam-tam, klaxon,
  sifflet, bip ou silencieux), volume, notifications du téléphone. Réglage gardé sur l'appareil.

## Stock et disponibilité
- Chaque produit affiche « En stock », « Plus que N en stock » (5 ou moins) ou « Épuisé ».
- Panier : quantité limitée au stock (ajustée avec un message), avertissement si le stock a baissé depuis l'ajout
  (bouton « Ajuster »), paiement bloqué tant que le panier n'est pas corrigé.
- Sécurité : un déclencheur en base empêche tout stock négatif ; si deux clients paient le dernier article en même temps,
  un seul paiement passe, l'autre reçoit un message clair.
- Produit épuisé : bouton « Me prévenir » ; au réassort, les clients qui attendaient reçoivent une notification.
- Vendeur : notification « Stock faible » ou « Produit épuisé » après chaque commande, bandeau « Stock à vérifier »,
  nombre de clients en attente par produit, annulation « Produit épuisé » qui met le stock à 0 et prévient le client et l'admin.

## Fidélité et bons d'achat
- Chaque boutique active sa carte de fidélité (Ma boutique → Fidélité) : un bon toutes les N commandes livrées (2 à 20),
  en % (5 à 30 %, plafond réglable par l'admin) ou en FCFA (500 à 50 000), achat minimum et durée de validité au choix.
- Chaque commande livrée ajoute un tampon ; au palier, le bon est créé automatiquement et le client est prévenu.
- Le vendeur voit ses clients fidèles (commandes, montant dépensé, carte) et peut offrir un bon (3 par client et par mois au plus).
- Le client retrouve ses cartes et ses bons dans Mon compte → Ma fidélité ; au panier, le meilleur bon est proposé d'office.
- Un bon sert une seule fois ; il est rendu si la commande est annulée.

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

## Logo

Le logo actuel est la « proposition 2 » dessinée dans Adobe Illustrator : un sac de courses souriant aux couleurs du Gabon (vert, jaune, bleu) avec « marché gabon » en vert et noir. Les 4 propositions sont conservées dans `design/marche-gabon-propositions.ai` (hors du site public) ; l'ancien éventail est dans `design/marche-gabon-logo.ai`. Les exports SVG et PNG (icône d'application, icône pour fond clair ou sombre, logo horizontal clair ou sombre, image de partage 1200×630) sont dans `public/logo/`. Il sert aussi de favicon, d'icône d'écran d'accueil, d'image de partage, d'icône d'en-tête, d'écran de chargement, de pastille sur les boutiques et d'en-tête des reçus. Couleurs : vert #009e60, jaune #fcd116, bleu #3a75c4, nuit #1f1a17, crème #fff8ee.

## Produits vendus au kilo, au litre, au tas…

Chaque produit a une **unité de vente** choisie par le vendeur dans « Ajouter un produit » : à la pièce (par défaut), au kilo, au litre, au tas, au sachet ou à la botte. Kilo et litre acceptent les quantités décimales ; le vendeur règle la quantité minimale (0,25, 0,5 ou 1) et le client commande par paliers. Le prix est celui d'une unité (« 3 500 FCFA / kg »), le stock est compté dans la même unité, le total d'une ligne est arrondi au franc. Les produits non vendus à la pièce apparaissent aussi dans la rubrique « Vendus au kilo et à la mesure » de l'accueil (`GET /api/by-weight`). Colonnes ajoutées : `products.unit`, `products.qty_step`, `order_items.unit` (migration automatique).

## Pièces justificatives (facultatives)

Un livreur peut ajouter sa carte d'identité, son permis ou son passeport ; une boutique, son document administratif d'ouverture du commerce (photo ou PDF, 1 Mo). Rien n'est obligatoire. Les pièces sont stockées dans la table `documents` (une par type et par personne), servies uniquement par `GET /api/documents/:id` à leur propriétaire et à l'administrateur (`cache-control: private, no-store`, jamais par la route publique des photos). L'administrateur les valide ou les refuse avec un motif dans l'onglet « Pièces » ; chaque consultation est inscrite au journal des actions et la personne est prévenue de la décision.

## Paiement direct aux boutiques et aux livreurs

Réglage « Mode de paiement » (Administration, Réglages) : **direct** (par défaut) ou **via le marché** (ancien parcours : le client paie le numéro du marché, l'administrateur confirme, le marché reverse aux boutiques).

En mode direct, chaque boutique et chaque livreur indique son compte (Airtel Money, Moov Money ou compte bancaire, titulaire, code marchand ou nom de la banque) : colonnes `shops.payout_*` et `couriers.pay_*`, validées par `cleanAccount`. Au moment de commander, si **toutes** les boutiques du panier ont un compte, le client voit pour chacune où envoyer l'argent des produits (`orders.pay_direct = 1`) et saisit la référence de sa transaction ; la boutique clique « Paiement reçu » (ou « Non reçu » : commande annulée, stock et bon d'achat restitués) et la commande démarre. Les frais de livraison se paient au livreur : dès qu'il accepte la course, le client voit son compte dans sa commande, déclare son paiement, et le livreur confirme (`orders.fee_state`). Si une boutique du panier n'a pas encore de compte, ce panier suit l'ancien parcours pour ne bloquer personne, et la boutique est invitée à renseigner son compte.

Confidentialité : le compte d'une boutique n'est montré qu'au client de la commande concernée, à l'administrateur et à la boutique elle-même ; celui du livreur, au client dont il a pris la course et à l'administrateur. Les routes publiques listent leurs colonnes une à une et n'exposent rien. Comptabilité : les ventes directes ne créent pas de solde dû par le marché ; la commission éventuelle apparaît comme « commission due au marché » (boutique) et « à encaisser » (administrateur).

### Comptes verrouillés, litiges et frais de livraison

- **Comptes de paiement :** toute saisie d'une boutique ou d'un livreur (première fois, modification ou suppression) devient une demande (`account_changes`) que l'administrateur accepte (avec son mot de passe) ou refuse (avec un motif). Tant qu'une boutique n'a pas de compte validé, ses clients paient via le marché. L'ancien compte reste actif jusque-là, une seule demande est en attente à la fois (les précédentes passent à « remplacée ») et tout est conservé dans l'historique, visible dans Administration, « À valider ».
- **Preuve :** chaque commande garde une copie du compte de la boutique montré au client (`orders.pay_account`) et de celui du livreur (`orders.fee_account`), même si le compte change ensuite.
- **« Non reçu » :** la boutique ne peut pas annuler seule. Elle ouvre un litige (`orders.pay_dispute`) ; l'administrateur valide le paiement ou annule la commande (stock et bon d'achat restitués).
- **Frais de livraison :** le livreur ne peut récupérer le colis que si le client a déclaré avoir payé les frais, et ne peut marquer « Livré » qu'après avoir confirmé les avoir reçus. Il peut relancer le client ou signaler « frais non reçus » (`orders.fee_dispute`) ; l'administrateur valide les frais ou remplace le livreur.
