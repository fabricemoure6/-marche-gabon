// Référencement : pages rendues côté serveur (contenu, titres, aperçus de partage, données structurées),
// sitemap.xml et robots.txt. Le JavaScript du navigateur reprend ensuite la main sur les mêmes éléments.
import { CATEGORIES, loadSettings, publicProduct, EFFECTIVE_PRICE, LOW_STOCK, UNITS, fmtQty, cached, PUBLIC_TTL } from './lib.js';

const ILLU = { habits: 'pagne-wax', parfumerie: 'parfum', alimentation: 'bananes-plantain', quincaillerie: 'sac-riz', electronique: 'smartphone', maison: 'marmite', autres: 'panier-tresse' };
const illu = cat => '/img/produits/' + (ILLU[cat] || 'panier-tresse') + '.svg';
const photo = id => (id ? '/api/photos/' + id : '');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fcfa = n => new Intl.NumberFormat('fr-FR').format(Math.round(Number(n) || 0)).replace(/[\u00a0\u202f ]/g, '\u202f') + '\u00a0FCFA';
const catName = id => (CATEGORIES.find(c => c[0] === id) || [])[1] || id;
const cut = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length <= n ? s : s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…'; };
const jsonLd = o => `<script type="application/ld+json">${JSON.stringify(o).replace(/</g, '\\u003c')}</script>`;
const ICO = {
  plus: '<path d="M12 5v14M5 12h14"/>', bell: '<path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
  pin: '<path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/>'
};
const icon = (n, s = 20) => `<svg class="ico" viewBox="0 0 24 24" width="${s}" height="${s}" aria-hidden="true">${ICO[n]}</svg>`;

// Balises d'en-tête communes : description, canonique, aperçus de partage
function headTags({ title, description, url, image, imageAlt, type = 'website', site }) {
  return `
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(url)}">
<meta property="og:site_name" content="${esc(site)}"><meta property="og:locale" content="fr_FR"><meta property="og:type" content="${type}">
<meta property="og:title" content="${esc(title)}"><meta property="og:description" content="${esc(description)}"><meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${esc(image)}"><meta property="og:image:alt" content="${esc(imageAlt || title)}">
<meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${esc(title)}"><meta name="twitter:description" content="${esc(description)}"><meta name="twitter:image" content="${esc(image)}">`;
}

// Mêmes balises que MG.productCard / MG.shopCard côté navigateur
function productCard(p, cat, eager) {
  const out = !(p.stock > 0);
  const badge = out ? '<span class="tag out">Épuisé</span>' : p.promo_pct ? `<span class="tag promo">−${p.promo_pct} %</span>` : '';
  const stock = out ? '<span class="stock-info out">Épuisé</span>' : p.stock <= LOW_STOCK ? `<span class="stock-info low">Plus que ${fmtQty(p.stock, p.unit)} en stock</span>` : '<span class="stock-info ok">En stock</span>';
  const n = (p.photos || []).length;
  return `<article class="tile product${out ? ' out' : ''}${p.promo_pct ? ' is-promo' : ''}">
    <div class="pimg" data-gal="${esc(p.id)}" role="button" tabindex="0" aria-label="Voir ${esc(p.name)}"><img src="${p.photo_id ? photo(p.photo_id) : illu(p.category || cat)}" alt="${esc(p.name)}" width="400" height="300"${eager ? ' fetchpriority="high"' : ' loading="lazy"'}><div class="pbadges" aria-hidden="true">${badge}</div>${n > 1 ? `<span class="pcount" aria-hidden="true">${n}</span>` : ''}</div>
    <div class="pbody">${p.shop_name ? `<a class="pshop" href="/boutique/${encodeURIComponent(p.slug)}">${esc(p.shop_name)}</a>` : ''}<h3 class="pname">${esc(p.name)}</h3>${p.description && !p.shop_name ? `<p class="pdesc">${esc(p.description)}</p>` : ''}${stock}
      <div class="pfoot"><div>${p.old_price ? `<span class="old">${fcfa(p.old_price)}</span>` : ''}<span class="price">${fcfa(p.price)}</span>${(UNITS[p.unit] || UNITS.piece).short ? `<small class="per"> / ${UNITS[p.unit].short}</small>` : ''}</div>
      ${out ? `<button class="btn small alt notify" data-alert="${esc(p.id)}" data-on="0">${icon('bell', 16)}Me prévenir</button>` : `<button class="add" data-add="${esc(p.id)}" data-stock="${p.stock}" data-step="${p.qty_step || 1}" data-unit="${p.unit || 'piece'}" aria-label="Ajouter ${esc(p.name)} au panier">${icon('plus')}</button>`}</div></div></article>`;
}
function shopCard(s) {
  const cover = s.cover_id ? photo(s.cover_id) : s.photo_id ? photo(s.photo_id) : illu(s.category);
  return `<a class="tile shop${s.promos ? ' has-promo' : ''}" href="/boutique/${encodeURIComponent(s.slug)}">
    <div class="cover" style="background-image:url('${cover}')">${s.promos ? `<span class="ribbon">Promo${s.best_pct ? '<span class="rl"> jusqu\'à</span> −' + s.best_pct + ' %' : ''}</span>` : ''}</div>
    <div class="body"><span class="logo"${s.photo_id ? ` style="background-image:url('${photo(s.photo_id)}')"` : ''}>${s.photo_id ? '' : esc(s.name.trim().charAt(0).toUpperCase())}</span><h3>${esc(s.name)}</h3>
    ${s.loyalty_enabled ? '<span class="tag fid">Carte fidélité</span>' : ''}<p class="muted" style="margin:0;font-size:.9rem">${s.products ? `${s.products} produit${s.products > 1 ? 's' : ''}` : 'Vitrine en préparation'}${s.promos ? ` · <b style="color:var(--papaye-text)">${s.promos} en promo</b>` : ''}${s.address ? ' · ' + esc(s.address) : ''}</p></div></a>`;
}

async function activeShops(env) {
  return cached('seo-shops', PUBLIC_TTL, () => activeShopsDb(env));
}
async function activeShopsDb(env) {
  const { results } = await env.DB.prepare(
    `SELECT s.id,s.name,s.slug,s.category,s.description,s.address,s.photo_id,s.created_at,s.loyalty_enabled,
            (SELECT COUNT(*) FROM products p WHERE p.shop_id=s.id AND p.active=1) AS products,
            (SELECT COUNT(*) FROM products p WHERE p.shop_id=s.id AND p.active=1 AND p.stock>0 AND ${EFFECTIVE_PRICE} < p.price) AS promos,
            (SELECT MAX(ROUND(100 - 100.0 * p.promo_price / p.price)) FROM products p WHERE p.shop_id=s.id AND p.active=1 AND p.stock>0 AND ${EFFECTIVE_PRICE} < p.price) AS best_pct,
            COALESCE(s.cover_photo, (SELECT p.photo_id FROM products p WHERE p.shop_id=s.id AND p.active=1 AND p.photo_id IS NOT NULL ORDER BY p.created_at DESC LIMIT 1)) AS cover_id,
            (SELECT MAX(p.created_at) FROM products p WHERE p.shop_id=s.id) AS last_product
     FROM shops s WHERE s.status='active' ORDER BY promos > 0 DESC, s.name`).all();
  return results;
}

async function page(env, url, path) {
  const r = await env.ASSETS.fetch(new Request(new URL(path, url.origin)));
  return r;
}
async function homePage(env, url) {
  const [st, shops] = await Promise.all([loadSettings(env), activeShops(env)]);
  const promoRows = await cached('promotions', PUBLIC_TTL, async () => (await env.DB.prepare(
    `SELECT p.id,p.name,p.description,p.price,p.promo_price,p.promo_until,p.stock,p.unit,p.qty_step,p.photo_id,p.photos,s.name AS shop_name,s.slug,s.category
     FROM products p JOIN shops s ON s.id=p.shop_id WHERE p.active=1 AND p.stock>0 AND s.status='active' AND ${EFFECTIVE_PRICE} < p.price
     ORDER BY (1.0 * p.promo_price / p.price) ASC, p.promo_until ASC LIMIT 24`).all()).results);
  const promos = promoRows.map(publicProduct);
  const site = st.site_name, origin = url.origin;
  const title = `${site} : vos boutiques en ligne, livrées chez vous à Libreville`;
  const cats = [...new Set(shops.map(s => catName(s.category)))].slice(0, 4).join(', ').toLowerCase();
  const description = cut(`${st.tagline}. ${shops.length ? `${shops.length} boutique${shops.length > 1 ? 's' : ''}${cats ? ' : ' + cats : ''}. ` : ''}Promotions, livraison rapide, paiement Airtel Money et Moov Money.`, 158);
  const sections = CATEGORIES.map(c => [c, shops.filter(s => s.category === c[0])]).filter(([, l]) => l.length).map(([c, list]) => `<section class="cat-section" id="rayon-${c[0]}">
      <div class="section-head"><h2><img src="${illu(c[0])}" alt="">${esc(c[1])}</h2><span class="muted">${list.length} boutique${list.length > 1 ? 's' : ''}${list.some(s => s.promos) ? ' · promotions en cours' : ''}</span></div>
      <div class="grid shops">${list.map(shopCard).join('')}</div></section>`).join('');
  const ld = [
    { '@context': 'https://schema.org', '@type': 'WebSite', name: site, url: origin + '/', inLanguage: 'fr',
      potentialAction: { '@type': 'SearchAction', target: origin + '/?q={search_term_string}', 'query-input': 'required name=search_term_string' } },
    { '@context': 'https://schema.org', '@type': 'Organization', name: site, url: origin + '/', logo: origin + '/img/icon-512.png', areaServed: { '@type': 'City', name: 'Libreville' } },
    shops.length && { '@context': 'https://schema.org', '@type': 'ItemList', name: 'Boutiques', itemListElement: shops.map((s, i) => ({ '@type': 'ListItem', position: i + 1, url: `${origin}/boutique/${s.slug}`, name: s.name })) }
  ].filter(Boolean);
  const res = await page(env, url, '/');
  let promoDone = false;
  return new HTMLRewriter()
    .on('title', { element: e => e.setInnerContent(title) })
    .on('head', { element: e => e.append(headTags({ title, description, url: origin + '/', image: origin + '/img/partage.png', imageAlt: site, site }) + '<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">' + ld.map(jsonLd).join(''), { html: true }) })
    .on('#siteName', { element: e => e.setInnerContent(site) })
    .on('#tagline', { element: e => e.setInnerContent(st.tagline) })
    .on('#sections', { element: e => { if (sections) e.setInnerContent(sections, { html: true }); } })
    .on('#promos', { element: e => { if (promos.length) { e.removeAttribute('hidden'); promoDone = true; } } })
    .on('#promoSub', { element: e => { if (promos.length) { const best = Math.max(...promos.map(p => p.promo_pct || 0)), n = new Set(promos.map(p => p.shop_name)).size; e.setInnerContent(`${promos.length} offre${promos.length > 1 ? 's' : ''} dans ${n} boutique${n > 1 ? 's' : ''} · jusqu'à −${best} %`); } } })
    .on('#promoRail', { element: e => { if (promos.length) e.setInnerContent(promos.map((p, i) => productCard(p, p.category, i < 4)).join(''), { html: true }); } })
    .transform(res);
}

async function shopPage(env, url, slug) {
  const st = await loadSettings(env);
  const s = await cached('seo-shop:' + slug, PUBLIC_TTL, () => env.DB.prepare(`SELECT id,name,slug,category,description,address,photo_id,cover_photo,phone,created_at,loyalty_enabled,loyalty_every,loyalty_kind,loyalty_value,loyalty_min FROM shops WHERE slug=?1 AND status='active'`).bind(slug).first());
  if (!s) return null;
  const results = await cached('shop-products:' + s.id, PUBLIC_TTL, async () => (await env.DB.prepare(`SELECT id,name,description,price,promo_price,promo_until,stock,unit,qty_step,photo_id,photos,created_at FROM products WHERE shop_id=?1 AND active=1 ORDER BY created_at DESC`).bind(s.id).all()).results);
  const products = results.map(publicProduct).sort((a, b) => (b.promo_pct ? 1 : 0) - (a.promo_pct ? 1 : 0) || (b.stock > 0) - (a.stock > 0));
  const origin = url.origin, site = st.site_name, pageUrl = `${origin}/boutique/${encodeURIComponent(s.slug)}`;
  const cat = catName(s.category), promos = products.filter(p => p.promo_pct && p.stock > 0);
  const title = `${s.name} · ${cat}${s.address ? ' à ' + cut(s.address, 40) : ''} | ${site}`;
  const names = products.slice(0, 4).map(p => p.name).join(', ');
  const description = cut(s.description && s.description.length >= 40 ? s.description
    : `${s.name}, boutique ${cat.toLowerCase()}${s.address ? ' à ' + s.address : ''}. ${products.length} produit${products.length > 1 ? 's' : ''}${names ? ' : ' + names : ''}. Commandez en ligne, livraison rapide.`, 158);
  const imgId = s.photo_id || (products.find(p => p.photo_id) || {}).photo_id;
  const image = imgId ? origin + photo(imgId) : origin + '/img/partage.png';
  const ld = [
    { '@context': 'https://schema.org', '@type': 'Store', name: s.name, url: pageUrl, image, description: cut(s.description || description, 300),
      address: { '@type': 'PostalAddress', streetAddress: s.address || undefined, addressLocality: 'Libreville', addressCountry: 'GA' },
      ...(s.phone ? { telephone: s.phone } : {}), currenciesAccepted: 'XAF', paymentAccepted: 'Airtel Money, Moov Money, carte bancaire',
      ...(products.length ? { hasOfferCatalog: { '@type': 'OfferCatalog', name: 'Produits', itemListElement: products.slice(0, 50).map(p => ({
        '@type': 'Offer', price: p.price, priceCurrency: 'XAF', availability: p.stock > 0 ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock', url: pageUrl,
        ...(p.promo_until ? { priceValidUntil: new Date(p.promo_until).toISOString().slice(0, 10) } : {}),
        itemOffered: { '@type': 'Product', name: p.name, ...(p.description ? { description: cut(p.description, 300) } : {}), image: (p.photos || []).map(id => origin + photo(id)) } })) } } : {}) },
    { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: site, item: origin + '/' },
      { '@type': 'ListItem', position: 2, name: cat, item: `${origin}/?cat=${s.category}` },
      { '@type': 'ListItem', position: 3, name: s.name, item: pageUrl }] }
  ];
  const coverId = s.cover_photo || (products.find(p => p.photo_id) || {}).photo_id || null;
  const hero = `<a href="/?cat=${encodeURIComponent(s.category)}" style="display:inline-block;margin-bottom:var(--space-3)">← ${esc(cat)}</a>
    <section class="card shop-hero${coverId ? ' has-cover' : ''}"${coverId ? `  style="--cover-img:url('${photo(coverId)}')"` : ''}><span class="av"><img class="avatar-xl" src="${s.photo_id ? photo(s.photo_id) : illu(s.category)}" alt="" width="104" height="104"></span>
      <div style="flex:1;min-width:220px"><h1 style="margin:0 0 .3rem">${esc(s.name)}</h1>
        <div class="stats"><span class="tag">${esc(cat)}</span><span class="tag">${products.length} produit${products.length > 1 ? 's' : ''}</span>${promos.length ? `<span class="tag promo">${promos.length} en promo</span>` : ''}</div>
        ${s.description ? `<p style="margin:.7rem 0 0">${esc(s.description)}</p>` : ''}${s.address ? `<p class="muted" style="margin:.4rem 0 0">${icon('pin', 18)} ${esc(s.address)}</p>` : ''}</div></section>`;
  // Données pour le navigateur : évite un second appel réseau au chargement
  const loyalty = s.loyalty_enabled ? { every: s.loyalty_every, kind: s.loyalty_kind, value: s.loyalty_value, min: s.loyalty_min || 0 } : null;
  const shopPub = { id: s.id, name: s.name, slug: s.slug, category: s.category, description: s.description, address: s.address, photo_id: s.photo_id, cover_photo: s.cover_photo, phone: s.phone, loyalty };
  const boot = `<script>window.__SHOP__=${JSON.stringify({ shop: shopPub, products, mine: null }).replace(/</g, '\\u003c')};</script>`;
  const res = await page(env, url, '/boutique');
  return new HTMLRewriter()
    .on('title', { element: e => e.setInnerContent(title) })
    .on('head', { element: e => e.append(headTags({ title, description, url: pageUrl, image, imageAlt: s.name, site }) + ld.map(jsonLd).join('') + boot, { html: true }) })
    .on('#head', { element: e => e.setInnerContent(hero, { html: true }) })
    .on('#products', { element: e => e.setInnerContent(products.map((p, i) => productCard(p, s.category, i < 4)).join(''), { html: true }) })
    .on('#empty', { element: e => { if (!products.length) e.removeAttribute('hidden'); } })
    .transform(res);
}

async function sitemap(env, url) {
  const shops = await activeShops(env), o = url.origin, day = d => (d || new Date().toISOString()).slice(0, 10);
  const newest = shops.reduce((m, s) => [s.created_at, s.last_product, m].filter(Boolean).sort().pop(), null);
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${o}/</loc><lastmod>${day(newest)}</lastmod><changefreq>daily</changefreq><priority>1.0</priority></url>
${shops.map(s => `  <url><loc>${o}/boutique/${encodeURIComponent(s.slug)}</loc><lastmod>${day([s.created_at, s.last_product].filter(Boolean).sort().pop())}</lastmod><changefreq>daily</changefreq><priority>0.8</priority></url>`).join('\n')}
</urlset>`;
  return new Response(xml, { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
}

function robots(url) {
  const body = `User-agent: *
Allow: /
Allow: /api/photos/
Disallow: /api/
Disallow: /compte
Disallow: /panier
Disallow: /commandes
Disallow: /vendeur
Disallow: /livreur
Disallow: /admin
Disallow: /recu

Sitemap: ${url.origin}/sitemap.xml
`;
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=3600' } });
}

// Renvoie une réponse pour les pages gérées ici, sinon null
export async function seoRoute(request, env, url) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  const p = url.pathname;
  if (p === '/robots.txt') return robots(url);
  if (p === '/sitemap.xml') return sitemap(env, url);
  if (p === '/' || p === '/index.html') return homePage(env, url);
  // Anciennes adresses → adresse propre et définitive
  if (p === '/boutique' || p === '/boutique.html' || p === '/boutique/') {
    const s = url.searchParams.get('s');
    return Response.redirect(url.origin + (s ? '/boutique/' + encodeURIComponent(s) : '/'), 301);
  }
  const m = p.match(/^\/boutique\/([a-z0-9-]{1,60})\/?$/);
  if (m) {
    const r = await shopPage(env, url, m[1]);
    if (r) return r;
    const nf = await page(env, url, '/boutique');
    return new HTMLRewriter()
      .on('title', { element: e => e.setInnerContent('Boutique introuvable') })
      .on('head', { element: e => e.append('<meta name="robots" content="noindex">', { html: true }) })
      .transform(new Response(nf.body, { status: 404, headers: nf.headers }));
  }
  return null;
}
