/* Kit vendeur : affiche avec QR code et images pour les statuts WhatsApp, dessinées dans le navigateur.
   Aucune donnée ne part vers un service extérieur : le QR code est calculé ici (vendor/qrcode.js). */
(function () {
  const C = { nuit: '#1f1a17', creme: '#fff8ee', papaye: '#f76707', papayeText: '#b83d0a', soleil: '#ffc53d', muted: '#6b5f55', vert: '#009e60', jaune: '#fcd116', bleu: '#3a75c4' };
  const DISPLAY = '"Bricolage Grotesque","Trebuchet MS",sans-serif', SANS = 'Figtree,"Segoe UI",sans-serif';

  const loadImg = src => new Promise(res => { if (!src) return res(null); const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; });
  async function fonts() { try { await Promise.all([document.fonts.load(`800 80px ${DISPLAY}`), document.fonts.load(`700 40px ${SANS}`), document.fonts.load(`500 40px ${SANS}`)]); } catch (e) { /* polices de secours */ } }
  function rr(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  // Image recadrée pour remplir le cadre (comme object-fit: cover)
  function cover(ctx, img, x, y, w, h, r) {
    ctx.save(); rr(ctx, x, y, w, h, r); ctx.clip();
    const s = Math.max(w / img.width, h / img.height), iw = img.width * s, ih = img.height * s;
    ctx.drawImage(img, x + (w - iw) / 2, y + (h - ih) / 2, iw, ih); ctx.restore();
  }
  // Texte centré sur plusieurs lignes, coupé proprement avec « … » si trop long
  function lines(ctx, text, maxW, max) {
    const words = String(text).split(/\s+/), out = []; let cur = '';
    for (const w of words) { const t = cur ? cur + ' ' + w : w; if (ctx.measureText(t).width <= maxW || !cur) cur = t; else { out.push(cur); cur = w; } }
    if (cur) out.push(cur);
    if (out.length > max) { out.length = max; let l = out[max - 1]; while (l.length > 1 && ctx.measureText(l + '…').width > maxW) l = l.slice(0, -1); out[max - 1] = l.trim() + '…'; }
    return out;
  }
  // Une seule ligne, raccourcie avec « … » si elle dépasse
  function fit(ctx, text, maxW) { let t = String(text); if (ctx.measureText(t).width <= maxW) return t; while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1); return t + '…'; }
  function textC(ctx, text, cx, y, maxW, lh, max) { const ls = lines(ctx, text, maxW, max); ls.forEach((l, k) => ctx.fillText(l, cx, y + k * lh)); return ls.length * lh; }
  function qr(ctx, text, x, y, size, color) {
    const q = qrcode(0, 'M'); q.addData(text); q.make();
    const n = q.getModuleCount(), cell = size / n;
    ctx.fillStyle = color || C.nuit;
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) ctx.fillRect(Math.floor(x + c * cell), Math.floor(y + r * cell), Math.ceil(cell), Math.ceil(cell));
  }
  function stripe(ctx, x, y, w, h) { const t = w / 3; [C.vert, C.jaune, C.bleu].forEach((c, k) => { ctx.fillStyle = c; ctx.fillRect(x + k * t, y, t + 1, h); }); }
  async function header(ctx, W, h) {
    ctx.fillStyle = C.nuit; ctx.fillRect(0, 0, W, h); stripe(ctx, 0, h, W, 14);
    const logo = await loadImg('/logo/marche-gabon-icone-fond-sombre.svg'), ls = h * 0.56;
    ctx.font = `800 ${Math.round(h * 0.3)}px ${DISPLAY}`; ctx.textBaseline = 'middle';
    const label = (MG.config && MG.config.site_name) || 'Marché Gabon', tw = ctx.measureText(label).width, gap = h * 0.12;
    const x0 = (W - (ls + gap + tw)) / 2;
    if (logo) ctx.drawImage(logo, x0, (h - ls) / 2, ls, ls);
    ctx.fillStyle = C.creme; ctx.textAlign = 'left'; ctx.fillText(label, x0 + ls + gap, h / 2 + 2);
  }
  const host = url => url.replace(/^https?:\/\//, '');

  // Affiche A4 (1240 × 1754) à coller sur l'étal ou la vitrine
  async function poster(shop, url) {
    await fonts();
    const W = 1240, H = 1754, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = C.creme; ctx.fillRect(0, 0, W, H);
    await header(ctx, W, 200);
    const av = await loadImg(MG.img(shop.photo_id, shop.category));
    const cy = 250, as = 230;
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(W / 2, cy + as / 2, as / 2 + 10, 0, Math.PI * 2); ctx.fill();
    if (av) cover(ctx, av, W / 2 - as / 2, cy, as, as, as / 2);
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = C.nuit;
    ctx.font = `800 88px ${DISPLAY}`;
    let y = cy + as + 110; y += textC(ctx, shop.name, W / 2, y, W - 160, 96, 2);
    ctx.font = `600 38px ${SANS}`; ctx.fillStyle = C.muted;
    ctx.fillText(fit(ctx, MG.catName(shop.category) + (shop.address ? ' · ' + shop.address : ''), W - 160), W / 2, y + 6);
    ctx.font = `800 54px ${DISPLAY}`; ctx.fillStyle = C.papayeText;
    ctx.fillText('Commandez en ligne, livré chez vous', W / 2, y + 100);
    // QR code dans une carte blanche
    const qy = y + 230, qs = Math.min(620, 1525 - qy), qx = (W - qs) / 2; // plus petit si le nom tient sur 2 lignes
    ctx.fillStyle = '#fff'; rr(ctx, qx - 50, qy - 50, qs + 100, qs + 100, 48); ctx.fill();
    ctx.lineWidth = 10; ctx.strokeStyle = C.papaye; ctx.stroke();
    qr(ctx, url, qx, qy, qs);
    ctx.fillStyle = C.nuit; ctx.font = `700 40px ${SANS}`;
    ctx.fillText('Scannez avec l\'appareil photo du téléphone', W / 2, qy + qs + 120);
    ctx.font = `600 32px ${SANS}`; ctx.fillStyle = C.muted;
    ctx.fillText(fit(ctx, host(url), W - 160), W / 2, qy + qs + 175);
    stripe(ctx, 0, H - 24, W, 24);
    return cv;
  }

  // Image de statut WhatsApp (1080 × 1920) : un produit, ou la boutique si product est vide
  // product : { name, photo_id, price, old_price?, promo_pct? } ; pour un service : priceText (« Sur devis »), suffix (« / jour »), prefix (« à partir de »)
  // opts : { cta, sub } pour adapter l'appel à l'action (« Réservez ici », « Devis gratuit »…)
  async function status(shop, product, url, opts = {}) {
    await fonts();
    const W = 1080, H = 1920, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, '#ffe8d6'); g.addColorStop(1, C.creme);
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    await header(ctx, W, 170);
    const pic = product ? MG.img(product.photo_id, shop.category) : (shop.cover_photo ? MG.photo(shop.cover_photo) : MG.img(shop.photo_id, shop.category));
    const img = await loadImg(pic);
    const ps = 880, px = (W - ps) / 2, py = 250;
    ctx.fillStyle = '#fff'; rr(ctx, px - 12, py - 12, ps + 24, ps + 24, 64); ctx.fill();
    if (img) cover(ctx, img, px, py, ps, ps, 54);
    if (product && product.promo_pct) { // pastille de remise
      ctx.fillStyle = C.soleil; ctx.beginPath(); ctx.arc(px + ps - 120, py + 120, 120, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = C.nuit; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = `800 76px ${DISPLAY}`;
      ctx.fillText('−' + product.promo_pct + ' %', px + ps - 120, py + 124);
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = C.nuit;
    let y = py + ps + 120;
    ctx.font = `800 76px ${DISPLAY}`;
    y += textC(ctx, product ? product.name : shop.name, W / 2, y, W - 120, 84, 2);
    if (product && (product.priceText || product.suffix || product.prefix)) { // prestation ou modèle
      if (product.prefix) { ctx.font = `600 40px ${SANS}`; ctx.fillStyle = C.muted; ctx.fillText(product.prefix, W / 2, y - 18); y += 34; }
      const price = product.priceText || MG.fcfa(product.price) + (product.suffix || '');
      let size = 92; ctx.font = `800 ${size}px ${DISPLAY}`;
      while (ctx.measureText(price).width > W - 120 && size > 52) { size -= 4; ctx.font = `800 ${size}px ${DISPLAY}`; }
      ctx.fillStyle = C.papayeText; ctx.fillText(price, W / 2, y + 40);
      ctx.font = `600 42px ${SANS}`; ctx.fillStyle = C.muted; ctx.fillText(MG.chez(shop.name), W / 2, y + 110);
    } else if (product) {
      ctx.font = `800 92px ${DISPLAY}`; ctx.fillStyle = C.papayeText;
      const price = MG.fcfa(product.price), pw = ctx.measureText(price).width;
      if (product.old_price) {
        ctx.font = `600 48px ${SANS}`; const old = MG.fcfa(product.old_price), ow = ctx.measureText(old).width, total = pw + 30 + ow, x0 = (W - total) / 2;
        ctx.fillStyle = C.muted; ctx.textAlign = 'left'; ctx.fillText(old, x0 + pw + 30, y + 26);
        ctx.fillRect(x0 + pw + 30, y + 10, ow, 5);
        ctx.font = `800 92px ${DISPLAY}`; ctx.fillStyle = C.papayeText; ctx.fillText(price, x0, y + 40); ctx.textAlign = 'center';
      } else ctx.fillText(price, W / 2, y + 40);
      ctx.font = `600 42px ${SANS}`; ctx.fillStyle = C.muted; ctx.fillText(MG.chez(shop.name), W / 2, y + 110);
    } else {
      ctx.font = `600 44px ${SANS}`; ctx.fillStyle = C.muted; textC(ctx, MG.catName(shop.category) + (shop.address ? ' · ' + shop.address : ''), W / 2, y + 10, W - 140, 52, 2);
    }
    // bas : QR code + appel à l'action
    const by = H - 330, bh = 270;
    ctx.fillStyle = '#fff'; rr(ctx, 60, by, W - 120, bh, 44); ctx.fill();
    qr(ctx, url, 100, by + 35, 200);
    ctx.textAlign = 'left'; ctx.fillStyle = C.nuit; ctx.font = `800 56px ${DISPLAY}`;
    ctx.fillText(opts.cta || 'Commandez ici', 340, by + 105);
    ctx.font = `600 34px ${SANS}`; ctx.fillStyle = C.muted;
    ctx.fillText(opts.sub || 'Livraison rapide à domicile', 340, by + 160);
    ctx.font = `700 30px ${SANS}`; ctx.fillStyle = C.papayeText;
    ctx.fillText(fit(ctx, host(url).split('?')[0], W - 120 - 300), 340, by + 210);
    stripe(ctx, 0, H - 20, W, 20);
    return cv;
  }

  const toFile = (cv, name) => new Promise(res => cv.toBlob(b => res(new File([b], name, { type: 'image/png' })), 'image/png'));
  function download(file) { const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = file.name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); }
  // Partager l'image (sur téléphone : WhatsApp, statut, Facebook…) ; sinon on la télécharge
  async function shareImage(cv, name, text) {
    const file = await toFile(cv, name);
    if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file], text }); return 'shared'; } catch (e) { if (e && e.name === 'AbortError') return 'cancel'; } }
    download(file); return 'downloaded';
  }
  // Impression de l'affiche seule
  function printCanvas(cv) {
    const img = new Image(); img.className = 'print-only'; img.src = cv.toDataURL('image/png'); img.alt = '';
    document.body.appendChild(img); document.body.classList.add('printing');
    const done = () => { img.remove(); document.body.classList.remove('printing'); removeEventListener('afterprint', done); };
    addEventListener('afterprint', done);
    img.onload = () => setTimeout(() => window.print(), 50);
  }
  window.MGKit = { poster, status, shareImage, download: async (cv, name) => download(await toFile(cv, name)), printCanvas };
})();
