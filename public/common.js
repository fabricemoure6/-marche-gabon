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
    const k = Math.min(1, 900 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    let blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.8));
    if (blob.size > 690 * 1024) blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.55));
    const out = await MG.api('/api/photos', { method: 'POST', body: await blob.arrayBuffer() });
    return out.id;
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
    chat: '<path d="M4 5h16v11H8l-4 4z"/>', trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>'
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
  MG.productCard = function (p, opts = {}) {
    const out = !(p.stock > 0);
    const shop = p.shop_name ? (opts.demo ? `<span class="pshop">${MG.esc(p.shop_name)}</span>` : `<a class="pshop" href="/boutique.html?s=${encodeURIComponent(p.slug)}">${MG.esc(p.shop_name)}</a>`) : '';
    const badge = out ? '<span class="tag out">Épuisé</span>'
      : p.promo_pct ? `<span class="tag promo">−${p.promo_pct} %</span>` : (p.badge ? `<span class="tag new">${MG.esc(p.badge)}</span>` : '');
    const left = p.promo_until ? MG.timeLeft(p.promo_until) : '';
    const img = opts.img || MG.img(p.photo_id, p.category || opts.category);
    return `<article class="tile product${out ? ' out' : ''}${p.promo_pct ? ' is-promo' : ''}">
      <div class="pimg"><img src="${img}" alt="${MG.esc(p.name)}" loading="lazy"><div class="pbadges">${badge}</div>${left && !out ? `<span class="ptimer">${left}</span>` : ''}</div>
      <div class="pbody">${shop}<h3 class="pname">${MG.esc(p.name)}</h3>${opts.desc && p.description ? `<p class="pdesc">${MG.esc(p.description)}</p>` : ''}
        <div class="pfoot"><div>${p.old_price ? `<span class="old">${MG.fcfa(p.old_price)}</span>` : ''}<span class="price">${MG.fcfa(p.price)}</span></div>
        ${opts.demo || out ? '' : `<button class="add" data-add="${MG.esc(p.id)}" aria-label="Ajouter ${MG.esc(p.name)} au panier">${MG.icon('plus')}</button>`}</div></div></article>`;
  };

  // Tuile boutique. s = {name, slug, category, address, photo_id, cover_id?, products, promos?, best_pct?}
  MG.shopCard = function (s, opts = {}) {
    const cover = opts.cover || (s.cover_id ? MG.photo(s.cover_id) : MG.img(s.photo_id, s.category));
    const logo = s.photo_id ? `style="background-image:url('${MG.photo(s.photo_id)}')"` : '';
    const tag = opts.demo ? 'div' : 'a';
    return `<${tag} class="tile shop${s.promos ? ' has-promo' : ''}"${opts.demo ? '' : ` href="/boutique.html?s=${encodeURIComponent(s.slug)}"`}>
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
      ${opts.link && v.slug && !v.used_at ? `<a class="btn small" href="/boutique.html?s=${encodeURIComponent(v.slug)}">Utiliser</a>` : ''}</div>`;

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
      const cur = (items.find(i => i.product_id === btn.dataset.add) || {}).qty || 0;
      await MG.api('/api/cart', { method: 'PUT', body: { productId: btn.dataset.add, qty: cur + 1 } });
      const old = btn.innerHTML; btn.classList.add('done'); btn.innerHTML = MG.icon('check', btn.classList.contains('sm') ? 16 : 20);
      setTimeout(() => { btn.classList.remove('done'); btn.innerHTML = old; }, 1500);
      MG.toast('Ajouté au panier'); MG.refreshCartBadge();
    } catch (er) { MG.fail(er); }
  };
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-add]');
    if (b && !b.closest('[data-own-add]')) { e.preventDefault(); MG.addToCart(b); }
  });

  const ROLE_HOME = { seller: ['/vendeur.html', 'Ma boutique'], courier: ['/livreur.html', 'Mes livraisons'], admin: ['/admin.html', 'Administration'] };

  async function renderHeader() {
    const h = document.getElementById('top');
    if (!h) return;
    const u = MG.user, role = u && ROLE_HOME[u.role];
    document.title = (document.title ? document.title + ' · ' : '') + MG.config.site_name;
    h.innerHTML = `<div class="bar"><a class="brand" href="/">${MG.esc(MG.config.site_name)}</a>
      <nav id="nav">
        <a href="/">Boutiques</a>
        ${u ? '<a href="/commandes.html">' + (u.role === 'customer' ? 'Mes commandes' : 'Mes achats') + '</a>' : ''}
        ${role ? `<a href="${role[0]}">${role[1]}</a>` : ''}
        ${u ? '<button id="bell" class="bell" aria-label="Notifications">' + MG.icon('bell') + '<span class="badge" id="bellBadge" hidden>0</span></button>' : ''}
        ${u ? `<a href="/compte.html" class="me">${MG.avatar(u, 28)}${MG.esc(u.name.split(' ')[0])}</a>` : '<a href="/compte.html">Connexion</a>'}
        ${!u || u.role === 'customer' ? '<a class="cart" href="/panier.html">' + MG.icon('cart', 18) + 'Panier <span class="badge" id="cartBadge" hidden>0</span></a>' : ''}
      </nav><button id="burger" aria-label="Menu">${MG.icon('menu', 24)}</button></div><div id="notifBox" hidden></div>`;
    MG.$('#burger').onclick = () => MG.$('#nav').classList.toggle('open');
    if (u) {
      MG.$('#bell').onclick = toggleNotifs;
      pollNotifs(); setInterval(pollNotifs, 30000);
    }
    if (!u || u.role === 'customer') refreshCartBadge();
  }

  MG.refreshCartBadge = refreshCartBadge;
  async function refreshCartBadge() {
    const b = document.getElementById('cartBadge');
    if (!b || !MG.user) return;
    try {
      const { items } = await MG.api('/api/cart');
      const n = items.reduce((t, i) => t + i.qty, 0);
      b.textContent = n; b.hidden = !n;
    } catch { /* ignoré */ }
  }

  async function pollNotifs() {
    try {
      const d = await MG.api('/api/notifications');
      MG.notifs = d.items;
      const b = MG.$('#bellBadge');
      if (b) { b.textContent = d.unread; b.hidden = !d.unread; }
      if (d.unread > (MG._lastUnread ?? d.unread)) MG.toast('Nouvelle notification : ' + (d.items[0] || {}).title);
      MG._lastUnread = d.unread;
    } catch { /* hors ligne */ }
  }

  function toggleNotifs() {
    const box = MG.$('#notifBox');
    if (!box.hidden) { box.hidden = true; return; }
    const items = MG.notifs || [];
    box.innerHTML = '<div class="notif-head"><strong>Notifications</strong><button class="link" id="markRead">Tout marquer comme lu</button></div>' +
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
      add('suggest', list.map(p => `<div class="it"><a href="/boutique.html?s=${encodeURIComponent(p.slug)}" style="display:contents;color:inherit"><span style="position:relative;display:block"><img src="${MG.img(p.photo_id, p.category)}" alt="">${p.promo_pct ? `<span class="tag promo" style="position:absolute;top:6px;left:6px">−${p.promo_pct} %</span>` : ''}</span>
        <strong>${MG.esc(p.name)}</strong><small>${MG.esc(p.shop)}</small></a>
        <div class="f"><span>${p.old_price ? `<span class="old">${MG.fcfa(p.old_price)}</span>` : ''}<span class="price">${MG.fcfa(p.price)}</span></span>${p.stock > 0 ? `<button class="add sm" data-add="${MG.esc(p.id)}" aria-label="Ajouter ${MG.esc(p.name)}">${MG.icon('plus', 16)}</button>` : '<span class="tag out">Épuisé</span>'}</div></div>`).join(''));
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
      try {
        const d = await MG.api('/api/orders/' + ref + '/messages?after=' + encodeURIComponent(last));
        me = d.me;
        const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
        for (const m of d.items) {
          const div = document.createElement('div');
          const mine = m.sender_id === me;
          div.className = 'msg ' + (mine ? 'me' : 'them');
          div.innerHTML = `<small><b>${mine ? 'Vous' : MG.esc(m.sender_name)}</b><span class="role ${MG.esc(m.sender_role)}">${ROLE_NAME[m.sender_role] || ''}</span></small>${MG.esc(m.body)}<time>${MG.date(m.created_at)}</time>`;
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
