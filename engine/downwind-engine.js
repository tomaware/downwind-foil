/*
 * Downwind wing foil — moteur de prévision (V1)
 * ---------------------------------------------
 * Pour chaque parcours le long de la côte et chaque heure : le vent (AROME → ARPEGE / ECMWF), la mer au
 * large (ensemble de modèles de vagues vérifié contre les bouées Candhis) et une note sur 10 qui dit si le
 * downwind vaut le coup, dans quel sens, et s'il est sûr.
 *
 * Critères (sources : guide Unifoil « Downwind Foiling Forecasting », retours de pratiquants, adaptés à la
 * Méditerranée où la mer du vent domine) :
 *   - vent régulier de 15 à 25 nd (selon le niveau), rafales pas trop irrégulières ;
 *   - vent le long de la côte (side-shore) ou un peu de mer (side-on) : jamais de terre (offshore) ;
 *   - bosses de 0,5 à 1,5 m qui avancent dans le sens du vent, bien espacées : la période compte plus que
 *     la hauteur (clapot serré < 4 s = freine le foil ; 6-8 s en Méditerranée = très bon ; ≥ 8 s = idéal) ;
 *   - mer croisée (houle d'une autre direction que le vent) pénalisée ;
 *   - de jour.
 * Le moteur réutilise surf-engine.js (lecture des données, calibration contre les bouées, mélange du vent).
 *
 * JS pur, sans dépendance : Node (collecteur, tests) et navigateur.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../lib/surf-engine.js'));
  else root.DownwindEngine = factory(root.SurfEngine);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  var KN = 1 / 1.852;   // km/h → nœuds

  var LEVELS = {
    // vent en nœuds : [début, idéal min, idéal max, limite]
    debutant: { label: 'débutant', wind: [15, 18, 23, 27], seaMax: 1.5 },
    intermediaire: { label: 'intermédiaire', wind: [13, 16, 25, 30], seaMax: 2.0 },
    confirme: { label: 'confirmé', wind: [11, 14, 28, 35], seaMax: 3.0 }
  };

  var DEFAULT_CONFIG = {
    level: 'intermediaire',
    offshoreKm: 2,            // la mer est lue à 2 km du bord, là où l'on navigue
    // angle entre le vent (d'où il vient) et le large vu de la plage : 0 = de mer, 90 = le long de la côte, 180 = de terre
    shore: [[0, 0.55], [25, 0.6], [45, 0.85], [60, 1], [100, 1], [115, 0.55], [130, 0.15], [140, 0]],
    // écart entre le sens du vent et l'axe du parcours (°) : au-delà de 60°, ce n'est plus un downwind
    along: [[0, 1], [25, 1], [45, 0.75], [60, 0.4], [75, 0]],
    // bosses : hauteur (m) de la mer qui avance avec le vent
    bumpH: [[0, 0.15], [0.25, 0.3], [0.5, 0.85], [0.7, 1], [1.5, 1], [2.0, 0.85], [2.5, 0.6], [3.5, 0.35]],
    // période pic (s) des bosses : espacement ≈ 1,56 · T² m (4 s ≈ 25 m, 6 s ≈ 56 m, 8 s ≈ 100 m)
    bumpT: [[2.5, 0.25], [3.5, 0.45], [4.5, 0.7], [5.5, 0.85], [6.5, 0.95], [8, 1]],
    alignDeg: 50,             // composante de mer « avec le vent » si sa direction est à moins de 50° de celle du vent
    crossMalus: 0.5,          // mer croisée : note × (1 − 0,5 × part d'énergie croisée)
    gust: [[1.25, 1], [1.45, 0.9], [1.7, 0.7], [2.0, 0.5]],   // rafales / vent moyen
    daylightElevation: -2,
    windowThreshold: 5,       // note mini d'un créneau
    windowMinHours: 2,
    upwindMaxKn: 26,          // aller-retour possible (remonter puis redescendre) jusqu'à ce vent, côte side-shore
    nowcast: { maxAgeH: 3, decayH: 3.5, ratioClip: [0.6, 1.6] },
    // vent corrigé de la super prévision (spots Winds-Up) : appliqué autour de chaque spot
    windSpots: [
      { id: '135-la-grande-motte', name: 'La Grande-Motte', lat: 43.545, lon: 4.085 },
      { id: '22-port-camargue', name: 'Port Camargue', lat: 43.480, lon: 4.130 }
    ],
    corrRadiusKm: 12,           // poids exp(−(d/12 km)²) : ~1 au spot, 0,5 à 10 km, ~0 au-delà de 25 km
    corrClip: [0.7, 1.4],       // correction de vitesse bornée
    liveMaxAgeMin: 90, liveDecayH: 3,
    // grille de vent pour la carte
    grid: { lat0: 43.36, lat1: 43.62, lon0: 3.68, lon1: 4.20, nLat: 7, nLon: 9 }
  };

  function isNum(x) { return typeof x === 'number' && isFinite(x); }
  function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }
  function merge(a, b) {
    var o = JSON.parse(JSON.stringify(a));
    Object.keys(b || {}).forEach(function (k) {
      o[k] = (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) && o[k] && typeof o[k] === 'object') ? merge(o[k], b[k]) : b[k];
    });
    return o;
  }

  /** cap (°) et distance (km) de p à q */
  function bearing(p, q) {
    var r = Math.PI / 180, y = Math.sin((q.lon - p.lon) * r) * Math.cos(q.lat * r);
    var x = Math.cos(p.lat * r) * Math.sin(q.lat * r) - Math.sin(p.lat * r) * Math.cos(q.lat * r) * Math.cos((q.lon - p.lon) * r);
    return E.norm360(Math.atan2(y, x) / r);
  }
  function distKm(p, q) {
    var r = Math.PI / 180, dLat = (q.lat - p.lat) * r, dLon = (q.lon - p.lon) * r;
    var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(p.lat * r) * Math.cos(q.lat * r) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * 6371 * Math.asin(Math.sqrt(h));
  }

  /** tracé du parcours (au large) : r.path, sinon la droite a → b */
  function pathOf(r) { return r.path && r.path.length >= 2 ? r.path.map(function (c) { return { lat: c[0], lon: c[1] }; }) : [r.a, r.b]; }
  function pathKm(r) { var p = pathOf(r), k = 0; for (var i = 1; i < p.length; i++) k += distKm(p[i - 1], p[i]); return k; }
  /** point à la fraction f de la longueur du tracé */
  function along(r, f) {
    var p = pathOf(r), tot = pathKm(r), goal = f * tot, acc = 0;
    for (var i = 1; i < p.length; i++) {
      var d = distKm(p[i - 1], p[i]);
      if (acc + d >= goal) { var g = d ? (goal - acc) / d : 0; return { lat: p[i - 1].lat + g * (p[i].lat - p[i - 1].lat), lon: p[i - 1].lon + g * (p[i].lon - p[i - 1].lon) }; }
      acc += d;
    }
    return p[p.length - 1];
  }

  /** points de prévision : 2 points en mer (au tiers et aux deux tiers du parcours) + la bouée */
  function queryPoints(runs, buoys, cfg) {
    cfg = merge(DEFAULT_CONFIG, cfg);
    var pts = [];
    runs.forEach(function (r) {
      [1 / 3, 2 / 3].forEach(function (f, i) {
        var q = along(r, f);
        // le tracé est déjà ~1,2 km au large : on va chercher la mer à offshoreKm du bord
        var p = E.offsetPoint(q.lat, q.lon, r.normal, r.path ? Math.max(0.5, cfg.offshoreKm - 1.2) : cfg.offshoreKm);
        pts.push({ id: r.id + '_' + i, run: r.id, lat: p.lat, lon: p.lon });
      });
    });
    (buoys || []).forEach(function (b) { pts.push({ id: 'buoy_' + b.code, lat: b.lat, lon: b.lon }); });
    return pts;
  }

  /** type de vent par rapport à la côte */
  function shoreKind(windFrom, normal) {
    var a = Math.abs(E.angDiff(windFrom, normal));
    if (a < 35) return { a: a, kind: 'de mer', code: 'on' };
    if (a < 65) return { a: a, kind: 'side-on', code: 'sideon' };
    if (a <= 105) return { a: a, kind: 'side-shore', code: 'side' };
    if (a <= 135) return { a: a, kind: 'side-off', code: 'sideoff' };
    return { a: a, kind: 'de terre', code: 'off' };
  }

  function windFactor(kn, lv) {
    var w = lv.wind;
    if (!isNum(kn) || kn < w[0]) return 0;
    if (kn < w[1]) return 0.35 + 0.65 * (kn - w[0]) / (w[1] - w[0]);
    if (kn <= w[2]) return 1;
    if (kn <= w[3]) return 1 - 0.6 * (kn - w[2]) / (w[3] - w[2]);
    return 0.2;   // au-delà de la limite du niveau : réservé aux plus aguerris
  }

  /**
   * Mer qui « porte » : sépare l'énergie des composantes (houles + mer du vent) qui avancent avec le vent
   * de celles qui croisent. Renvoie { h, t, cross, hs } pour un modèle.
   */
  function bumps(state, windFrom, cfg) {
    var comps = state.comps && state.comps.length ? state.comps : (isNum(state.tp) && state.dir != null ? [{ h: state.hs, t: state.tp, d: state.dir }] : []);
    var eA = 0, eX = 0, tA = 0;
    comps.forEach(function (c) {
      var e = c.h * c.h;
      if (Math.abs(E.angDiff(c.d, windFrom)) <= cfg.alignDeg) { eA += e; tA += e * c.t; } else eX += e;
    });
    var tot = eA + eX;
    return { h: Math.sqrt(eA), t: eA > 0 ? tA / eA : null, cross: tot > 0 ? eX / tot : 0, hs: state.hs };
  }

  /** moyenne pondérée des modèles (poids et biais issus de la vérification contre la bouée) */
  function seaAt(pointData, t, windFrom, cal, ecfg, cfg) {
    var mods = E.modelsAt(pointData, t, ecfg);
    if (!mods.length) return null;
    var W = 0, h = 0, tt = 0, wt = 0, cross = 0, hs = 0;
    mods.forEach(function (m) {
      var c = cal[m.name] || { weight: 0.5, bias: 1 };
      var b = bumps(m.state, windFrom, cfg);
      W += c.weight; h += c.weight * b.h * c.bias; cross += c.weight * b.cross; hs += c.weight * b.hs * c.bias;
      if (isNum(b.t)) { tt += c.weight * b.t; wt += c.weight; }
    });
    return { h: h / W, t: wt ? tt / wt : null, cross: cross / W, hs: hs / W, n: mods.length };
  }

  /** vent de chaque modèle à t (km/h) : { meteofrance: {spd,dir,gust}, ecmwf: {...} } */
  function windAt(wd, t) {
    var res = {};
    if (!wd) return res;
    Object.keys(wd.models).forEach(function (k) {
      var m = wd.models[k];
      var s = E.valueAt(wd.time, m.spd, t), d = E.valueAt(wd.time, m.dir, t, true), g = E.valueAt(wd.time, m.gust, t);
      if (isNum(s) && d != null) res[k] = { spd: s, dir: d, gust: isNum(g) ? g : null };
    });
    return res;
  }

  /** vent mélangé (AROME → ECMWF) d'un point : { spd (km/h), dir, gust } */
  function rawWind(wd, t, leadH, ecfg) { var w = windAt(wd, t); return w && Object.keys(w).length ? E.blendWind(w, leadH, ecfg) : null; }

  var DIR16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];
  function compassDeg(o) { var i = DIR16.indexOf(String(o || '').toUpperCase().replace('W', 'O')); return i < 0 ? null : i * 22.5; }

  /**
   * Corrections de vitesse issues de la super prévision vent : rapport (vent corrigé du spot) / (vent brut au spot),
   * heure par heure, puis recalage sur le dernier relevé Winds-Up (qui s'efface en quelques heures).
   * Les relevés eux-mêmes ne sortent jamais du calcul.
   */
  function corrections(ctx, cfg, ecfg) {
    var sp = ctx.superPrev;
    if (!sp || !sp.spots) return [];
    var now = ctx.now, out = [];
    cfg.windSpots.forEach(function (ws) {
      var series = sp.spots[ws.id], wd = ctx.wind['ws_' + ws.id];
      if (!wd) return;
      var ratio = {}, n = 0, live = false;
      (series || []).forEach(function (p) {
        if (!isNum(p.v)) return;
        var raw = rawWind(wd, p.t, (p.t - now) / 3600000, ecfg);
        if (!raw || raw.spd * KN < 4) return;
        ratio[p.t] = clamp(p.v / (raw.spd * KN), cfg.corrClip[0], cfg.corrClip[1]); n++;
      });
      var l = sp.live && sp.live.spots && sp.live.spots[ws.id];
      if (l && !l.panne && isNum(l.v) && isNum(l.t) && now - l.t <= cfg.liveMaxAgeMin * 60000) {
        var th = Math.round(l.t / 3600000) * 3600000, rawL = rawWind(wd, th, (th - now) / 3600000, ecfg);
        if (rawL && rawL.spd * KN >= 4) {
          var lr = clamp(l.v / (rawL.spd * KN), cfg.corrClip[0], cfg.corrClip[1]);
          live = true;
          for (var k = 0; k <= 6; k++) {
            var t = th + k * 3600000, w = Math.exp(-k / cfg.liveDecayH);
            ratio[t] = isNum(ratio[t]) ? ratio[t] * (1 - w) + lr * w : 1 + (lr - 1) * w;
          }
        }
      }
      if (n || live) out.push({ id: ws.id, name: ws.name, lat: ws.lat, lon: ws.lon, ratio: ratio, hours: n, live: live });
    });
    return out;
  }

  /** facteur de vitesse à appliquer en (lat, lon) à l'heure t */
  function corrAt(corrs, lat, lon, t, cfg) {
    var sw = 0, s = 0;
    (corrs || []).forEach(function (c) {
      var r = c.ratio[t];
      if (!isNum(r)) return;
      var d = distKm({ lat: lat, lon: lon }, c), w = Math.exp(-Math.pow(d / cfg.corrRadiusKm, 2));
      sw += w; s += w * (r - 1);
    });
    return sw > 0.02 ? 1 + s / Math.max(1, sw) : 1;
  }

  function gridPoints(cfg) {
    var g = cfg.grid, pts = [];
    for (var i = 0; i < g.nLat; i++) for (var j = 0; j < g.nLon; j++) {
      pts.push({ id: 'g_' + i + '_' + j, lat: +(g.lat0 + i * (g.lat1 - g.lat0) / (g.nLat - 1)).toFixed(4), lon: +(g.lon0 + j * (g.lon1 - g.lon0) / (g.nLon - 1)).toFixed(4) });
    }
    return pts;
  }
  /** points de vent supplémentaires : grille de la carte + spots de la super prévision */
  function windPoints(cfg) {
    cfg = merge(DEFAULT_CONFIG, cfg);
    return gridPoints(cfg).concat(cfg.windSpots.map(function (w) { return { id: 'ws_' + w.id, lat: w.lat, lon: w.lon }; }));
  }

  function daylight(t, lat, lon, cfg) { return E.solarElevation(t, lat, lon) > cfg.daylightElevation; }

  /**
   * Prévision de tous les parcours.
   * ctx : { runs, buoys, marine (mergeMarine), wind ({pointId: parseOpenMeteoWind}), buoyObs, now, hours, cfg }
   */
  function run(ctx) {
    var cfg = merge(DEFAULT_CONFIG, ctx.cfg || {});
    var ecfg = E.mergeCfg(E.DEFAULT_CONFIG, ctx.surfCfg || {});
    var now = ctx.now, hours = ctx.hours || 96;
    var t0 = Math.floor(now / 3600000) * 3600000;
    // calibration des modèles de vagues à chaque bouée (mêmes réglages que Super Prévi Surf : 3 derniers jours)
    var calib = {}, nowObs = {};
    (ctx.buoys || []).forEach(function (b) {
      var obs = (ctx.buoyObs[b.code] || []).filter(function (o) { return isNum(o.hs) && o.t <= now && o.t > now - 3 * 86400000; });
      var pd = ctx.marine['buoy_' + b.code];
      calib[b.code] = E.modelCalibration(E.verifyAgainstBuoy(obs, pd, ecfg, now), ecfg);
      var last = obs[obs.length - 1];
      if (last && pd && now - last.t <= cfg.nowcast.maxAgeH * 3600000) {
        var mods = E.modelsAt(pd, last.t, ecfg), ens = mods.length ? E.ensembleHs(mods, calib[b.code]) : null;
        if (isNum(ens) && ens > 0.15) nowObs[b.code] = { t: last.t, hs: last.hs, tm: last.tm, ratio: clamp(last.hs / ens, cfg.nowcast.ratioClip[0], cfg.nowcast.ratioClip[1]) };
      }
    });

    var corrs = corrections(ctx, cfg, ecfg);
    var ptById = {};
    queryPoints(ctx.runs, [], cfg).forEach(function (p) { ptById[p.id] = p; });
    var out = ctx.runs.map(function (r) {
      var heading = bearing(r.a, r.b), km = pathKm(r);
      var cal = calib[r.buoy] || E.modelCalibration(null, ecfg);
      var nc = nowObs[r.buoy];
      var mid = { lat: (r.a.lat + r.b.lat) / 2, lon: (r.a.lon + r.b.lon) / 2 };
      var rows = [];
      for (var k = 0; k < hours; k++) {
        var t = t0 + k * 3600000, leadH = (t - now) / 3600000;
        var winds = [0, 1].map(function (i) {
          var w = rawWind(ctx.wind[r.id + '_' + i], t, leadH, ecfg), p = ptById[r.id + '_' + i];
          if (w && p) { var f = corrAt(corrs, p.lat, p.lon, t, cfg); w.spd *= f; if (isNum(w.gust)) w.gust *= f; w.corr = f; }
          return w;
        }).filter(Boolean);
        if (!winds.length) { rows.push({ t: t, missing: true }); continue; }
        // moyenne des 2 points du parcours
        var u = 0, v = 0, spd = 0, gust = 0, ng = 0, agree = 0;
        winds.forEach(function (w) {
          u += w.spd * Math.sin(w.dir * Math.PI / 180); v += w.spd * Math.cos(w.dir * Math.PI / 180); spd += w.spd; agree += w.agree;
          if (isNum(w.gust)) { gust += w.gust; ng++; }
        });
        var windFrom = E.norm360(Math.atan2(u, v) * 180 / Math.PI);
        var kn = spd / winds.length * KN, gkn = ng ? gust / ng * KN : null;
        var sea = [0, 1].map(function (i) { return seaAt(ctx.marine[r.id + '_' + i], t, windFrom, cal, ecfg, cfg); }).filter(Boolean);
        var s = sea.length ? {
          h: sea.reduce(function (a, x) { return a + x.h; }, 0) / sea.length,
          t: E.median(sea.map(function (x) { return x.t; })),
          cross: sea.reduce(function (a, x) { return a + x.cross; }, 0) / sea.length,
          hs: sea.reduce(function (a, x) { return a + x.hs; }, 0) / sea.length
        } : null;
        // correction « maintenant » par la dernière mesure de la bouée, qui s'efface en quelques heures
        if (s && nc && leadH >= -1) {
          var f = 1 + (nc.ratio - 1) * Math.exp(-Math.max(0, (t - nc.t) / 3600000) / cfg.nowcast.decayH);
          s.h *= f; s.hs *= f;
        }
        var corrF = winds.reduce(function (a, w) { return a + (w.corr || 1); }, 0) / winds.length;
        var row = score({ t: t, windFrom: windFrom, kn: kn, gkn: gkn, agree: agree / winds.length, sea: s, heading: heading, normal: r.normal, oneWay: !!r.oneWay }, cfg);
        row.leadH = Math.round(leadH);
        row.corr = Math.round(corrF * 100) / 100;
        row.day = daylight(t, mid.lat, mid.lon, cfg);
        rows.push(row);
      }
      return {
        id: r.id, name: r.name, a: r.a.name, b: r.b.name, coords: pathOf(r).map(function (c) { return [c.lat, c.lon]; }), oneWay: !!r.oneWay, label: r.label || { bearing: r.normal, km: 2.5 }, km: Math.round(km), heading: Math.round(heading), normal: r.normal,
        buoy: r.buoy, nowObs: nc || null, access: r.access || [], confidence: r.confidence, notes: r.notes,
        rows: rows, windows: windows(rows, r, cfg)
      };
    });
    // grille de vent pour la carte (heures de jour élargies), avec la même correction
    var gp = gridPoints(cfg), gc = { lat: (cfg.grid.lat0 + cfg.grid.lat1) / 2, lon: (cfg.grid.lon0 + cfg.grid.lon1) / 2 };
    var grid = { lats: [], lons: [], n: [cfg.grid.nLat, cfg.grid.nLon], times: [], kn: [], dir: [] };
    for (var gi = 0; gi < cfg.grid.nLat; gi++) grid.lats.push(gp[gi * cfg.grid.nLon].lat);
    for (var gj = 0; gj < cfg.grid.nLon; gj++) grid.lons.push(gp[gj].lon);
    for (var k2 = 0; k2 < hours; k2++) {
      var tg = t0 + k2 * 3600000;
      if (E.solarElevation(tg, gc.lat, gc.lon) < -12) continue;
      var kn2 = [], dr2 = [], ok = 0;
      gp.forEach(function (p) {
        var w = rawWind(ctx.wind[p.id], tg, (tg - now) / 3600000, ecfg);
        if (!w) { kn2.push(null); dr2.push(null); return; }
        ok++; kn2.push(Math.round(w.spd * KN * corrAt(corrs, p.lat, p.lon, tg, cfg) * 10) / 10); dr2.push(Math.round(w.dir));
      });
      if (ok) { grid.times.push(tg); grid.kn.push(kn2); grid.dir.push(dr2); }
    }
    return { now: now, level: cfg.level, runs: out, calib: calib, cfg: cfg, grid: grid,
      correction: corrs.map(function (c) {
        var v = Object.keys(c.ratio).map(function (k) { return c.ratio[k]; });
        return { spot: c.name, hours: c.hours, live: c.live, ratioMin: v.length ? Math.round(Math.min.apply(null, v) * 100) / 100 : null,
          ratioMoy: v.length ? Math.round(v.reduce(function (a, x) { return a + x; }, 0) / v.length * 100) / 100 : null, ratioMax: v.length ? Math.round(Math.max.apply(null, v) * 100) / 100 : null };
      }) };
  }

  /** note d'une heure (0-10) pour chaque niveau + explication */
  function score(x, cfg) {
    var sk = shoreKind(x.windFrom, x.normal);
    var windTo = E.norm360(x.windFrom + 180);
    // sens du parcours : a→b si le vent pousse vers b, sinon b→a
    var dAB = Math.abs(E.angDiff(windTo, x.heading)), dBA = Math.abs(E.angDiff(windTo, x.heading + 180));
    var dir = dAB <= dBA ? 'ab' : 'ba', along = Math.min(dAB, dBA);
    var fShore = E.interp(cfg.shore, sk.a), fAlong = E.interp(cfg.along, along);
    var gr = isNum(x.gkn) && x.kn > 5 ? x.gkn / x.kn : 1;
    var fGust = E.interp(cfg.gust, gr);
    var s = x.sea;
    var fH = s ? E.interp(cfg.bumpH, s.h) : 0.5, fT = s && isNum(s.t) ? E.interp(cfg.bumpT, s.t) : 0.6;
    var fCross = s ? 1 - cfg.crossMalus * s.cross : 1;
    var flags = [];
    if (sk.code === 'off') flags.push('vent de terre : dangereux, on est poussé au large');
    else if (sk.code === 'sideoff') flags.push('side-off : à plusieurs et avec une sortie sûre');
    if (gr >= 1.6) flags.push('vent irrégulier (rafales ' + Math.round(x.gkn) + ' nd)');
    if (s && s.cross > 0.4) flags.push('mer croisée');
    var wrongWay = x.oneWay && dir === 'ba';
    if (wrongWay) flags.push('parcours à sens unique : vent dans le mauvais sens');
    var scores = {};
    Object.keys(LEVELS).forEach(function (k) {
      var lv = LEVELS[k];
      var fW = windFactor(x.kn, lv);
      var fSea = s && s.h > lv.seaMax ? Math.max(0.3, 1 - 0.5 * (s.h - lv.seaMax)) : 1;
      // le vent fait l'essentiel (pas de vent, pas de downwind) ; la mer décide entre « correct » et « top »
      var sc = 10 * fW * fShore * fAlong * fGust * (0.35 + 0.65 * fH * fT * fCross) * fSea;
      if (sk.code === 'off') sc = Math.min(sc, 1);
      if (wrongWay) sc = 0;
      if (k === 'debutant' && sk.code === 'sideoff') sc = Math.min(sc, 2);
      scores[k] = Math.round(sc * 10) / 10;
    });
    var lvl = LEVELS[cfg.level] || LEVELS.intermediaire;
    // aller-retour : remonter le vent puis redescendre, possible si le vent est le long de la côte et pas trop fort
    var roundTrip = !x.oneWay && (sk.code === 'side' || sk.code === 'sideon') && x.kn >= lvl.wind[0] && x.kn <= cfg.upwindMaxKn;
    return {
      t: x.t, kn: Math.round(x.kn * 10) / 10, gust: isNum(x.gkn) ? Math.round(x.gkn) : null, windFrom: Math.round(x.windFrom),
      shore: sk.kind, shoreCode: sk.code, dir: dir, along: Math.round(along), agree: Math.round(x.agree * 100) / 100,
      bumpH: s ? Math.round(s.h * 100) / 100 : null, bumpT: s && isNum(s.t) ? Math.round(s.t * 10) / 10 : null,
      spacing: s && isNum(s.t) ? Math.round(1.56 * s.t * s.t) : null,
      hs: s ? Math.round(s.hs * 100) / 100 : null, cross: s ? Math.round(s.cross * 100) / 100 : null,
      scores: scores, score: scores[cfg.level] != null ? scores[cfg.level] : scores.intermediaire,
      roundTrip: roundTrip, flags: flags,
      factors: { wind: +windFactor(x.kn, lvl).toFixed(2), shore: +fShore.toFixed(2), along: +fAlong.toFixed(2), gust: +fGust.toFixed(2), bumpH: +fH.toFixed(2), bumpT: +fT.toFixed(2), cross: +fCross.toFixed(2) }
    };
  }

  /** créneaux de jour : au moins 2 h d'affilée ≥ seuil, dans le même sens */
  function windows(rows, r, cfg) {
    var out = [], cur = null;
    function close() {
      if (cur && cur.n >= cfg.windowMinHours) {
        cur.mean = Math.round(cur.sum / cur.n * 10) / 10;
        cur.end += 3600000;
        cur.from = cur.dir === 'ab' ? r.a.name : r.b.name; cur.to = cur.dir === 'ab' ? r.b.name : r.a.name;
        cur.text = describe(cur.peak);
        delete cur.sum;
        out.push(cur);
      }
      cur = null;
    }
    rows.forEach(function (x) {
      var ok = !x.missing && x.day && x.leadH > -1 && x.score >= cfg.windowThreshold;
      if (ok && cur && cur.dir === x.dir) { cur.end = x.t; cur.sum += x.score; cur.n++; if (x.score > cur.peak.score) cur.peak = x; return; }
      close();
      if (ok) cur = { run: r.id, dir: x.dir, start: x.t, end: x.t, sum: x.score, n: 1, peak: x };
    });
    close();
    return out;
  }

  function describe(x) {
    var p = [Math.round(x.kn) + ' nd ' + E.compass(x.windFrom) + (x.gust ? ' (raf. ' + x.gust + ')' : ''), x.shore];
    if (x.bumpH != null) p.push('houle ' + E.fmt(x.bumpH) + ' m' + (x.bumpT ? ' · ' + E.fmt(x.bumpT, 0) + ' s (~' + x.spacing + ' m)' : ''));
    if (x.cross > 0.4) p.push('mer croisée');
    return p.join(' · ');
  }

  /** forecast JSON compact pour l'app / le site */
  function toJSON(res, meta) {
    var all = [];
    res.runs.forEach(function (r) { r.windows.forEach(function (w) { all.push(w); }); });
    all.sort(function (a, b) { return (b.mean * 0.6 + b.peak.score * 0.4 + Math.min(b.n, 5) * 0.1) - (a.mean * 0.6 + a.peak.score * 0.4 + Math.min(a.n, 5) * 0.1); });
    return {
      generated: new Date(res.now).toISOString(), level: res.level, levels: Object.keys(LEVELS).map(function (k) { return { id: k, label: LEVELS[k].label, wind: LEVELS[k].wind }; }),
      meta: meta || {},
      correction: res.correction || [],
      grid: res.grid || null,
      best: all.slice(0, 10).map(function (w) { return { run: w.run, from: w.from, to: w.to, start: w.start, end: w.end, mean: w.mean, peak: w.peak.score, text: w.text }; }),
      runs: res.runs.map(function (r) {
        return {
          id: r.id, name: r.name, a: r.a, b: r.b, coords: r.coords, oneWay: r.oneWay, label: r.label, km: r.km, heading: r.heading, normal: r.normal, buoy: r.buoy, nowObs: r.nowObs,
          access: r.access, confidence: r.confidence, notes: r.notes,
          windows: r.windows.map(function (w) { return { from: w.from, to: w.to, start: w.start, end: w.end, mean: w.mean, peak: w.peak.score, text: w.text }; }),
          hours: r.rows.filter(function (x) { return !x.missing; }).map(function (x) {
            return [x.t, x.kn, x.gust, x.windFrom, x.shoreCode, x.dir, x.bumpH, x.bumpT, x.hs, x.cross, x.scores.debutant, x.scores.intermediaire, x.scores.confirme, x.day ? 1 : 0, x.roundTrip ? 1 : 0];
          })
        };
      }),
      hourFields: ['t', 'kn', 'gust', 'windFrom', 'shore', 'dir', 'bumpH', 'bumpT', 'hs', 'cross', 'debutant', 'intermediaire', 'confirme', 'day', 'roundTrip']
    };
  }

  return { VERSION: '1.1.0', corrections: corrections, corrAt: corrAt, compassDeg: compassDeg, windPoints: windPoints, gridPoints: gridPoints, DEFAULT_CONFIG: DEFAULT_CONFIG, LEVELS: LEVELS, bearing: bearing, distKm: distKm, queryPoints: queryPoints,
    shoreKind: shoreKind, pathOf: pathOf, pathKm: pathKm, along: along, windFactor: windFactor, bumps: bumps, score: score, run: run, windows: windows, describe: describe, toJSON: toJSON, merge: merge };
});
