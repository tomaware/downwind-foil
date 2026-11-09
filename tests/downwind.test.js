'use strict';
const test = require('node:test');
const assert = require('node:assert');
const E = require('../lib/surf-engine.js');
const D = require('../engine/downwind-engine.js');
const doc = require('../engine/runs.json');

const cfg = D.merge(D.DEFAULT_CONFIG, {});
const sete = doc.runs.find((r) => r.id === 'frontignan-palavas');
const heading = D.bearing(sete.a, sete.b);
const sea = (h, t, d, cross) => ({ h, t, cross: cross || 0, hs: h });
const hour = (windFrom, kn, gkn, s, r) => D.score({ t: 0, windFrom, kn, gkn, agree: 1, sea: s, heading: r ? D.bearing(r.a, r.b) : heading, normal: (r || sete).normal, oneWay: !!(r && r.oneWay) }, cfg);

test('géométrie des parcours : la normale est perpendiculaire à la côte et pointe vers la mer', () => {
  doc.runs.forEach((r) => {
    const h = D.bearing(r.a, r.b);
    if (!r.crossing) assert.ok(Math.abs(Math.abs(E.angDiff(r.normal, h)) - 90) < 8, r.id + ' normale ⟂ côte');
    assert.ok(D.pathKm(r) >= D.distKm(r.a, r.b) - 1e-9 && D.pathKm(r) < D.distKm(r.a, r.b) * 1.2, r.id + ' tracé cohérent');
    assert.deepStrictEqual([r.path[0][0], r.path[0][1]], [r.a.lat, r.a.lon]);
  });
});

test('type de vent par rapport à la côte (Sète-Palavas, large au SE)', () => {
  assert.strictEqual(D.shoreKind(225, 144).code, 'side');     // SO : le long de la côte
  assert.strictEqual(D.shoreKind(135, 144).code, 'on');       // SE : de mer
  assert.strictEqual(D.shoreKind(315, 144).code, 'off');      // NO (mistral / tramontane) : de terre
  assert.strictEqual(D.shoreKind(270, 144).code, 'sideoff');  // O
  assert.strictEqual(D.shoreKind(50, 144).code, 'side');      // NE : le long de la côte, dans l'autre sens
  assert.strictEqual(D.shoreKind(90, 144).code, 'sideon');    // E : un peu de mer
});

test('SO 20 nd, houle 1 m 6 s dans le sens du vent : très bon, de Frontignan vers Palavas', () => {
  const x = hour(225, 20, 25, sea(1.0, 6, 225));
  assert.strictEqual(x.dir, 'ab');
  assert.ok(x.score >= 8, 'note ' + x.score);
  assert.ok(x.roundTrip, 'aller-retour possible');
  assert.deepStrictEqual(x.flags, []);
});

test('E 18 nd : même parcours dans l’autre sens', () => {
  const x = hour(65, 18, 22, sea(0.8, 5, 65));
  assert.strictEqual(x.dir, 'ba');
  assert.ok(x.score >= 6, 'note ' + x.score);
});

test('mistral / tramontane NO 25 nd : de terre, plafonné et signalé dangereux', () => {
  const x = hour(320, 25, 35, sea(0.4, 3, 320));
  assert.ok(x.score <= 1, 'note ' + x.score);
  assert.ok(x.flags.some((f) => /terre/.test(f)));
  assert.ok(!x.roundTrip);
});

test('vent trop faible : rien, même avec de belles bosses', () => {
  assert.strictEqual(hour(225, 9, 12, sea(1.2, 7, 225)).score, 0);
});

test('la période compte : clapot serré 3 s < bosses 6 s < houle 8 s', () => {
  const a = hour(225, 20, 24, sea(1, 3, 225)).score, b = hour(225, 20, 24, sea(1, 6, 225)).score, c = hour(225, 20, 24, sea(1, 8, 225)).score;
  assert.ok(a < b && b <= c, [a, b, c].join(' '));
});

test('mer croisée pénalisée', () => {
  const ok = hour(225, 20, 24, sea(1, 6, 225, 0)).score, x = hour(225, 20, 24, sea(1, 6, 225, 0.8)).score;
  assert.ok(x < ok * 0.75, ok + ' vs ' + x);
});

test('rafales irrégulières pénalisées et signalées', () => {
  const r = hour(225, 18, 31, sea(1, 6, 225));
  assert.ok(r.score < hour(225, 18, 22, sea(1, 6, 225)).score);
  assert.ok(r.flags.some((f) => /irrégulier/.test(f)));
});

test('niveaux : 30 nd va au confirmé, pas au débutant', () => {
  const x = hour(225, 30, 36, sea(1.5, 6, 225));
  assert.ok(x.scores.confirme > x.scores.debutant + 3, JSON.stringify(x.scores));
});

test('bumps() sépare la mer qui suit le vent de la mer croisée', () => {
  const st = { hs: 1.12, comps: [{ h: 1, t: 6, d: 230 }, { h: 0.5, t: 9, d: 120 }] };
  const b = D.bumps(st, 225, cfg);
  assert.ok(Math.abs(b.h - 1) < 1e-9 && b.t === 6);
  assert.ok(Math.abs(b.cross - 0.2) < 0.01);
});

test('créneaux : heures de jour consécutives, dans le même sens', () => {
  const mk = (h, sc, dir, day) => ({ t: h * 3600000, score: sc, dir, day, leadH: h, kn: 20, windFrom: 225, shore: 'side-shore', bumpH: 1, bumpT: 6, spacing: 56 });
  const rows = [mk(0, 6, 'ab', true), mk(1, 7, 'ab', true), mk(2, 7, 'ba', true), mk(3, 8, 'ba', true), mk(4, 8, 'ba', false), mk(5, 3, 'ab', true)];
  const w = D.windows(rows, sete, cfg);
  assert.strictEqual(w.length, 2);
  assert.strictEqual(w[0].from, sete.a.name);
  assert.strictEqual(w[1].from, sete.b.name);
  assert.strictEqual(w[1].n, 2, 'la nuit coupe le créneau');
});

// Scénario complet avec des données au format Open-Meteo
function fakeOM(points, n, t0, f) {
  return points.map((p) => {
    const time = [], h = {};
    for (let i = 0; i < n; i++) time.push(new Date(t0 + i * 3600000).toISOString().slice(0, 16));
    f(p, h, time);
    return { hourly: Object.assign({ time }, h) };
  });
}
test('run() de bout en bout : SO établi le jour 2 → créneau Frontignan → Palavas', () => {
  const t0 = Date.UTC(2026, 10, 10, 0);
  const pts = D.queryPoints(doc.runs, doc.buoys);
  const runPts = pts.filter((p) => !p.id.startsWith('buoy_'));
  const n = 96;
  const windSW = (i) => (i >= 30 && i <= 42 ? 20 * 1.852 : 6 * 1.852);
  const marineJ = fakeOM(pts, n, t0, (p, h) => {
    E.OM_WAVE_MODELS.forEach((m) => {
      const hs = Array.from({ length: n }, (_, i) => (i >= 30 && i <= 44 ? 1.1 : 0.3));
      h['wave_height_' + m] = hs; h['wave_period_' + m] = hs.map(() => 4.8); h['wave_peak_period_' + m] = hs.map((x) => (x > 1 ? 6 : 3.5));
      h['wave_direction_' + m] = hs.map(() => 225);
      h['wind_wave_height_' + m] = hs.map((x) => x * 0.95); h['wind_wave_peak_period_' + m] = hs.map((x) => (x > 1 ? 6 : 3.5)); h['wind_wave_direction_' + m] = hs.map(() => 225);
      h['swell_wave_height_' + m] = hs.map(() => 0.3); h['swell_wave_peak_period_' + m] = hs.map(() => 7); h['swell_wave_direction_' + m] = hs.map(() => 140);
    });
  });
  const windJ = fakeOM(runPts, n, t0, (p, h) => {
    Object.values(E.OM_WIND_MODELS).forEach((m) => {
      h['wind_speed_10m_' + m] = Array.from({ length: n }, (_, i) => windSW(i));
      h['wind_direction_10m_' + m] = Array.from({ length: n }, () => 225);
      h['wind_gusts_10m_' + m] = Array.from({ length: n }, (_, i) => windSW(i) * 1.25);
    });
  });
  const marine = E.mergeMarine(E.parseOpenMeteoMarine(marineJ, pts.map((p) => p.id)));
  const wind = E.parseOpenMeteoWind(windJ, runPts.map((p) => p.id));
  const res = D.run({ runs: doc.runs, buoys: doc.buoys, marine, wind, buoyObs: {}, now: t0 + 6 * 3600000, hours: 72 });
  const sp = res.runs.find((r) => r.id === 'frontignan-palavas');
  assert.ok(sp.windows.length >= 1, 'créneau trouvé');
  const w = sp.windows[0];
  assert.strictEqual(w.from, sete.a.name);
  assert.ok(w.mean >= 6, 'note ' + w.mean + ' ' + w.text);
  const peak = w.peak;
  assert.ok(peak.bumpH > 0.9 && peak.cross < 0.15, 'la houle de SE (0,3 m) compte comme mer croisée, la mer du vent porte : ' + JSON.stringify(peak));
  // traversée plage Sud → Grande-Motte (large à l'OSO) : le SO y souffle de la mer et dans le mauvais sens
  const ps = res.runs.find((r) => r.id === 'plagesud-grandemotte');
  const px = ps.rows.find((x) => x.t === peak.t);
  assert.strictEqual(px.shoreCode, 'on', px.shore);
  assert.ok(px.score < 4, 'note ' + px.score);
  const json = D.toJSON(res);
  assert.ok(json.best.length >= 1 && json.runs[0].hours[0].length === json.hourFields.length);
});

test('parcours à sens unique : plage Sud → Grande-Motte par SE, rien par NO', () => {
  const r = doc.runs.find((x) => x.id === 'plagesud-grandemotte');
  const se = hour(135, 20, 24, sea(1, 5.5, 135), r), no = hour(315, 20, 24, sea(0.5, 4, 315), r);
  assert.strictEqual(se.dir, 'ab'); assert.ok(se.score >= 6, 'SE ' + se.score);
  assert.strictEqual(no.score, 0); assert.ok(no.flags.some((f) => /sens unique/.test(f)) && !no.roundTrip);
  assert.ok(no.flags.some((f) => /side-off|terre/.test(f)), 'NO : dérive vers le large signalée');
});

test('vent corrigé par la super prévision : rapport au spot, recalage Winds-Up, effet limité autour du spot', () => {
  const t0 = Date.UTC(2026, 10, 12, 6), n = 12;
  const ws = D.DEFAULT_CONFIG.windSpots;
  const pts = ws.map((w) => ({ id: 'ws_' + w.id, lat: w.lat, lon: w.lon }));
  const windJ = fakeOM(pts, n, t0, (p, h) => {
    Object.values(E.OM_WIND_MODELS).forEach((m) => {
      h['wind_speed_10m_' + m] = Array(n).fill(16 * 1.852); h['wind_direction_10m_' + m] = Array(n).fill(135); h['wind_gusts_10m_' + m] = Array(n).fill(20 * 1.852);
    });
  });
  const wind = E.parseOpenMeteoWind(windJ, pts.map((p) => p.id));
  const gm = ws[0].id, pc = ws[1].id;
  const superPrev = {
    spots: { [gm]: Array.from({ length: n }, (_, i) => ({ t: t0 + i * 3600000, v: 20, o: 'SE' })), [pc]: Array.from({ length: n }, (_, i) => ({ t: t0 + i * 3600000, v: 16, o: 'SE' })) },
    live: { spots: { [pc]: { t: t0 + 2 * 3600000 - 600000, v: 24, o: 'SE' }, [gm]: { panne: true } } }
  };
  const cfg2 = D.merge(D.DEFAULT_CONFIG, {});
  const c = D.corrections({ superPrev, wind, now: t0 + 2 * 3600000 }, cfg2, E.mergeCfg(E.DEFAULT_CONFIG, {}));
  assert.strictEqual(c.length, 2);
  const cg = c.find((x) => x.id === gm), cp = c.find((x) => x.id === pc);
  assert.ok(Math.abs(cg.ratio[t0 + 5 * 3600000] - 1.25) < 1e-9, 'GM : 20 / 16');
  assert.ok(!cg.live, 'balise en panne ignorée');
  assert.ok(cp.live && cp.ratio[t0 + 2 * 3600000] > 1.35, 'PC recalé sur le relevé (24 / 16 → borné 1,4)');
  assert.ok(cp.ratio[t0 + 8 * 3600000] < 1.06, 'le recalage s’efface : ' + cp.ratio[t0 + 8 * 3600000]);
  const t = t0 + 5 * 3600000;
  assert.ok(Math.abs(D.corrAt([cg], ws[0].lat, ws[0].lon, t, cfg2) - 1.25) < 0.01, 'au spot');
  assert.ok(D.corrAt([cg], 43.43, 3.77, t, cfg2) < 1.01, 'à Frontignan (≈ 27 km) : pas d’effet');
  assert.strictEqual(D.corrAt([cg], 43.5, 4.0, t0 + 50 * 3600000, cfg2), 1, 'heure sans correction');
  assert.strictEqual(D.compassDeg('SSO'), 202.5);
});

test('grille de vent pour la carte', () => {
  const cfg2 = D.merge(D.DEFAULT_CONFIG, {});
  const g = D.gridPoints(cfg2);
  assert.strictEqual(g.length, cfg2.grid.nLat * cfg2.grid.nLon);
  assert.deepStrictEqual([g[0].lat, g[0].lon, g[g.length - 1].lat, g[g.length - 1].lon], [cfg2.grid.lat0, cfg2.grid.lon0, cfg2.grid.lat1, cfg2.grid.lon1]);
  assert.strictEqual(D.windPoints({}).length, g.length + cfg2.windSpots.length);
});
