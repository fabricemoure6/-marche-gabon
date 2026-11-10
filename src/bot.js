// Assistant à règles : répond aux questions fréquentes sans service externe.
import { CATEGORIES, ORDER_STATUS } from './lib.js';

const has = (t, words) => words.some(w => t.includes(w));

export async function botReply(env, user, settings, message) {
  const t = String(message || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').slice(0, 300);
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
  if (has(t, ['boutique', 'magasin', 'trouver', 'produit', 'habit', 'parfum', 'aliment', 'quincaill'])) {
    const hit = CATEGORIES.find(([id, label]) => t.includes(id.slice(0, 5)) || t.includes(label.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(' ')[0]));
    if (hit) links.push([hit[1], `/?cat=${hit[0]}`]); else links.push(['Toutes les boutiques', '/']);
    return { reply: 'Voici les boutiques de cette rubrique. Choisissez une boutique, ajoutez des produits au panier, puis validez.', links };
  }
  if (has(t, ['bonjour', 'salut', 'bonsoir', 'hello', 'coucou'])) {
    return { reply: 'Bonjour ! Je peux vous aider pour une commande, la livraison, le paiement ou pour ouvrir une boutique. Que souhaitez-vous savoir ?', links: [] };
  }
  if (has(t, ['merci'])) return { reply: 'Avec plaisir !', links: [] };
  return {
    reply: 'Je n\'ai pas bien compris. Vous pouvez me demander : « où est ma commande ? », « quels sont les frais de livraison ? », « comment payer ? », « comment vendre ? ». Pour tout autre sujet, écrivez à l\'équipe.',
    links: []
  };
}
