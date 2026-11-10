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

  MG.getPosition = () => new Promise((res, rej) => {
    if (!navigator.geolocation) return rej(new Error('La géolocalisation n\'est pas disponible sur cet appareil'));
    navigator.geolocation.getCurrentPosition(p => res({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => rej(new Error('Position refusée : autorisez la localisation dans votre navigateur')), { enableHighAccuracy: true, timeout: 15000 });
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
        ${!u || u.role === 'customer' ? '<a href="/panier.html">Panier <span class="badge" id="cartBadge" hidden>0</span></a>' : ''}
        ${u ? '<a href="/commandes.html">' + (u.role === 'customer' ? 'Mes commandes' : 'Mes achats') + '</a>' : ''}
        ${role ? `<a href="${role[0]}">${role[1]}</a>` : ''}
        ${u ? `<a href="/compte.html">${MG.esc(u.name.split(' ')[0])}</a>` : '<a class="btn small" href="/compte.html">Connexion</a>'}
        ${u ? '<button id="bell" class="bell" aria-label="Notifications">🔔<span class="badge" id="bellBadge" hidden>0</span></button>' : ''}
      </nav><button id="burger" aria-label="Menu">☰</button></div><div id="notifBox" hidden></div>`;
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

  // ---------- Assistant (chatbot) ----------
  function botWidget() {
    const w = document.createElement('div');
    w.id = 'bot';
    w.innerHTML = `<button id="botBtn" aria-label="Assistant">💬 Aide</button>
      <div id="botBox" hidden><div class="bot-head"><strong>Assistant ${MG.esc(MG.config.site_name)}</strong><button class="link" id="botClose">✕</button></div>
      <div id="botLog" class="log"></div>
      <form id="botForm"><input id="botIn" placeholder="Posez votre question…" maxlength="300" autocomplete="off"><button class="btn small">OK</button></form></div>`;
    document.body.appendChild(w);
    const log = MG.$('#botLog');
    const add = (cls, html) => { const d = document.createElement('div'); d.className = 'msg ' + cls; d.innerHTML = html; log.appendChild(d); log.scrollTop = log.scrollHeight; };
    let opened = false;
    MG.$('#botBtn').onclick = () => {
      MG.$('#botBox').hidden = false; MG.$('#botBtn').hidden = true;
      if (!opened) { opened = true; add('them', 'Bonjour ! Je peux vous aider pour une commande, la livraison, le paiement ou pour devenir vendeur ou livreur.'); }
      MG.$('#botIn').focus();
    };
    MG.$('#botClose').onclick = () => { MG.$('#botBox').hidden = true; MG.$('#botBtn').hidden = false; };
    MG.$('#botForm').onsubmit = async e => {
      e.preventDefault();
      const inp = MG.$('#botIn'), text = inp.value.trim();
      if (!text) return;
      inp.value = ''; add('me', MG.esc(text));
      try {
        const r = await MG.api('/api/bot', { method: 'POST', body: { message: text } });
        add('them', MG.esc(r.reply).replace(/\n/g, '<br>') + (r.links || []).map(l => `<br><a href="${MG.esc(l[1])}">${MG.esc(l[0])} →</a>`).join(''));
      } catch (er) { add('them', MG.esc(er.message)); }
    };
  }

  // ---------- Discussion d'une commande (client, boutique, livreur) ----------
  MG.chat = function (box, ref) {
    box.innerHTML = `<div class="log chatlog"></div><form class="row"><input maxlength="500" placeholder="Votre message…" required><button class="btn small">Envoyer</button></form>`;
    const log = box.querySelector('.log'), form = box.querySelector('form'), input = form.querySelector('input');
    let last = '', me = null, stopped = false;
    async function load() {
      if (stopped || !document.body.contains(box)) { stopped = true; return; }
      try {
        const d = await MG.api('/api/orders/' + ref + '/messages?after=' + encodeURIComponent(last));
        me = d.me;
        for (const m of d.items) {
          const div = document.createElement('div');
          div.className = 'msg ' + (m.sender_id === me ? 'me' : 'them');
          const who = { customer: 'Client', seller: 'Boutique', courier: 'Livreur', admin: 'Admin' }[m.sender_role] || '';
          div.innerHTML = `<small>${MG.esc(m.sender_name)} (${who}) · ${MG.date(m.created_at)}</small><br>${MG.esc(m.body)}`;
          log.appendChild(div); last = m.created_at;
        }
        if (d.items.length) log.scrollTop = log.scrollHeight;
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
