/*!
 * gabon-map.js — Module OpenStreetMap (Leaflet) pour Gabon Market
 * Aucune dépendance à part Leaflet. Pas de clé API.
 *
 *  GabonMap.pickLocation(el, opts)  -> carte du paiement : choisir/confirmer l'adresse de livraison
 *  GabonMap.track(el, opts)         -> carte de suivi : boutique, client, livreur en mouvement
 *  GabonMap.broadcast(opts)         -> côté livreur : envoie sa position GPS au serveur
 *  GabonMap.simulateDriver(coords)  -> livreur simulé (démo / tests)
 *
 * Données © contributeurs OpenStreetMap (ODbL) : l'attribution est affichée par la carte.
 */
(function (global) {
  'use strict';

  var DEFAULT_CENTER = [0.404302, 9.434897]; // Libreville
  var NOMINATIM = 'https://nominatim.openstreetmap.org';
  var OSRM = 'https://router.project-osrm.org';


  // ---------- Chargement paresseux de Leaflet (uniquement quand une carte est affichée) ----------
  var loading = null;
  function load() {
    if (window.L) return Promise.resolve();
    if (loading) return loading;
    loading = new Promise(function (ok, ko) {
      var css = document.createElement('link');
      css.rel = 'stylesheet'; css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      document.head.appendChild(css);
      var s = document.createElement('script');
      s.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
      s.onload = ok; s.onerror = function () { loading = null; ko(new Error('Carte indisponible (réseau)')); };
      document.head.appendChild(s);
    });
    return loading;
  }
  // ---------- utilitaires ----------
  function haversine(a, b) {
    var R = 6371000, rad = Math.PI / 180;
    var dLat = (b[0] - a[0]) * rad, dLon = (b[1] - a[1]) * rad;
    var x = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(a[0] * rad) * Math.cos(b[0] * rad) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  function fmtDist(m) { return m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(1) + ' km'; }
  function fmtTime(s) { var m = Math.max(1, Math.round(s / 60)); return m + ' min'; }

  function icon(emoji, bg) {
    return L.divIcon({
      className: 'gm-icon',
      html: '<div style="width:38px;height:38px;border-radius:50%;background:' + bg +
        ';border:3px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;font-size:20px">' +
        emoji + '</div>',
      iconSize: [38, 38], iconAnchor: [19, 19]
    });
  }
  var ICONS = {
    shop: function () { return icon('🏪', '#f59e0b'); },
    dest: function () { return icon('🏠', '#16a34a'); },
    driver: function () { return icon('🛵', '#2563eb'); },
    pin: function () { return icon('📍', '#dc2626'); }
  };

  function makeMap(el, center, zoom) {
    var map = L.map(el, { zoomControl: true }).setView(center || DEFAULT_CENTER, zoom || 14);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(map);
    return map;
  }

  // Les serveurs publics d'OSM demandent : 1 requête/s max pour Nominatim.
  var lastNominatim = 0;
  function nominatim(path) {
    var wait = Math.max(0, lastNominatim + 1100 - Date.now());
    lastNominatim = Date.now() + wait;
    return new Promise(function (r) { setTimeout(r, wait); })
      .then(function () { return fetch(NOMINATIM + path, { headers: { 'Accept-Language': 'fr' } }); })
      .then(function (r) { if (!r.ok) throw new Error('Nominatim ' + r.status); return r.json(); });
  }
  function reverse(lat, lon) {
    return nominatim('/reverse?format=jsonv2&zoom=18&lat=' + lat + '&lon=' + lon)
      .then(function (j) { return j && j.display_name ? j.display_name : ''; })
      .catch(function () { return ''; });
  }
  function search(q) {
    return nominatim('/search?format=jsonv2&limit=5&countrycodes=ga&q=' + encodeURIComponent(q))
      .then(function (list) {
        return list.map(function (i) { return { label: i.display_name, lat: +i.lat, lon: +i.lon }; });
      });
  }

  // Itinéraire routier (OSRM). En cas d'échec : ligne droite.
  function route(from, to) {
    var url = OSRM + '/route/v1/driving/' + from[1] + ',' + from[0] + ';' + to[1] + ',' + to[0] +
      '?overview=full&geometries=geojson';
    return fetch(url).then(function (r) { return r.json(); }).then(function (j) {
      var rt = j.routes && j.routes[0];
      if (!rt) throw new Error('no route');
      return {
        coords: rt.geometry.coordinates.map(function (c) { return [c[1], c[0]]; }),
        distance: rt.distance, duration: rt.duration, fallback: false
      };
    }).catch(function () {
      var d = haversine(from, to);
      return { coords: [from, to], distance: d, duration: d / 6.9, fallback: true }; // ~25 km/h
    });
  }

  // ---------- 1) Carte du paiement ----------
  /**
   * opts: { center, value:[lat,lon], searchInput, locateButton, addressOutput,
   *         onChange({lat,lon,address}) }
   */
  function pickLocation(el, opts) {
    opts = opts || {};
    var start = opts.value || opts.center || DEFAULT_CENTER;
    var map = makeMap(el, start, 15);
    var marker = L.marker(start, { draggable: true, icon: ICONS.pin() }).addTo(map);
    var current = { lat: start[0], lng: start[1], address: '' };

    var moved = false;
    function set(lat, lon, address, pan, user) {
      if (user) moved = true;
      marker.setLatLng([lat, lon]);
      if (pan) map.setView([lat, lon], Math.max(map.getZoom(), 16));
      current = { lat: lat, lng: lon, address: address || '', moved: moved };
      if (address == null) {
        reverse(lat, lon).then(function (a) {
          if (current.lat === lat && current.lng === lon) { current.address = a; emit(); }
        });
      }
      emit();
    }
    function emit() {
      if (opts.addressOutput) {
        var o = typeof opts.addressOutput === 'string' ? document.querySelector(opts.addressOutput) : opts.addressOutput;
        if (o) o.value !== undefined ? (o.value = current.address) : (o.textContent = current.address);
      }
      if (opts.onChange) opts.onChange(current);
    }

    marker.on('dragend', function () { var p = marker.getLatLng(); set(p.lat, p.lng, null, false, true); });
    map.on('click', function (e) { set(e.latlng.lat, e.latlng.lng, null, false, true); });

    if (opts.locateButton) {
      var b = typeof opts.locateButton === 'string' ? document.querySelector(opts.locateButton) : opts.locateButton;
      b && b.addEventListener('click', function () {
        if (!navigator.geolocation) return alert('Géolocalisation indisponible');
        navigator.geolocation.getCurrentPosition(
          function (p) { set(p.coords.latitude, p.coords.longitude, null, true, true); },
          function () { alert("Impossible d'obtenir votre position"); },
          { enableHighAccuracy: true, timeout: 10000 });
      });
    }

    if (opts.searchInput) {
      var inp = typeof opts.searchInput === 'string' ? document.querySelector(opts.searchInput) : opts.searchInput;
      var box = document.createElement('div');
      box.className = 'gm-suggest';
      box.style.cssText = 'position:absolute;z-index:1000;background:#fff;border:1px solid #ccc;border-radius:6px;max-width:420px;display:none;box-shadow:0 4px 12px rgba(0,0,0,.2)';
      inp.parentNode.style.position = 'relative';
      inp.parentNode.appendChild(box);
      var timer;
      inp.addEventListener('input', function () {
        clearTimeout(timer);
        var q = inp.value.trim();
        if (q.length < 3) { box.style.display = 'none'; return; }
        timer = setTimeout(function () {
          search(q).then(function (res) {
            box.innerHTML = '';
            if (!res.length) { box.style.display = 'none'; return; }
            res.forEach(function (r) {
              var d = document.createElement('div');
              d.textContent = r.label;
              d.style.cssText = 'padding:8px 10px;cursor:pointer;font-size:14px;border-bottom:1px solid #eee';
              d.addEventListener('click', function () {
                inp.value = r.label; box.style.display = 'none';
                set(r.lat, r.lon, r.label, true, true);
              });
              box.appendChild(d);
            });
            box.style.display = 'block';
          }).catch(function () { box.style.display = 'none'; });
        }, 500);
      });
    }

    set(start[0], start[1], null);
    return { map: map, get: function () { return current; }, set: set };
  }

  // ---------- 2) Carte de suivi ----------
  /**
   * opts: { shop:[lat,lon], destination:[lat,lon],
   *         getDriverPosition: () => Promise<[lat,lon]> | [lat,lon],
   *         pollMs (3000), onUpdate({position, distance, duration}), onArrived() }
   * Retourne { stop(), map }
   */
  function track(el, opts) {
    var map = makeMap(el, opts.destination || DEFAULT_CENTER, 14);
    var poll = opts.pollMs || 3000;
    var shop = opts.shop && L.marker(opts.shop, { icon: ICONS.shop() }).addTo(map).bindTooltip('Boutique');
    var dest = L.marker(opts.destination, { icon: ICONS.dest() }).addTo(map).bindTooltip('Livraison');
    var driver = null, line = null, lastRouteAt = 0, lastRoute = null, stopped = false, timer, anim, arrived = false;

    function moveSmooth(to) {
      var from = driver.getLatLng(), t0 = performance.now(), dur = Math.min(poll, 2500);
      cancelAnimationFrame(anim);
      (function step(now) {
        var k = Math.min(1, (now - t0) / dur);
        driver.setLatLng([from.lat + (to[0] - from.lat) * k, from.lng + (to[1] - from.lng) * k]);
        if (k < 1) anim = requestAnimationFrame(step);
      })(t0);
    }

    function tick() {
      if (stopped) return;
      Promise.resolve(opts.getDriverPosition()).then(function (pos) {
        if (!pos) return;
        if (!driver) {
          driver = L.marker(pos, { icon: ICONS.driver(), zIndexOffset: 1000 }).addTo(map).bindTooltip('Livreur');
          map.fitBounds(L.latLngBounds([pos, opts.destination]).pad(0.3));
        } else { moveSmooth(pos); }

        var remaining = haversine(pos, opts.destination);
        if (remaining < 40 && !arrived) {
          arrived = true;
          if (line) { map.removeLayer(line); line = null; }
          opts.onUpdate && opts.onUpdate({ position: pos, distance: 0, duration: 0, arrived: true });
          opts.onArrived && opts.onArrived();
          return;
        }
        // Recalcule l'itinéraire restant au plus toutes les 10 s
        var p = Date.now() - lastRouteAt > 10000 ? route(pos, opts.destination) : Promise.resolve(lastRoute);
        return p.then(function (r) {
          if (r !== lastRoute) { lastRoute = r; lastRouteAt = Date.now(); }
          if (line) map.removeLayer(line);
          line = L.polyline(r.coords, { color: '#2563eb', weight: 5, opacity: .75, dashArray: r.fallback ? '8 8' : null }).addTo(map);
          opts.onUpdate && opts.onUpdate({ position: pos, distance: r.distance, duration: r.duration });
        });
      }).catch(function (e) { console.warn('[GabonMap] suivi :', e); })
        .then(function () { if (!stopped && !arrived) timer = setTimeout(tick, poll); });
    }
    tick();
    return { map: map, stop: function () { stopped = true; clearTimeout(timer); cancelAnimationFrame(anim); } };
  }

  // ---------- 3) Côté livreur ----------
  /** opts: { url, orderId, headers } — POST {orderId, lat, lon, ts} à chaque nouvelle position */
  function broadcast(opts) {
    if (!navigator.geolocation) throw new Error('Géolocalisation indisponible');
    var last = 0;
    var id = navigator.geolocation.watchPosition(function (p) {
      if (Date.now() - last < 3000) return;
      last = Date.now();
      fetch(opts.url, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {}),
        body: JSON.stringify({ orderId: opts.orderId, lat: p.coords.latitude, lon: p.coords.longitude, ts: p.timestamp })
      }).catch(function () {});
    }, function (e) { console.warn(e); }, { enableHighAccuracy: true, maximumAge: 2000 });
    return { stop: function () { navigator.geolocation.clearWatch(id); } };
  }

  // ---------- 4) Livreur simulé (démo/tests) ----------
  function simulateDriver(coords, durationMs) {
    var cum = [0];
    for (var i = 1; i < coords.length; i++) cum.push(cum[i - 1] + haversine(coords[i - 1], coords[i]));
    var total = cum[cum.length - 1], t0 = Date.now();
    return function () {
      var k = Math.min(1, (Date.now() - t0) / durationMs), d = k * total, j = 1;
      while (j < cum.length - 1 && cum[j] < d) j++;
      var seg = cum[j] - cum[j - 1] || 1, f = Math.min(1, Math.max(0, (d - cum[j - 1]) / seg));
      return [coords[j - 1][0] + (coords[j][0] - coords[j - 1][0]) * f,
              coords[j - 1][1] + (coords[j][1] - coords[j - 1][1]) * f];
    };
  }

  global.GabonMap = {
    load: load,
    DEFAULT_CENTER: DEFAULT_CENTER, pickLocation: pickLocation, track: track, broadcast: broadcast,
    simulateDriver: simulateDriver, route: route, search: search, reverse: reverse,
    haversine: haversine, fmtDist: fmtDist, fmtTime: fmtTime
  };
})(window);
