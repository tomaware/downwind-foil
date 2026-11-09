#!/usr/bin/env node
/*
 * Calcul complet → data/downwind.json + data/PREVISION.md
 *   - vent : Open-Meteo, AROME/ARPEGE (meteofrance_seamless) mélangé à ECMWF IFS selon l'échéance
 *   - mer : Open-Meteo Marine, 5 modèles de vagues (houles + mer du vent séparées), 2 km au large
 *   - bouées Candhis : historique publié par Super Prévi Surf (data/history/buoys.json, dépôt public)
 * Usage : node collector/build.js [--offline fichier.json]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const E = require('../lib/surf-engine.js');
const D = require('../engine/downwind-engine.js');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'data');
const BUOYS_URL = 'https://raw.githubusercontent.com/tomaware/super-previ-surf/main/data/history/buoys.json';

async function getJSON(url, tries = 3) {
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'downwind-foil/1.0 (usage personnel)' } });
      if (r.ok) return await r.json();
      if (r.status < 500 && r.status !== 429) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
    } catch (e) { if (i === tries) throw e; }
    await new Promise((res) => setTimeout(res, 3000 * i));
  }
  throw new Error('échec ' + url);
}
const readJSON = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return d; } };

async function main() {
  const doc = readJSON(path.join(ROOT, 'engine', 'runs.json'));
  const cfg = readJSON(path.join(ROOT, 'engine', 'config.json'), {});
  const pts = D.queryPoints(doc.runs, doc.buoys, cfg);
  const runPts = pts.filter((p) => !p.id.startsWith('buoy_'));
  const windPts = runPts.concat(D.windPoints(cfg));   // + grille de la carte + spots de la super prévision
  const offline = process.argv.includes('--offline') ? readJSON(process.argv[process.argv.indexOf('--offline') + 1]) : null;
  let marineJ, windJ, hist, superPrev = null;
  if (offline) ({ marineJ, windJ, hist, superPrev } = offline);
  else {
    marineJ = await getJSON(E.openMeteoMarineURL(pts, { pastDays: 3, forecastDays: 5 }));
    windJ = await getJSON(E.openMeteoWindURL(windPts, { pastDays: 1, forecastDays: 5 }));
    // Vent corrigé de la super prévision (+ relevés Winds-Up, utilisés seulement pour recaler, jamais publiés)
    const sp = (process.env.SUPER_PREVISION_URL || '').trim();
    if (sp) {
      try {
        const j = await getJSON(sp + (sp.includes('?') ? '&' : '?') + 'action=widget', 2);
        if (j && j.spots) superPrev = { spots: j.spots, live: j.live && j.live.spots ? { spots: j.live.spots } : null };
        else console.warn('[build] super prévision : réponse inattendue', JSON.stringify(j).slice(0, 120));
      } catch (e) { console.warn('[build] super prévision indisponible :', e.message); }
    } else console.log('[build] super prévision : pas de lien (secret SUPER_PREVISION_URL) → vent AROME / ECMWF brut');
    try { hist = await getJSON(BUOYS_URL); } catch (e) { console.warn('[build] bouées indisponibles :', e.message); hist = {}; }
  }
  const marine = E.mergeMarine(E.parseOpenMeteoMarine(marineJ, pts.map((p) => p.id)));
  const wind = E.parseOpenMeteoWind(windJ, windPts.map((p) => p.id));
  const buoyObs = {};
  Object.keys(hist || {}).forEach((c) => { buoyObs[c] = hist[c].filter((o) => o.hs != null); });
  const now = offline && offline.now ? offline.now : Date.now();
  const res = D.run({ runs: doc.runs, buoys: doc.buoys, marine, wind, buoyObs, now, cfg, hours: 96, superPrev });
  console.log('[build] correction du vent : ' + (res.correction.length ? res.correction.map((c) => `${c.spot} ${c.hours} h (vitesse × ${c.ratioMin}…${c.ratioMoy}…${c.ratioMax})${c.live ? ' + relevé en direct' : ''}`).join(' ; ') : 'aucune') + ` ; grille ${res.grid.times.length} h`);

  const waveModels = [...new Set(Object.values(marine).flatMap((p) => p.series.flatMap((s) => Object.keys(s.models))))];
  const windModels = [...new Set(Object.values(wind).flatMap((p) => Object.keys(p.models)))];
  const verified = {};
  Object.keys(res.calib).forEach((c) => { verified[c] = Object.keys(res.calib[c]).filter((m) => res.calib[c][m].verified).length; });
  const out = D.toJSON(res, { waveModels, windModels, verifiedModelsPerBuoy: verified, buoysLast: Object.fromEntries(Object.entries(buoyObs).map(([c, o]) => [c, o.length ? o[o.length - 1].t : null])) });
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'downwind.json'), JSON.stringify(out));
  fs.writeFileSync(path.join(DATA, 'PREVISION.md'), markdown(res, out));
  const top = out.best.slice(0, 3).map((w) => `${w.from}→${w.to} ${new Date(w.start).toISOString().slice(5, 13)}Z ${w.mean}`).join(' | ');
  console.log(`[build] ${out.runs.length} parcours ; vagues : ${waveModels.join(',')} ; vent : ${windModels.join(',')} ; modèles vérifiés par bouée : ${JSON.stringify(verified)} ; meilleurs : ${top || 'aucun créneau'}`);
  if (!waveModels.length || !windModels.length) { console.error('[build] données manquantes'); process.exit(1); }
}

const TZ = 'Europe/Paris';
const fmtT = (t, o) => new Date(t).toLocaleString('fr-FR', Object.assign({ timeZone: TZ }, o));
const day = (t) => fmtT(t, { weekday: 'short', day: 'numeric' });
const hh = (t) => fmtT(t, { hour: '2-digit', minute: '2-digit' }).replace(':00', ' h');
const f1 = (x) => (x == null ? '—' : x.toFixed(1).replace('.', ','));

function markdown(res, out) {
  const L = D.LEVELS[res.level] || D.LEVELS.intermediaire;
  let s = `# Downwind wing foil — prévision\n\nMise à jour : ${fmtT(res.now, { dateStyle: 'full', timeStyle: 'short' })} · niveau **${L.label}** (vent idéal ${L.wind[1]}-${L.wind[2]} nd)\n\n`;
  s += '## Meilleurs créneaux (4 jours)\n\n';
  if (!out.best.length) s += '_Aucun créneau de jour noté ≥ 5/10._\n\n';
  else {
    s += '| Quand | Parcours | Note | Conditions au meilleur moment |\n|---|---|---|---|\n';
    out.best.forEach((w) => { s += `| ${day(w.start)} ${hh(w.start)} – ${hh(w.end)} | ${w.from} → ${w.to} | **${f1(w.mean)}** (max ${f1(w.peak)}) | ${w.text} |\n`; });
    s += '\n';
  }
  s += '## Par parcours, toutes les 3 h (de jour)\n\nVent en nœuds (rafales), d\'où il vient · houle = mer qui avance avec le vent (hauteur · période · espacement des vagues) · ⚠ = vent de terre ou side-off.\n\n';
  res.runs.forEach((r) => {
    s += `### ${r.name} (${r.km} km)\n\n`;
    if (r.nowObs) s += `Bouée ${r.buoy} : ${f1(r.nowObs.hs)} m mesurés à ${hh(r.nowObs.t)} (modèles ×${r.nowObs.ratio.toFixed(2)} sur les premières heures).\n\n`;
    s += '| Heure | Vent | Côte | Sens | Houle | Note |\n|---|---|---|---|---|---|\n';
    let last = '';
    r.rows.filter((x) => !x.missing && x.day && x.leadH > -1 && new Date(x.t).getUTCHours() % 3 === 0).forEach((x) => {
      const d = day(x.t);
      const sens = x.dir === 'ab' ? `→ ${r.b}` : `→ ${r.a}`;
      s += `| ${d !== last ? d + ' ' : ''}${hh(x.t)} | ${Math.round(x.kn)} (${x.gust ?? '—'}) ${E.compass(x.windFrom)} | ${['off', 'sideoff'].includes(x.shoreCode) ? '⚠ ' : ''}${x.shore} | ${sens} | ${x.bumpH == null ? '—' : f1(x.bumpH) + ' m · ' + (x.bumpT ? Math.round(x.bumpT) + ' s · ~' + x.spacing + ' m' : '')} | ${x.score >= 7 ? '🟢' : x.score >= 5 ? '🟡' : '⚪'} ${f1(x.score)} |\n`;
      last = d;
    });
    s += `\n_${r.notes}_\n\n`;
  });
  s += `---\nSources : Open-Meteo (Météo-France AROME/ARPEGE, ECMWF, DWD, NOAA), bouées Candhis – Cerema (licence Etalab).\n`;
  return s;
}

main().catch((e) => { console.error('[build] échec :', e); process.exit(1); });
