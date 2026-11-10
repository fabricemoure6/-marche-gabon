// Paiement : SingPay (page hébergée) avec repli manuel Airtel Money, confirmation des commandes, notifications.
import { uid, now } from './lib.js';

export async function notify(env, userId, title, body, url) {
  await env.DB.prepare('INSERT INTO notifications (id,user_id,title,body,url,created_at) VALUES (?1,?2,?3,?4,?5,?6)')
    .bind(uid(), userId, String(title).slice(0, 120), String(body || '').slice(0, 300), url || null, now()).run();
}

// Quand un paiement est confirmé : commandes payées, boutiques et client prévenus
export async function confirmCheckout(env, checkout) {
  if (checkout.status === 'confirmed') return;
  const r = await env.DB.prepare(`UPDATE checkouts SET status='confirmed', confirmed_at=?2 WHERE id=?1 AND status!='confirmed'`)
    .bind(checkout.id, now()).run();
  if (!r.meta.changes) return; // déjà confirmé par un autre signal
  await env.DB.prepare(`UPDATE orders SET status='paid', updated_at=?2 WHERE checkout_id=?1 AND status='awaiting_payment'`)
    .bind(checkout.id, now()).run();
  const { results: orders } = await env.DB.prepare(
    `SELECT o.ref,o.total,o.customer_id,s.owner_id,s.name AS shop_name FROM orders o JOIN shops s ON s.id=o.shop_id WHERE o.checkout_id=?1`)
    .bind(checkout.id).all();
  for (const o of orders) {
    await notify(env, o.owner_id, 'Nouvelle commande payée', `Commande ${o.ref}, ${o.total} FCFA. À préparer.`, '/vendeur.html');
    await notify(env, o.customer_id, 'Paiement reçu', `Votre commande ${o.ref} chez ${o.shop_name} est payée. Votre reçu est disponible.`, `/recu.html?ref=${o.ref}`);
  }
}

export async function rejectCheckout(env, checkout, restock = true) {
  if (checkout.status === 'confirmed' || checkout.status === 'rejected') return;
  await env.DB.prepare(`UPDATE checkouts SET status='rejected' WHERE id=?1 AND status NOT IN ('confirmed','rejected')`).bind(checkout.id).run();
  await cancelOrders(env, checkout.id, restock);
}

// Annule les commandes d'un paiement et remet les produits en stock
export async function cancelOrders(env, checkoutId, restock = true) {
  const { results: orders } = await env.DB.prepare(
    `SELECT id FROM orders WHERE checkout_id=?1 AND status='awaiting_payment'`).bind(checkoutId).all();
  for (const o of orders) {
    if (restock) {
      await env.DB.prepare(`UPDATE products SET stock = stock + COALESCE((SELECT qty FROM order_items WHERE order_id=?1 AND product_id=products.id),0)
        WHERE id IN (SELECT product_id FROM order_items WHERE order_id=?1)`).bind(o.id).run();
    }
    await env.DB.prepare(`UPDATE orders SET status='cancelled', updated_at=?2 WHERE id=?1`).bind(o.id, now()).run();
  }
}

// ---------- SingPay ----------
// Actif seulement si SINGPAY_CLIENT_ID, SINGPAY_CLIENT_SECRET et SINGPAY_WALLET sont définis (type Secret dans Cloudflare).
const SINGPAY_BASE = 'https://gateway.singpay.ga/v1';
export const sp = (env, k) => String(env[k] || '').trim();
export const singpayOn = env => !!(sp(env, 'SINGPAY_CLIENT_ID') && sp(env, 'SINGPAY_CLIENT_SECRET') && sp(env, 'SINGPAY_WALLET'));

export async function singpayCall(env, method, path, body) {
  const res = await fetch((env.SINGPAY_BASE_URL || SINGPAY_BASE) + path, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-client-id': sp(env, 'SINGPAY_CLIENT_ID'), 'x-client-secret': sp(env, 'SINGPAY_CLIENT_SECRET'), 'x-wallet': sp(env, 'SINGPAY_WALLET')
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error('SingPay ' + res.status + ' ' + JSON.stringify(data).slice(0, 200));
  return data;
}

// Renvoie { redirectUrl } ou null (le client retombe alors sur le paiement manuel)
export async function startOnlinePayment(env, checkout, origin) {
  if (!singpayOn(env)) return null;
  const body = {
    portefeuille: sp(env, 'SINGPAY_WALLET'), reference: checkout.ref, amount: checkout.amount,
    redirect_success: `${origin}/commandes.html?paiement=ok&ref=${checkout.ref}`,
    redirect_error: `${origin}/commandes.html?paiement=erreur&ref=${checkout.ref}`
  };
  if (sp(env, 'SINGPAY_DISBURSEMENT')) body.disbursement = sp(env, 'SINGPAY_DISBURSEMENT');
  try {
    const r = await singpayCall(env, 'POST', '/ext', body);
    const link = r && r.link;
    if (!link || !/^https:\/\//.test(link)) { console.error('SingPay: pas de lien', JSON.stringify(r).slice(0, 200)); return null; }
    await env.DB.prepare(`UPDATE checkouts SET provider='singpay' WHERE id=?1`).bind(checkout.id).run();
    return { redirectUrl: link };
  } catch (e) {
    console.error('SingPay start failed', e.message);
    return null;
  }
}

// Interroge SingPay (jamais le corps du webhook, non signé) pour connaître l'état réel du paiement.
export async function singpayVerify(env, checkout) {
  if (!singpayOn(env) || checkout.provider !== 'singpay') return checkout.status;
  if (checkout.status === 'confirmed') return 'confirmed';
  let r;
  try { r = await singpayCall(env, 'GET', '/transaction/api/search/by-reference/' + encodeURIComponent(checkout.ref)); }
  catch (e) { console.error('SingPay verify failed', e.message); return checkout.status; }
  const t = Array.isArray(r) ? r[0] : (r && r.transaction) || r;
  if (!t) return checkout.status;
  if (t.reference && t.reference !== checkout.ref) return checkout.status;
  // Doc SingPay : status = Start | Partenaire | Terminate | Disbursement | Refund ; result = Success | PasswordError | BalanceError | TimeOutError | Error
  const status = String(t.status || ''), result = String(t.result || ''), amt = Number(t.amount);
  if (result === 'Success' && (status === 'Terminate' || status === 'Disbursement')) {
    if (Number.isFinite(amt) && amt !== checkout.amount) { console.error('SingPay amount mismatch', checkout.ref); return checkout.status; }
    await confirmCheckout(env, checkout);
    return 'confirmed';
  }
  if (status === 'Refund' || /^(PasswordError|BalanceError|TimeOutError|Error)$/.test(result)) {
    await rejectCheckout(env, checkout);
    return 'rejected';
  }
  return checkout.status;
}
