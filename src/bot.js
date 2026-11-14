// Assistant à règles : répond aux questions fréquentes sans service externe.
import { CATEGORIES, ORDER_STATUS, publicProduct, EFFECTIVE_PRICE } from './lib.js';

const has = (t, words) => words.some(w => t.includes(w));
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const STOP = new Set(['je', 'j', 'cherche', 'chercher', 'voudrais', 'veux', 'acheter', 'trouver', 'avez', 'vous', 'des', 'du', 'de', 'la', 'le', 'les', 'un', 'une',
  'pour', 'avec', 'est', 'il', 'y', 'a', 'quoi', 'faire', 'preparer', 'svp', 'stp', 'merci', 'bonjour', 'produit', 'produits', 'prix', 'combien', 'coute', 'moins', 'cher', 'au', 'aux', 'en', 'et', 'ou', 'mon', 'ma', 'mes', 'oui', 'non', 'salut', 'bonsoir', 'hello', 'coucou', 'mbolo', 'aide', 'help', 'avec', 'plaisir']);
const keywords = q => norm(q).split(/[^a-z0-9]+/).filter(w => w.length > 2 && !STOP.has(w));
const QUICK = ['Les promotions', 'Où est ma commande ?', 'Frais de livraison', 'Trouver un produit'];

// Produits actifs des boutiques actives, filtrés par rubrique et mots-clés (sans accents).
export async function searchProducts(env, { cat = '', q = '', limit = 24 } = {}) {
  const { results } = await env.DB.prepare(
    `SELECT p.id,p.name,p.description,p.price,p.promo_price,p.promo_until,p.stock,p.photo_id,s.name AS shop_name,s.slug,s.category,s.address
     FROM products p JOIN shops s ON s.id=p.shop_id WHERE p.active=1 AND s.status='active' ORDER BY p.created_at DESC LIMIT 400`).all();
  const words = keywords(q);
  if (String(q).trim() && !words.length) return [];
  return results
    .filter(r => !cat || r.category === cat)
    .map(r => {
      const hay = norm(r.name + ' ' + (r.description || '') + ' ' + r.shop_name + ' ' + r.category);
      return { r, score: words.reduce((n, w) => n + (hay.includes(w) ? 1 : hay.includes(w.slice(0, 5)) ? 0.5 : 0), 0) };
    })
    .filter(x => !words.length || x.score > 0)
    .sort((a, b) => b.score - a.score || (b.r.stock > 0) - (a.r.stock > 0))
    .slice(0, limit)
    .map(x => publicProduct(x.r));
}

export async function botReply(env, user, settings, message) {
  const r = await rawReply(env, user, settings, message);
  return { quick: QUICK, ...r };
}

async function rawReply(env, user, settings, message) {
  const t = norm(message).slice(0, 300);
  const links = [];

  if (has(t, ['ou est', 'suivre', 'suivi', 'statut', 'ma commande', 'mes commandes', 'livreur est'])) {
    if (!user) return { reply: 'Connectez-vous pour que je retrouve vos commandes.', links: [['Se connecter', '/compte.html']] };
    const { results } = await env.DB.prepare(
      `SELECT o.ref,o.status,s.name AS shop FROM orders o JOIN shops s ON s.id=o.shop_id WHERE o.customer_id=?1 ORDER BY o.created_at DESC LIMIT 3`)
      .bind(user.id).all();
    if (!results.length) return { reply: 'Vous n\'avez pas encore de commande.', links: [['Voir les boutiques', '/']] };
    return {
      reply: 'Vos dernières commandes :\n' + results.map(o => `${o.ref} (${o.shop}) : ${ORDER_STATUS[o.status] || o.status}`).join('\n'),
      links: [['Suivre mes commandes', '/commandes.html']]
    };
  }
  if (has(t, ['livraison', 'livrer', 'frais', 'delai', 'combien de temps'])) {
    return {
      reply: `Un livreur proche de la boutique récupère votre commande dès qu'elle est prête. Les frais de livraison se calculent par boutique : ${settings.delivery_base} FCFA de base, plus ${settings.delivery_per_km} FCFA par kilomètre. Partagez votre position au moment de la commande pour un prix exact.`,
      links: []
    };
  }
  if (has(t, ['paiement', 'payer', 'airtel', 'moov', 'carte', 'mobile money'])) {
    return {
      reply: 'Vous pouvez payer par Airtel Money, Moov Money ou carte bancaire sur la page de paiement sécurisée. Si le paiement en ligne n\'est pas disponible, un paiement manuel par Airtel Money vous est proposé, avec la référence à saisir. Un reçu détaillé vous est remis après paiement.',
      links: []
    };
  }
  if (has(t, ['annuler', 'rembours', 'retour', 'probleme', 'reclam'])) {
    return {
      reply: 'Une commande non payée peut être annulée depuis « Mes commandes ». Après paiement, écrivez à la boutique et au livreur depuis la discussion de la commande : ils vous répondront rapidement.',
      links: [['Mes commandes', '/commandes.html']]
    };
  }
  if (has(t, ['vendre', 'vendeur', 'ouvrir une boutique', 'ma boutique', 'devenir'])) {
    return {
      reply: 'Pour vendre : créez un compte « Gestionnaire de boutique ». Votre boutique est validée par l\'équipe, puis vous ajoutez vos produits et recevez une notification à chaque commande.',
      links: [['Créer un compte vendeur', '/compte.html?role=seller']]
    };
  }
  if (has(t, ['livreur', 'devenir livreur', 'coursier'])) {
    return {
      reply: 'Pour livrer : créez un compte « Livreur », activez votre disponibilité et partagez votre position. Les commandes prêtes près de vous s\'affichent, la première acceptée est pour vous.',
      links: [['Créer un compte livreur', '/compte.html?role=courier']]
    };
  }
  if (has(t, ['compte', 'inscri', 'connexion', 'mot de passe'])) {
    return {
      reply: 'Créez un compte client en quelques secondes pour commander et suivre vos livraisons. Mot de passe oublié : écrivez-nous depuis la page Contact du site ou demandez un lien à l\'administrateur.',
      links: [['Mon compte', '/compte.html']]
    };
  }
  if (has(t, ['promo', 'solde', 'reduction', 'remise', 'bon plan', 'bonne affaire', 'pas cher'])) {
    const { results } = await env.DB.prepare(
      `SELECT p.id,p.name,p.description,p.price,p.promo_price,p.promo_until,p.stock,p.photo_id,s.name AS shop_name,s.slug,s.category
       FROM products p JOIN shops s ON s.id=p.shop_id WHERE p.active=1 AND p.stock>0 AND s.status='active' AND ${EFFECTIVE_PRICE} < p.price
       ORDER BY (1.0 * p.promo_price / p.price) ASC LIMIT 8`).all();
    if (!results.length) return { reply: 'Pas de promotion en ce moment. Revenez bientôt : les boutiques en lancent régulièrement !', links: [['Voir les boutiques', '/']] };
    const list = results.map(publicProduct);
    return {
      reply: `Voici les meilleures promotions du moment (jusqu'à −${list[0].promo_pct} %) :`,
      products: list.map(p => ({ id: p.id, name: p.name, price: p.price, old_price: p.old_price, promo_pct: p.promo_pct, stock: p.stock, photo_id: p.photo_id, shop: p.shop_name, slug: p.slug, category: p.category })),
      links: [['Toutes les promotions', '/#promos']]
    };
  }
  if (has(t, ['trouver un produit'])) {
    return { reply: 'Dites-moi ce que vous cherchez : « pagne », « bananes », « parfum », « téléphone »… Je vous montre les produits disponibles avec leur prix.', links: [] };
  }
  const wantsProduct = has(t, ['cherche', 'acheter', 'trouver', 'produit', 'avez-vous', 'avez vous', 'prix', 'combien', 'vend', 'habit', 'parfum', 'aliment', 'quincaill', 'boutique', 'magasin']);
  const hit = CATEGORIES.find(([id, label]) => t.includes(id.slice(0, 5)) || t.includes(norm(label).split(' ')[0]));
  const products = await searchProducts(env, { q: message, cat: '', limit: 6 });
  if (products.length) {
    return {
      reply: products.length > 1 ? `J'ai trouvé ${products.length} produits qui peuvent vous plaire :` : 'Voici ce que j\'ai trouvé :',
      products: products.map(p => ({ id: p.id, name: p.name, price: p.price, old_price: p.old_price, promo_pct: p.promo_pct, stock: p.stock, photo_id: p.photo_id, shop: p.shop_name, slug: p.slug, category: p.category })),
      links: hit ? [[`Voir la rubrique ${hit[1]}`, `/?cat=${hit[0]}`]] : []
    };
  }
  if (wantsProduct || hit || keywords(message).length) {
    if (hit) links.push([hit[1], `/?cat=${hit[0]}`]); else links.push(['Toutes les boutiques', '/']);
    return { reply: `Je n'ai pas trouvé « ${String(message).slice(0, 40)} » pour le moment. Parcourez les boutiques de cette rubrique : de nouveaux articles arrivent chaque jour.`, links };
  }
  if (has(t, ['bonjour', 'salut', 'bonsoir', 'hello', 'coucou', 'mbolo'])) {
    return { reply: 'Mbolo ! Je peux vous aider pour une commande, la livraison, le paiement, ou trouver un produit. Que souhaitez-vous ?', links: [] };
  }
  if (has(t, ['merci'])) return { reply: 'Avec plaisir !', links: [] };
  return {
    reply: 'Je n\'ai pas bien compris. Vous pouvez me demander : « où est ma commande ? », « quels sont les frais de livraison ? », « comment payer ? », ou le nom d\'un produit (« pagne », « bananes »…). Pour tout autre sujet, écrivez à l\'équipe.',
    links: []
  };
}
