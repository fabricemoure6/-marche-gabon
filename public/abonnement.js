/* « Mon abonnement » : partagé par l'espace vendeur et l'espace livreur. */
(function () {
  const STATE = {
    trial: ['Essai gratuit', 'ready'], active: ['Actif', 'active'], late: ['Paiement en retard', 'pending'], suspended: ['Suspendu', 'cancelled']
  };
  const date = ms => new Date(ms).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  const FEATURES = {
    essentiel: ['Votre boutique en ligne', 'Commandes, comptabilité, fidélité', 'Designs et kit de partage', 'Jusqu\'à {limit} produits en ligne'],
    pro: ['Tout ce qu\'offre Essentiel', 'Produits illimités', 'Mise en avant en tête de l\'accueil et de votre rayon', 'Badge « ★ Pro » sur votre boutique'],
    courier: ['Recevoir les courses près de vous', 'Paiement des livraisons sur votre compte', 'Suivi de vos courses']
  };

  // Bandeau court à afficher en haut de l'espace (rien si tout va bien)
  MG.subBanner = function (d, hash) {
    if (!d || !d.enabled || d.state === 'off') return '';
    const shop = d.plans && d.plans[0].id !== 'courier';
    const go = `<a href="${hash}" data-sub-go>Mon abonnement</a>`;
    if (d.state === 'suspended') return `<div class="notice danger"><b>${shop ? 'Votre boutique est masquée aux clients' : 'Vous ne recevez plus de courses'}</b> : votre abonnement n'est pas réglé. Payez-le pour revenir tout de suite. ${go}</div>`;
    if (d.state === 'late') return `<div class="notice"><b>Abonnement terminé.</b> Il vous reste ${d.daysLeft} jour${d.daysLeft > 1 ? 's' : ''} pour payer avant ${shop ? 'que votre boutique soit masquée' : 'de ne plus recevoir de courses'}. ${go}</div>`;
    if (d.daysLeft <= 7) return `<div class="notice">${d.state === 'trial' ? 'Votre essai gratuit' : 'Votre abonnement'} se termine le <b>${date(d.until)}</b>. ${go}</div>`;
    return '';
  };

  MG.subPane = async function (box) {
    const d = await MG.api('/api/sub');
    if (!d.enabled) { box.innerHTML = '<div class="card"><h3 style="margin-top:0">Mon abonnement</h3><p style="margin:0">Le site est <b>gratuit</b> pour le moment : aucun abonnement à payer. Vous serez prévenu à l\'avance avant tout changement.</p></div>'; return; }
    const [label, cls] = STATE[d.state] || ['—', ''];
    const shop = d.plans[0].id !== 'courier';
    const pays = [['airtel_money', 'Airtel Money'], ['moov_money', 'Moov Money']].filter(([k]) => d.pay[k]);
    const until = d.state === 'trial' ? `Essai gratuit jusqu'au <b>${date(d.until)}</b>` : d.state === 'active' ? `Payé jusqu'au <b>${date(d.until)}</b>`
      : d.state === 'late' ? `Terminé le ${date(d.until)} : encore <b>${d.daysLeft} jour${d.daysLeft > 1 ? 's' : ''}</b> pour payer` : `Terminé le ${date(d.until)}`;
    const feat = k => (FEATURES[k] || []).map(f => `<li>${MG.esc(f.replace('{limit}', d.product_limit))}</li>`).join('');
    box.innerHTML = `<div class="card sub-status"><div><span class="tag ${cls}">${label}</span><h3 style="margin:.4rem 0 .2rem">Formule ${MG.esc(d.trial ? 'Essai' : d.plan_label)}</h3><p class="muted" style="margin:0">${until}</p>
        ${shop && d.products != null && d.plan !== 'pro' ? `<p class="muted" style="margin:.3rem 0 0;font-size:.9rem">${d.products} produit${d.products > 1 ? 's' : ''} en ligne sur ${d.product_limit} avec Essentiel</p>` : ''}</div></div>
      <div class="sub-plans">${d.plans.map(p => `<label class="sub-plan"><input type="radio" name="subPlan" value="${p.id}"${p.id === (d.plan || d.plans[0].id) ? ' checked' : ''}${d.plans.length < 2 ? ' hidden' : ''}>
        <span class="sp-name">${MG.esc(p.label)}</span><span class="sp-price">${MG.fcfa(p.price)}<small> / mois</small></span><ul>${feat(p.id)}</ul></label>`).join('')}</div>
      ${d.pending ? '<div class="notice">Votre dernier paiement attend la vérification de l\'équipe du marché. Vous serez prévenu dès sa validation.</div>'
        : !pays.length ? '<div class="notice">L\'équipe du marché n\'a pas encore indiqué de numéro pour recevoir les abonnements. Revenez un peu plus tard.</div>'
        : `<form class="card" id="subForm"><h3 style="margin-top:0">Payer mon abonnement</h3>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:0 var(--space-3)">
          <div><label for="subMonths">Durée</label><select id="subMonths">${d.months.map(m => `<option value="${m}">${m} mois</option>`).join('')}</select></div>
          <div><label for="subMethod">Moyen de paiement</label><select id="subMethod">${pays.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div></div>
        <div class="sub-howto" id="subHow"></div>
        <label for="subRef">Référence de la transaction (reçue par SMS)</label><input id="subRef" required maxlength="40" placeholder="Ex. MP240612.1234.A56789" autocomplete="off">
        <p><button class="btn">J'ai payé : envoyer la référence</button></p></form>`}
      ${d.payments.length ? `<div class="card scroll"><h3 style="margin-top:0">Mes paiements</h3><table><thead><tr><th>Date</th><th>Formule</th><th>Montant</th><th>Réf.</th><th>État</th></tr></thead><tbody>
        ${d.payments.map(p => `<tr><td><small>${MG.date(p.created_at)}</small></td><td>${MG.esc(p.plan_label)} · ${p.months} mois</td><td>${MG.fcfa(p.amount)}</td><td><small>${MG.esc(p.txn_ref || '')}</small></td>
        <td><span class="tag ${p.status === 'confirmed' ? 'active' : p.status === 'rejected' ? 'cancelled' : 'pending'}">${p.status === 'confirmed' ? 'Validé' : p.status === 'rejected' ? 'Refusé' : 'En vérification'}</span>${p.note ? `<br><small class="muted">${MG.esc(p.note)}</small>` : ''}</td></tr>`).join('')}</tbody></table></div>` : ''}`;
    const form = box.querySelector('#subForm'); if (!form) return;
    const plan = () => (box.querySelector('input[name=subPlan]:checked') || {}).value || d.plans[0].id;
    const how = () => {
      const p = d.plans.find(x => x.id === plan()), months = Number(box.querySelector('#subMonths').value), meth = box.querySelector('#subMethod').value;
      box.querySelector('#subHow').innerHTML = `<p style="margin:var(--space-3) 0">Envoyez <b style="font-size:1.15rem">${MG.fcfa(p.price * months)}</b> par ${meth === 'moov_money' ? 'Moov Money' : 'Airtel Money'} au <b>${MG.esc(d.pay[meth])}</b>${d.pay.name ? ' (' + MG.esc(d.pay.name) + ')' : ''}, avec le motif <b>Abonnement ${MG.esc(MG.user.name || '')}</b>.<br><span class="muted">Puis recopiez ci-dessous la référence du SMS de confirmation. L'équipe du marché vérifie et valide.</span></p>`;
    };
    box.querySelectorAll('input[name=subPlan], #subMonths, #subMethod').forEach(el => (el.onchange = how)); how();
    form.onsubmit = async e => {
      e.preventDefault();
      try {
        const r = await MG.api('/api/sub/pay', { method: 'POST', body: { plan: plan(), months: Number(box.querySelector('#subMonths').value), method: box.querySelector('#subMethod').value, txn_ref: box.querySelector('#subRef').value } });
        MG.toast(`Référence envoyée (${MG.fcfa(r.amount)}) : l'équipe du marché va vérifier`); MG.subPane(box);
      } catch (er) { MG.fail(er); }
    };
  };
})();
