// Code partagé : appels API, menu, notifications, chatbot, discussion de commande.
(function () {
  const MG = (window.MG = {});
  MG.esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  MG.fcfa = n => new Intl.NumberFormat('fr-FR').format(Math.round(Number(n) || 0)).replace(/[  ]/g, ' ') + ' FCFA';
  MG.photo = id => (id ? '/api/photos/' + encodeURIComponent(id) : '');
  MG.date = iso => { try { return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' }); } catch { return ''; } };
  MG.$ = (s, r) => (r || document).querySelector(s);
  MG.param = k => new URLSearchParams(location.search).get(k);
  MG.catName = id => ((MG.config.categories.find(c => c[0] === id) || [])[1]) || id;
  MG.waLink = (digits, text) => digits ? 'https://wa.me/' + encodeURIComponent(String(digits).replace(/\D/g, '')) + (text ? '?text=' + encodeURIComponent(text) : '') : '';

  MG.api = async function (path, opts = {}) {
    const o = { method: opts.method || 'GET', headers: { 'x-csrf': '1' }, credentials: 'same-origin' };
    if (opts.body instanceof ArrayBuffer || opts.body instanceof Blob) o.body = opts.body;
    else if (opts.body !== undefined) { o.headers['content-type'] = 'application/json'; o.body = JSON.stringify(opts.body); }
    const r = await fetch(path, o);
    let data = null;
    try { data = await r.json(); } catch { /* pas de JSON */ }
    if (!r.ok) { const e = new Error((data && data.error) || 'Erreur ' + r.status); e.status = r.status; throw e; }
    return data;
  };

  MG.toast = function (msg, bad) {
    let t = document.getElementById('toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
    t.textContent = msg; t.className = 'show' + (bad ? ' bad' : '');
    clearTimeout(MG._tt); MG._tt = setTimeout(() => (t.className = ''), 3500);
  };
  MG.fail = e => MG.toast(e.message || 'Erreur', true);

  // Réduit une photo (≤ 900 px) avant l'envoi pour rester léger.
  MG.uploadPhoto = async function (file) {
    if (!file) return null;
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 800 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    let blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.76));
    if (blob.size > 690 * 1024) blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.55));
    const out = await MG.api('/api/photos', { method: 'POST', body: await blob.arrayBuffer() });
    return out.id;
  };

  // ---------- Paiement direct : où envoyer l'argent ----------
  // acc = { method, methodLabel, number, name, code, bank }
  MG.accountBox = function (acc, amount) {
    if (!acc) return '';
    const bank = acc.method === 'bank';
    return `<div class="payacc"><div><span class="muted">${bank ? 'Compte bancaire' : 'Envoyer par'}</span> <b>${MG.esc(acc.methodLabel || '')}</b>${bank && acc.bank ? ` · ${MG.esc(acc.bank)}` : ''}</div>
      <div class="payno"><span>${bank ? 'N° de compte' : 'Numéro'}</span><b>${MG.esc(acc.number)}</b><button type="button" class="btn small alt" data-copy="${MG.esc(acc.number)}">Copier</button></div>
      ${acc.name ? `<div><span class="muted">Titulaire</span> <b>${MG.esc(acc.name)}</b></div>` : ''}${acc.code ? `<div><span class="muted">Code marchand</span> <b>${MG.esc(acc.code)}</b></div>` : ''}
      ${amount != null ? `<div class="payamt">Montant à envoyer : <b>${MG.fcfa(amount)}</b></div>` : ''}</div>`;
  };
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-copy]'); if (!b) return;
    const v = b.dataset.copy;
    (navigator.clipboard ? navigator.clipboard.writeText(v) : Promise.reject()).then(() => MG.toast('Numéro copié'), () => { const t = document.createElement('input'); t.value = v; document.body.appendChild(t); t.select(); try { document.execCommand('copy'); MG.toast('Numéro copié'); } catch (er) { /* ignoré */ } t.remove(); });
  });
  // Bloc « payer la boutique » / « payer le livreur » d'une commande (p = order.pay.shop ou order.pay.fee)
  MG.payBlock = function (title, p, who, ref, kind) {
    const S = { to_pay: ['À payer', 'pending'], submitted: ['Paiement déclaré, en attente de confirmation', 'pending'], paid: ['Payé et confirmé', 'active'], cancelled: ['Annulé', 'cancelled'], waiting_courier: ['En attente d\'un livreur', 'cancelled'] }[p.state];
    return `<div class="card paycard"><h3 style="margin:0 0 .4rem">${MG.esc(title)} <span class="tag ${S[1]}">${S[0]}</span></h3>
      ${p.state === 'waiting_courier' ? `<p class="muted" style="margin:0">Dès qu'un livreur accepte votre commande, vous verrez ici son numéro pour lui envoyer les ${MG.fcfa(p.amount)} de frais de livraison.</p>`
        : p.state === 'to_pay' ? `<p style="margin:0 0 .5rem">Envoyez ${MG.fcfa(p.amount)} ${who}, puis saisissez la référence de la transaction.</p>${p.account ? MG.accountBox(p.account, p.amount) : '<p class="muted">Le compte de paiement n\'est pas renseigné.</p>'}
          <label for="ref-${kind}">Référence de la transaction (SMS de confirmation)</label><div class="row"><input id="ref-${kind}" maxlength="60" placeholder="Ex. : MP240101.1234.A12345"><button type="button" class="btn" data-sendproof="${kind}" data-ref="${ref}">J'ai payé</button></div>`
        : p.state === 'submitted' ? `<p class="muted" style="margin:0">Référence envoyée : <b>${MG.esc(p.ref || '')}</b>. ${p.dispute ? '<b>L\'équipe du marché vérifie votre paiement avec la boutique ou le livreur : gardez votre SMS de confirmation.</b>' : kind === 'proof' ? 'La boutique vérifie son compte puis confirme.' : 'Le livreur confirmera la réception.'}</p>`
        : p.state === 'paid' ? '<p class="muted" style="margin:0">Merci, tout est en ordre.</p>' : '<p class="muted" style="margin:0">Cette commande a été annulée.</p>'}</div>`;
  };

  // ---------- Pièces justificatives (facultatives, privées) ----------
  // Une photo est réduite à 1600 px ; un PDF part tel quel (1 Mo maximum).
  const DOC_STATE = { pending: ['En attente de vérification', 'pending'], verified: ['Vérifiée', 'active'], rejected: ['Refusée', 'suspended'] };
  MG.openDocument = async id => {
    const r = await fetch('/api/documents/' + id, { credentials: 'same-origin' });
    if (!r.ok) throw new Error('Document introuvable');
    const url = URL.createObjectURL(await r.blob()); window.open(url, '_blank', 'noopener'); setTimeout(() => URL.revokeObjectURL(url), 60000);
  };
  MG.docsCard = async function (box, { title, intro } = {}) {
    const { kinds, documents } = await MG.api('/api/me/documents');
    box.innerHTML = `<div class="card docs"><h3>${MG.esc(title || 'Mes pièces')} <span class="tag">Facultatif</span></h3>
      <p class="muted" style="margin:0 0 var(--space-3)">${MG.esc(intro || '')} <b>Seule l'équipe du marché peut les voir</b> : jamais les clients.</p>
      ${kinds.map(k => { const d = documents.find(x => x.kind === k.id), st = d && DOC_STATE[d.status];
        return `<div class="docrow"><div><b>${MG.esc(k.label)}</b>${d ? `<br><span class="tag ${st[1]}">${st[0]}</span> <span class="muted">· envoyée le ${MG.date(d.created_at)}</span>${d.note ? `<br><span class="muted">Message de l'équipe : ${MG.esc(d.note)}</span>` : ''}` : '<br><span class="muted">Pas encore envoyée</span>'}</div>
        <div class="row">${d ? `<button type="button" class="btn small alt" data-view="${d.id}">Voir</button><button type="button" class="btn small alt" data-del="${d.id}">Retirer</button>` : ''}
        <label class="btn small ${d ? 'alt' : ''}" style="cursor:pointer">${d ? 'Remplacer' : 'Ajouter'}<input type="file" accept="image/*,application/pdf" hidden data-up="${k.id}"></label></div></div>`; }).join('')}</div>`;
    box.onclick = async e => {
      const v = e.target.closest('[data-view]'), x = e.target.closest('[data-del]');
      try {
        if (v) await MG.openDocument(v.dataset.view);
        if (x && confirm('Retirer cette pièce ?')) { await MG.api('/api/me/documents/' + x.dataset.del, { method: 'DELETE' }); MG.toast('Pièce retirée'); MG.docsCard(box, { title, intro }); }
      } catch (er) { MG.fail(er); }
    };
    box.onchange = async e => {
      const i = e.target.closest('[data-up]'); if (!i || !i.files[0]) return;
      const f = i.files[0];
      try {
        let body;
        if (f.type === 'application/pdf') { if (f.size > 1024 * 1024) throw new Error('PDF trop lourd (1 Mo maximum) : envoyez plutôt une photo.'); body = await f.arrayBuffer(); }
        else {
          const bmp = await createImageBitmap(f), k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height)), c = document.createElement('canvas');
          c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k); c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
          let q = 0.82, blob = await new Promise(r => c.toBlob(r, 'image/jpeg', q));
          while (blob.size > 1000 * 1024 && q > 0.4) { q -= 0.12; blob = await new Promise(r => c.toBlob(r, 'image/jpeg', q)); }
          body = await blob.arrayBuffer();
        }
        await MG.api('/api/me/documents/' + i.dataset.up, { method: 'POST', body });
        MG.toast('Pièce envoyée : l\'équipe va la vérifier'); MG.docsCard(box, { title, intro });
      } catch (er) { MG.fail(er); }
    };
  };

  // Photo de profil : recadrée au centre en carré de 400 px (JPEG léger)
  MG.uploadAvatar = async function (file) {
    if (!file) return null;
    if (!/^image\//.test(file.type)) throw new Error('Choisissez une image (JPEG, PNG ou WebP)');
    const bmp = await createImageBitmap(file);
    const side = Math.min(bmp.width, bmp.height), out = Math.min(400, side);
    const c = document.createElement('canvas'); c.width = c.height = out;
    c.getContext('2d').drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, out, out);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.82));
    return (await MG.api('/api/photos', { method: 'POST', body: await blob.arrayBuffer() })).id;
  };
  // Avatar rond : la photo, sinon l'initiale sur fond soleil. u = {name, avatar_id}
  MG.avatar = (u, size = 40) => {
    const n = (u && u.name ? u.name.trim() : '?') || '?';
    return u && u.avatar_id
      ? `<img class="pfp" src="${MG.photo(u.avatar_id)}" alt="" width="${size}" height="${size}" style="width:${size}px;height:${size}px">`
      : `<span class="pfp" aria-hidden="true" style="width:${size}px;height:${size}px;font-size:${Math.round(size * 0.42)}px">${MG.esc(n.charAt(0).toUpperCase())}</span>`;
  };
  // Sélecteur de photo de profil avec aperçu rond. Renvoie { file() } pour lire le fichier choisi.
  MG.photoPicker = function (box, { name = '', current = null, hint = '' } = {}) {
    box.innerHTML = `<div class="pfp-pick"><span class="pfp-prev">${MG.avatar({ name, avatar_id: current }, 88)}</span>
      <div><label class="btn small alt" style="margin:0;cursor:pointer">${MG.icon('user', 16)}<span>${current ? 'Changer la photo' : 'Ajouter une photo'}</span>
        <input type="file" accept="image/*" capture="user" hidden></label>
        ${hint ? `<p class="muted" style="margin:.4rem 0 0;font-size:.85rem">${MG.esc(hint)}</p>` : ''}</div></div>`;
    const input = box.querySelector('input'), prev = box.querySelector('.pfp-prev');
    input.onchange = () => {
      const f = input.files[0]; if (!f) return;
      prev.innerHTML = `<img class="pfp" src="${URL.createObjectURL(f)}" alt="" style="width:88px;height:88px">`;
      box.querySelector('label span').textContent = 'Changer la photo';
    };
    return { file: () => input.files[0] || null };
  };

  MG.getPosition = () => new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error('La géolocalisation n\'est pas disponible sur cet appareil'));
    navigator.geolocation.getCurrentPosition(p => res({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => rej(new Error('Position refusée : autorisez la localisation dans votre navigateur')), { enableHighAccuracy: true, timeout: 15000 });
  });

  // ---------- Icônes (trait 2px, style Lucide) ----------
  const ICONS = {
    plus: '<path d="M12 5v14M5 12h14"/>', check: '<path d="m5 12 5 5L20 7"/>', x: '<path d="M6 6l12 12M18 6 6 18"/>',
    cart: '<circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2 3h3l2.4 11.2a2 2 0 0 0 2 1.6h7.7a2 2 0 0 0 2-1.5L21 7H6"/>',
    bell: '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>', send: '<path d="M4 12 20 4l-6 16-3-7z"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>', menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    pin: '<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>',
    chat: '<path d="M4 5h16v11H8l-4 4z"/>', download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>', trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>'
  };
  MG.icon = (n, s = 20) => `<svg class="ico" viewBox="0 0 24 24" width="${s}" height="${s}" aria-hidden="true">${ICONS[n] || ''}</svg>`;

  // Illustration de remplacement quand un produit ou une boutique n'a pas de photo
  const ILLU = { habits: 'pagne-wax', parfumerie: 'parfum', alimentation: 'bananes-plantain', quincaillerie: 'sac-riz', electronique: 'smartphone', maison: 'marmite', autres: 'panier-tresse' };
  MG.illu = cat => '/img/produits/' + (ILLU[cat] || 'panier-tresse') + '.svg';
  MG.img = (photoId, cat) => (photoId ? MG.photo(photoId) : MG.illu(cat));

  // Temps restant d'une promotion, en mots
  MG.timeLeft = ms => {
    const d = ms - Date.now(); if (d <= 0) return '';
    const h = Math.ceil(d / 3600000);
    return h <= 24 ? `Plus que ${h} h` : `Plus que ${Math.ceil(h / 24)} j`;
  };

  // Tuile produit partagée (accueil, boutique, recherche).
  // p = {id, name, description, price, old_price?, promo_pct?, promo_until?, stock, photo_id, shop_name?, slug?, category?}
  MG.LOW_STOCK = 5;
  // Unités de vente : à la pièce, au kilo, au litre, au tas, au sachet, à la botte (kilo et litre acceptent les décimales)
  MG.UNITS = { piece: { label: 'À la pièce', short: '', decimal: false }, kg: { label: 'Au kilo', short: 'kg', decimal: true }, litre: { label: 'Au litre', short: 'L', decimal: true },
    tas: { label: 'Au tas', short: 'tas', decimal: false }, sachet: { label: 'Au sachet', short: 'sachet', decimal: false }, botte: { label: 'À la botte', short: 'botte', decimal: false } };
  MG.r3 = n => Math.round(n * 1000) / 1000;
  MG.qty = (q, unit) => { const s = (MG.UNITS[unit] || MG.UNITS.piece).short, n = String(MG.r3(q)).replace('.', ','); return s ? n + ' ' + s : n; };
  MG.per = unit => { const s = (MG.UNITS[unit] || MG.UNITS.piece).short; return s ? `<small class="per"> / ${s}</small>` : ''; };
  MG.lineTotal = (price, qty) => Math.round(price * qty);
  MG.cartCount = items => items.reduce((t, i) => t + ((MG.UNITS[i.unit] || MG.UNITS.piece).decimal ? 1 : i.qty), 0);
  // Indication de stock lisible par tous : épuisé, plus que N, en stock
  MG.stockInfo = (n, unit) => n <= 0 ? '<span class="stock-info out">Épuisé</span>'
    : n <= MG.LOW_STOCK ? `<span class="stock-info low">Plus que ${MG.qty(n, unit)} en stock</span>` : '<span class="stock-info ok">En stock</span>';
  MG.productCard = function (p, opts = {}) {
    const out = !(p.stock > 0);
    const watching = opts.alerts && opts.alerts.includes(p.id);
    const shop = p.shop_name ? (opts.demo ? `<span class="pshop">${MG.esc(p.shop_name)}</span>` : `<a class="pshop" href="/boutique/${encodeURIComponent(p.slug)}">${MG.esc(p.shop_name)}</a>`) : '';
    const badge = out ? '<span class="tag out">Épuisé</span>'
      : p.promo_pct ? `<span class="tag promo">−${p.promo_pct} %</span>` : (p.badge ? `<span class="tag new">${MG.esc(p.badge)}</span>` : '');
    const left = p.promo_until ? MG.timeLeft(p.promo_until) : '';
    const img = opts.img || MG.img(p.photo_id, p.category || opts.category);
    const nPics = (p.photos || []).length;
    if (!opts.demo) { MG._prod = MG._prod || {}; MG._prod[p.id] = { ...p, category: p.category || opts.category, watching }; }
    return `<article class="tile product${out ? ' out' : ''}${p.promo_pct ? ' is-promo' : ''}">
      <div class="pimg"${opts.demo ? '' : ` data-gal="${MG.esc(p.id)}" role="button" tabindex="0" aria-label="Voir ${MG.esc(p.name)}${nPics > 1 ? ' (' + nPics + ' photos)' : ''}"`}><img src="${img}" alt="${MG.esc(p.name)}" width="400" height="300"${opts.eager ? ' fetchpriority="high"' : ' loading="lazy"'}>${nPics > 1 ? `<span class="pcount" aria-hidden="true"><svg class="ico" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg>${nPics}</span>` : ''}<div class="pbadges" aria-hidden="true">${badge}</div>${left && !out ? `<span class="ptimer" aria-hidden="true">${left}</span>` : ''}</div>
      <div class="pbody">${shop}<h3 class="pname">${MG.esc(p.name)}</h3>${opts.desc && p.description ? `<p class="pdesc">${MG.esc(p.description)}</p>` : ''}${opts.demo ? '' : MG.stockInfo(p.stock, p.unit)}
        <div class="pfoot"><div>${p.old_price ? `<span class="old">${MG.fcfa(p.old_price)}</span>` : ''}<span class="price">${MG.fcfa(p.price)}</span>${MG.per(p.unit)}</div>
        ${opts.demo ? '' : out ? `<button class="btn small ${watching ? 'green' : 'alt'} notify" data-alert="${MG.esc(p.id)}" data-on="${watching ? 1 : 0}">${MG.icon(watching ? 'check' : 'bell', 16)}${watching ? 'Alerte activée' : 'Me prévenir'}</button>`
          : `<button class="add" data-add="${MG.esc(p.id)}" data-stock="${p.stock}" data-step="${p.qty_step || 1}" data-unit="${p.unit || 'piece'}" aria-label="Ajouter ${(p.qty_step || 1) !== 1 || p.unit && p.unit !== 'piece' ? MG.qty(p.qty_step || 1, p.unit) + ' de ' : ''}${MG.esc(p.name)} au panier">${MG.icon('plus')}</button>`}</div></div></article>`;
  };

  // Fiche produit : galerie de photos + informations + ajout au panier
  MG.productSheet = function (p) {
    const pics = (p.photos && p.photos.length ? p.photos : [p.photo_id]).filter(Boolean);
    const urls = pics.length ? pics.map(MG.photo) : [MG.illu(p.category)];
    let i = 0;
    const m = MG.modal(`<div class="sheet"><button type="button" class="sheet-x" data-close aria-label="Fermer">${MG.icon('x', 20)}</button>
      <div class="gal"><div class="gal-main"><img id="galImg" src="${urls[0]}" alt="${MG.esc(p.name)}">
        ${urls.length > 1 ? `<button type="button" class="gal-nav prev" aria-label="Photo précédente">‹</button><button type="button" class="gal-nav next" aria-label="Photo suivante">›</button><span class="gal-n" id="galN">1 / ${urls.length}</span>` : ''}
        ${p.promo_pct ? `<span class="tag promo" style="position:absolute;top:12px;left:12px">−${p.promo_pct} %</span>` : ''}</div>
        ${urls.length > 1 ? `<div class="gal-thumbs">${urls.map((u, k) => `<button type="button" data-k="${k}" class="${k ? '' : 'on'}" aria-label="Photo ${k + 1}"><img src="${u}" alt=""></button>`).join('')}</div>` : ''}</div>
      <div class="sheet-info">${p.shop_name ? `<span class="pshop">${MG.esc(p.shop_name)}</span>` : ''}<h2>${MG.esc(p.name)}</h2>${MG.stockInfo(p.stock, p.unit)}
        ${p.description ? `<p class="muted" style="margin:.6rem 0 0">${MG.esc(p.description)}</p>` : ''}
        <div class="sheet-buy"><div>${p.old_price ? `<span class="old">${MG.fcfa(p.old_price)}</span>` : ''}<span class="price" style="font-size:1.6rem">${MG.fcfa(p.price)}</span>${MG.per(p.unit)}</div>
        ${p.stock > 0 ? `<button class="btn" data-add="${MG.esc(p.id)}" data-step="${p.qty_step || 1}" data-unit="${p.unit || 'piece'}">${MG.icon('cart', 18)}Ajouter ${p.unit && p.unit !== 'piece' ? MG.qty(p.qty_step || 1, p.unit) : 'au panier'}${p.unit && p.unit !== 'piece' ? ' au panier' : ''}</button>`
          : `<button class="btn ${p.watching ? 'green' : 'alt'}" data-alert="${MG.esc(p.id)}" data-on="${p.watching ? 1 : 0}">${MG.icon(p.watching ? 'check' : 'bell', 16)}${p.watching ? 'Alerte activée' : 'Me prévenir'}</button>`}</div></div></div>`, { wide: true });
    const el = m.el; el.classList.add('sheet-modal');
    const show = k => {
      i = (k + urls.length) % urls.length; el.querySelector('#galImg').src = urls[i];
      const n = el.querySelector('#galN'); if (n) n.textContent = `${i + 1} / ${urls.length}`;
      el.querySelectorAll('.gal-thumbs button').forEach((b, j) => b.classList.toggle('on', j === i));
    };
    el.addEventListener('click', e => {
      if (e.target.closest('.prev')) show(i - 1);
      if (e.target.closest('.next')) show(i + 1);
      const t = e.target.closest('[data-k]'); if (t) show(Number(t.dataset.k));
      if (e.target.closest('[data-add]')) setTimeout(() => m.close(), 900);
    });
    el.addEventListener('keydown', e => { if (e.key === 'ArrowLeft') show(i - 1); if (e.key === 'ArrowRight') show(i + 1); });
    let x0 = null; const main = el.querySelector('.gal-main');
    main.addEventListener('touchstart', e => (x0 = e.touches[0].clientX), { passive: true });
    main.addEventListener('touchend', e => { if (x0 === null) return; const dx = e.changedTouches[0].clientX - x0; if (Math.abs(dx) > 40) show(i + (dx < 0 ? 1 : -1)); x0 = null; });
  };

  // Tuile boutique. s = {name, slug, category, address, photo_id, cover_id?, products, promos?, best_pct?}
  MG.shopCard = function (s, opts = {}) {
    const cover = opts.cover || (s.cover_id ? MG.photo(s.cover_id) : MG.img(s.photo_id, s.category));
    const logo = s.photo_id ? `style="background-image:url('${MG.photo(s.photo_id)}')"` : '';
    const tag = opts.demo ? 'div' : 'a';
    return `<${tag} class="tile shop${s.promos ? ' has-promo' : ''}"${opts.demo ? '' : ` href="/boutique/${encodeURIComponent(s.slug)}"`}>
      <div class="cover" style="background-image:url('${cover}')">${s.promos ? `<span class="ribbon">Promo${s.best_pct ? '<span class="rl"> jusqu\'à</span> −' + s.best_pct + ' %' : ''}</span>` : ''}</div>
      <div class="body"><span class="logo" ${logo}>${s.photo_id ? '' : MG.esc(s.name.trim().charAt(0).toUpperCase())}</span><h3>${MG.esc(s.name)}</h3>
       ${s.loyalty_enabled ? '<span class="tag fid">Carte fidélité</span>' : ''}<p class="muted" style="margin:0;font-size:.9rem">${s.products ? `${s.products} produit${s.products > 1 ? 's' : ''}` : 'Vitrine en préparation'}${s.promos ? ` · <b style="color:var(--papaye-text)">${s.promos} en promo</b>` : ''}${s.address ? ' · ' + MG.esc(s.address) : ''}</p></div></${tag}>`;
  };

  // ---------- Fidélité ----------
  MG.voucherLabel = v => (v.kind === 'percent' ? `−${v.value} %` : `−${MG.fcfa(v.value)}`);
  MG.programText = p => `1 bon de ${p.kind === 'percent' ? p.value + ' %' : MG.fcfa(p.value)} toutes les ${p.every} commandes livrées`;
  MG.stamps = (n, every) => `<span class="stamps" role="img" aria-label="${n} tampon${n > 1 ? 's' : ''} sur ${every}">${Array.from({ length: every }, (_, i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('')}</span>`;
  // Ticket de bon d'achat. v = {code, kind, value, min_order, expires_at, shop_name?, slug?, note?, used_at?}
  MG.voucherTicket = (v, opts = {}) => `<div class="ticket${v.used_at ? ' used' : ''}">
      <div class="tv">${MG.voucherLabel(v)}</div>
      <div class="ti"><b>${opts.title || (v.shop_name ? MG.esc(v.shop_name) : 'Bon d\'achat')}</b>
        <span>Code <code>${MG.esc(v.code)}</code>${v.min_order ? ` · dès ${MG.fcfa(v.min_order)} d'achats` : ''}</span>
        <span>${v.used_at ? 'Utilisé' : 'Valable jusqu\'au ' + new Date(v.expires_at).toLocaleDateString('fr-FR')}${v.note ? ' · ' + MG.esc(v.note) : ''}</span></div>
      ${opts.link && v.slug && !v.used_at ? `<a class="btn small" href="/boutique/${encodeURIComponent(v.slug)}">Utiliser</a>` : ''}</div>`;

  // ---------- Comptabilité : période et graphique ----------
  const iso = d => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  MG.periods = () => {
    const t = new Date(), y = t.getFullYear(), m = t.getMonth();
    return [['month', 'Ce mois', iso(new Date(y, m, 1)), iso(t)], ['last', 'Mois dernier', iso(new Date(y, m - 1, 1)), iso(new Date(y, m, 0))],
      ['d30', '30 derniers jours', iso(new Date(t - 29 * 864e5)), iso(t)], ['year', 'Cette année', iso(new Date(y, 0, 1)), iso(t)]];
  };
  MG.fmtDay = d => new Date(d + 'T12:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  const kfmt = v => v >= 1e6 ? (v / 1e6).toLocaleString('fr-FR', { maximumFractionDigits: 1 }) + ' M' : v >= 1e3 ? Math.round(v / 1e3) + ' k' : String(v);
  // Barres verticales (une série) avec infobulle. points = [{label, value, detail}]
  MG.barChart = function (box, points, { title = '' } = {}) {
    const W = 760, H = 240, L = 48, B = 28, T = 12, max = Math.max(1, ...points.map(p => p.value));
    const step = Math.pow(10, Math.floor(Math.log10(max))), nice = Math.ceil(max / step) * step, ticks = [0, nice / 2, nice];
    const n = points.length, bw = Math.max(2, Math.min(28, (W - L) / n - 2)), gap = (W - L) / n;
    const y = v => T + (H - T - B) * (1 - v / nice);
    const every = Math.ceil(n / 8);
    box.innerHTML = `<div class="chart" role="img" aria-label="${MG.esc(title)}"><svg viewBox="0 0 ${W} ${H}" class="chart-svg">
      ${ticks.map(t => `<line x1="${L}" x2="${W}" y1="${y(t)}" y2="${y(t)}" class="grid"/><text x="${L - 8}" y="${y(t) + 4}" class="axis" text-anchor="end">${kfmt(t)}</text>`).join('')}
      ${points.map((p, i) => { const x = L + i * gap + (gap - bw) / 2, h = Math.max(0, y(0) - y(p.value)), r = Math.min(4, bw / 2, h);
        return `<g class="bar" data-i="${i}"><rect x="${L + i * gap}" y="${T}" width="${gap}" height="${H - T - B}" class="hit"/>
          ${h > 0 ? `<path d="M${x},${y(0)} V${y(p.value) + r} Q${x},${y(p.value)} ${x + r},${y(p.value)} H${x + bw - r} Q${x + bw},${y(p.value)} ${x + bw},${y(p.value) + r} V${y(0)} Z" class="mark"/>` : ''}
          ${i % every === 0 ? `<text x="${x + bw / 2}" y="${H - 8}" class="axis" text-anchor="middle">${MG.esc(p.label)}</text>` : ''}</g>`; }).join('')}
      <line x1="${L}" x2="${W}" y1="${y(0)}" y2="${y(0)}" class="base"/></svg><div class="chart-tip" hidden></div></div>`;
    const tip = box.querySelector('.chart-tip'), wrap = box.querySelector('.chart');
    wrap.addEventListener('pointermove', e => {
      const g = e.target.closest('.bar'); if (!g) { tip.hidden = true; return; }
      const p = points[g.dataset.i]; wrap.querySelectorAll('.bar').forEach(b => b.classList.toggle('on', b === g));
      tip.innerHTML = `<b>${MG.esc(p.full || p.label)}</b><br>${MG.fcfa(p.value)}${p.detail ? '<br><span>' + MG.esc(p.detail) + '</span>' : ''}`; tip.hidden = false;
      const r = wrap.getBoundingClientRect(); tip.style.left = Math.min(r.width - 170, Math.max(0, e.clientX - r.left + 12)) + 'px'; tip.style.top = Math.max(0, e.clientY - r.top - 60) + 'px';
    });
    wrap.addEventListener('pointerleave', () => { tip.hidden = true; wrap.querySelectorAll('.bar').forEach(b => b.classList.remove('on')); });
  };

  // Fenêtre modale simple. Renvoie { el, close }. html = contenu du formulaire.
  MG.modal = function (html, { wide } = {}) {
    const d = document.createElement('dialog');
    d.className = 'modal' + (wide ? ' wide' : '');
    d.innerHTML = html;
    document.body.appendChild(d);
    const close = () => { d.close(); d.remove(); };
    d.addEventListener('cancel', e => { e.preventDefault(); close(); });
    d.querySelectorAll('[data-close]').forEach(b => (b.onclick = close));
    d.showModal();
    return { el: d, close };
  };

  // Ajout au panier (+1) depuis n'importe quel bouton [data-add]
  MG.addToCart = async function (btn) {
    if (!MG.user) { location.href = '/compte.html?next=' + encodeURIComponent(location.pathname + location.search); return; }
    if (MG.user.role !== 'customer') return MG.toast('Utilisez un compte client pour acheter', true);
    try {
      const { items } = await MG.api('/api/cart');
      const cur = (items.find(i => i.product_id === btn.dataset.add) || {}).qty || 0, step = Number(btn.dataset.step) || 1, unit = btn.dataset.unit || 'piece';
      const r = await MG.api('/api/cart', { method: 'PUT', body: { productId: btn.dataset.add, qty: MG.r3(cur + step) } });
      await MG.refreshCartBadge();
      if (!r.adjusted) flyToCart(btn);
      if (r.adjusted) return MG.toast(`Il n'en reste que ${MG.qty(r.stock, unit)} : vous avez déjà tout le stock dans votre panier.`, true);
      const old = btn.innerHTML; btn.classList.add('done'); btn.innerHTML = MG.icon('check', btn.classList.contains('sm') ? 16 : 20);
      setTimeout(() => { btn.classList.remove('done'); btn.innerHTML = old; }, 1500);
      MG.toast(r.stock - r.qty <= 0 ? 'Ajouté : c\'était le dernier en stock !' : r.stock <= MG.LOW_STOCK ? `Ajouté au panier · plus que ${MG.qty(MG.r3(r.stock - r.qty), unit)} après vous` : unit !== 'piece' ? `Ajouté : ${MG.qty(r.qty, unit)} au panier` : 'Ajouté au panier');
    } catch (er) {
      if (er.status === 409) { MG.toast(er.message, true); const card = btn.closest('.product'); if (card) setTimeout(() => location.reload(), 1600); return; }
      MG.fail(er);
    }
  };
  MG.toggleAlert = async function (btn) {
    if (!MG.user) { location.href = '/compte.html?next=' + encodeURIComponent(location.pathname + location.search); return; }
    if (MG.user.role !== 'customer') return MG.toast('Les alertes sont réservées aux comptes clients', true);
    const on = btn.dataset.on === '1';
    try {
      await MG.api('/api/products/' + btn.dataset.alert + '/alert', { method: on ? 'DELETE' : 'POST', body: {} });
      btn.dataset.on = on ? '0' : '1'; btn.classList.toggle('green', !on); btn.classList.toggle('alt', on);
      btn.innerHTML = MG.icon(on ? 'bell' : 'check', 16) + (on ? 'Me prévenir' : 'Alerte activée');
      MG.toast(on ? 'Alerte retirée' : 'C\'est noté : vous serez prévenu dès son retour en stock');
    } catch (er) { MG.fail(er); }
  };
  document.addEventListener('keydown', e => { const g = e.target.closest && e.target.closest('[data-gal]'); if (g && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); g.click(); } });
  document.addEventListener('click', e => {
    const gal = e.target.closest('[data-gal]');
    if (gal && MG._prod && MG._prod[gal.dataset.gal]) { e.preventDefault(); MG.productSheet(MG._prod[gal.dataset.gal]); return; }
    const al = e.target.closest('[data-alert]');
    if (al) { e.preventDefault(); MG.toggleAlert(al); return; }
    const b = e.target.closest('[data-add]');
    if (b && !b.closest('[data-own-add]')) { e.preventDefault(); MG.addToCart(b); }
  });

  // ---------- Sonneries (générées par le navigateur, aucun fichier à télécharger) ----------
  let actx = null;
  const ac = () => { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); return actx; };
  // Les navigateurs n'autorisent le son qu'après un premier geste : on prépare le moteur au premier clic
  addEventListener('pointerdown', () => { try { ac(); } catch { /* pas de son */ } }, { once: true, capture: true });
  function tone(c, out, { f = 440, f2, type = 'sine', at = 0, dur = .3, vol = .5, attack = .005 }) {
    const o = c.createOscillator(), g = c.createGain(), t = c.currentTime + at;
    o.type = type; o.frequency.setValueAtTime(f, t); if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(out); o.start(t); o.stop(t + dur + .05);
  }
  function noise(c, out, { at = 0, dur = .12, vol = .3, freq = 900 }) {
    const n = c.createBuffer(1, c.sampleRate * dur, c.sampleRate), d = n.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const src = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain(), t = c.currentTime + at;
    f.type = 'bandpass'; f.frequency.value = freq; g.gain.value = vol; src.buffer = n;
    src.connect(f); f.connect(g); g.connect(out); src.start(t);
  }
  const SOUNDS = {
    balafon: { label: 'Balafon', play: (c, o) => [523, 659, 784, 1047].forEach((f, i) => { tone(c, o, { f, at: i * .11, dur: .35, vol: .55 }); tone(c, o, { f: f * 4, at: i * .11, dur: .08, vol: .12 }); }) },
    clochette: { label: 'Clochette', play: (c, o) => { tone(c, o, { f: 1319, dur: .9, vol: .4 }); tone(c, o, { f: 1760, at: .16, dur: 1.1, vol: .32 }); tone(c, o, { f: 3520, at: .16, dur: .3, vol: .06 }); } },
    carillon: { label: 'Carillon', play: (c, o) => [784, 988, 1175, 1568].forEach((f, i) => tone(c, o, { f, type: 'triangle', at: i * .17, dur: 1.4, vol: .4 })) },
    tamtam: { label: 'Tam-tam', play: (c, o) => [0, .18, .36, .62].forEach((at, i) => { tone(c, o, { f: i === 3 ? 110 : 160, f2: 60, at, dur: .32, vol: .9 }); noise(c, o, { at, dur: .05, vol: .25, freq: 600 }); }) },
    klaxon: { label: 'Klaxon de moto', play: (c, o) => [0, .3].forEach(at => { tone(c, o, { f: 440, type: 'square', at, dur: .22, vol: .32, attack: .01 }); tone(c, o, { f: 554, type: 'square', at, dur: .22, vol: .26, attack: .01 }); }) },
    sifflet: { label: 'Sifflet', play: (c, o) => { tone(c, o, { f: 1800, f2: 2600, dur: .18, vol: .5 }); tone(c, o, { f: 2600, f2: 1900, at: .2, dur: .28, vol: .5 }); } },
    bip: { label: 'Bip discret', play: (c, o) => { tone(c, o, { f: 880, dur: .16, vol: .55 }); tone(c, o, { f: 1320, at: .02, dur: .1, vol: .12 }); } },
    aucun: { label: 'Silencieux', play: () => {} }
  };
  const EVENTS = {
    order: ['Nouvelle commande', 'balafon'], payment: ['Paiement', 'carillon'], courier: ['Livreur et courses', 'klaxon'],
    delivered: ['Commande livrée', 'tamtam'], message: ['Nouveau message', 'clochette'], loyalty: ['Bonnes nouvelles (bons d\'achat, retour en stock)', 'sifflet'],
    stock: ['Alerte de stock', 'bip'], info: ['Autres notifications', 'bip']
  };
  const ROLE_EVENTS = { customer: ['payment', 'courier', 'delivered', 'message', 'loyalty', 'info'], seller: ['order', 'courier', 'message', 'stock', 'info'],
    courier: ['courier', 'message', 'info'], admin: ['payment', 'order', 'stock', 'info'] };
  MG.soundPrefs = () => {
    let p = {}; try { p = JSON.parse(localStorage.getItem('mg-sounds') || '{}'); } catch { /* défaut */ }
    const map = {}; for (const k in EVENTS) map[k] = (p.map && SOUNDS[p.map[k]]) ? p.map[k] : EVENTS[k][1];
    return { enabled: p.enabled !== false, volume: typeof p.volume === 'number' ? p.volume : .8, system: !!p.system, map };
  };
  const savePrefs = p => { try { localStorage.setItem('mg-sounds', JSON.stringify(p)); } catch { /* non mémorisé */ } };
  MG.playSound = (name, force) => {
    const p = MG.soundPrefs(); if (!force && !p.enabled) return;
    const snd = SOUNDS[name]; if (!snd) return;
    try { const c = ac(), g = c.createGain(); g.gain.value = p.volume; g.connect(c.destination); snd.play(c, g); } catch { /* son impossible */ }
  };
  let lastSound = { kind: '', at: 0 };
  MG.notifySound = kind => {
    const k = EVENTS[kind] ? kind : 'info';
    if (lastSound.kind === k && Date.now() - lastSound.at < 20000) return; // pas deux fois le même son en 20 s
    lastSound = { kind: k, at: Date.now() };
    MG.playSound(MG.soundPrefs().map[k]);
  };
  // Panneau de réglage des sons (profil). box = conteneur.
  MG.soundSettings = function (box) {
    const p = MG.soundPrefs(), kinds = ROLE_EVENTS[(MG.user || {}).role] || ROLE_EVENTS.customer;
    const opts = sel => Object.entries(SOUNDS).map(([k, v]) => `<option value="${k}"${k === sel ? ' selected' : ''}>${v.label}</option>`).join('');
    box.innerHTML = `<div class="card sound-card"><div class="split"><div><h2 style="margin:0">Sons des notifications</h2><p class="muted" style="margin:0">Choisissez une sonnerie pour chaque événement. Réglage gardé sur cet appareil.</p></div>
        <label class="switch"><input type="checkbox" id="sndOn"${p.enabled ? ' checked' : ''}><span></span> Sons activés</label></div>
      <div class="sound-rows" id="sndRows">${kinds.map(k => `<div class="sound-row"><span class="ev">${MG.esc(EVENTS[k][0])}</span>
        <select data-ev="${k}" aria-label="Sonnerie : ${MG.esc(EVENTS[k][0])}">${opts(p.map[k])}</select>
        <button class="btn small alt" type="button" data-try="${k}" aria-label="Écouter">${MG.icon('bell', 16)}Écouter</button></div>`).join('')}</div>
      <div class="sound-foot"><label class="vol">Volume <input type="range" id="sndVol" min="0" max="1" step="0.05" value="${p.volume}"></label>
        ${'Notification' in window ? `<label class="switch"><input type="checkbox" id="sndSys"${p.system && Notification.permission === 'granted' ? ' checked' : ''}><span></span> Aussi dans les notifications du téléphone</label>` : ''}</div></div>`;
    const read = () => { const q = MG.soundPrefs(); q.enabled = box.querySelector('#sndOn').checked; q.volume = Number(box.querySelector('#sndVol').value);
      box.querySelectorAll('[data-ev]').forEach(sel => (q.map[sel.dataset.ev] = sel.value)); const sys = box.querySelector('#sndSys'); q.system = !!(sys && sys.checked); savePrefs(q); return q; };
    box.onchange = async e => {
      if (e.target.id === 'sndSys' && e.target.checked && Notification.permission !== 'granted') {
        const r = await Notification.requestPermission(); if (r !== 'granted') { e.target.checked = false; MG.toast('Autorisation refusée par le navigateur', true); }
      }
      const q = read();
      if (e.target.dataset.ev) MG.playSound(e.target.value, true);
      if (e.target.id === 'sndOn') MG.toast(q.enabled ? 'Sons activés' : 'Sons coupés');
    };
    box.querySelector('#sndVol').oninput = () => read();
    box.onclick = e => { const b = e.target.closest('[data-try]'); if (b) MG.playSound(box.querySelector(`[data-ev="${b.dataset.try}"]`).value, true); };
  };

  const ROLE_HOME = { seller: ['/vendeur.html', 'Ma boutique'], courier: ['/livreur.html', 'Mes livraisons'], admin: ['/admin.html', 'Administration'] };

  async function renderHeader() {
    const h = document.getElementById('top');
    if (!h) return;
    const u = MG.user, role = u && ROLE_HOME[u.role];
    if (!document.title.includes(MG.config.site_name)) document.title = (document.title ? document.title + ' · ' : '') + MG.config.site_name;
    h.innerHTML = `<div class="bar"><a class="brand" href="/">${MG.esc(MG.config.site_name)}</a>
      <nav id="nav">
        <a href="/">Boutiques</a>
        ${u ? '<a href="/commandes.html">' + (u.role === 'customer' ? 'Mes commandes' : 'Mes achats') + '</a>' : ''}
        ${role ? `<a href="${role[0]}">${role[1]}</a>` : ''}
        ${u ? '<button id="bell" class="bell" aria-label="Notifications">' + MG.icon('bell') + '<span class="badge" id="bellBadge" hidden>0</span></button>' : ''}
        ${u ? `<a href="/compte.html" class="me">${MG.avatar(u, 28)}${MG.esc(u.name.split(' ')[0])}</a>` : '<a href="/compte.html">Connexion</a>'}
        <button id="themeBtn" class="theme-btn" type="button" aria-label="Passer en mode nuit" title="Mode jour / nuit">
          <svg class="ico sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
          <svg class="ico moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg></button>
      </nav><button id="burger" aria-label="Menu">${MG.icon('menu', 24)}</button></div><div id="notifBox" hidden></div>`;
    MG.$('#burger').onclick = () => MG.$('#nav').classList.toggle('open');
    const isDark = () => document.documentElement.dataset.theme ? document.documentElement.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    const label = () => { const b = MG.$('#themeBtn'); b.setAttribute('aria-label', isDark() ? 'Passer en mode jour' : 'Passer en mode nuit'); document.querySelector('meta[name=theme-color]')?.setAttribute('content', isDark() ? '#110e0c' : '#1f1a17'); };
    MG.$('#themeBtn').onclick = () => {
      const next = isDark() ? 'light' : 'dark', root = document.documentElement;
      root.classList.add('theme-anim'); root.dataset.theme = next; setTimeout(() => root.classList.remove('theme-anim'), 400);
      try { localStorage.setItem('mg-theme', next); } catch { /* navigation privée : choix non mémorisé */ }
      label(); MG.toast(next === 'dark' ? 'Mode nuit activé' : 'Mode jour activé');
    };
    label();
    if (u) {
      MG.$('#bell').onclick = toggleNotifs;
      // Notifications : toutes les 15 s, puis de plus en plus espacé (jusqu'à 60 s) tant que rien de nouveau n'arrive.
      // Rien du tout quand l'onglet est caché ; vérification immédiate quand on revient sur la page.
      let delay = 15000, nt = null;
      const next = () => { clearTimeout(nt); if (!document.hidden) nt = setTimeout(async () => { delay = (await pollNotifs()) ? 15000 : Math.min(delay * 2, 60000); next(); }, delay); };
      document.addEventListener('visibilitychange', () => { if (document.hidden) clearTimeout(nt); else { delay = 15000; pollNotifs().then(next); } });
      pollNotifs().then(next);
    }
    if (!u || u.role === 'customer') refreshCartBadge();
  }

  // ---------- Panier flottant, toujours visible ----------
  const onCartPage = () => /^\/panier(\.html)?\/?$/.test(location.pathname);
  function cartWidget() {
    if (!MG.user || MG.user.role !== 'customer' || document.getElementById('cartFab')) return;
    const b = document.createElement('button');
    b.id = 'cartFab'; b.type = 'button'; b.hidden = true;
    b.innerHTML = `<span class="cf-ico">${MG.icon('cart', 22)}<span class="cf-n" id="cartCount">0</span></span><span class="cf-txt"><b id="cartTotal">0 FCFA</b><small>Voir mon panier</small></span>`;
    b.onclick = () => MG.openCart();
    document.body.appendChild(b);
  }
  MG.refreshCartBadge = refreshCartBadge;
  async function refreshCartBadge() {
    if (!MG.user || MG.user.role !== 'customer') return null;
    cartWidget();
    try {
      const d = await MG.api('/api/cart');
      MG.cart = d;
      const n = MG.cartCount(d.items), tot = d.items.reduce((t, i) => t + MG.lineTotal(i.price, i.qty), 0);
      const fab = document.getElementById('cartFab');
      if (fab) {
        fab.hidden = !n || onCartPage();
        fab.querySelector('#cartCount').textContent = n;
        fab.querySelector('#cartTotal').textContent = MG.fcfa(tot);
        fab.setAttribute('aria-label', `Panier : ${n} article${n > 1 ? 's' : ''}, ${MG.fcfa(tot)}`);
      }
      const drawer = document.getElementById('cartDrawer'); if (drawer && drawer.classList.contains('open')) drawCart();
      return d;
    } catch { return null; }
  }
  // Volet latéral du panier : modifier les quantités sans quitter la page
  MG.openCart = function () {
    let d = document.getElementById('cartDrawer');
    if (!d) {
      d = document.createElement('div'); d.id = 'cartDrawer';
      d.innerHTML = `<div class="cd-back" data-cd-close></div><aside class="cd-panel" role="dialog" aria-modal="true" aria-label="Mon panier">
        <header class="cd-head"><h2>Mon panier</h2><button type="button" class="cd-x" data-cd-close aria-label="Fermer">${MG.icon('x', 20)}</button></header>
        <div class="cd-body" id="cdBody"></div><footer class="cd-foot" id="cdFoot"></footer></aside>`;
      document.body.appendChild(d);
      d.addEventListener('click', async e => {
        if (e.target.closest('[data-cd-close]')) return MG.closeCart();
        const b = e.target.closest('[data-cq]'); if (!b) return;
        const it = MG.cart.items.find(i => i.product_id === b.dataset.cq);
        const qty = b.dataset.d === 'x' ? 0 : MG.r3(it.qty + Number(b.dataset.d) * (it.qty_step || 1));
        b.disabled = true;
        try { const r = await MG.api('/api/cart', { method: 'PUT', body: { productId: it.product_id, qty: Math.max(0, qty) } }); if (r.adjusted) MG.toast(`Il n'en reste que ${MG.qty(r.stock, it.unit)}`, true); }
        catch (er) { MG.fail(er); }
        await refreshCartBadge();
      });
      document.addEventListener('keydown', e => { if (e.key === 'Escape' && d.classList.contains('open')) MG.closeCart(); });
    }
    drawCart();
    requestAnimationFrame(() => d.classList.add('open'));
    document.body.classList.add('cd-lock');
    setTimeout(() => { const x = d.querySelector('.cd-x'); if (x) x.focus(); }, 250);
    refreshCartBadge();
  };
  MG.closeCart = () => { const d = document.getElementById('cartDrawer'); if (d) d.classList.remove('open'); document.body.classList.remove('cd-lock'); const f = document.getElementById('cartFab'); if (f) f.focus(); };
  function drawCart() {
    const items = (MG.cart && MG.cart.items) || [], body = document.getElementById('cdBody'), foot = document.getElementById('cdFoot');
    if (!body) return;
    if (!items.length) {
      body.innerHTML = `<div class="empty-state"><img src="/img/produits/panier-tresse.svg" alt=""><h3>Votre panier est vide</h3><p class="muted">Ajoutez des produits avec le bouton +.</p></div>`;
      foot.innerHTML = `<button type="button" class="btn alt" style="width:100%" data-cd-close>Continuer mes achats</button>`; return;
    }
    const shops = {};
    for (const i of items) (shops[i.shop_id] = shops[i.shop_id] || { name: i.shop_name, lines: [] }).lines.push(i);
    const tot = items.reduce((t, i) => t + MG.lineTotal(i.price, i.qty), 0), n = MG.cartCount(items);
    body.innerHTML = Object.values(shops).map(sh => `<div class="cd-shop"><h3>${MG.esc(sh.name)}</h3>${sh.lines.map(i => {
      const gone = !i.active || i.shop_status !== 'active' || i.stock <= 0, over = !gone && i.qty > i.stock;
      return `<div class="cd-line"><img src="${MG.img(i.photo_id)}" alt=""><div class="cd-info"><b>${MG.esc(i.name)}</b>
        <span class="muted">${i.base_price > i.price ? `<s>${MG.fcfa(i.base_price)}</s> ` : ''}${MG.fcfa(i.price)}${MG.per(i.unit)}</span>
        ${gone ? '<span class="stock-info out">Épuisé : à retirer</span>' : over ? `<span class="stock-info out">Il n'en reste que ${MG.qty(i.stock, i.unit)}</span>` : i.stock <= MG.LOW_STOCK ? `<span class="stock-info low">Plus que ${MG.qty(i.stock, i.unit)}</span>` : ''}
        <div class="cd-row"><div class="qty"><button data-cq="${i.product_id}" data-d="-1" aria-label="Retirer un">−</button><b>${MG.qty(i.qty, i.unit)}</b><button data-cq="${i.product_id}" data-d="1" aria-label="Ajouter un"${gone || MG.r3(i.qty + (i.qty_step || 1)) > i.stock ? ' disabled' : ''}>+</button></div>
        <span class="price" style="font-size:1rem">${MG.fcfa(MG.lineTotal(i.price, i.qty))}</span><button class="cd-rm" data-cq="${i.product_id}" data-d="x" aria-label="Retirer ${MG.esc(i.name)}">${MG.icon('trash', 16)}</button></div></div></div>`;
    }).join('')}</div>`).join('');
    foot.innerHTML = `<div class="total"><span>${n} article${n > 1 ? 's' : ''}</span><b>${MG.fcfa(tot)}</b></div><p class="muted" style="margin:0 0 var(--space-3);font-size:.85rem">Livraison et bons d'achat calculés à l'étape suivante.</p>
      <a class="btn big" style="width:100%" href="/panier.html">Commander</a><button type="button" class="btn alt" style="width:100%;margin-top:var(--space-2)" data-cd-close>Continuer mes achats</button>`;
  }
  // La photo du produit « vole » jusqu'au panier
  function flyToCart(btn) {
    const fab = document.getElementById('cartFab'); if (!fab || fab.hidden) return;
    const src = (btn.closest('.product') && btn.closest('.product').querySelector('.pimg img')) || (btn.closest('.sheet') && btn.closest('.sheet').querySelector('#galImg'))
      || (btn.closest('.suggest .it') && btn.closest('.suggest .it').querySelector('img'));
    const bump = () => { fab.classList.remove('bump'); void fab.offsetWidth; fab.classList.add('bump'); };
    if (!src || matchMedia('(prefers-reduced-motion: reduce)').matches) return bump();
    const a = src.getBoundingClientRect(), b = fab.querySelector('.cf-ico').getBoundingClientRect();
    const g = src.cloneNode(); g.className = 'fly'; g.removeAttribute('loading');
    Object.assign(g.style, { left: a.left + 'px', top: a.top + 'px', width: a.width + 'px', height: a.height + 'px' });
    document.body.appendChild(g);
    const dx = b.left + b.width / 2 - (a.left + a.width / 2), dy = b.top + b.height / 2 - (a.top + a.height / 2);
    g.animate([{ transform: 'translate(0,0) scale(1)', opacity: 1, borderRadius: '16px' },
      { transform: `translate(${dx * .5}px,${dy * .5 - 80}px) scale(.55)`, opacity: 1, offset: .55 },
      { transform: `translate(${dx}px,${dy}px) scale(.08)`, opacity: .3, borderRadius: '50%' }], { duration: 750, easing: 'cubic-bezier(.5,0,.6,1)' })
      .onfinish = () => { g.remove(); bump(); };
  }

  // Renvoie true s'il y a du nouveau (le rythme de vérification se resserre alors)
  async function pollNotifs() {
    try {
      const d = await MG.api('/api/notifications');
      const changed = d.unread !== MG._lastUnread;
      MG.notifs = d.items;
      const b = MG.$('#bellBadge');
      if (b) { b.textContent = d.unread; b.hidden = !d.unread; }
      const seen = MG._seenNotifs;
      MG._seenNotifs = new Set(d.items.map(n => n.id));
      if (seen) {
        const fresh = d.items.filter(n => !n.read && !seen.has(n.id));
        if (fresh.length) {
          const n = fresh[0];
          MG.toast('Nouvelle notification : ' + n.title);
          MG.notifySound(n.kind);
          const p = MG.soundPrefs();
          if (p.system && 'Notification' in window && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
            try { const sn = new Notification(n.title, { body: n.body || '', tag: n.id, icon: '/img/produits/panier-tresse.svg' }); sn.onclick = () => { focus(); if (n.url) location.href = n.url; }; } catch { /* non pris en charge */ }
          }
        }
      }
      MG._lastUnread = d.unread;
      return changed;
    } catch { return false; /* hors ligne */ }
  }
  // Exécute fn seulement si l'onglet est visible (pour les rafraîchissements automatiques des pages)
  MG.ifVisible = fn => () => (document.hidden ? undefined : fn());

  function toggleNotifs() {
    const box = MG.$('#notifBox');
    if (!box.hidden) { box.hidden = true; return; }
    const items = MG.notifs || [];
    box.innerHTML = '<div class="notif-head"><strong>Notifications</strong><span class="row" style="gap:.8rem"><a class="link" href="/compte.html#sons">Sons</a><button class="link" id="markRead">Tout marquer comme lu</button></span></div>' +
      (items.length ? items.map(n => `<a class="notif${n.read ? '' : ' unread'}" href="${MG.esc(n.url || '#')}"><b>${MG.esc(n.title)}</b><span>${MG.esc(n.body || '')}</span><small>${MG.date(n.created_at)}</small></a>`).join('')
        : '<p class="muted pad">Aucune notification.</p>');
    box.hidden = false;
    MG.$('#markRead').onclick = async () => { await MG.api('/api/notifications/read', { method: 'POST', body: {} }); box.hidden = true; pollNotifs(); };
  }

  // ---------- Assistant « Mbolo » ----------
  const hhmm = () => new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  function botWidget() {
    const w = document.createElement('div');
    w.id = 'bot';
    w.innerHTML = `<section id="botBox" hidden aria-label="Assistant">
        <header class="bot-head"><span class="avatar online">M</span><div class="t"><strong>Mbolo, l'assistant</strong><span>Répond en quelques secondes</span></div>
          <button id="botClose" aria-label="Fermer">${MG.icon('x', 18)}</button></header>
        <div id="botLog" class="log" aria-live="polite"><span class="day">Aujourd'hui</span></div>
        <div class="quick" id="botQuick"></div>
        <form id="botForm" class="composer"><input id="botIn" placeholder="Écrivez votre message…" maxlength="300" autocomplete="off" aria-label="Message">
          <button class="btn icon" aria-label="Envoyer">${MG.icon('send', 18)}</button></form></section>
      <button id="botBtn" aria-label="Ouvrir l'assistant"><span class="avatar online">M</span><span class="lbl">Besoin d'aide ?</span></button>`;
    document.body.appendChild(w);
    const log = MG.$('#botLog'), quick = MG.$('#botQuick');
    const scroll = () => (log.scrollTop = log.scrollHeight);
    const add = (cls, html) => { const d = document.createElement('div'); d.className = cls; d.innerHTML = html; log.appendChild(d); scroll(); return d; };
    const bubble = (who, html) => add('msg ' + who, html + `<time>${hhmm()}</time>`);
    const setQuick = list => { quick.innerHTML = (list || []).map(q => `<button type="button">${MG.esc(q)}</button>`).join(''); };
    const products = list => {
      if (!list || !list.length) return;
      add('suggest', list.map(p => `<div class="it"><a href="/boutique/${encodeURIComponent(p.slug)}" style="display:contents;color:inherit"><span style="position:relative;display:block"><img src="${MG.img(p.photo_id, p.category)}" alt="">${p.promo_pct ? `<span class="tag promo" style="position:absolute;top:6px;left:6px">−${p.promo_pct} %</span>` : ''}</span>
        <strong>${MG.esc(p.name)}</strong><small>${MG.esc(p.shop)}</small></a>
        <div class="f"><span>${p.old_price ? `<span class="old">${MG.fcfa(p.old_price)}</span>` : ''}<span class="price">${MG.fcfa(p.price)}</span>${MG.per(p.unit)}</span>${p.stock > 0 ? `<button class="add sm" data-add="${MG.esc(p.id)}" data-step="${p.qty_step || 1}" data-unit="${p.unit || 'piece'}" aria-label="Ajouter ${MG.esc(p.name)}">${MG.icon('plus', 16)}</button>` : '<span class="tag out">Épuisé</span>'}</div></div>`).join(''));
    };
    async function ask(text) {
      bubble('me', MG.esc(text)); setQuick([]);
      const typing = add('typing', '<i></i><i></i><i></i>');
      try {
        const [r] = await Promise.all([MG.api('/api/bot', { method: 'POST', body: { message: text } }), new Promise(ok => setTimeout(ok, 450))]);
        typing.remove();
        bubble('them', MG.esc(r.reply).replace(/\n/g, '<br>') + (r.links || []).map(l => `<br><a href="${MG.esc(l[1])}">${MG.esc(l[0])} →</a>`).join(''));
        products(r.products); setQuick(r.quick);
      } catch (er) { typing.remove(); bubble('them', MG.esc(er.message)); }
    }
    let opened = false;
    MG.$('#botBtn').onclick = () => {
      MG.$('#botBox').hidden = false; MG.$('#botBtn').hidden = true;
      if (!opened) {
        opened = true;
        const name = MG.user ? ' ' + MG.esc(MG.user.name.split(' ')[0]) : '';
        bubble('them', `Mbolo${name} ! Je peux vous aider pour une commande, la livraison, le paiement, ou trouver un produit. Écrivez par exemple « pagne » ou « bananes ».`);
        setQuick(['Les promotions', 'Où est ma commande ?', 'Frais de livraison', 'Trouver un produit']);
      }
      MG.$('#botIn').focus();
    };
    MG.$('#botClose').onclick = () => { MG.$('#botBox').hidden = true; MG.$('#botBtn').hidden = false; };
    quick.onclick = e => { const b = e.target.closest('button'); if (b) ask(b.textContent); };
    MG.$('#botForm').onsubmit = e => {
      e.preventDefault();
      const inp = MG.$('#botIn'), text = inp.value.trim();
      if (!text) return;
      inp.value = ''; ask(text);
    };
  }

  // ---------- Discussion d'une commande (client, boutique, livreur) ----------
  const ROLE_NAME = { customer: 'Client', seller: 'Boutique', courier: 'Livreur', admin: 'Admin' };
  MG.chat = function (box, ref) {
    box.innerHTML = `<div class="log chatlog"></div><form class="composer" style="border:0;padding:0"><input maxlength="500" placeholder="Votre message…" required aria-label="Message"><button class="btn icon" aria-label="Envoyer">${MG.icon('send', 18)}</button></form>`;
    const log = box.querySelector('.log'), form = box.querySelector('form'), input = form.querySelector('input');
    let last = '', me = null, stopped = false;
    async function load() {
      if (stopped || !document.body.contains(box)) { stopped = true; return; }
      if (document.hidden) { setTimeout(load, 5000); return; } // onglet caché : pas de requête
      try {
        const d = await MG.api('/api/orders/' + ref + '/messages?after=' + encodeURIComponent(last));
        me = d.me;
        const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
        for (const m of d.items) {
          const div = document.createElement('div');
          const mine = m.sender_id === me;
          div.className = 'msg ' + (mine ? 'me' : 'them');
          div.innerHTML = `<small><b>${mine ? 'Vous' : MG.esc(m.sender_name)}</b><span class="role ${MG.esc(m.sender_role)}">${ROLE_NAME[m.sender_role] || ''}</span></small>${MG.esc(m.body)}<time>${MG.date(m.created_at)}</time>`;
          if (!mine && log.dataset.init) MG.notifySound('message');
          if (!mine) { const row = document.createElement('div'); row.className = 'msg-row'; row.innerHTML = MG.avatar({ name: m.sender_name, avatar_id: m.avatar_id }, 32); row.appendChild(div); log.appendChild(row); }
          else log.appendChild(div);
          last = m.created_at;
        }
        if (d.items.length && (atBottom || !log.dataset.init)) log.scrollTop = log.scrollHeight;
        log.dataset.init = '1';
      } catch { /* ignoré */ }
      setTimeout(load, 5000);
    }
    form.onsubmit = async e => {
      e.preventDefault();
      const body = input.value.trim(); if (!body) return;
      try { await MG.api('/api/orders/' + ref + '/messages', { method: 'POST', body: { body } }); input.value = ''; } catch (er) { MG.fail(er); }
    };
    load();
  };

  MG.ready = (async function () {
    try {
      const [config, me] = await Promise.all([MG.api('/api/config'), MG.api('/api/me')]);
      MG.config = config; MG.user = me.user;
    } catch (e) {
      document.body.innerHTML = '<p style="padding:2rem">Le site est momentanément indisponible. Réessayez dans un instant.</p>';
      throw e;
    }
    await renderHeader();
    botWidget();
  })();


  // ----- Écran de bienvenue : barre de chargement jusqu'à ce que le site soit prêt -----
  MG.splash = function (msg) {
    let el = document.getElementById('mg-splash');
    if (!el) {
      el = document.createElement('div'); el.id = 'mg-splash'; el.setAttribute('role', 'status');
      el.innerHTML = '<div class="lg"><i></i><i></i></div><b>Bienvenue sur Marché Gabon</b><small></small><div class="bar"><span></span></div>';
      (document.body || document.documentElement).appendChild(el);
    }
    el.className = ''; el.querySelector('small').textContent = msg || 'Chargement…';
    const bar = el.querySelector('.bar span'); bar.style.animation = 'none'; void bar.offsetWidth; bar.style.animation = '';
    return el;
  };
  MG.splashHide = function () {
    const el = document.getElementById('mg-splash'); if (!el) return;
    el.classList.add('done'); setTimeout(() => el.classList.add('out'), 250); setTimeout(() => el.remove(), 800);
  };

  // Affiché dès le début du chargement, retiré quand le site est prêt (0,9 s mini, 1,6 s à la première visite)
  (function () {
    let first = true; try { first = !sessionStorage.getItem('mg-welcomed'); sessionStorage.setItem('mg-welcomed', '1'); } catch (e) {}
    const t0 = Date.now(), min = first ? 1600 : 900;
    MG.splash(first ? 'Bienvenue, nous préparons le marché…' : 'Chargement…');
    const done = () => setTimeout(MG.splashHide, Math.max(0, min - (Date.now() - t0)));
    MG.ready.then(done, done);
    setTimeout(MG.splashHide, 8000); // filet de sécurité
  })();

  // ----- Pied de page (lien Confidentialité) et bandeau d'information, une fois par appareil -----
  MG.ready.then(() => {
    if (!document.querySelector('.site-foot')) {
      const f = document.createElement('footer'); f.className = 'site-foot noprint';
      f.innerHTML = `<a href="/confidentialite.html">Confidentialité et cookies</a><span>© ${new Date().getFullYear()} ${MG.esc(MG.config.site_name)}</span>`;
      document.body.appendChild(f);
    }
    try { if (localStorage.getItem('mg-info-ok') === '1' || /confidentialite/.test(location.pathname)) return; } catch (e) { /* stockage indisponible : on affiche */ }
    const b = document.createElement('div'); b.className = 'info-bar noprint'; b.setAttribute('role', 'region'); b.setAttribute('aria-label', 'Information sur vos données');
    b.innerHTML = '<p>Nous utilisons un cookie pour vous garder connecté, et des services extérieurs (cartes OpenStreetMap, polices Google). Aucune publicité, aucun suivi. <a href="/confidentialite.html">En savoir plus</a></p><button type="button" class="btn small">OK</button>';
    b.querySelector('button').onclick = () => { try { localStorage.setItem('mg-info-ok', '1'); } catch (e) { /* non mémorisé */ } b.remove(); };
    document.body.appendChild(b);
  }).catch(() => {});
  // Pour les pages réservées à un rôle
  MG.require = async function (roles) {
    await MG.ready;
    if (!MG.user) { location.href = '/compte.html?next=' + encodeURIComponent(location.pathname + location.search); return false; }
    if (roles && !roles.includes(MG.user.role)) {
      document.querySelector('main').innerHTML = '<div class="card"><p>Cette page est réservée à un autre type de compte.</p><p><a class="btn" href="/">Retour aux boutiques</a></p></div>';
      return false;
    }
    return true;
  };
})();
