// Abonnements mensuels : gestionnaires de boutique (formules Essentiel / Pro) et livreurs.
// Le marché ne prend pas de commission : il vit des abonnements. Tout est réglable dans Admin → Réglages,
// et rien ne change pour personne tant que l'administrateur n'a pas activé les abonnements.
import { json, bad, now, uid, loadSettings, clearCache } from './lib.js';
import { notify } from './pay.js';

export const DAY = 864e5;
export const MONTH_DAYS = 30;
export const PLANS = { essentiel: 'Essentiel', pro: 'Pro', courier: 'Livreur' };
export const SUB_MONTHS = [1, 3, 6, 12];
const METHODS = { airtel_money: 'Airtel Money', moov_money: 'Moov Money' };

export const planPrice = (st, plan) => (plan === 'pro' ? st.sub_price_pro : plan === 'courier' ? st.sub_price_courier : st.sub_price_essentiel);
const fcfa = n => new Intl.NumberFormat('fr-FR').format(Math.round(Number(n) || 0)).replace(/[   ]/g, ' ') + ' FCFA';
const day = ms => new Date(ms).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Africa/Libreville' });

// État d'un compte : off (abonnements non activés ou rôle non concerné), trial, active, late (délai de grâce), suspended
export function subState(st, u, t = Date.now()) {
  if (!st.sub_enabled || !u || !['seller', 'courier'].includes(u.role)) return { state: 'off' };
  const until = u.sub_until;
  if (!until) return { state: 'trial', until: t + st.sub_trial_days * DAY, daysLeft: st.sub_trial_days }; // l'essai démarre au prochain passage
  if (t < until) return { state: u.sub_trial ? 'trial' : 'active', until, daysLeft: Math.ceil((until - t) / DAY) };
  const graceEnd = until + st.sub_grace_days * DAY;
  if (t < graceEnd) return { state: 'late', until, graceEnd, daysLeft: Math.ceil((graceEnd - t) / DAY) };
  return { state: 'suspended', until, graceEnd };
}
export const isBlocked = s => s.state === 'suspended';
// Formule Pro en cours (payée) : mise en avant et produits illimités
const proOn = (st, u, s) => st.sub_enabled && u.sub_plan === 'pro' && !u.sub_trial && ['active', 'late'].includes(s.state);

// Passage régulier : démarre les essais, envoie les rappels, masque / rétablit les boutiques, coupe les livreurs en retard.
// Appelé au plus toutes les 10 minutes pendant la navigation, et par le déclencheur planifié s'il est activé.
let lastSweep = 0;
export async function subSweep(env, force = false) {
  const t = Date.now();
  if (!force && t - lastSweep < 10 * 60e3) return;
  lastSweep = t;
  const st = await loadSettings(env), DB = env.DB;
  let changed = 0;
  if (!st.sub_enabled) { // abonnements coupés : tout ce qui était masqué pour impayé revient, plus de badge Pro
    changed += (await DB.prepare(`UPDATE shops SET status='active' WHERE status='unpaid'`).run()).meta.changes;
    changed += (await DB.prepare(`UPDATE shops SET pro=0 WHERE pro=1`).run()).meta.changes;
    if (changed) clearCache();
    return;
  }
  const grace = st.sub_grace_days * DAY, cut = t - grace;
  await DB.prepare(`UPDATE users SET sub_until=?1, sub_trial=1, sub_plan=CASE WHEN role='courier' THEN 'courier' ELSE COALESCE(sub_plan,'essentiel') END
    WHERE role IN ('seller','courier') AND sub_until IS NULL`).bind(t + st.sub_trial_days * DAY).run();
  // Rappels : 7 jours avant, la veille, à l'échéance, à la suspension (une seule fois chacun)
  const { results } = await DB.prepare(`SELECT id,role,sub_plan,sub_until,sub_trial,sub_notice FROM users
    WHERE role IN ('seller','courier') AND status='active' AND sub_until < ?1`).bind(t + 7 * DAY).all();
  for (const u of results) {
    const key = u.sub_until < cut ? 'off' : u.sub_until < t ? 'late' : u.sub_until < t + DAY ? 'j1' : 'j7';
    const tag = key + ':' + u.sub_until;
    if (u.sub_notice === tag) continue;
    const shop = u.role === 'seller', url = shop ? '/vendeur.html#abonnement' : '/livreur.html#abonnement';
    const what = u.sub_trial ? 'Votre essai gratuit' : 'Votre abonnement';
    const price = fcfa(planPrice(st, u.sub_plan || (shop ? 'essentiel' : 'courier'))) + ' par mois';
    const msg = {
      j7: [`${what} se termine dans 7 jours`, `Il prend fin le ${day(u.sub_until)}. Renouvelez (${price}) pour ${shop ? 'que votre boutique reste visible' : 'continuer à recevoir des courses'}.`],
      j1: [`${what} se termine demain`, `Renouvelez maintenant (${price}) pour ne pas être interrompu.`],
      late: [`${what} est terminé`, `Vous avez ${st.sub_grace_days} jours pour payer avant ${shop ? 'que votre boutique soit masquée aux clients' : 'de ne plus recevoir de courses'}.`],
      off: [shop ? 'Boutique masquée aux clients' : 'Courses suspendues', 'Votre abonnement n\'est pas réglé. Payez-le : tout revient dès sa validation.']
    }[key];
    await notify(env, u.id, msg[0], msg[1], url, 'info');
    await DB.prepare('UPDATE users SET sub_notice=?2 WHERE id=?1').bind(u.id, tag).run();
  }
  changed += (await DB.prepare(`UPDATE shops SET status='unpaid' WHERE status='active' AND owner_id IN
    (SELECT id FROM users WHERE role='seller' AND sub_until < ?1)`).bind(cut).run()).meta.changes;
  changed += (await DB.prepare(`UPDATE shops SET status='active' WHERE status='unpaid' AND owner_id IN
    (SELECT id FROM users WHERE sub_until >= ?1)`).bind(cut).run()).meta.changes;
  await DB.prepare(`UPDATE couriers SET available=0 WHERE available=1 AND user_id IN (SELECT id FROM users WHERE role='courier' AND sub_until < ?1)`).bind(cut).run();
  changed += (await DB.prepare(`UPDATE shops SET pro = 1 - pro WHERE pro != (CASE WHEN owner_id IN
    (SELECT id FROM users WHERE sub_plan='pro' AND sub_trial=0 AND sub_until >= ?1) THEN 1 ELSE 0 END)`).bind(cut).run()).meta.changes;
  if (changed) clearCache();
}

// Après un paiement validé ou des jours offerts : la boutique revient tout de suite
async function refresh(env, userId) {
  const st = await loadSettings(env);
  const u = await env.DB.prepare('SELECT * FROM users WHERE id=?1').bind(userId).first();
  const s = subState(st, u);
  if (!isBlocked(s)) await env.DB.prepare(`UPDATE shops SET status='active' WHERE owner_id=?1 AND status='unpaid'`).bind(userId).run();
  await env.DB.prepare('UPDATE shops SET pro=?2 WHERE owner_id=?1').bind(userId, proOn(st, u, s) ? 1 : 0).run();
  clearCache();
}

function paymentRow(r) {
  return { id: r.id, plan: r.plan, plan_label: PLANS[r.plan] || r.plan, months: r.months, amount: r.amount, method: r.method, method_label: METHODS[r.method] || r.method,
    txn_ref: r.txn_ref, status: r.status, note: r.note, created_at: r.created_at, decided_at: r.decided_at };
}

// ---------- Côté gestionnaire / livreur ----------
export async function subRoutes(env, request, user, p, method, { readJson, cleanText }) {
  if (p !== '/api/sub' && p !== '/api/sub/pay') return null;
  if (!['seller', 'courier'].includes(user.role)) return bad('Réservé aux gestionnaires et aux livreurs', 403);
  const st = await loadSettings(env);
  const plans = user.role === 'courier' ? ['courier'] : ['essentiel', 'pro'];
  if (method === 'GET' && p === '/api/sub') {
    const u = await env.DB.prepare('SELECT * FROM users WHERE id=?1').bind(user.id).first();
    const { results } = await env.DB.prepare('SELECT * FROM sub_payments WHERE user_id=?1 ORDER BY created_at DESC LIMIT 12').bind(user.id).all();
    const shop = user.role === 'seller' ? await env.DB.prepare(`SELECT id,status,(SELECT COUNT(*) FROM products p WHERE p.shop_id=shops.id AND p.active=1) AS products FROM shops WHERE owner_id=?1`).bind(user.id).first() : null;
    return json({ enabled: !!st.sub_enabled, ...subState(st, u), plan: u.sub_plan || plans[0], plan_label: PLANS[u.sub_plan || plans[0]], trial: !!u.sub_trial || !u.sub_until,
      plans: plans.map(k => ({ id: k, label: PLANS[k], price: planPrice(st, k) })), months: SUB_MONTHS, grace_days: st.sub_grace_days,
      product_limit: st.sub_product_limit, products: shop ? shop.products : null, shop_status: shop ? shop.status : null,
      pay: { airtel_money: st.airtel_number || '', moov_money: st.moov_number || '', name: st.merchant_name },
      payments: results.map(paymentRow), pending: results.some(r => r.status === 'pending') });
  }
  if (method === 'POST' && p === '/api/sub/pay') {
    if (!st.sub_enabled) return bad('Les abonnements ne sont pas encore activés : le site est gratuit pour le moment.');
    const b = await readJson(request);
    const plan = b && plans.includes(b.plan) ? b.plan : null, months = b && SUB_MONTHS.includes(Number(b.months)) ? Number(b.months) : null;
    const meth = b && METHODS[b.method] ? b.method : null, ref = cleanText(b && b.txn_ref, 40);
    if (!plan) return bad('Choisissez une formule');
    if (!months) return bad('Choisissez une durée');
    if (!meth || !(meth === 'airtel_money' ? st.airtel_number : st.moov_number)) return bad('Ce moyen de paiement n\'est pas disponible');
    if (ref.length < 4) return bad('Indiquez la référence de la transaction reçue par SMS');
    if (await env.DB.prepare(`SELECT 1 FROM sub_payments WHERE user_id=?1 AND status='pending'`).bind(user.id).first()) return bad('Un paiement attend déjà la vérification de l\'équipe du marché', 409);
    if (await env.DB.prepare(`SELECT 1 FROM sub_payments WHERE txn_ref=?1 AND status!='rejected'`).bind(ref).first()) return bad('Cette référence de transaction a déjà été envoyée', 409);
    const amount = planPrice(st, plan) * months;
    await env.DB.prepare(`INSERT INTO sub_payments (id,user_id,plan,months,amount,method,txn_ref,status,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,'pending',?8)`)
      .bind(uid(), user.id, plan, months, amount, meth, ref, now()).run();
    const { results: admins } = await env.DB.prepare(`SELECT id FROM users WHERE role='admin'`).all();
    for (const a of admins) await notify(env, a.id, 'Abonnement à vérifier', `${user.name || 'Un compte'} : ${fcfa(amount)} (${PLANS[plan]}, ${months} mois) · réf. ${ref}`, '/admin.html#abonnements', 'payment');
    return json({ ok: true, amount });
  }
  return bad('Introuvable', 404);
}

// ---------- Côté administrateur ----------
export async function subAdminRoutes(env, request, user, p, method, { readJson, cleanText, logAction }) {
  if (!p.startsWith('/api/admin/subs')) return null;
  const st = await loadSettings(env), t = Date.now();
  let m;
  if (method === 'GET' && p === '/api/admin/subs') {
    const { results: users } = await env.DB.prepare(`SELECT u.id,u.name,u.phone,u.role,u.status,u.sub_plan,u.sub_until,u.sub_trial,u.created_at,
        s.name AS shop_name, s.slug, s.status AS shop_status FROM users u LEFT JOIN shops s ON s.owner_id=u.id
      WHERE u.role IN ('seller','courier') ORDER BY u.sub_until IS NULL, u.sub_until`).all();
    const members = users.map(u => ({ ...u, ...subState(st, u, t), plan_label: PLANS[u.sub_plan] || (u.role === 'courier' ? 'Livreur' : 'Essentiel') }));
    const { results: pend } = await env.DB.prepare(`SELECT sp.*, u.name, u.phone, u.role, s.name AS shop_name FROM sub_payments sp JOIN users u ON u.id=sp.user_id
      LEFT JOIN shops s ON s.owner_id=u.id WHERE sp.status='pending' ORDER BY sp.created_at`).all();
    const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
    const rev = await env.DB.prepare(`SELECT COALESCE(SUM(amount),0) AS v, COUNT(*) AS n FROM sub_payments WHERE status='confirmed' AND decided_at >= ?1`).bind(monthStart.toISOString()).first();
    const count = k => members.filter(x => x.state === k).length;
    const paying = members.filter(x => x.state === 'active' || x.state === 'late');
    return json({ enabled: !!st.sub_enabled,
      stats: { active: count('active'), trial: count('trial'), late: count('late'), suspended: count('suspended'),
        monthly: paying.reduce((a, x) => a + planPrice(st, x.sub_plan || (x.role === 'courier' ? 'courier' : 'essentiel')), 0),
        month_revenue: rev.v, month_payments: rev.n, trials_ending: members.filter(x => x.state === 'trial' && x.daysLeft <= 14).length },
      pending: pend.map(r => ({ ...paymentRow(r), name: r.name, phone: r.phone, role: r.role, shop_name: r.shop_name })), members });
  }
  if (method === 'POST' && (m = p.match(/^\/api\/admin\/subs\/([a-f0-9]{16})\/(confirm|reject)$/))) {
    const b = await readJson(request) || {};
    const pay = await env.DB.prepare(`SELECT * FROM sub_payments WHERE id=?1 AND status='pending'`).bind(m[1]).first();
    if (!pay) return bad('Paiement introuvable ou déjà traité', 404);
    const u = await env.DB.prepare('SELECT * FROM users WHERE id=?1').bind(pay.user_id).first();
    if (m[2] === 'reject') {
      const note = cleanText(b.note, 200) || 'Paiement non retrouvé';
      await env.DB.prepare(`UPDATE sub_payments SET status='rejected', note=?2, decided_at=?3, decided_by=?4 WHERE id=?1`).bind(pay.id, note, now(), user.id).run();
      await notify(env, u.id, 'Paiement d\'abonnement refusé', `${note}. Vérifiez la référence et renvoyez-la.`, u.role === 'courier' ? '/livreur.html#abonnement' : '/vendeur.html#abonnement', 'payment');
      await logAction(env, user, 'Paiement d\'abonnement refusé', 'user', u.id, u.name, note);
      return json({ ok: true });
    }
    // Les mois payés s'ajoutent à la fin de la période en cours (ou à aujourd'hui si elle est passée)
    const from = Math.max(t, u.sub_until || 0), until = from + pay.months * MONTH_DAYS * DAY;
    const r = await env.DB.prepare(`UPDATE sub_payments SET status='confirmed', decided_at=?2, decided_by=?3 WHERE id=?1 AND status='pending'`).bind(pay.id, now(), user.id).run();
    if (!r.meta.changes) return bad('Paiement déjà traité', 409);
    await env.DB.prepare('UPDATE users SET sub_until=?2, sub_trial=0, sub_plan=?3, sub_notice=NULL WHERE id=?1').bind(u.id, until, pay.plan).run();
    await refresh(env, u.id);
    await notify(env, u.id, 'Abonnement validé', `Formule ${PLANS[pay.plan]} active jusqu'au ${day(until)}. Merci !`, u.role === 'courier' ? '/livreur.html#abonnement' : '/vendeur.html#abonnement', 'payment');
    await logAction(env, user, `Abonnement validé (${PLANS[pay.plan]}, ${pay.months} mois, ${fcfa(pay.amount)})`, 'user', u.id, u.name, pay.txn_ref);
    return json({ ok: true, until });
  }
  // Jours offerts (geste commercial, tarif pionnier, dédommagement) : prolonge sans paiement
  if (method === 'POST' && (m = p.match(/^\/api\/admin\/subs\/user\/([a-f0-9]{16})\/gift$/))) {
    const b = await readJson(request) || {};
    const days = Math.round(Number(b.days));
    if (!(days >= 1 && days <= 366)) return bad('Indiquez un nombre de jours entre 1 et 366');
    const u = await env.DB.prepare(`SELECT * FROM users WHERE id=?1 AND role IN ('seller','courier')`).bind(m[1]).first();
    if (!u) return bad('Compte introuvable', 404);
    const until = Math.max(t, u.sub_until || t) + days * DAY;
    await env.DB.prepare('UPDATE users SET sub_until=?2, sub_notice=NULL, sub_plan=COALESCE(sub_plan, ?3) WHERE id=?1').bind(u.id, until, u.role === 'courier' ? 'courier' : 'essentiel').run();
    await refresh(env, u.id);
    await notify(env, u.id, `${days} jour${days > 1 ? 's' : ''} offert${days > 1 ? 's' : ''} par le marché`, `Votre ${u.sub_trial ? 'essai' : 'abonnement'} va maintenant jusqu'au ${day(until)}.`, u.role === 'courier' ? '/livreur.html#abonnement' : '/vendeur.html#abonnement', 'info');
    await logAction(env, user, `${days} jours d'abonnement offerts`, 'user', u.id, u.name, cleanText(b.reason, 200));
    return json({ ok: true, until });
  }
  return bad('Introuvable', 404);
}
