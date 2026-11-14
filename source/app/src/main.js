import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import LC from './lc.js';
import workerSrc from './worker.txt';

// ------------------------------------------------------------------ data
const PKG = JSON.parse(document.getElementById('pkg').textContent);
const N = PKG.N, CELL = PKG.cell, EX = PKG.exag, BAND = PKG.band;
const HALF = N * CELL / 2;
const $ = (s) => document.querySelector(s);
const fmt = (v, d = 1) => (v == null || isNaN(v)) ? '–' : v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const hhmm = (h) => String(h).padStart(2, '0') + ':00';
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const INNER = (i) => { const r = (i / N) | 0, c = i % N; return r > 15 && r < N - 15 && c > 15 && c < N - 15; };

const state = { site: 'walled', day: 'heat', hour: 15, layer: 'temp', scen: 'base', playing: false, tour: null };
const SITES = {}; // key -> loaded site
const SIM = { walled: { heat: {}, smog: {} }, dha: { heat: {}, smog: {} } };

// ------------------------------------------------------------------ worker
const worker = new Worker(URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' })));
let jobId = 0; const pending = {};
worker.onmessage = (e) => { const p = pending[e.data.id]; delete pending[e.data.id]; p(e.data); };
function runSim(key, day, scen) {
  const params = JSON.parse(JSON.stringify(PKG.params));
  const opts = {};
  if (scen.includes('cool')) params.roof.a = 0.30;
  if (scen.includes('shade')) opts.streetShade = 0.6;
  return new Promise((res) => { const id = ++jobId; pending[id] = res; worker.postMessage({ type: 'run', id, key, dayName: day, day: PKG.days[day], params, opts }); });
}
async function getSim(key, day, scen = 'base') {
  await ensureSite(key);
  const slot = SIM[key][day];
  if (!slot[scen]) slot[scen] = runSim(key, day, scen).then((r) => (slot[scen] = r));
  return slot[scen];
}

async function inflate(b64) {
  const bin = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  const ds = new Blob([bin]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(ds).arrayBuffer());
}

async function loadSite(key) {
  const s = PKG.sites[key];
  const H = await inflate(s.H);
  const q = async (b) => Float32Array.from(await inflate(b), (v) => v / 250);
  const ndvi = Float32Array.from(await inflate(s.ndvi), (v) => v / 100);
  const fw = await q(s.fw), fr = await q(s.fr), fg = await q(s.fg);
  const lit = {};
  for (const d of ['heat', 'smog']) lit[d] = { w: await inflate(s['lit_' + d].w), r: await inflate(s['lit_' + d].r), g: await inflate(s['lit_' + d].g) };
  const geom = LC.buildSurfaces(H, N, BAND);
  worker.postMessage({ type: 'init', key, H, N, cell: CELL, band: BAND, fw, fr, fg, ndvi, lit });
  const site = { key, H, ndvi, fw, fr, fg, lit, geom, meta: PKG.siteMeta[key] };
  site.nR = geom.roofs.length; site.nG = geom.ground.length; site.nW = geom.W.cell.length;
  // index helpers
  site.roofOf = new Int32Array(N * N).fill(-1); geom.roofs.forEach((c, e) => (site.roofOf[c] = e));
  site.groundOf = new Int32Array(N * N).fill(-1); geom.ground.forEach((c, e) => (site.groundOf[c] = e));
  site.wallsOf = new Map();
  for (let e = 0; e < site.nW; e++) { const c = geom.W.cell[e]; if (!site.wallsOf.has(c)) site.wallsOf.set(c, []); site.wallsOf.get(c).push(e); }
  const hs = []; let built = 0; for (let i = 0; i < N * N; i++) if (H[i] > 0) { built++; hs.push(H[i]); }
  hs.sort((a, b) => a - b);
  site.builtShare = built / (N * N); site.medH = hs[hs.length >> 1]; site.maxH = hs[hs.length - 1];
  SITES[key] = site;
  return site;
}

const LOADING = {};
function ensureSite(key) { return LOADING[key] || (LOADING[key] = loadSite(key)); }
const litBit = (arr, n, h, e) => (arr[h * Math.ceil(n / 8) + (e >> 3)] >> (7 - (e & 7))) & 1;

// ------------------------------------------------------------------ colour
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
function makeRamp(stops) {
  const cs = stops.map(hex);
  return (t) => { t = clamp(t, 0, 1) * (cs.length - 1); const i = Math.min(Math.floor(t), cs.length - 2), f = t - i; return [0, 1, 2].map((k) => cs[i][k] + (cs[i + 1][k] - cs[i][k]) * f); };
}
const RAMP = {
  temp: makeRamp(['#1f2f5c', '#2f6a9a', '#6fa7a8', '#cfd59a', '#f3c46a', '#ee8a45', '#d4473f', '#8e1d42']),
  sky: makeRamp(['#2a1238', '#5a2a6e', '#8f4f8a', '#c98a7a', '#f0c987', '#fbf3d5']),
  dose: makeRamp(['#2a2f3a', '#5a4a3a', '#a5642f', '#e0823a', '#f2b45a', '#fff0b8']),
  prio: makeRamp(['#2c3038', '#3c3f46', '#7a5a3a', '#d27a36', '#f0b04f', '#ffe9a8'])
};
const TEMP_DOMAIN = { heat: [25, 70], smog: [8, 40] };
const SHADE = { roof: 1.0, ground: 0.86, wall: [0.62, 0.8, 0.7, 0.9] };

// ------------------------------------------------------------------ three
const canvas = $('#stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color('#0b0e13');
const camera = new THREE.PerspectiveCamera(40, 1, 5, 12000);
camera.position.set(-260, 820, 1150);
const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 0, 0); controls.enableDamping = true; controls.maxPolarAngle = Math.PI * 0.47; controls.minDistance = 60; controls.maxDistance = 3800;
controls.update();

const basePlate = new THREE.Mesh(new THREE.PlaneGeometry(N * CELL + 120, N * CELL + 120), new THREE.MeshBasicMaterial({ color: '#12161d' }));
basePlate.rotation.x = -Math.PI / 2; basePlate.position.y = -0.6; scene.add(basePlate);
const frame = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(N * CELL, 0.1, N * CELL)), new THREE.LineBasicMaterial({ color: '#3a4250' }));
scene.add(frame);

// mixing-layer lid (winter)
const lid = new THREE.Mesh(new THREE.PlaneGeometry(N * CELL, N * CELL), new THREE.MeshBasicMaterial({ color: '#b9c4ea', transparent: true, opacity: 0.32, side: THREE.DoubleSide, depthWrite: false }));
lid.rotation.x = -Math.PI / 2; lid.visible = false; scene.add(lid);
const lidEdge = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.PlaneGeometry(N * CELL, N * CELL)), new THREE.LineBasicMaterial({ color: '#e4e9ff', transparent: true, opacity: 0.95 }));
lidEdge.rotation.x = -Math.PI / 2; lidEdge.visible = false; scene.add(lidEdge);

// highlight box for selected building / block
const hiMat = new THREE.LineBasicMaterial({ color: '#fff4d6' });
let hiObj = null;
function setHighlight(cells, H) {
  if (hiObj) { scene.remove(hiObj); hiObj.geometry.dispose(); hiObj = null; }
  if (!cells || !cells.length) return;
  let r0 = N, r1 = 0, c0 = N, c1 = 0, hm = 0;
  for (const i of cells) { const r = (i / N) | 0, c = i % N; r0 = Math.min(r0, r); r1 = Math.max(r1, r); c0 = Math.min(c0, c); c1 = Math.max(c1, c); hm = Math.max(hm, H[i]); }
  const w = (c1 - c0 + 1) * CELL, d = (r1 - r0 + 1) * CELL, h = Math.max(hm * EX, 2) + 2;
  hiObj = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(w + 2, h, d + 2)), hiMat);
  hiObj.position.set((c0 - N / 2) * CELL + w / 2, h / 2, (r0 - N / 2) * CELL + d / 2);
  scene.add(hiObj);
}

function buildMesh(site) {
  const { H, geom } = site; const nR = site.nR, nG = site.nG, nW = site.nW, nq = nR + nG + nW;
  const pos = new Float32Array(nq * 12), col = new Uint8Array(nq * 12 / 4 * 3 + 0);
  const idx = new Uint32Array(nq * 6);
  let q = 0;
  const quad = (a, b, c, d) => {
    pos.set(a, q * 12); pos.set(b, q * 12 + 3); pos.set(c, q * 12 + 6); pos.set(d, q * 12 + 9);
    const v = q * 4; idx.set([v, v + 1, v + 2, v, v + 2, v + 3], q * 6); q++;
  };
  const X = (c) => (c - N / 2) * CELL, Z = (r) => (r - N / 2) * CELL;
  for (let e = 0; e < nR; e++) { const i = geom.roofs[e], r = (i / N) | 0, c = i % N, y = H[i] * EX; quad([X(c), y, Z(r)], [X(c), y, Z(r + 1)], [X(c + 1), y, Z(r + 1)], [X(c + 1), y, Z(r)]); }
  for (let e = 0; e < nG; e++) { const i = geom.ground[e], r = (i / N) | 0, c = i % N; quad([X(c), 0, Z(r)], [X(c), 0, Z(r + 1)], [X(c + 1), 0, Z(r + 1)], [X(c + 1), 0, Z(r)]); }
  const W = geom.W;
  for (let e = 0; e < nW; e++) {
    const i = W.cell[e], r = (i / N) | 0, c = i % N, y0 = W.z0[e] * EX, y1 = W.z1[e] * EX, d = W.dir[e];
    if (d === 0) quad([X(c), y0, Z(r)], [X(c + 1), y0, Z(r)], [X(c + 1), y1, Z(r)], [X(c), y1, Z(r)]);
    else if (d === 1) quad([X(c + 1), y0, Z(r)], [X(c + 1), y0, Z(r + 1)], [X(c + 1), y1, Z(r + 1)], [X(c + 1), y1, Z(r)]);
    else if (d === 2) quad([X(c + 1), y0, Z(r + 1)], [X(c), y0, Z(r + 1)], [X(c), y1, Z(r + 1)], [X(c + 1), y1, Z(r + 1)]);
    else quad([X(c), y0, Z(r + 1)], [X(c), y0, Z(r)], [X(c), y1, Z(r)], [X(c), y1, Z(r + 1)]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const colors = new Uint8Array(nq * 4 * 3);
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3, true));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  m.frustumCulled = false;
  site.mesh = m; site.colors = colors;
  return m;
}

// ------------------------------------------------------------------ colouring
function setQuadColor(colors, q, rgb, f) {
  const r = rgb[0] * f, g = rgb[1] * f, b = rgb[2] * f, o = q * 12;
  colors[o] = colors[o + 3] = colors[o + 6] = colors[o + 9] = r;
  colors[o + 1] = colors[o + 4] = colors[o + 7] = colors[o + 10] = g;
  colors[o + 2] = colors[o + 5] = colors[o + 8] = colors[o + 11] = b;
}

function currentSim() { const s = SIM[state.site][state.day][state.scen]; return (s && s.Tw) ? s : null; }

function recolor() {
  const site = SITES[state.site]; if (!site || !site.mesh) return;
  const { nR, nG, nW, geom, colors } = site; const h = state.hour; const W = geom.W;
  const sim = currentSim(); const layer = state.layer;
  const day = PKG.days[state.day]; const alt = day.alt[h];
  const [t0, t1] = TEMP_DOMAIN[state.day];
  const grey = [74, 80, 92], dark = [44, 49, 58];
  if (layer === 'temp' && sim) {
    for (let e = 0; e < nR; e++) setQuadColor(colors, e, RAMP.temp((sim.Tr[h * nR + e] - t0) / (t1 - t0)), SHADE.roof);
    for (let e = 0; e < nG; e++) setQuadColor(colors, nR + e, RAMP.temp((sim.Tg[h * nG + e] - t0) / (t1 - t0)), SHADE.ground);
    for (let e = 0; e < nW; e++) setQuadColor(colors, nR + nG + e, RAMP.temp((sim.Tw[h * nW + e] - t0) / (t1 - t0)), SHADE.wall[W.dir[e]]);
  } else if (layer === 'sun') {
    const night = alt <= 2 * Math.PI / 180;
    const SUN = [255, 205, 128], SH = [56, 72, 104], NIGHT = [30, 36, 50];
    const L = site.lit[state.day];
    for (let e = 0; e < nR; e++) setQuadColor(colors, e, night ? NIGHT : (litBit(L.r, nR, h, e) ? SUN : SH), SHADE.roof);
    for (let e = 0; e < nG; e++) setQuadColor(colors, nR + e, night ? NIGHT : (litBit(L.g, nG, h, e) ? SUN : SH), SHADE.ground);
    for (let e = 0; e < nW; e++) setQuadColor(colors, nR + nG + e, night ? NIGHT : (litBit(L.w, nW, h, e) ? SUN : SH), SHADE.wall[W.dir[e]]);
  } else if (layer === 'sky' || layer === 'vent') {
    for (let e = 0; e < nR; e++) setQuadColor(colors, e, layer === 'vent' ? grey : [70, 76, 88], SHADE.roof);
    for (let e = 0; e < nG; e++) setQuadColor(colors, nR + e, RAMP.sky(site.fg[e]), SHADE.ground);
    for (let e = 0; e < nW; e++) setQuadColor(colors, nR + nG + e, layer === 'vent' ? dark : RAMP.sky(2 * site.fw[e]), SHADE.wall[W.dir[e]] * 0.5);
  } else if (layer === 'dose' && sim) {
    const dose = (T, n, e) => { let s = 0; for (let k = 0; k < 24; k++) s += Math.max(T[k * n + e] - 40, 0); return s; };
    for (let e = 0; e < nR; e++) setQuadColor(colors, e, RAMP.dose(dose(sim.Tr, nR, e) / 260), SHADE.roof);
    for (let e = 0; e < nG; e++) setQuadColor(colors, nR + e, RAMP.dose(dose(sim.Tg, nG, e) / 260), SHADE.ground);
    for (let e = 0; e < nW; e++) setQuadColor(colors, nR + nG + e, RAMP.dose(dose(sim.Tw, nW, e) / 260), SHADE.wall[W.dir[e]]);
  } else if (layer === 'prio' && site.tiles) {
    const T = site.tiles;
    const sc = (i) => { const t = T.byCell[i]; return t >= 0 && T.list[t].score != null ? T.list[t].score / 100 : 0; };
    for (let e = 0; e < nR; e++) setQuadColor(colors, e, RAMP.prio(sc(geom.roofs[e])), SHADE.roof);
    for (let e = 0; e < nG; e++) setQuadColor(colors, nR + e, dark, SHADE.ground);
    for (let e = 0; e < nW; e++) setQuadColor(colors, nR + nG + e, RAMP.prio(sc(W.cell[e])), SHADE.wall[W.dir[e]]);
  } else {
    for (let q = 0; q < nR + nG + nW; q++) setQuadColor(colors, q, grey, 1);
  }
  site.mesh.geometry.attributes.color.needsUpdate = true;
  updateAtmosphere(); updateLegend(); updateReadout(); drawTimeline();
}

function updateAtmosphere() {
  const f = PKG.days[state.day].forc, h = state.hour;
  if (state.day === 'smog') {
    const pm = f.pm2_5[h];
    scene.fog = new THREE.FogExp2('#6f6a63', clamp(pm / 260 * 0.0011, 0.00025, 0.0013));
    scene.background = new THREE.Color('#15140f');
    const blh = f.boundary_layer_height[h];
    const show = blh < 400;
    lid.visible = lidEdge.visible = show; lid.position.y = lidEdge.position.y = blh * EX;
  } else {
    scene.fog = new THREE.FogExp2('#0b0e13', 0.00018);
    scene.background = new THREE.Color('#0b0e13');
    lid.visible = lidEdge.visible = false;
  }
}

// ------------------------------------------------------------------ stats
function siteStats(key, day, scen = 'base') {
  const site = SITES[key], sim = SIM[key][day][scen]; if (!site || !sim || !sim.Tw) return null;
  const { nR, nG, nW, geom } = site;
  const meanAt = (T, n, idxs, h) => { let s = 0, k = 0; for (let e = 0; e < n; e++) if (INNER(idxs[e])) { s += T[h * n + e]; k++; } return s / k; };
  const out = { street: [], roof: [], wall: [] };
  for (let h = 0; h < 24; h++) {
    out.street.push(meanAt(sim.Tg, nG, geom.ground, h)); out.roof.push(meanAt(sim.Tr, nR, geom.roofs, h)); out.wall.push(meanAt(sim.Tw, nW, geom.W.cell, h));
  }
  let peak = 0, k = 0, sunh = 0, kg = 0, green = 0;
  for (let e = 0; e < nR; e++) if (INNER(geom.roofs[e])) { let m = -99; for (let h = 0; h < 24; h++) m = Math.max(m, sim.Tr[h * nR + e]); peak += m; k++; }
  const L = site.lit[day];
  for (let e = 0; e < nG; e++) if (INNER(geom.ground[e])) { let s = 0; for (let h = 0; h < 24; h++) s += litBit(L.g, nG, h, e); sunh += s; kg++; if (site.ndvi[geom.ground[e]] > 0.3) green++; }
  const fgs = []; for (let e = 0; e < nG; e++) if (INNER(geom.ground[e])) fgs.push(site.fg[e]); fgs.sort((a, b) => a - b);
  out.roofPeak = peak / k; out.streetSunH = sunh / kg; out.greenShare = green / kg; out.fgMed = fgs[fgs.length >> 1];
  return out;
}

// building = connected cells of similar height (±1.5 m)
function blob(site, seed, tol = 1.5, maxn = 900) {
  const H = site.H, h0 = H[seed]; if (h0 <= 0) return [];
  const seen = new Set([seed]), st = [seed];
  while (st.length && seen.size < maxn) {
    const p = st.pop(), r = (p / N) | 0, c = p % N;
    for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const rr = r + dr, cc = c + dc, q = rr * N + cc;
      if (rr >= 0 && rr < N && cc >= 0 && cc < N && !seen.has(q) && H[q] > 0 && Math.abs(H[q] - h0) <= tol) { seen.add(q); st.push(q); }
    }
  }
  return [...seen];
}

function buildingBrief(site, cells, sim, day) {
  const set = new Set(cells), W = site.geom.W, nW = site.nW, nR = site.nR;
  const L = site.lit[day];
  const rows = {};
  const FR = [[-1, 0], [0, 1], [1, 0], [0, -1]];
  for (const c of cells) {
    const ws = site.wallsOf.get(c); if (!ws) continue;
    for (const e of ws) {
      const r = (c / N) | 0, cc = c % N, d = W.dir[e], fr = (r + FR[d][0]) * N + (cc + FR[d][1]);
      if (set.has(fr)) continue; // interior step
      const st = Math.floor((W.z0[e] + W.z1[e]) / 2 / 3);
      let pk = -99, pkH = 0, sun = 0, h45 = 0;
      for (let h = 0; h < 24; h++) { const t = sim.Tw[h * nW + e]; if (t > pk) { pk = t; pkH = h; } sun += litBit(L.w, nW, h, e); if (t > 45) h45++; }
      const R = (rows[st] = rows[st] || { st, n: 0, pk: -99, pkSum: 0, sun: 0, h45: 0, fsky: 0, dir: [[], [], [], []] });
      R.n++; R.pk = Math.max(R.pk, pk); R.pkSum += pk; R.sun += sun; R.h45 += h45; R.fsky += site.fw[e]; R.dir[d].push(pk);
    }
  }
  const list = Object.values(rows).sort((a, b) => a.st - b.st).map((R) => ({ st: R.st, n: R.n, peak: R.pk, meanPeak: R.pkSum / R.n, sun: R.sun / R.n, h45: R.h45 / R.n, fsky: R.fsky / R.n, dir: R.dir.map((a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null) }));
  let roofPk = 0, roofNight = 0, k = 0, hMax = 0;
  for (const c of cells) { const e = site.roofOf[c]; if (e < 0) continue; let m = -99; for (let h = 0; h < 24; h++) m = Math.max(m, sim.Tr[h * nR + e]); roofPk += m; roofNight += sim.Tr[4 * nR + e]; k++; hMax = Math.max(hMax, site.H[c]); }
  return { rows: list, roofPeak: roofPk / k, roofNight: roofNight / k, height: hMax, footprint: cells.length * CELL * CELL };
}

// where to act first: 40 m blocks
function computeTiles(site, sim) {
  const T = 10, nT = N / T; const { nR, nG, nW, geom } = site; const W = geom.W;
  const tiles = Array.from({ length: nT * nT }, (_, i) => ({ i, r: Math.floor(i / nT), c: i % nT, dRoof: 0, aRoof: 0, dGround: 0, aGround: 0, dWall: 0, aWall: 0, floor: 0, built: 0, fg: 0, ng: 0, fw: 0, wallDir: [0, 0, 0, 0] }));
  const byCell = new Int32Array(N * N);
  for (let i = 0; i < N * N; i++) { const r = (i / N) | 0, c = i % N; byCell[i] = Math.floor(r / T) * nT + Math.floor(c / T); }
  const dose = (A, n, e) => { let s = 0; for (let h = 0; h < 24; h++) s += Math.max(A[h * n + e] - 40, 0); return s; };
  const A = CELL * CELL;
  for (let e = 0; e < nR; e++) { const c = geom.roofs[e], t = tiles[byCell[c]]; t.dRoof += dose(sim.Tr, nR, e) * A; t.aRoof += A; t.floor += A * Math.max(1, Math.round(site.H[c] / 3)); t.built++; }
  for (let e = 0; e < nG; e++) { const c = geom.ground[e], t = tiles[byCell[c]]; t.dGround += dose(sim.Tg, nG, e) * A; t.aGround += A; t.fg += site.fg[e]; t.ng++; }
  for (let e = 0; e < nW; e++) { const c = W.cell[e], t = tiles[byCell[c]], a = (W.z1[e] - W.z0[e]) * CELL, d = dose(sim.Tw, nW, e) * a; t.dWall += d; t.aWall += a; t.fw += site.fw[e] * a; t.wallDir[W.dir[e]] += d; }
  const ok = tiles.filter((t) => t.r > 0 && t.r < nT - 1 && t.c > 0 && t.c < nT - 1 && t.built / (T * T) >= 0.25);
  ok.forEach((t) => { t.dose = (t.dRoof + t.dGround + t.dWall) / (t.aRoof + t.aGround + t.aWall); });
  const rank = (key) => { const s = [...ok].sort((a, b) => a[key] - b[key]); s.forEach((t, j) => (t['pr_' + key] = j / (s.length - 1))); };
  rank('dose'); rank('floor');
  const DN = ['north', 'east', 'south', 'west'];
  ok.forEach((t) => {
    t.score = Math.round(100 * (0.6 * t.pr_dose + 0.4 * t.pr_floor));
    const parts = [['roof', t.dRoof], ['street', t.dGround], ['wall', t.dWall]].sort((a, b) => b[1] - a[1]);
    const share = parts[0][1] / (t.dRoof + t.dGround + t.dWall);
    t.fgMean = t.ng ? t.fg / t.ng : null; t.fwMean = t.aWall ? t.fw / t.aWall : 0;
    const wd = t.wallDir.indexOf(Math.max(...t.wallDir));
    if (parts[0][0] === 'roof') t.lever = { k: 'roof', title: 'Paint roofs white', text: `Roofs carry ${Math.round(share * 100)}% of this block's heat load. Lime wash or a reflective coat is the cheapest fix here.` };
    else if (parts[0][0] === 'street') t.lever = { k: 'street', title: 'Shade the street', text: `Streets and open ground carry ${Math.round(share * 100)}% of the heat load. Trees or awnings over the ${t.fgMean != null && t.fgMean > 0.6 ? 'wide, open' : 'narrow'} streets.` };
    else t.lever = { k: 'wall', title: `Shade ${DN[wd]} walls`, text: `Walls carry ${Math.round(share * 100)}% of the heat load, most of it on ${DN[wd]}-facing faces. External shading or lighter plaster on those faces.` };
    t.center = [(t.r * T + T / 2), (t.c * T + T / 2)];
    const lm = nearestLandmark(site, Math.round(t.center[0]) * N + Math.round(t.center[1])); t.near = lm ? 'near ' + lm[0] : null;
  });
  const list = tiles; const ranked = [...ok].sort((a, b) => b.score - a.score || b.dose - a.dose);
  // tiles without a score are not coloured
  tiles.forEach((t) => { if (t.score == null) t.score = null; });
  return { byCell: Int32Array.from(byCell, (t) => (tiles[t].score == null ? -1 : t)), list, ranked };
}

// ------------------------------------------------------------------ UI: legend, readout, timeline
const LAYERS = {
  temp: { name: 'How hot is each surface', note: 'Temperature of every roof, wall and street at the hour on the slider. Blue is cool, dark red is hottest.' },
  sun: { name: 'Sun or shade', note: 'Yellow surfaces are in direct sunlight at this hour; blue ones are shaded by buildings. Dark means night.' },
  sky: { name: 'How much sky it sees', note: 'Share of the open sky visible from each street (bright = open, dark purple = enclosed). Narrow lanes see little sky: shaded by day, but they hold heat at night. Roofs grey, walls dimmed.' },
  dose: { name: 'Heat load over the day', note: 'Adds up how far each surface stays above 40 °C across the day. Example: 2 hours at 50 °C = 20 °C·h.' },
  vent: { name: 'How fast smog can clear', note: 'Streets that see more open sky swap air with the atmosphere faster, so smoke and dust clear sooner. Narrow lanes trap it.' },
  prio: { name: 'Where to act first', note: 'Each 40 m block scored 0–100: 60% from its heat load, 40% from its floor space (more floor space, more people).' }
};
function rampCSS(r, n = 8) { return 'linear-gradient(90deg,' + Array.from({ length: n }, (_, i) => `rgb(${r(i / (n - 1)).map(Math.round).join(',')}) ${Math.round(i / (n - 1) * 100)}%`).join(',') + ')'; }
function ticksHTML(ticks) { return ticks.map(([p, t]) => `<span style="left:${p}%">${t}</span>`).join(''); }
function updateLegend() {
  const L = LAYERS[state.layer]; const el = $('#legend');
  let bar = '', ticks = [];
  if (state.layer === 'temp') { const [a, b] = TEMP_DOMAIN[state.day]; bar = rampCSS(RAMP.temp); const n = 4; ticks = Array.from({ length: n + 1 }, (_, i) => [i / n * 100, Math.round(a + (b - a) * i / n) + ' °C']); }
  else if (state.layer === 'sun') { bar = 'linear-gradient(90deg,#384868 0 50%,#ffcd80 50% 100%)'; ticks = [[0, 'shade'], [100, 'direct sun']]; }
  else if (state.layer === 'sky' || state.layer === 'vent') { bar = rampCSS(RAMP.sky); ticks = state.layer === 'vent' ? [[0, 'traps smog'], [100, 'clears fast']] : [[0, '0%'], [25, '25%'], [50, '50%'], [75, '75%'], [100, '100% sky']]; }
  else if (state.layer === 'dose') { bar = rampCSS(RAMP.dose); ticks = [[0, '0'], [50, '130'], [100, '260 °C·h']]; }
  else if (state.layer === 'prio') { bar = rampCSS(RAMP.prio); ticks = [[0, '0 low'], [50, '50'], [100, '100 act first']]; }
  el.innerHTML = `<div class="lg-name">${L.name}</div><div class="lg-bar" style="background:${bar}"></div><div class="lg-ticks">${ticksHTML(ticks)}</div><div class="lg-note">${L.note}</div>`;
}

function updateReadout() {
  const site = SITES[state.site]; if (!site) return;
  const f = PKG.days[state.day].forc, h = state.hour;
  const st = SIM[state.site][state.day][state.scen]; const S = st && st.Tw ? (st._stats || (st._stats = siteStats(state.site, state.day, state.scen))) : null;
  const rows = [['Air temperature', fmt(f.temperature_2m[h]) + ' °C']];
  if (S) rows.push(['Streets (avg)', fmt(S.street[h]) + ' °C'], ['Roofs (avg)', fmt(S.roof[h]) + ' °C'], ['Walls (avg)', fmt(S.wall[h]) + ' °C']);
  if (state.day === 'smog') rows.push(['PM2.5', fmt(f.pm2_5[h], 0) + ' µg/m³'], ['Air mixing height', fmt(f.boundary_layer_height[h], 0) + ' m']);
  $('#readout').innerHTML = `<div class="ro-time">${hhmm(h)} <span>PKT · ${state.day === 'heat' ? '10 Jun 2026' : '10 Nov 2026'}</span></div>` + rows.map(([k, v]) => `<div class="ro-row"><span>${k}</span><b>${v}</b></div>`).join('');
  $('#hourLabel').textContent = hhmm(h);
  $('#hour').value = h;
}

function drawTimeline() {
  const cv = $('#timeline'); const dpr = Math.min(window.devicePixelRatio, 2);
  const w = cv.clientWidth, hgt = cv.clientHeight; if (!w) return;
  cv.width = w * dpr; cv.height = hgt * dpr; const g = cv.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, w, hgt);
  const f = PKG.days[state.day].forc; const st = SIM[state.site][state.day][state.scen]; const S = st && st._stats;
  const pad = { l: 34, r: 10, t: 8, b: 16 }; const W = w - pad.l - pad.r, Hh = hgt - pad.t - pad.b;
  const x = (i) => pad.l + i / 23 * W;
  g.font = '10px "IBM Plex Mono", ui-monospace, monospace'; g.textBaseline = 'middle';
  const series = [];
  let lo, hi, unit;
  if (state.day === 'heat') {
    lo = 20; hi = 70; unit = '°C';
    series.push({ v: f.temperature_2m, c: '#9fb3c8', n: 'Air', u: ' °C' });
    if (S) series.push({ v: S.roof, c: '#d4473f', n: 'Roofs', u: ' °C' }, { v: S.street, c: '#ee8a45', n: 'Streets', u: ' °C' }, { v: S.wall, c: '#f3c46a', n: 'Walls', u: ' °C' });
  } else {
    lo = 0; hi = 300; unit = 'µg/m³';
    series.push({ v: f.pm2_5, c: '#c9b28a', n: 'PM2.5', u: ' µg/m³', d: 0 });
    series.push({ v: f.boundary_layer_height.map((b) => Math.min(b, 1500) / 5), raw: f.boundary_layer_height, c: '#a8b4d8', n: 'Air mixing height (scaled)', u: ' m', d: 0, dash: true });
  }
  const y = (v) => pad.t + Hh - (v - lo) / (hi - lo) * Hh;
  g.strokeStyle = 'rgba(200,210,225,0.08)'; g.fillStyle = 'rgba(200,210,225,0.45)';
  const ticks = state.day === 'heat' ? [20, 30, 40, 50, 60, 70] : [0, 100, 200];
  ticks.forEach((t) => { g.beginPath(); g.moveTo(pad.l, y(t)); g.lineTo(pad.l + W, y(t)); g.stroke(); g.textAlign = 'right'; g.fillText(t, pad.l - 6, y(t)); });
  g.textAlign = 'center'; [0, 6, 12, 18, 23].forEach((i) => g.fillText(hhmm(i), x(i), hgt - 7));
  if (state.day === 'heat') { g.strokeStyle = 'rgba(212,71,63,0.35)'; g.setLineDash([2, 3]); g.beginPath(); g.moveTo(pad.l, y(40)); g.lineTo(pad.l + W, y(40)); g.stroke(); g.setLineDash([]); }
  $('#tlHead').innerHTML = series.map((s) => `<span><i class="${s.dash ? 'dash' : ''}" style="background:${s.c};color:${s.c}"></i>${s.n} <b style="color:var(--paper);font-weight:500">${fmt(s.raw ? s.raw[state.hour] : s.v[state.hour], s.d == null ? 1 : s.d)}${s.u || ''}</b></span>`).join('') + (state.day === 'heat' ? '<span style="margin-left:auto">dashed line = 40 °C</span>' : '');
  series.forEach((s, si) => {
    g.strokeStyle = s.c; g.lineWidth = 1.6; g.setLineDash(s.dash ? [4, 3] : []); g.beginPath();
    s.v.forEach((v, i) => (i ? g.lineTo(x(i), y(v)) : g.moveTo(x(i), y(v)))); g.stroke(); g.setLineDash([]);
    g.fillStyle = s.c; g.beginPath(); g.arc(x(state.hour), y(s.v[state.hour]), 3, 0, 7); g.fill();
  });
  g.strokeStyle = 'rgba(255,244,214,0.5)'; g.beginPath(); g.moveTo(x(state.hour), pad.t); g.lineTo(x(state.hour), pad.t + Hh); g.stroke();
  g.fillStyle = 'rgba(200,210,225,0.45)'; g.textAlign = 'left'; g.fillText(unit, 2, pad.t);
}

// ------------------------------------------------------------------ year chart (walkthrough I)
function drawYear(cv) {
  const dpr = Math.min(window.devicePixelRatio, 2); const w = cv.clientWidth, hgt = cv.clientHeight;
  cv.width = w * dpr; cv.height = hgt * dpr; const g = cv.getContext('2d'); g.scale(dpr, dpr);
  const Y = PKG.year; const n = Y.monthsTmax.length; const pad = { l: 30, r: 30, t: 14, b: 22 }; const W = w - pad.l - pad.r, Hh = hgt - pad.t - pad.b; const bw = W / n;
  g.font = '10px "IBM Plex Mono", ui-monospace, monospace'; g.textBaseline = 'middle';
  const yT = (v) => pad.t + Hh - (v - 10) / 40 * Hh, yP = (v) => pad.t + Hh - v / 160 * Hh;
  g.strokeStyle = 'rgba(200,210,225,0.08)';
  [10, 20, 30, 40, 50].forEach((t) => { g.beginPath(); g.moveTo(pad.l, yT(t)); g.lineTo(pad.l + W, yT(t)); g.stroke(); g.fillStyle = 'rgba(238,138,69,0.8)'; g.textAlign = 'right'; g.fillText(t + '°', pad.l - 5, yT(t)); });
  Y.monthsPM25.forEach(([m, v], i) => { g.fillStyle = 'rgba(201,178,138,0.28)'; g.fillRect(pad.l + i * bw + bw * 0.18, yP(v), bw * 0.64, pad.t + Hh - yP(v)); });
  [0, 80, 160].forEach((t) => { g.fillStyle = 'rgba(201,178,138,0.9)'; g.textAlign = 'left'; g.fillText(t, pad.l + W + 5, yP(t)); });
  g.strokeStyle = '#ee8a45'; g.lineWidth = 2; g.beginPath(); Y.monthsTmax.forEach(([m, a], i) => { const xx = pad.l + i * bw + bw / 2; i ? g.lineTo(xx, yT(a)) : g.moveTo(xx, yT(a)); }); g.stroke();
  g.fillStyle = '#d4473f'; Y.monthsTmax.forEach(([m, a, mx], i) => { const xx = pad.l + i * bw + bw / 2; g.beginPath(); g.arc(xx, yT(mx), 2.2, 0, 7); g.fill(); });
  g.fillStyle = 'rgba(200,210,225,0.55)'; g.textAlign = 'center';
  Y.monthsTmax.forEach(([m], i) => { if (i % 2 === 0) g.fillText(new Date(m + '-01').toLocaleString('en-US', { month: 'short' }), pad.l + i * bw + bw / 2, hgt - 8); });
}

// ------------------------------------------------------------------ picking (grid ray march)
const ray = new THREE.Raycaster(); const ndc = new THREE.Vector2();
function pickCell(ev) {
  const site = SITES[state.site]; if (!site) return -1;
  const rect = canvas.getBoundingClientRect();
  ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const o = ray.ray.origin, d = ray.ray.direction;
  const top = site.maxH * EX + 1;
  let t = d.y < 0 ? Math.max(0, (o.y - top) / -d.y) : 0;
  const tEnd = d.y < 0 ? (o.y + 1) / -d.y : 8000;
  for (let k = 0; k < 6000 && t <= tEnd; k++, t += 1.0) {
    const x = o.x + d.x * t, y = o.y + d.y * t, z = o.z + d.z * t;
    const c = Math.floor(x / CELL + N / 2), r = Math.floor(z / CELL + N / 2);
    if (r < 0 || r >= N || c < 0 || c >= N) continue;
    if (y <= site.H[r * N + c] * EX + 0.01) return r * N + c;
  }
  return -1;
}

const tip = $('#tip');
canvas.addEventListener('pointermove', (ev) => {
  if (state.tour) { tip.hidden = true; return; }
  const i = pickCell(ev); const site = SITES[state.site]; const sim = currentSim();
  if (i < 0 || !site) { tip.hidden = true; return; }
  const h = state.hour, Hh = site.H[i];
  let html = '';
  if (Hh > 0) {
    const e = site.roofOf[i];
    html = `<b>Building · ${Hh} m tall</b> (about ${Math.max(1, Math.round(Hh / 3))} storeys)`;
    if (sim) html += `<br>Roof ${fmt(sim.Tr[h * site.nR + e])} °C at ${hhmm(h)}`;
    html += `<br><span>Click for the building brief</span>`;
  } else {
    const e = site.groundOf[i];
    html = `<b>Street / open ground</b><br>Sees ${fmt(site.fg[e] * 100, 0)}% of the sky`;
    if (sim) html += ` · ${fmt(sim.Tg[h * site.nG + e])} °C`;
    if (site.ndvi[i] > 0.3) html += `<br><span>Green cover (trees or grass)</span>`;
  }
  tip.innerHTML = html; tip.hidden = false; tip.style.left = ev.clientX + 14 + 'px'; tip.style.top = ev.clientY + 14 + 'px';
});
canvas.addEventListener('pointerleave', () => (tip.hidden = true));
let downAt = null;
canvas.addEventListener('pointerdown', (ev) => (downAt = [ev.clientX, ev.clientY]));
canvas.addEventListener('pointerup', (ev) => {
  if (!downAt || Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]) > 4 || state.tour) return;
  const i = pickCell(ev); if (i >= 0 && SITES[state.site].H[i] > 0) openBrief(i);
});

// ------------------------------------------------------------------ building brief
function cellLatLon(site, cell) {
  const r = (cell / N) | 0, c = cell % N, [lat0, lon0] = site.meta.center;
  const dy = (N / 2 - r) * CELL, dx = (c - N / 2) * CELL;
  return [lat0 + dy / 111320, lon0 + dx / (111320 * Math.cos(lat0 * Math.PI / 180))];
}
function nearestLandmark(site, cell) {
  const r = (cell / N) | 0, c = cell % N; let best = null, bd = 1e9;
  for (const [nm, lr, lc] of site.meta.landmarks || []) { const d = Math.hypot(lr - r, lc - c) * CELL; if (d < bd) { bd = d; best = nm; } }
  return bd <= 120 ? [best, bd] : null;
}
function showBriefPanel(open) {
  $('#brief').hidden = !open; $('#rightDefault').hidden = open; document.body.classList.toggle('brief-open', open);
}
async function openBrief(cell, title) {
  const site = SITES[state.site];
  const sim = await getSim(state.site, 'heat', state.scen);
  const cells = blob(site, cell);
  setHighlight(cells, site.H);
  const B = buildingBrief(site, cells, sim, 'heat');
  let nm = title;
  if (!nm) { const lm = nearestLandmark(site, cell); const [la, lo] = cellLatLon(site, cell); nm = lm ? (lm[1] < 25 ? lm[0] : `Building near ${lm[0]}`) : `Building at ${la.toFixed(4)}° N, ${lo.toFixed(4)}° E`; }
  const rows = B.rows;
  const lo = rows.length ? rows[0] : null, top = rows.length ? rows[rows.length - 1] : null;
  const fl = (R) => R.st === 0 ? 'ground floor' : `storey ${R.st + 1}`;
  let lead = '';
  if (!rows.length) lead = 'Its neighbours are as tall as it is, so no outside wall is exposed. See the roof figures below.';
  else if (rows.length === 1) lead = `Only ${fl(lo)} stands above its neighbours. Its walls peak at <b>${fmt(lo.peak)} °C</b> with ${fmt(lo.sun)} hours of direct sun.`;
  else {
    lead = `Exposed walls run from the ${fl(lo)} to storey ${top.st + 1}. The lowest get <b>${fmt(lo.sun)} h</b> of direct sun on 10 June, the highest <b>${fmt(top.sun)} h</b>. `;
    if (lo.peak > top.peak + 0.3) lead += `${lo.sun < top.sun ? 'Even so, the' : 'The'} lowest walls peak hotter, <b>${fmt(lo.peak)} °C</b> against ${fmt(top.peak)} °C: they see only ${fmt(Math.min(lo.fsky * 200, 100), 0)}% of the open sky, so heat bounces between neighbouring walls instead of escaping.`;
    else if (top.peak > lo.peak + 0.3) lead += `The highest walls peak hotter, <b>${fmt(top.peak)} °C</b> against ${fmt(lo.peak)} °C, because they get more sun.`;
    else lead += `Peak wall temperature is about the same top to bottom, around <b>${fmt(top.peak)} °C</b>.`;
  }
  $('#brief .bf-title').textContent = nm;
  $('#brief .bf-meta').textContent = `${B.height} m tall · about ${Math.max(1, Math.round(B.height / 3))} storeys · ${fmt(B.footprint, 0)} m² footprint${state.scen !== 'base' ? ' · what-if: ' + scenName(state.scen) : ''}`;
  $('#brief .bf-lead').innerHTML = lead;
  $('#brief .bf-roof').innerHTML = `<div><span>Roof, hottest</span><b>${fmt(B.roofPeak, 0)} °C</b></div><div><span>Roof at 4 am</span><b>${fmt(B.roofNight, 0)} °C</b></div><div><span>Air at 4 am</span><b>${fmt(PKG.days.heat.forc.temperature_2m[4], 0)} °C</b></div>`;
  showBriefPanel(true);
  drawBrief($('#briefChart'), rows);
  return B;
}
function drawBrief(cv, rows) {
  const dpr = Math.min(window.devicePixelRatio, 2); const w = cv.clientWidth; const rowH = 18; const hgt = Math.max(rows.length * rowH + 36, 80);
  cv.style.height = hgt + 'px'; cv.width = w * dpr; cv.height = hgt * dpr; const g = cv.getContext('2d'); g.scale(dpr, dpr);
  g.font = '10px "IBM Plex Mono", ui-monospace, monospace'; g.textBaseline = 'middle';
  const x0 = 70, x1 = w - 78; const tx = (t) => x0 + (t - 35) / 20 * (x1 - x0); const sx = (s) => x1 + 10 + s / 12 * 44;
  g.fillStyle = 'rgba(200,210,225,0.5)'; g.textAlign = 'center';
  [35, 40, 45, 50, 55].forEach((t) => { g.fillText(t + '°', tx(t), 8); g.strokeStyle = 'rgba(200,210,225,0.07)'; g.beginPath(); g.moveTo(tx(t), 16); g.lineTo(tx(t), hgt - 18); g.stroke(); });
  g.textAlign = 'left'; g.fillText('sun', x1 + 10, 8);
  const DC = ['#7fa6c9', '#f3c46a', '#ee8a45', '#d4473f']; const DN = ['N', 'E', 'S', 'W'];
  [...rows].reverse().forEach((R, j) => {
    const yy = 24 + j * rowH;
    g.fillStyle = 'rgba(236,230,218,0.75)'; g.textAlign = 'right'; g.fillText(R.st === 0 ? 'ground' : 'storey ' + (R.st + 1), x0 - 8, yy);
    g.fillStyle = 'rgba(255,255,255,0.05)'; g.fillRect(x0, yy - 6, x1 - x0, 12);
    g.fillStyle = 'rgba(212,71,63,0.55)'; g.fillRect(x0, yy - 4, Math.max(tx(R.peak) - x0, 1), 8);
    R.dir.forEach((v, d) => { if (v == null) return; g.fillStyle = DC[d]; g.beginPath(); g.arc(tx(v), yy, 3, 0, 7); g.fill(); });
    g.fillStyle = 'rgba(255,205,128,0.75)'; g.fillRect(x1 + 10, yy - 4, sx(R.sun) - (x1 + 10), 8);
    g.fillStyle = 'rgba(236,230,218,0.8)'; g.textAlign = 'left'; g.fillText(fmt(R.sun) + 'h', sx(R.sun) + 3, yy);
  });
  const ly = hgt - 8; let lx = 4;
  g.textAlign = 'left'; g.fillStyle = 'rgba(212,71,63,0.8)'; g.fillRect(lx, ly - 4, 10, 8); g.fillStyle = 'rgba(200,210,225,0.7)'; g.fillText('hottest', lx + 13, ly); lx += 62;
  DN.forEach((n, d) => { g.fillStyle = DC[d]; g.beginPath(); g.arc(lx + 3, ly, 3, 0, 7); g.fill(); g.fillStyle = 'rgba(200,210,225,0.7)'; g.fillText(n + '-facing', lx + 9, ly); lx += 56; });
}
$('#brief .bf-close').addEventListener('click', () => { showBriefPanel(false); setHighlight(null); });

// ------------------------------------------------------------------ key numbers (real data first)
function renderKeys() {
  const key = state.site, site = SITES[key]; if (!site) return;
  const M = PKG.measured[key], Y = PKG.year;
  const S = SIM[key].heat.base && SIM[key].heat.base.Tw ? (SIM[key].heat.base._stats || (SIM[key].heat.base._stats = siteStats(key, 'heat'))) : null;
  const k = (label, value, src, srcName, sub) => `<div class="key"><span class="k">${label}</span><span class="v">${value}</span><span class="s"><span class="src ${src}">${srcName}</span> ${sub}</span></div>`;
  let h = '';
  h += k('Ground temperature seen from space', `${fmt(M.landsatMed, 1)} °C`, 'meas', 'Landsat 8', `7 Jun 2026, 10:35 am. Hottest 30 m spot: ${fmt(M.landsatMax, 1)} °C`);
  if (M.modisPM != null) h += k('Afternoon, seen from space', `${fmt(M.modisPM, 1)} °C`, 'meas', 'MODIS Aqua', `10 Jun 2026, ${M.modisPMtime}, 1 km average`);
  h += k('Hottest air of the year', `${fmt(Y.hottestMax, 0)} °C`, 'rean', 'ERA5', `10 Jun 2026 · ${Y.daysAbove40} days at 40 °C or more in the past year`);
  h += k('Green cover (trees, grass)', `${S ? Math.round(S.greenShare * 100) : '–'}%`, 'meas', 'Landsat 8', 'of open ground, from the vegetation index');
  h += k('Covered by buildings', `${Math.round(site.builtShare * 100)}%`, 'meas', 'Google', `typical height ${site.medH} m, tallest ${site.maxH} m`);
  if (S) h += k('Hottest roofs, 3 pm', `≈ ${fmt(S.roofPeak, 0)} °C`, 'model', 'Model', 'estimate, likely 60–68 °C. The 1 km MODIS average reads lower, so treat as an upper value');
  h += k('Worst smog day', `${fmt(Y.pmWorstDaily, 0)} µg/m³`, 'rean', 'CAMS', `PM2.5 on 16 Jan 2026, about 17× the WHO daily limit`);
  $('#keys').innerHTML = h;
}

// ------------------------------------------------------------------ where to act first list
function renderPrio() {
  const site = SITES[state.site]; const el = $('#prioList'); if (!site || !site.tiles) { el.innerHTML = '<div class="muted">Computing…</div>'; return; }
  const top = site.tiles.ranked.slice(0, 5);
  el.innerHTML = top.map((t, j) => `<button class="pr-item" data-t="${t.i}"><span class="pr-n">${j + 1}</span><span class="pr-body"><span class="pr-title">${t.lever.title}</span><span class="pr-sub">${t.near ? t.near + ' · ' : ''}heat load ${fmt(t.dose, 0)} °C·h · ${fmt(t.floor / 1000, 1)}k m² floors</span></span><span class="pr-score">${t.score}</span></button>`).join('');
  el.querySelectorAll('.pr-item').forEach((b) => b.addEventListener('click', () => focusTile(+b.dataset.t)));
}
function focusTile(ti, fly = true) {
  const site = SITES[state.site]; const t = site.tiles.list[ti];
  const cells = []; for (let r = t.r * 10; r < t.r * 10 + 10; r++) for (let c = t.c * 10; c < t.c * 10 + 10; c++) cells.push(r * N + c);
  setHighlight(cells.filter((i) => site.H[i] > 0), site.H);
  const X = (t.center[1] - N / 2) * CELL, Z = (t.center[0] - N / 2) * CELL;
  if (fly) flyTo([X + 140, 170, Z + 190], [X, 10, Z], 1400);
  $('#prioDetail').innerHTML = `<div class="pd-title">${t.lever.title} <span>score ${t.score}</span></div><p>${t.lever.text}</p><p class="muted" style="font-size:11.5px;margin:0">Heat load ${fmt(t.dose, 0)} °C·h · ${fmt(t.floor, 0)} m² of floor space${t.fgMean != null ? ` · streets see ${fmt(t.fgMean * 100, 0)}% of the sky` : ''}</p>`;
}

// ------------------------------------------------------------------ camera flights
let flight = null;
function flyTo(pos, target, ms = 1600) {
  const p0 = camera.position.clone(), t0 = controls.target.clone(); const p1 = new THREE.Vector3(...pos), t1 = new THREE.Vector3(...target);
  const start = performance.now(); const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  flight = { p0, t0, p1, t1, start, ms: reduce ? 1 : ms };
  return new Promise((res) => (flight.res = res));
}
function stepFlight(now) {
  if (!flight) return;
  let k = clamp((now - flight.start) / flight.ms, 0, 1); const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
  camera.position.lerpVectors(flight.p0, flight.p1, e); controls.target.lerpVectors(flight.t0, flight.t1, e);
  if (k >= 1) { const r = flight.res; flight = null; r && r(); }
}

// ------------------------------------------------------------------ labels
const labelBox = $('#labels');
function renderLabels() {
  const site = SITES[state.site];
  const marks = site && site.meta.landmarks ? site.meta.landmarks : [];
  if (labelBox.children.length !== marks.length || labelBox.dataset.site !== state.site) {
    labelBox.innerHTML = marks.map((m) => `<div class="lm"><i></i>${m[0]}</div>`).join(''); labelBox.dataset.site = state.site;
  }
  const v = new THREE.Vector3(); const w = canvas.clientWidth, h = canvas.clientHeight;
  const placed = [];
  marks.forEach((m, j) => {
    const [nm, r, c] = m; const el = labelBox.children[j];
    v.set((c + 0.5 - N / 2) * CELL, site.H[r * N + c] * EX + 4, (r + 0.5 - N / 2) * CELL).project(camera);
    const px = (v.x + 1) / 2 * w, py = (1 - v.y) / 2 * h;
    if (!el._w) el._w = nm.length * 6.6 + 14;
    const box = [px - 4, py - 8, px + el._w, py + 8];
    let vis = v.z < 1 && px > 0 && px < w - 20 && py > 10 && py < h - 24;
    if (vis) for (const q of placed) if (box[0] < q[2] && box[2] > q[0] && box[1] < q[3] && box[3] > q[1]) { vis = false; break; }
    if (vis) placed.push(box);
    el.style.display = vis ? '' : 'none';
    if (vis) el.style.transform = `translate(${px}px, ${py - 6}px)`;
  });
  const lidLabel = $('#lidLabel');
  if (lid.visible) {
    v.set(-HALF + 60, lid.position.y, HALF - 60).project(camera);
    lidLabel.hidden = !(v.z < 1);
    lidLabel.style.transform = `translate(${(v.x + 1) / 2 * w}px, ${(1 - v.y) / 2 * h}px)`;
    lidLabel.textContent = `Pale layer = top of the air that smog can mix into: ${fmt(PKG.days.smog.forc.boundary_layer_height[state.hour], 0)} m`;
  } else lidLabel.hidden = true;
}

// ------------------------------------------------------------------ render loop
let rise = 1, riseStart = 0;
function resize() { const wrap = $('#stageWrap'); const w = Math.max(wrap.clientWidth, 10), h = Math.max(wrap.clientHeight, 10); renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); drawTimeline(); }
window.addEventListener('resize', resize);
new ResizeObserver(() => resize()).observe($('#stageWrap'));
// camera pose that shows the whole 1.2 km tile in the current map area
function fitPose(scale = 1, az = -0.4, el = 0.6) {
  const r = HALF * 1.18 * scale; const vf = camera.fov * Math.PI / 360; const hf = Math.atan(Math.tan(vf) * camera.aspect);
  const d = r / Math.sin(Math.min(vf, hf));
  return [[Math.sin(az) * Math.cos(el) * d, Math.sin(el) * d, Math.cos(az) * Math.cos(el) * d], [0, 0, 0]];
}
function loop(now) {
  stepFlight(now);
  const site = SITES[state.site];
  if (site && site.mesh && rise < 1) { rise = clamp((now - riseStart) / 2400, 0, 1); site.mesh.scale.y = 0.02 + 0.98 * (1 - Math.pow(1 - rise, 3)); }
  if (state.idleSpin && !flight) { const a = 0.00025; const p = camera.position, t = controls.target; const x = p.x - t.x, z = p.z - t.z; p.x = t.x + x * Math.cos(a) - z * Math.sin(a); p.z = t.z + x * Math.sin(a) + z * Math.cos(a); }
  controls.update(); renderer.render(scene, camera); renderLabels();
  requestAnimationFrame(loop);
}

// ------------------------------------------------------------------ state setters
async function setSite(key, { animate = false } = {}) {
  state.site = key;
  for (const k in SITES) if (SITES[k].mesh) SITES[k].mesh.visible = k === key;
  const site = await ensureSite(key);
  if (!site.mesh) { scene.add(buildMesh(site)); }
  site.mesh.visible = true;
  if (animate) { rise = 0; riseStart = performance.now(); }
  document.querySelectorAll('[data-site]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.site === key));
  $('#siteName').textContent = site.meta.long;
  $('#siteMeta').innerHTML = `1.2 × 1.2 km · ${Math.round(site.builtShare * 100)}% covered by buildings · typical height ${site.medH} m · ${site.nW.toLocaleString('en-US')} wall panels`;
  showBriefPanel(false); setHighlight(null); $('#prioDetail').innerHTML = '';
  $('#keysTitle').textContent = site.meta.long; renderKeys();
  await getSim(key, state.day, state.scen);
  if (!site.tiles) { site.tiles = computeTiles(site, await getSim(key, 'heat', 'base')); }
  renderPrio(); renderKeys(); recolor();
}
async function setDay(d) {
  state.day = d; document.querySelectorAll('[data-day]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.day === d));
  const doseBtn = document.querySelector('[data-layer="dose"]'); doseBtn.disabled = d !== 'heat';
  if (d !== 'heat' && state.layer === 'dose') state.layer = 'temp';
  await getSim(state.site, d, state.scen); setLayer(state.layer);
}
function setLayer(l) { state.layer = l; document.querySelectorAll('[data-layer]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.layer === l)); recolor(); }
function setHour(h) { state.hour = ((h % 24) + 24) % 24; recolor(); }
function scenName(s) { return { base: 'today', cool: 'cool roofs', shade: 'street shade', 'cool+shade': 'cool roofs + street shade' }[s]; }
async function setScen(s) {
  state.scen = s; $('#scenStatus').textContent = 'Recomputing every surface…';
  await getSim(state.site, state.day, s);
  const b = siteStats(state.site, state.day, 'base'); const n = siteStats(state.site, state.day, s);
  $('#scenStatus').innerHTML = s === 'base' ? 'Showing today.' : `Roof peak ${fmt(b.roofPeak)} → <b>${fmt(n.roofPeak)} °C</b> · street at 15:00 ${fmt(b.street[15])} → <b>${fmt(n.street[15])} °C</b>`;
  recolor();
}

// ------------------------------------------------------------------ controls wiring
document.querySelectorAll('[data-site]').forEach((b) => b.addEventListener('click', () => setSite(b.dataset.site, { animate: true })));
document.querySelectorAll('[data-day]').forEach((b) => b.addEventListener('click', () => setDay(b.dataset.day)));
document.querySelectorAll('[data-layer]').forEach((b) => b.addEventListener('click', () => setLayer(b.dataset.layer)));
$('#hour').addEventListener('input', (e) => setHour(+e.target.value));
let playT = null;
$('#play').addEventListener('click', () => {
  state.playing = !state.playing; $('#play').setAttribute('aria-pressed', state.playing); $('#play').textContent = state.playing ? 'Pause' : 'Play day';
  clearInterval(playT); if (state.playing) playT = setInterval(() => setHour(state.hour + 1), 700);
});
const scenBoxes = () => (($('#wCool').checked ? 'cool' : '') + ($('#wCool').checked && $('#wShade').checked ? '+' : '') + ($('#wShade').checked ? 'shade' : '')) || 'base';
$('#wCool').addEventListener('change', () => setScen(scenBoxes()));
$('#wShade').addEventListener('change', () => setScen(scenBoxes()));
$('#openMethod').addEventListener('click', () => ($('#method').hidden = false));
$('#method .bf-close').addEventListener('click', () => ($('#method').hidden = true));
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if (state.tour) endTour(); showBriefPanel(false); $('#method').hidden = true; }
  if (state.tour) { if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); nextScene(); } if (e.key === 'ArrowLeft') prevScene(); return; }
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'ArrowRight') setHour(state.hour + 1); if (e.key === 'ArrowLeft') setHour(state.hour - 1);
});

// ------------------------------------------------------------------ walkthrough
let SCENES = [];
function buildScenes() {
  const Y = PKG.year, fs = PKG.days.smog.forc;
  const wh = siteStats('walled', 'heat'), dh = siteStats('dha', 'heat'), wc = siteStats('walled', 'heat', 'cool');
  const W = SITES.walled, D = SITES.dha; const ex = W.meta.example;
  const plaza = buildingBrief(W, blob(W, ex.r * N + ex.c), SIM.walled.heat.base, 'heat');
  const lo = plaza.rows[0], top = plaza.rows[plaza.rows.length - 1];
  const exX = (ex.c - N / 2) * CELL, exZ = (ex.r - N / 2) * CELL;
  const h22 = 22;
  return [
    { eye: 'I · A year over Lahore', site: 'walled', day: 'heat', hour: 15, layer: 'temp', fit: 1.25, year: true,
      cap: `From November 2025 to November 2026, Lahore had ${Y.daysAbove40} days at 40 °C or more. The hottest was 10 June, at ${Y.hottestMax} °C. In winter the danger changes: fine dust (PM2.5) stayed above the WHO safe limit on every day of the year.` },
    { eye: 'II · Going in', site: 'walled', day: 'heat', hour: 15, layer: 'temp', fit: 1, rise: true,
      cap: `A normal heat map gives one number per area. This one climbs the walls. In 1.2 × 1.2 km of the Walled City it tracks ${(W.nW).toLocaleString('en-US')} wall panels, one storey each, plus every roof and every street, hour by hour.` },
    { eye: 'III · Two cities', site: 'dha', day: 'heat', hour: 15, layer: 'temp', fit: 1, rise: true,
      cap: `Same sun, same air, 14.5 km apart. In DHA Phase 2, buildings cover ${Math.round(D.builtShare * 100)}% of the ground; in the Walled City, ${Math.round(W.builtShare * 100)}%. Typical heights: ${D.medH} m against ${W.medH} m.` },
    { eye: 'IV · The street', site: 'walled', day: 'heat', hour: 15, layer: 'sun', cam: [[120, 260, 330], [0, 0, -20]],
      cap: `On 10 June, the Walled City's streets were in direct sun for ${fmt(wh.streetSunH)} hours. DHA's streets: ${fmt(dh.streetSunH)} hours. Tall buildings on narrow lanes shade the street.` },
    { eye: 'IV · The street', site: 'walled', day: 'heat', hour: 15, layer: 'temp', cam: [[120, 260, 330], [0, 0, -20]],
      cap: `Shade alone does not keep them cool. The Landsat satellite measured the Walled City ${fmt(PKG.measured.walled.landsatMed - PKG.measured.dha.landsatMed, 1)} °C hotter than DHA. One reason: trees and grass cover ${Math.round(dh.greenShare * 100)}% of DHA's open ground, but only ${Math.round(wh.greenShare * 100)}% in the old city.` },
    { eye: 'V · One building', site: 'walled', day: 'heat', hour: 15, layer: 'temp', cam: [[exX + 120, 130, exZ + 150], [exX, 30, exZ]], brief: ex,
      cap: `Take one building: ${ex.name}, about ${plaza.height} m tall, ${plaza.rows.length} storeys. The model splits each outside wall into storeys and follows each one through the day.` },
    { eye: 'V · One building', site: 'walled', day: 'heat', hour: 15, layer: 'sun', cam: [[exX + 120, 130, exZ + 150], [exX, 30, exZ]], brief: ex,
      cap: `The ground floor walls get ${fmt(lo.sun)} hours of direct sun. The top floor walls get ${fmt(top.sun)} hours.` },
    { eye: 'V · One building', site: 'walled', day: 'heat', hour: 15, layer: 'temp', cam: [[exX - 90, 60, exZ + 120], [exX, 25, exZ]], brief: ex,
      cap: `Yet the ground floor gets hotter: ${fmt(lo.peak)} °C against ${fmt(top.peak)} °C. Surrounded by neighbours, it sees only ${Math.round(Math.min(lo.fsky * 200, 100))}% of the open sky, so its heat bounces between walls instead of escaping.` },
    { eye: 'VI · Roofs', site: 'walled', day: 'heat', hour: 15, layer: 'temp', fit: 0.62,
      cap: `Roofs are the hottest surfaces in the afternoon, about ${fmt(wh.roofPeak, 0)} °C in the model (likely 60–68 °C). That is the model's upper estimate: NASA's coarser MODIS satellite, averaging 1 km, reads cooler.` },
    { eye: 'VI · Roofs', site: 'walled', day: 'heat', hour: 4, layer: 'temp', fit: 0.62,
      cap: `By 4 am they are the coolest, about ${fmt(wh.roof[4], 0)} °C, below the ${fmt(PKG.days.heat.forc.temperature_2m[4], 0)} °C air, because they face the whole open sky. That is why people in the old city sleep on their roofs.` },
    { eye: 'VII · What if', site: 'walled', day: 'heat', hour: 15, layer: 'temp', scen: 'cool', fit: 0.62,
      cap: `Paint every roof white with lime wash and the model's roof peak drops from about ${fmt(wh.roofPeak, 0)} °C to ${fmt(wc.roofPeak, 0)} °C. The street below barely changes (${fmt(wh.street[15], 0)} → ${fmt(wc.street[15], 0)} °C). Each surface needs its own fix.` },
    { eye: 'VIII · Winter', site: 'walled', day: 'smog', hour: h22, layer: 'temp', cam: [[-430, 70, 560], [-120, 28, 160]],
      cap: `10 November, 10 pm. PM2.5 reached ${fmt(fs.pm2_5[h22], 0)} µg/m³. The layer of air that smog can mix into had shrunk to ${fmt(fs.boundary_layer_height[h22], 0)} m, about rooftop height (the pale sheet). The smoke has nowhere to go.` },
    { eye: 'VIII · Winter', site: 'walled', day: 'smog', hour: h22, layer: 'vent', cam: [[120, 260, 330], [0, 0, -20]],
      cap: `Under that lid, open streets clear faster. The Walled City's streets see ${Math.round(wh.fgMed * 100)}% of the sky; DHA's see ${Math.round(dh.fgMed * 100)}%. The same narrow lanes that trap heat in June trap smoke in November.` },
    { eye: 'IX · Where to act first', site: 'walled', day: 'heat', hour: 15, layer: 'prio', fit: 1, prio: true,
      cap: `GIS turns all of this into a plan: every 40 m block ranked by heat load and floor space, each with the fix that suits it. Heat has an address. GIS finds it. Developed by Muhammad Mehdi & Hussain Ahmad.` }
  ];
}
let sceneIdx = 0;
async function startTour() {
  $('#intro').hidden = true; document.body.classList.remove('intro'); document.body.classList.add('touring'); state.tour = true; state.idleSpin = false;
  $('#capText').textContent = 'Preparing the walkthrough…';
  await Promise.all([getSim('walled', 'heat'), getSim('dha', 'heat'), getSim('walled', 'heat', 'cool'), getSim('walled', 'smog')]);
  if (!SITES.dha.tiles) SITES.dha.tiles = computeTiles(SITES.dha, SIM.dha.heat.base);
  SCENES = buildScenes(); sceneIdx = 0; showScene(0);
}
async function showScene(i) {
  sceneIdx = clamp(i, 0, SCENES.length - 1); const S = SCENES[sceneIdx];
  $('#capEye').textContent = S.eye; $('#capText').textContent = S.cap;
  $('#tourCount').textContent = `${sceneIdx + 1} / ${SCENES.length}`;
  $('#yearCard').hidden = !S.year; if (S.year) requestAnimationFrame(() => drawYear($('#yearChart')));
  showBriefPanel(false); setHighlight(null);
  state.scen = S.scen || 'base'; $('#wCool').checked = state.scen.includes('cool'); $('#wShade').checked = false;
  state.hour = S.hour; state.day = S.day;
  document.querySelectorAll('[data-day]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.day === S.day));
  if (state.site !== S.site || S.rise) await setSite(S.site, { animate: !!S.rise }); else await getSim(S.site, S.day, state.scen);
  setLayer(S.layer);
  const cam = S.fit ? fitPose(S.fit) : S.cam; flyTo(cam[0], cam[1], 2200);
  if (S.brief) openBrief(S.brief.r * N + S.brief.c, S.brief.name);
  if (S.prio) { const t = SITES.walled.tiles.ranked[0]; focusTile(t.i, false); }
}
function nextScene() { if (sceneIdx < SCENES.length - 1) showScene(sceneIdx + 1); else endTour(); }
function prevScene() { showScene(sceneIdx - 1); }
function endTour() { state.tour = null; document.body.classList.remove('touring'); $('#yearCard').hidden = true; state.scen = 'base'; $('#wCool').checked = false; renderKeys(); recolor(); }
$('#tourNext').addEventListener('click', nextScene);
setTimeout(() => {}, 0); $('#tourPrev').addEventListener('click', prevScene); $('#tourExit').addEventListener('click', endTour);

// ------------------------------------------------------------------ boot
async function boot() {
  document.body.classList.add('intro');
  resize(); { const p = fitPose(0.95, -0.55, 0.55); camera.position.set(...p[0]); controls.target.set(0, 0, 0); camera.position.x += HALF * 0.55; controls.target.x += HALF * 0.55; } requestAnimationFrame(loop);
  state.idleSpin = true;
  $('#bootStatus').textContent = 'Loading building heights…';
  await setSite('walled', { animate: true });
  $('#bootStatus').textContent = 'Solving surface heat for every wall, roof and street…';
  await getSim('walled', 'heat'); recolor();
  const W = SITES.walled;
  $('#bootStatus').textContent = ''; void W;
  $('#startTour').disabled = false; $('#startMap').disabled = false;
  ensureSite('dha').then(() => { getSim('dha', 'heat'); getSim('walled', 'heat', 'cool'); getSim('walled', 'smog'); getSim('dha', 'smog'); });
}
$('#startTour').addEventListener('click', startTour);
$('#startMap').addEventListener('click', () => { $('#intro').hidden = true; document.body.classList.remove('intro'); state.idleSpin = false; requestAnimationFrame(() => { resize(); const p = fitPose(); flyTo(p[0], p[1], 1600); }); });
$('#backIntro').addEventListener('click', () => { $('#intro').hidden = false; document.body.classList.add('intro'); state.idleSpin = true; });
boot();
