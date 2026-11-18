import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import LC from './lc.js';
import workerSrc from './worker.txt';

// ================================================================== data
const PKG = JSON.parse(document.getElementById('pkg').textContent);
const N = PKG.N, CELL = PKG.cell, EX = PKG.exag, BAND = PKG.band;
const HALF = N * CELL / 2;
const $ = (s) => document.querySelector(s);
const fmt = (v, d = 1) => (v == null || isNaN(v)) ? '–' : v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const hhmm = (h) => String(h).padStart(2, '0') + ':00';
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const INNER = (i) => { const r = (i / N) | 0, c = i % N; return r > 15 && r < N - 15 && c > 15 && c < N - 15; };
const remPx = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 15;
const DAYNAME = { heat: '10 Jun 2026', smog: '10 Nov 2026' };

const state = { site: 'walled', day: 'heat', hour: 15, layer: 'lst', tour: false, idleSpin: true, brief: null };
const SITES = {};
const SIM = { walled: {}, dha: {} };

// ================================================================== model worker (only for the white-roof estimate)
const worker = new Worker(URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' })));
let jobId = 0; const pending = {};
worker.onmessage = (e) => { const p = pending[e.data.id]; delete pending[e.data.id]; p(e.data); };
function getSim(key, scen) {
  if (!SIM[key]['p' + scen]) SIM[key]['p' + scen] = ensureSite(key).then(() => new Promise((res) => {
    const params = JSON.parse(JSON.stringify(PKG.params)); if (scen === 'cool') params.roof.a = 0.30;
    const id = ++jobId; pending[id] = (r) => { SIM[key][scen] = r; res(r); }; worker.postMessage({ type: 'run', id, key, dayName: 'heat', day: PKG.days.heat, params, opts: {} });
  }));
  return SIM[key]['p' + scen];
}

async function inflate(b64) {
  const bin = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
  const ds = new Blob([bin]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(ds).arrayBuffer());
}
const litBit = (arr, n, h, e) => (arr[h * Math.ceil(n / 8) + (e >> 3)] >> (7 - (e & 7))) & 1;

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
  site.roofOf = new Int32Array(N * N).fill(-1); geom.roofs.forEach((c, e) => (site.roofOf[c] = e));
  site.groundOf = new Int32Array(N * N).fill(-1); geom.ground.forEach((c, e) => (site.groundOf[c] = e));
  site.wallsOf = new Map();
  for (let e = 0; e < site.nW; e++) { const c = geom.W.cell[e]; if (!site.wallsOf.has(c)) site.wallsOf.set(c, []); site.wallsOf.get(c).push(e); }
  // measured Landsat value for every 4 m cell (the 30 m pixel it falls in)
  const L = PKG.landsat[key], [xmin, ymax] = site.meta.utm;
  site.lst = new Float32Array(N * N);
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    const i = Math.floor((L.gy1 - (ymax - CELL * r - 2)) / 30), j = Math.floor((xmin + CELL * c + 2 - L.gx0) / 30);
    site.lst[r * N + c] = L.vals[i * L.W + j] / 10 + 40;
  }
  site.photo = {};
  for (const d of ['heat', 'smog']) {
    const im = new Image(); im.src = 'data:image/jpeg;base64,' + PKG.photo[d + '_' + key]; await im.decode();
    const cv = document.createElement('canvas'); cv.width = cv.height = N; const g = cv.getContext('2d'); g.drawImage(im, 0, 0, N, N);
    site.photo[d] = g.getImageData(0, 0, N, N).data;
  }
  const hs = []; let built = 0; for (let i = 0; i < N * N; i++) if (H[i] > 0) { built++; hs.push(H[i]); }
  hs.sort((a, b) => a - b);
  site.builtShare = built / (N * N); site.medH = hs[hs.length >> 1]; site.maxH = hs[hs.length - 1];
  site.stats = siteStats(site);
  SITES[key] = site;
  return site;
}
const LOADING = {};
function ensureSite(key) { return LOADING[key] || (LOADING[key] = loadSite(key)); }

function siteStats(site) {
  const { nR, nG, geom } = site, L = site.lit.heat;
  let rs = 0, rk = 0, gs = 0, gk = 0, green = 0; const fgs = [];
  for (let e = 0; e < nR; e++) if (INNER(geom.roofs[e])) { for (let h = 0; h < 24; h++) rs += litBit(L.r, nR, h, e); rk++; }
  for (let e = 0; e < nG; e++) if (INNER(geom.ground[e])) { for (let h = 0; h < 24; h++) gs += litBit(L.g, nG, h, e); gk++; if (site.ndvi[geom.ground[e]] > 0.3) green++; fgs.push(site.fg[e]); }
  fgs.sort((a, b) => a - b);
  const v = PKG.landsat[site.key].vals.map((x) => x / 10 + 40).sort((a, b) => a - b);
  return { roofSunH: rs / rk, streetSunH: gs / gk, greenShare: green / gk, skyMed: fgs[fgs.length >> 1], lstMed: v[v.length >> 1], lstMax: v[v.length - 1], lstMin: v[0] };
}

// ================================================================== colour
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
function makeRamp(stops) { const cs = stops.map(hex); return (t) => { t = clamp(t, 0, 1) * (cs.length - 1); const i = Math.min(Math.floor(t), cs.length - 2), f = t - i; return [0, 1, 2].map((k) => cs[i][k] + (cs[i + 1][k] - cs[i][k]) * f); }; }
const RAMP = {
  lst: makeRamp(['#2b4f8a', '#4f8fb0', '#9cc7b0', '#f1df8a', '#f3a65a', '#e0603e', '#a8233a']),
  sky: makeRamp(['#2a1238', '#5a2a6e', '#8f4f8a', '#c98a7a', '#f0c987', '#fbf3d5']),
  hours: makeRamp(['#1d2433', '#3d3a52', '#7d5a5a', '#c7804a', '#f2b44f', '#fff1b8']),
  cool: makeRamp(['#3a3f4a', '#3d5d86', '#4f8fc8', '#8fc6f2', '#dff1ff'])
};
const LST_RANGE = [47, 55];
const GREY = [86, 92, 104];

// ================================================================== three.js scene
const canvas = $('#stage');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
const scene = new THREE.Scene();
scene.background = new THREE.Color('#0b0e13');
const camera = new THREE.PerspectiveCamera(40, 1, 5, 12000);
camera.position.set(-260, 820, 1150);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true; controls.maxPolarAngle = Math.PI * 0.47; controls.minDistance = 60; controls.maxDistance = 3800;

const ambient = new THREE.AmbientLight(0xffffff, 1.0);
const sunLight = new THREE.DirectionalLight(0xfff0d0, 1.6);
scene.add(ambient, sunLight, sunLight.target);

const basePlate = new THREE.Mesh(new THREE.PlaneGeometry(N * CELL + 120, N * CELL + 120), new THREE.MeshBasicMaterial({ color: '#141922' }));
basePlate.rotation.x = -Math.PI / 2; basePlate.position.y = -0.6; scene.add(basePlate);
scene.add(new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(N * CELL, 0.1, N * CELL)), new THREE.LineBasicMaterial({ color: '#3a4250' })));

// smog: the lid of the mixing layer
const lid = new THREE.Mesh(new THREE.PlaneGeometry(N * CELL, N * CELL), new THREE.MeshBasicMaterial({ color: '#c8b89a', transparent: true, opacity: 0.16, side: THREE.DoubleSide, depthWrite: false }));
lid.rotation.x = -Math.PI / 2; lid.visible = false; scene.add(lid);

// the sun: glowing ball, ray to the city, path across the day
const SUN_R = HALF * 1.25;
const sunVec = (alt, az) => new THREE.Vector3(Math.sin(az) * Math.cos(alt) * SUN_R, Math.sin(alt) * SUN_R, -Math.cos(az) * Math.cos(alt) * SUN_R);
function glowTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d');
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,248,220,1)'); gr.addColorStop(0.18, 'rgba(255,220,130,0.95)'); gr.addColorStop(0.4, 'rgba(255,190,90,0.35)'); gr.addColorStop(1, 'rgba(255,170,60,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128); return new THREE.CanvasTexture(c);
}
const sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(), blending: THREE.AdditiveBlending, depthWrite: false, fog: false, transparent: true }));
sunGlow.scale.set(220, 220, 1);
const sunBall = new THREE.Mesh(new THREE.SphereGeometry(22, 24, 16), new THREE.MeshBasicMaterial({ color: '#fff3c4', fog: false }));
const sunRay = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: '#ffd27a', transparent: true, opacity: 0.75, fog: false }));
let sunPath = null;
scene.add(sunGlow, sunBall, sunRay);
const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
function sunInfo() {
  const day = PKG.days[state.day], h = state.hour, alt = day.alt[h], az = day.az[h];
  return { up: alt > 2 * Math.PI / 180, alt, az, deg: Math.round(alt * 180 / Math.PI), from: COMPASS[Math.round(az * 180 / Math.PI / 45) % 8] };
}
function updateSun() {
  const day = PKG.days[state.day], S = sunInfo(), intro = document.body.classList.contains('intro');
  const show = S.up && !intro;
  sunGlow.visible = sunBall.visible = sunRay.visible = show;
  if (sunPath) { scene.remove(sunPath); sunPath.geometry.dispose(); }
  const pts = []; for (let k = 0; k < 24; k++) if (day.alt[k] > 0) pts.push(sunVec(day.alt[k], day.az[k]));
  sunPath = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ color: '#ffd27a', dashSize: 14, gapSize: 12, transparent: true, opacity: 0.45, fog: false }));
  sunPath.computeLineDistances(); sunPath.visible = !intro && pts.length > 1; scene.add(sunPath);
  if (S.up) {
    const p = sunVec(S.alt, S.az);
    sunBall.position.copy(p); sunGlow.position.copy(p); sunRay.geometry.setFromPoints([p, new THREE.Vector3(0, 0, 0)]);
    sunLight.position.copy(p); sunLight.intensity = 0.6 + 1.2 * Math.sin(S.alt); ambient.intensity = 0.9;
  } else { sunLight.intensity = 0; ambient.intensity = state.day === 'smog' ? 0.9 : 1.05; }
}

// highlight box
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
  const pos = new Float32Array(nq * 12), idx = new Uint32Array(nq * 6);
  let q = 0;
  const quad = (a, b, c, d) => { pos.set(a, q * 12); pos.set(b, q * 12 + 3); pos.set(c, q * 12 + 6); pos.set(d, q * 12 + 9); const v = q * 4; idx.set([v, v + 1, v + 2, v, v + 2, v + 3], q * 6); q++; };
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
  const colors = new Uint8Array(nq * 12);
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3, true));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  g.computeVertexNormals(); g.computeBoundingSphere();
  const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  m.frustumCulled = false;
  site.mesh = m; site.colors = colors;
  return m;
}

// ================================================================== colouring
function setQuadColor(colors, q, rgb, f) {
  const r = clamp(rgb[0] * f, 0, 255), g = clamp(rgb[1] * f, 0, 255), b = clamp(rgb[2] * f, 0, 255), o = q * 12;
  colors[o] = colors[o + 3] = colors[o + 6] = colors[o + 9] = r;
  colors[o + 1] = colors[o + 4] = colors[o + 7] = colors[o + 10] = g;
  colors[o + 2] = colors[o + 5] = colors[o + 8] = colors[o + 11] = b;
}
const sunHours = (arr, n, e) => { let s = 0; for (let k = 0; k < 24; k++) s += litBit(arr, n, k, e); return s; };

function recolor() {
  const site = SITES[state.site]; if (!site || !site.mesh) return;
  const { nR, nG, nW, geom, colors } = site, h = state.hour, W = geom.W, layer = state.layer;
  const L = site.lit[state.day], up = sunInfo().up;
  const shadeF = (arr, n, e) => (up && !litBit(arr, n, h, e) ? 0.58 : 1);
  if (layer === 'lst') {
    const t = (v) => (v - LST_RANGE[0]) / (LST_RANGE[1] - LST_RANGE[0]);
    for (let e = 0; e < nR; e++) setQuadColor(colors, e, RAMP.lst(t(site.lst[geom.roofs[e]])), shadeF(L.r, nR, e));
    for (let e = 0; e < nG; e++) setQuadColor(colors, nR + e, RAMP.lst(t(site.lst[geom.ground[e]])), 0.92 * shadeF(L.g, nG, e));
    for (let e = 0; e < nW; e++) setQuadColor(colors, nR + nG + e, RAMP.lst(t(site.lst[W.cell[e]])), 0.85 * shadeF(L.w, nW, e));
  } else if (layer === 'sun') {
    const SUN = [255, 214, 140], SH = [48, 74, 140], NIGHT = [40, 46, 62];
    for (let e = 0; e < nR; e++) setQuadColor(colors, e, !up ? NIGHT : (litBit(L.r, nR, h, e) ? SUN : SH), 1);
    for (let e = 0; e < nG; e++) setQuadColor(colors, nR + e, !up ? NIGHT : (litBit(L.g, nG, h, e) ? SUN : SH), 0.9);
    for (let e = 0; e < nW; e++) setQuadColor(colors, nR + nG + e, !up ? NIGHT : (litBit(L.w, nW, h, e) ? SUN : SH), 0.95);
  } else if (layer === 'hours') {
    for (let e = 0; e < nR; e++) setQuadColor(colors, e, RAMP.hours(sunHours(L.r, nR, e) / 14), 1);
    for (let e = 0; e < nG; e++) setQuadColor(colors, nR + e, RAMP.hours(sunHours(L.g, nG, e) / 14), 1);
    for (let e = 0; e < nW; e++) setQuadColor(colors, nR + nG + e, RAMP.hours(sunHours(L.w, nW, e) / 14), 1);
  } else if (layer === 'sky') {
    const BLD = [170, 176, 188];
    for (let e = 0; e < nR; e++) setQuadColor(colors, e, BLD, 1);
    for (let e = 0; e < nG; e++) setQuadColor(colors, nR + e, RAMP.sky(site.fg[e]), 1);
    for (let e = 0; e < nW; e++) setQuadColor(colors, nR + nG + e, BLD, 0.75);
  } else if (layer === 'photo') {
    const P = site.photo[state.day], px = (i) => [P[i * 4], P[i * 4 + 1], P[i * 4 + 2]];
    for (let e = 0; e < nR; e++) setQuadColor(colors, e, px(geom.roofs[e]), 1.15);
    for (let e = 0; e < nG; e++) setQuadColor(colors, nR + e, px(geom.ground[e]), 1.15);
    for (let e = 0; e < nW; e++) setQuadColor(colors, nR + nG + e, px(W.cell[e]), 0.8);
  } else if (layer === 'roof') {
    const B = SIM[state.site].base, C = SIM[state.site].cool;
    const ok = B && B.Tr && C && C.Tr;
    for (let e = 0; e < nR; e++) setQuadColor(colors, e, ok ? RAMP.cool((B.Tr[h * nR + e] - C.Tr[h * nR + e]) / 20) : GREY, 1);
    for (let e = 0; e < nG; e++) setQuadColor(colors, nR + e, GREY, 0.7);
    for (let e = 0; e < nW; e++) setQuadColor(colors, nR + nG + e, GREY, 0.85);
  }
  site.mesh.geometry.attributes.color.needsUpdate = true;
  updateSun(); updateAtmosphere(); updateLegend(); updateBar(); drawTimeline();
}

// ================================================================== smog look and AQI
// US EPA PM2.5 breakpoints (2024)
const AQI = [[0, 9, 0, 50, 'Good', '#00a64f'], [9.1, 35.4, 51, 100, 'Moderate', '#c9a400'], [35.5, 55.4, 101, 150, 'Unhealthy for sensitive groups', '#e46b00'], [55.5, 125.4, 151, 200, 'Unhealthy', '#d42020'], [125.5, 225.4, 201, 300, 'Very unhealthy', '#7d2e8f'], [225.5, 500, 301, 500, 'Hazardous', '#7e0023']];
function aqiOf(pm) {
  const b = AQI.find((x) => pm <= x[1]) || AQI[AQI.length - 1];
  return { aqi: Math.round(b[2] + (b[3] - b[2]) * (clamp(pm, b[0], b[1]) - b[0]) / (b[1] - b[0])), name: b[4], color: b[5] };
}
function updateAtmosphere() {
  const f = PKG.days[state.day].forc, h = state.hour;
  if (state.day === 'smog') {
    const pm = f.pm2_5[h];
    scene.fog = new THREE.FogExp2('#5f574b', clamp(pm / 260 * 0.00055, 0.00015, 0.0006));
    scene.background = new THREE.Color('#17140f');
    const blh = f.boundary_layer_height[h];
    lid.visible = blh < 500; lid.position.y = Math.max(blh, 3) * EX;
  } else {
    scene.fog = null; scene.background = new THREE.Color('#0b0e13'); lid.visible = false;
  }
}

// ================================================================== layer info, legend, map bar
const LAYERS = {
  lst: { what: 'Ground heat from space', tag: 'meas', when: () => `Landsat 8 · measured 7 Jun 2026, 10:35 am · 30 m pixels`,
    note: () => `Temperature of the ground and roofs measured by the Landsat 8 satellite. Each 30 m square has its own value; walls take the colour of the square above them. Darker faces are in shadow at the hour you pick.` },
  sun: { what: 'Sun and shade', tag: 'calc', when: () => `${DAYNAME[state.day]}, ${hhmm(state.hour)} · calculated from the sun's position and building heights`,
    note: () => `Yellow: in direct sunlight now. Blue: shaded by other buildings. The glowing ball is the sun and the dashed line its path today. Move the hour to watch the shadows turn.` },
  hours: { what: 'Hours of sun in the day', tag: 'calc', when: () => `${DAYNAME[state.day]}, whole day · calculated`,
    note: () => `How many hours each roof, wall and street gets direct sun on this day. Narrow lanes get far fewer hours than roofs.` },
  sky: { what: 'Open sky', tag: 'calc', when: () => `calculated from building heights`,
    note: () => `How much of the sky each street can see. Only the streets and open ground are coloured. Dark purple lanes are enclosed: they hold heat at night and smoke clears from them slowly. Buildings are plain grey (no data on them in this layer).` },
  photo: { what: 'Satellite photo', tag: 'meas', when: () => `Sentinel-2 · ${PKG.photoMeta[state.day].date}, about 10:40 am · 10 m pixels`,
    note: () => `A real true-colour photo from the European Sentinel-2 satellite, ${PKG.photoMeta[state.day].date}, draped over the buildings. Use it to check the other layers: compare where the trees, roads and open ground are with the heat colours.` },
  roof: { what: 'What if roofs were white', tag: 'model', when: () => `10 Jun 2026, ${hhmm(state.hour)} · model estimate, not a measurement`,
    note: () => `How much cooler each roof would be with white lime wash, estimated by the model. Bright blue = much cooler. Streets and walls are grey.` }
};
function rampCSS(r, n = 8) { return 'linear-gradient(90deg,' + Array.from({ length: n }, (_, i) => `rgb(${r(i / (n - 1)).map(Math.round).join(',')}) ${Math.round(i / (n - 1) * 100)}%`).join(',') + ')'; }
function updateLegend() {
  const l = state.layer; let bar, ticks;
  if (l === 'lst') { bar = rampCSS(RAMP.lst); ticks = [47, 49, 51, 53, 55].map((v, i) => [i * 25, v + ' °C']); }
  else if (l === 'sun') { bar = 'linear-gradient(90deg,#3e5278 0 50%,#ffd68c 50% 100%)'; ticks = [[0, 'shade'], [100, 'direct sun']]; }
  else if (l === 'hours') { bar = rampCSS(RAMP.hours); ticks = [[0, '0 h'], [50, '7 h'], [100, '14 h']]; }
  else if (l === 'photo') { bar = 'linear-gradient(90deg,#5d6b45,#a39780,#c9bfae)'; ticks = [[0, 'trees'], [50, 'roofs, roads'], [100, 'bright roofs']]; }
  else if (l === 'sky') { bar = rampCSS(RAMP.sky); ticks = [[0, '0%'], [50, '50%'], [100, '100% open']]; }
  else { bar = rampCSS(RAMP.cool); ticks = [[0, '0 °C'], [50, '10 °C'], [100, '20 °C cooler']]; }
  $('#lgBar').style.background = bar;
  $('#lgTicks').innerHTML = ticks.map(([p, t]) => `<span style="left:${p}%">${t}</span>`).join('');
  $('#lgNote').textContent = LAYERS[l].note();
}
function updateBar() {
  const L = LAYERS[state.layer];
  $('#barWhat').innerHTML = `${L.what} <span class="tag ${L.tag}">${(state.layer === 'photo' ? 'Photo' : { meas: 'Measured', calc: 'Calculated', model: 'Model' }[L.tag])}</span>`;
  $('#barWhen').textContent = L.when();
  const a = $('#aqi');
  if (state.day === 'smog') {
    const pm = PKG.days.smog.forc.pm2_5[state.hour], q = aqiOf(pm);
    a.hidden = false; a.style.background = q.color;
    a.innerHTML = `${q.name} · PM2.5 ${fmt(pm, 0)} µg/m³ <span style="font-weight:400;opacity:.85">(CAMS model)</span>`;
  } else a.hidden = true;
  const S = sunInfo();
  $('#hourLabel').textContent = hhmm(state.hour);
  $('#dayLabel').textContent = `${DAYNAME[state.day]} · Lahore time · sun ${S.up ? S.deg + '° high, in the ' + S.from : 'below horizon'}`;
  $('#hour').value = state.hour;
}

// ================================================================== key numbers
function renderKeys() {
  const site = SITES[state.site]; if (!site) return;
  const S = site.stats, M = PKG.measured[state.site], Y = PKG.year;
  const k = (label, value, tag, tagName, sub) => `<div class="key"><span class="k">${label}</span><span class="v">${value}</span><span class="s"><span class="tag ${tag}">${tagName}</span> ${sub}</span></div>`;
  $('#keysSite').textContent = site.meta.name;
  let h = '';
  h += k('Ground heat, typical', `${fmt(S.lstMed)} °C`, 'meas', 'Landsat 8', `7 Jun 2026, 10:35 am · middle of 1,681 pixels; hottest pixel ${fmt(S.lstMax)} °C`);
  h += k('Ground heat, afternoon', `${fmt(M.modisPM)} °C`, 'meas', 'MODIS', '10 Jun 2026, 2:48 pm · 1 km average');
  h += k('Ground heat, before dawn', `${fmt(M.modisNight)} °C`, 'meas', 'MODIS', '10 Jun 2026, 4:30 am · 1 km average');
  h += k('Hottest air of the year', `${fmt(Y.hottestMax, 0)} °C`, 'meas', 'ERA5', `10 Jun 2026 · ${Y.daysAbove40} days ≥ 40 °C, Nov 2025 – Nov 2026`);
  h += k('Green cover (trees, grass)', `${Math.round(S.greenShare * 100)}%`, 'meas', 'Landsat 8', 'of open ground, 7 Jun 2026');
  h += k('Ground covered by buildings', `${Math.round(site.builtShare * 100)}%`, 'meas', 'Google', `2023 · typical height ${site.medH} m, tallest ${site.maxH} m`);
  h += k('Streets in direct sun', `${fmt(S.streetSunH)} h`, 'calc', 'Calculated', `10 Jun 2026 · roofs ${fmt(S.roofSunH)} h`);
  h += k('Worst smog day', `${fmt(Y.pmWorstDaily, 0)} µg/m³`, 'model', 'CAMS model', `PM2.5, ${Y.pmWorstDay} · WHO daily limit is 15`);
  $('#keys').innerHTML = h;
}

// ================================================================== bottom chart (weather and satellite only)
function drawTimeline() {
  const cv = $('#timeline'); const dpr = Math.min(window.devicePixelRatio, 2);
  const w = cv.clientWidth, hgt = cv.clientHeight; if (!w) return;
  cv.width = w * dpr; cv.height = hgt * dpr; const g = cv.getContext('2d'); g.scale(dpr, dpr);
  const f = PKG.days[state.day].forc, M = PKG.measured[state.site], heat = state.day === 'heat';
  const fs = Math.round(remPx() * 0.7);
  const pad = { l: fs * 3, r: fs, t: fs * 0.6, b: fs * 1.5 }; const W = w - pad.l - pad.r, Hh = hgt - pad.t - pad.b;
  const x = (i) => pad.l + i / 23 * W;
  g.font = `${fs}px "IBM Plex Mono", ui-monospace, monospace`; g.textBaseline = 'middle';
  const lo = heat ? 20 : 0, hi = heat ? 50 : 300;
  const y = (v) => pad.t + Hh - (clamp(v, lo, hi) - lo) / (hi - lo) * Hh;
  if (!heat) AQI.forEach((b) => { if (b[0] > hi) return; g.fillStyle = b[5] + '2a'; g.fillRect(pad.l, y(Math.min(b[1], hi)), W, y(b[0]) - y(Math.min(b[1], hi))); });
  const sw = f.shortwave_radiation; g.fillStyle = 'rgba(255,205,128,0.15)'; g.beginPath(); g.moveTo(x(0), pad.t + Hh);
  sw.forEach((v, i) => g.lineTo(x(i), pad.t + Hh - Math.min(v / 1000, 1) * Hh)); g.lineTo(x(23), pad.t + Hh); g.closePath(); g.fill();
  g.strokeStyle = 'rgba(200,210,225,0.1)'; g.fillStyle = 'rgba(200,210,225,0.55)';
  (heat ? [20, 35, 50] : [0, 150, 300]).forEach((t) => { g.beginPath(); g.moveTo(pad.l, y(t)); g.lineTo(pad.l + W, y(t)); g.stroke(); g.textAlign = 'right'; g.fillText(t, pad.l - 5, y(t)); });
  g.textAlign = 'center'; [0, 6, 12, 18, 23].forEach((i) => g.fillText(hhmm(i), x(i), hgt - fs * 0.6));
  const line = (v, c, dash) => { g.strokeStyle = c; g.lineWidth = 2; g.setLineDash(dash ? [5, 4] : []); g.beginPath(); v.forEach((a, i) => (i ? g.lineTo(x(i), y(a)) : g.moveTo(x(i), y(a)))); g.stroke(); g.setLineDash([]); g.fillStyle = c; g.beginPath(); g.arc(x(state.hour), y(v[state.hour]), 3.5, 0, 7); g.fill(); };
  let head = '';
  if (heat) {
    line(f.temperature_2m, '#9fb3c8');
    [[4.5, M.modisNight], [14.8, M.modisPM]].forEach(([t, v]) => { g.fillStyle = '#7fd3a0'; g.save(); g.translate(x(t), y(v)); g.rotate(Math.PI / 4); g.fillRect(-4.5, -4.5, 9, 9); g.restore(); g.textAlign = 'left'; g.fillText(fmt(v) + '°', x(t) + 9, y(v)); });
    head = `<span><i style="background:#9fb3c8"></i>Air <b>${fmt(f.temperature_2m[state.hour])} °C</b> <span class="tag meas">ERA5</span></span>`
      + `<span><i style="background:#7fd3a0;width:0.5rem;height:0.5rem;transform:rotate(45deg)"></i>Ground from space <b>${fmt(M.modisNight)} °C</b> at 4:30 am, <b>${fmt(M.modisPM)} °C</b> at 2:48 pm <span class="tag meas">MODIS</span></span>`
      + `<span><i style="background:rgba(255,205,128,0.5);height:0.5rem"></i>Sunshine <b>${fmt(sw[state.hour], 0)} W/m²</b></span>`;
  } else {
    line(f.pm2_5, '#e6cf9f');
    line(f.boundary_layer_height.map((b) => Math.min(b, 1500) / 5), '#a8b4d8', true);
    const q = aqiOf(f.pm2_5[state.hour]);
    head = `<span><i style="background:#e6cf9f"></i>PM2.5 <b>${fmt(f.pm2_5[state.hour], 0)} µg/m³</b> · ${q.name} <span class="tag model">CAMS model</span></span>`
      + `<span><i style="background:#a8b4d8"></i>Mixing height <b>${fmt(f.boundary_layer_height[state.hour], 0)} m</b> (line ÷5) <span class="tag meas">ERA5</span></span>`
      + `<span>Air <b>${fmt(f.temperature_2m[state.hour])} °C</b></span>`;
  }
  $('#tlHead').innerHTML = head;
  g.strokeStyle = 'rgba(255,244,214,0.6)'; g.beginPath(); g.moveTo(x(state.hour), pad.t); g.lineTo(x(state.hour), pad.t + Hh); g.stroke();
}

function drawYear(cv) {
  const dpr = Math.min(window.devicePixelRatio, 2); const w = cv.clientWidth, hgt = cv.clientHeight; if (!w) return;
  cv.width = w * dpr; cv.height = hgt * dpr; const g = cv.getContext('2d'); g.scale(dpr, dpr);
  const Y = PKG.year, n = Y.monthsTmax.length, fs = Math.round(remPx() * 0.66);
  const pad = { l: fs * 2.6, r: fs * 2.6, t: fs, b: fs * 1.6 }; const W = w - pad.l - pad.r, Hh = hgt - pad.t - pad.b, bw = W / n;
  g.font = `${fs}px "IBM Plex Mono", ui-monospace, monospace`; g.textBaseline = 'middle';
  const yT = (v) => pad.t + Hh - (v - 10) / 40 * Hh, yP = (v) => pad.t + Hh - v / 160 * Hh;
  g.strokeStyle = 'rgba(200,210,225,0.1)';
  [10, 30, 50].forEach((t) => { g.beginPath(); g.moveTo(pad.l, yT(t)); g.lineTo(pad.l + W, yT(t)); g.stroke(); g.fillStyle = 'rgba(238,138,69,0.9)'; g.textAlign = 'right'; g.fillText(t + '°', pad.l - 4, yT(t)); });
  Y.monthsPM25.forEach(([m, v], i) => { g.fillStyle = 'rgba(201,178,138,0.35)'; g.fillRect(pad.l + i * bw + bw * 0.18, yP(v), bw * 0.64, pad.t + Hh - yP(v)); });
  [0, 80, 160].forEach((t) => { g.fillStyle = 'rgba(201,178,138,0.95)'; g.textAlign = 'left'; g.fillText(t, pad.l + W + 4, yP(t)); });
  g.strokeStyle = '#ee8a45'; g.lineWidth = 2; g.beginPath(); Y.monthsTmax.forEach(([m, a], i) => { const xx = pad.l + i * bw + bw / 2; i ? g.lineTo(xx, yT(a)) : g.moveTo(xx, yT(a)); }); g.stroke();
  g.fillStyle = 'rgba(200,210,225,0.6)'; g.textAlign = 'center';
  Y.monthsTmax.forEach(([m], i) => { if (i % 3 === 0) g.fillText(new Date(m + '-01').toLocaleString('en-US', { month: 'short' }), pad.l + i * bw + bw / 2, hgt - fs * 0.7); });
}

// ================================================================== picking, tooltip
const ray = new THREE.Raycaster(); const ndc = new THREE.Vector2();
function pickCell(ev) {
  const site = SITES[state.site]; if (!site) return -1;
  const rect = canvas.getBoundingClientRect();
  ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const o = ray.ray.origin, d = ray.ray.direction, top = site.maxH * EX + 1;
  let t = d.y < 0 ? Math.max(0, (o.y - top) / -d.y) : 0; const tEnd = d.y < 0 ? (o.y + 1) / -d.y : 8000;
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
  if (state.tour || ev.pointerType === 'touch') { tip.hidden = true; return; }
  const i = pickCell(ev), site = SITES[state.site]; if (i < 0 || !site) { tip.hidden = true; return; }
  const L = site.lit[state.day], up = sunInfo().up, Hh = site.H[i];
  const now = (arr, n, e) => !up ? 'night' : (litBit(arr, n, state.hour, e) ? 'in direct sun' : 'in shade');
  let html = `<b>${Hh > 0 ? `Building · ${Hh} m tall` : 'Street / open ground'}</b>`;
  html += `<br>Landsat ground heat here: <b>${fmt(site.lst[i])} °C</b> <span class="s">(7 Jun, 10:35 am, 30 m)</span>`;
  if (Hh > 0) { const e = site.roofOf[i]; html += `<br>Roof ${now(L.r, site.nR, e)} at ${hhmm(state.hour)} · ${sunHours(L.r, site.nR, e)} h sun today<br><span class="s">Click for the building details</span>`; }
  else { const e = site.groundOf[i]; html += `<br>${now(L.g, site.nG, e)[0].toUpperCase() + now(L.g, site.nG, e).slice(1)} at ${hhmm(state.hour)} · ${sunHours(L.g, site.nG, e)} h sun today<br>Sees ${fmt(site.fg[e] * 100, 0)}% of the sky`; }
  tip.innerHTML = html; tip.hidden = false;
  const tx = Math.min(ev.clientX + 14, window.innerWidth - tip.offsetWidth - 8), ty = Math.min(ev.clientY + 14, window.innerHeight - tip.offsetHeight - 8);
  tip.style.left = tx + 'px'; tip.style.top = ty + 'px';
});
canvas.addEventListener('pointerleave', () => (tip.hidden = true));
let downAt = null;
canvas.addEventListener('pointerdown', (ev) => (downAt = [ev.clientX, ev.clientY]));
canvas.addEventListener('pointerup', (ev) => {
  if (!downAt || Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]) > 6 || state.tour) return;
  const i = pickCell(ev); if (i >= 0 && SITES[state.site].H[i] > 0) openBrief(i);
});

// ================================================================== building details (measured + calculated only)
function blob(site, seed, tol = 1.5, maxn = 900) {
  const H = site.H, h0 = H[seed]; if (h0 <= 0) return [];
  const seen = new Set([seed]), st = [seed];
  while (st.length && seen.size < maxn) {
    const p = st.pop(), r = (p / N) | 0, c = p % N;
    for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) { const rr = r + dr, cc = c + dc, q = rr * N + cc; if (rr >= 0 && rr < N && cc >= 0 && cc < N && !seen.has(q) && H[q] > 0 && Math.abs(H[q] - h0) <= tol) { seen.add(q); st.push(q); } }
  }
  return [...seen];
}
function buildingFacts(site, cells) {
  const set = new Set(cells), W = site.geom.W, nW = site.nW, nR = site.nR, L = site.lit.heat, rows = {};
  const FR = [[-1, 0], [0, 1], [1, 0], [0, -1]];
  for (const c of cells) {
    const ws = site.wallsOf.get(c); if (!ws) continue;
    for (const e of ws) {
      const r = (c / N) | 0, cc = c % N, d = W.dir[e], fr = (r + FR[d][0]) * N + (cc + FR[d][1]);
      if (set.has(fr)) continue;
      const st = Math.floor((W.z0[e] + W.z1[e]) / 2 / 3);
      const R = (rows[st] = rows[st] || { st, n: 0, sun: 0, fsky: 0 });
      R.n++; R.sun += sunHours(L.w, nW, e); R.fsky += site.fw[e];
    }
  }
  const list = Object.values(rows).sort((a, b) => a.st - b.st).map((R) => ({ st: R.st, sun: R.sun / R.n, sky: Math.min(R.fsky / R.n * 200, 100) }));
  let roofSun = 0, k = 0, hMax = 0, lst = 0, lstMax = 0;
  for (const c of cells) { const e = site.roofOf[c]; if (e < 0) continue; roofSun += sunHours(L.r, nR, e); k++; hMax = Math.max(hMax, site.H[c]); lst += site.lst[c]; lstMax = Math.max(lstMax, site.lst[c]); }
  return { rows: list, roofSun: roofSun / k, height: hMax, lst: lst / k, lstMax, footprint: cells.length * CELL * CELL };
}
function nearestLandmark(site, cell) {
  const r = (cell / N) | 0, c = cell % N; let best = null, bd = 1e9;
  for (const [nm, lr, lc] of site.meta.landmarks || []) { const d = Math.hypot(lr - r, lc - c) * CELL; if (d < bd) { bd = d; best = nm; } }
  return bd <= 120 ? [best, bd] : null;
}
function openBrief(cell, title) {
  const site = SITES[state.site], cells = blob(site, cell); setHighlight(cells, site.H);
  const B = buildingFacts(site, cells);
  let nm = title; if (!nm) { const lm = nearestLandmark(site, cell); nm = lm ? (lm[1] < 25 ? lm[0] : `Building near ${lm[0]}`) : 'Building'; }
  $('#brief .bf-title').textContent = nm;
  $('#brief .bf-meta').textContent = `${B.height} m tall · about ${Math.max(1, Math.round(B.height / 3))} storeys · ${fmt(B.footprint, 0)} m² footprint`;
  const lo = B.rows[0], top = B.rows[B.rows.length - 1];
  $('#briefGrid').innerHTML = `<div><span>Roof heat, Landsat 7 Jun 10:35 am</span><b>${fmt(B.lst)} °C</b></div><div><span>Roof in direct sun, 10 Jun</span><b>${fmt(B.roofSun)} h</b></div>`
    + (lo ? `<div><span>Lowest exposed walls: sun</span><b>${fmt(lo.sun)} h</b></div><div><span>Lowest exposed walls see</span><b>${fmt(lo.sky, 0)}% of the sky</b></div>` : '');
  $('#briefNote').textContent = B.rows.length > 1 ? `Lower walls get ${fmt(lo.sun)} h of sun, top walls ${fmt(top.sun)} h. Calculated from the building heights and the sun's path on 10 June 2026. Roof heat is the Landsat 30 m pixel above this building.` : 'Calculated from the building heights and the sun\'s path on 10 June 2026. Roof heat is the Landsat 30 m pixel above this building.';
  $('#brief').hidden = false; drawBrief(B.rows); $('#side').scrollTop = 0;
  state.brief = cell;
}
function drawBrief(rows) {
  const cv = $('#briefChart'), dpr = Math.min(window.devicePixelRatio, 2), w = cv.clientWidth, fs = Math.round(remPx() * 0.68), rowH = fs * 1.6;
  const hgt = Math.max(rows.length * rowH + fs * 2.2, fs * 4); cv.style.height = hgt + 'px'; cv.width = w * dpr; cv.height = hgt * dpr;
  const g = cv.getContext('2d'); g.scale(dpr, dpr); g.font = `${fs}px "IBM Plex Mono", ui-monospace, monospace`; g.textBaseline = 'middle';
  const x0 = fs * 5.5, x1 = w - fs * 3, sx = (s) => x0 + s / 14 * (x1 - x0);
  g.fillStyle = 'rgba(200,210,225,0.55)'; g.textAlign = 'center'; [0, 7, 14].forEach((t) => g.fillText(t + ' h', sx(t), fs * 0.6));
  [...rows].reverse().forEach((R, j) => {
    const yy = fs * 1.8 + j * rowH;
    g.fillStyle = 'rgba(236,230,218,0.8)'; g.textAlign = 'right'; g.fillText(R.st === 0 ? 'ground' : 'storey ' + (R.st + 1), x0 - 6, yy);
    g.fillStyle = 'rgba(255,255,255,0.06)'; g.fillRect(x0, yy - rowH * 0.3, x1 - x0, rowH * 0.6);
    g.fillStyle = 'rgba(255,205,128,0.85)'; g.fillRect(x0, yy - rowH * 0.3, sx(R.sun) - x0, rowH * 0.6);
    g.fillStyle = 'rgba(236,230,218,0.9)'; g.textAlign = 'left'; g.fillText(fmt(R.sun), sx(R.sun) + 4, yy);
  });
}
function closeBrief() { $('#brief').hidden = true; setHighlight(null); state.brief = null; }
$('#briefClose').addEventListener('click', closeBrief);

// ================================================================== white-roof estimate
async function updateWhatIf() {
  const st = $('#whatStatus');
  if (state.layer !== 'roof') { st.hidden = true; return; }
  st.hidden = false; st.textContent = 'Working out the estimate for every roof…';
  const site = SITES[state.site], B = await getSim(state.site, 'base'), C = await getSim(state.site, 'cool');
  const { nR, nG, geom } = site, h = state.hour;
  let dr = 0, kr = 0, dg = 0, kg = 0;
  for (let e = 0; e < nR; e++) if (INNER(geom.roofs[e])) { dr += B.Tr[h * nR + e] - C.Tr[h * nR + e]; kr++; }
  for (let e = 0; e < nG; e++) if (INNER(geom.ground[e])) { dg += B.Tg[h * nG + e] - C.Tg[h * nG + e]; kg++; }
  st.innerHTML = `<span class="tag model">Model estimate</span> At ${hhmm(h)} on 10 June, white roofs would be about <b>${fmt(dr / kr, 0)} °C cooler</b>; the streets below about <b>${fmt(dg / kg, 1)} °C cooler</b>. Not a measurement.`;
  recolor();
}

// ================================================================== camera
let flight = null;
function flyTo(pos, target, ms = 1600) {
  const p0 = camera.position.clone(), t0 = controls.target.clone(), p1 = new THREE.Vector3(...pos), t1 = new THREE.Vector3(...target);
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  flight = { p0, t0, p1, t1, start: performance.now(), ms: reduce ? 1 : ms };
  return new Promise((res) => (flight.res = res));
}
function stepFlight(now) {
  if (!flight) return;
  const k = clamp((now - flight.start) / flight.ms, 0, 1), e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
  camera.position.lerpVectors(flight.p0, flight.p1, e); controls.target.lerpVectors(flight.t0, flight.t1, e);
  if (k >= 1) { const r = flight.res; flight = null; r && r(); }
}
function fitPose(scale = 1, az = -0.4, el = 0.6) {
  const r = HALF * 1.18 * scale, vf = camera.fov * Math.PI / 360, hf = Math.atan(Math.tan(vf) * camera.aspect), d = r / Math.sin(Math.min(vf, hf));
  return [[Math.sin(az) * Math.cos(el) * d, Math.sin(el) * d, Math.cos(az) * Math.cos(el) * d], [0, 0, 0]];
}

// ================================================================== labels on the map
const labelBox = $('#labels');
function renderLabels() {
  const site = SITES[state.site], marks = site && site.meta.landmarks ? site.meta.landmarks : [];
  if (site && labelBox.dataset.site !== state.site) { labelBox.innerHTML = marks.map((m) => `<div class="lm"><i></i>${m[0]}</div>`).join(''); labelBox.dataset.site = state.site; }
  const v = new THREE.Vector3(), w = canvas.clientWidth, h = canvas.clientHeight, placed = [], cw = remPx() * 0.46;
  marks.forEach((m, j) => {
    const [nm, r, c] = m, el = labelBox.children[j]; if (!el) return;
    v.set((c + 0.5 - N / 2) * CELL, site.H[r * N + c] * EX + 4, (r + 0.5 - N / 2) * CELL).project(camera);
    const px = (v.x + 1) / 2 * w, py = (1 - v.y) / 2 * h, box = [px - 4, py - 9, px + nm.length * cw + 14, py + 9];
    let vis = v.z < 1 && px > 0 && px < w - 30 && py > 12 && py < h - 12;
    if (vis) for (const q of placed) if (box[0] < q[2] && box[2] > q[0] && box[1] < q[3] && box[3] > q[1]) { vis = false; break; }
    if (vis) placed.push(box);
    el.style.display = vis ? '' : 'none'; if (vis) el.style.transform = `translate(${px}px, ${py - 7}px)`;
  });
  const sl = $('#sunLabel'), SI = sunInfo();
  if (SI.up && sunBall.visible) { v.copy(sunBall.position).project(camera); const ok = v.z < 1 && Math.abs(v.x) < 0.95 && Math.abs(v.y) < 0.95; sl.hidden = !ok; if (ok) { sl.textContent = `Sun · ${SI.deg}° high`; sl.style.transform = `translate(${(v.x + 1) / 2 * w + 30}px, ${(1 - v.y) / 2 * h - 8}px)`; } } else sl.hidden = true;
  const nl = $('#northLabel'); v.set(0, 0, -HALF - 40).project(camera); nl.hidden = !(v.z < 1 && Math.abs(v.x) < 1 && Math.abs(v.y) < 1); nl.style.transform = `translate(${(v.x + 1) / 2 * w - 8}px, ${(1 - v.y) / 2 * h - 8}px)`;
  const ll = $('#lidLabel');
  if (lid.visible) { v.set(-HALF + 40, lid.position.y, HALF - 40).project(camera); ll.hidden = !(v.z < 1); ll.style.transform = `translate(${clamp((v.x + 1) / 2 * w, 8, w - 340)}px, ${clamp((1 - v.y) / 2 * h, 30, h - 10)}px)`; ll.textContent = `Smog lid: air mixes only up to ${fmt(PKG.days.smog.forc.boundary_layer_height[state.hour], 0)} m`; }
  else ll.hidden = true;
}

// ================================================================== render loop
let rise = 1, riseStart = 0;
function resize() { const wrap = $('#stageWrap'), w = Math.max(wrap.clientWidth, 10), h = Math.max(wrap.clientHeight, 10); renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); drawTimeline(); if (!$('#yearCard').hidden) drawYear($('#yearChart')); if (state.brief != null) openBrief(state.brief, $('#brief .bf-title').textContent); }
window.addEventListener('resize', resize);
new ResizeObserver(() => resize()).observe($('#stageWrap'));
function loop(now) {
  stepFlight(now);
  const site = SITES[state.site];
  if (site && site.mesh && rise < 1) { rise = clamp((now - riseStart) / 2200, 0, 1); site.mesh.scale.y = 0.02 + 0.98 * (1 - Math.pow(1 - rise, 3)); }
  if (state.idleSpin && !flight) { const a = 0.00025, p = camera.position, t = controls.target, x = p.x - t.x, z = p.z - t.z; p.x = t.x + x * Math.cos(a) - z * Math.sin(a); p.z = t.z + x * Math.sin(a) + z * Math.cos(a); }
  sunGlow.material.opacity = 0.85 + 0.15 * Math.sin(now / 500);
  controls.update(); renderer.render(scene, camera); renderLabels();
  requestAnimationFrame(loop);
}

// ================================================================== state changes
async function setSite(key, { animate = false } = {}) {
  state.site = key;
  for (const k in SITES) if (SITES[k].mesh) SITES[k].mesh.visible = k === key;
  const site = await ensureSite(key);
  if (!site.mesh) scene.add(buildMesh(site));
  site.mesh.visible = true;
  if (animate) { rise = 0; riseStart = performance.now(); }
  document.querySelectorAll('[data-site]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.site === key));
  closeBrief(); renderKeys(); recolor(); if (state.layer === 'roof') updateWhatIf();
}
function setDay(d) {
  state.day = d;
  document.querySelectorAll('[data-day]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.day === d));
  document.querySelector('[data-layer="lst"]').disabled = d !== 'heat';
  document.querySelector('[data-layer="roof"]').disabled = d !== 'heat';
  if (d === 'smog') { state.hour = 22; if (state.layer === 'lst' || state.layer === 'roof') state.layer = 'sky'; }
  setLayer(state.layer);
}
function setLayer(l) {
  state.layer = l;
  document.querySelectorAll('[data-layer]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.layer === l));
  recolor(); updateWhatIf();
}
function setHour(h) { state.hour = ((h % 24) + 24) % 24; recolor(); if (state.layer === 'roof') updateWhatIf(); }

document.querySelectorAll('[data-site]').forEach((b) => b.addEventListener('click', () => setSite(b.dataset.site, { animate: true })));
document.querySelectorAll('[data-day]').forEach((b) => b.addEventListener('click', () => setDay(b.dataset.day)));
document.querySelectorAll('[data-layer]').forEach((b) => b.addEventListener('click', () => setLayer(b.dataset.layer)));
$('#hour').addEventListener('input', (e) => setHour(+e.target.value));
let playT = null;
function stopPlay() { clearInterval(playT); playT = null; $('#play').textContent = '▶ Play the day'; $('#play').setAttribute('aria-pressed', 'false'); }
$('#play').addEventListener('click', () => { if (playT) return stopPlay(); $('#play').textContent = '❚❚ Pause'; $('#play').setAttribute('aria-pressed', 'true'); playT = setInterval(() => setHour(state.hour + 1), 800); });
const openSources = () => ($('#sources').hidden = false);
$('#openSources').addEventListener('click', openSources); $('#openSources2').addEventListener('click', openSources);
$('#sourcesClose').addEventListener('click', () => ($('#sources').hidden = true));
function toggleFull() { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {}); }
$('#fullBtn').addEventListener('click', toggleFull);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { $('#sources').hidden = true; closeBrief(); if (state.tour) endTour(); }
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'f' || e.key === 'F') toggleFull();
  if (state.tour) { if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); nextScene(); } if (e.key === 'ArrowLeft') prevScene(); return; }
  if (e.key === 'ArrowRight') setHour(state.hour + 1); if (e.key === 'ArrowLeft') setHour(state.hour - 1);
});

// ================================================================== walkthrough
let SCENES = [], sceneIdx = 0;
function buildScenes() {
  const W = SITES.walled, D = SITES.dha, ws = W.stats, ds = D.stats, M = PKG.measured, Y = PKG.year, fs = PKG.days.smog.forc;
  const ex = W.meta.example, exB = buildingFacts(W, blob(W, ex.r * N + ex.c));
  const exX = (ex.c - N / 2) * CELL, exZ = (ex.r - N / 2) * CELL, lo = exB.rows[0], top = exB.rows[exB.rows.length - 1];
  return [
    { eye: 'A year in Lahore', site: 'walled', day: 'heat', hour: 15, layer: 'lst', fit: 1.15, year: true,
      cap: `From November 2025 to November 2026 the air in Lahore reached 40 °C or more on ${Y.daysAbove40} days (ERA5 weather record). The hottest was 10 June 2026: ${fmt(Y.hottestMax, 0)} °C. In winter the danger is smog.` },
    { eye: 'Measured from space', site: 'walled', day: 'heat', hour: 10, layer: 'lst', fit: 1, rise: true,
      cap: `The Landsat 8 satellite measured this 1.2 km square of the Walled City at 10:35 am on 7 June 2026. Typical ground temperature: ${fmt(ws.lstMed)} °C. Hottest 30 m spot: ${fmt(ws.lstMax)} °C.` },
    { eye: 'Check it with a photo', site: 'walled', day: 'heat', hour: 10, layer: 'photo', fit: 1,
      cap: `The same square photographed by the Sentinel-2 satellite on 5 June 2026. The green garden strip along the old city wall near Lohari Gate lines up with the cooler blue squares on the heat map; the hottest red squares are dense rooftops with no trees.` },
    { eye: 'Two cities', site: 'dha', day: 'heat', hour: 10, layer: 'lst', fit: 1, rise: true,
      cap: `Same satellite, same moment, DHA Phase 2: typical ${fmt(ds.lstMed)} °C, ${fmt(ws.lstMed - ds.lstMed)} °C cooler than the Walled City. Trees and grass cover ${Math.round(ds.greenShare * 100)}% of DHA's open ground, but only ${Math.round(ws.greenShare * 100)}% in the Walled City.` },
    { eye: 'Where the sun reaches', site: 'walled', day: 'heat', hour: 17, layer: 'sun', fit: 0.5, fitAz: 0.15, fitEl: 0.8,
      cap: `5 pm on 10 June 2026, the sun ${Math.round(PKG.days.heat.alt[17] * 180 / Math.PI)}° high in the west. Walls facing the sun are yellow; streets and walls in shadow are blue. Calculated from the real building heights and the sun's position.` },
    { eye: 'Narrow lanes', site: 'walled', day: 'heat', hour: 15, layer: 'hours', fit: 0.9,
      cap: `Over the whole day, the Walled City's streets got ${fmt(ws.streetSunH)} hours of direct sun and its roofs ${fmt(ws.roofSunH)}. DHA's open streets got ${fmt(ds.streetSunH)} hours. Narrow lanes shade themselves.` },
    { eye: 'One building', site: 'walled', day: 'heat', hour: 15, layer: 'sun', cam: [[exX + 120, 130, exZ + 150], [exX, 30, exZ]], brief: ex,
      cap: `${ex.name}: about ${exB.height} m tall. Its lowest exposed walls get ${fmt(lo.sun)} hours of sun, its top walls ${fmt(top.sun)}. Landsat measured ${fmt(exB.lst)} °C on its roof.` },
    { eye: 'Night', site: 'walled', day: 'heat', hour: 4, layer: 'sky', fit: 0.9,
      cap: `At 4:30 am on 10 June the MODIS satellite measured the ground at ${fmt(M.walled.modisNight)} °C, while the air was about ${fmt(PKG.days.heat.forc.temperature_2m[4], 0)} °C. Surfaces open to the sky cool fastest. The dark lanes see only ${Math.round(ws.skyMed * 100)}% of the sky (DHA streets: ${Math.round(ds.skyMed * 100)}%).` },
    { eye: 'What if', site: 'walled', day: 'heat', hour: 15, layer: 'roof', fit: 0.9,
      cap: `A model estimate, not a measurement: paint every roof white with lime wash and the roofs run much cooler at 3 pm, but the streets below barely change. Each surface needs its own fix.` },
    { eye: 'Smog night', site: 'walled', day: 'smog', hour: 22, layer: 'sky', cam: [[-560, 300, 640], [-60, 10, 60]],
      cap: `10 November 2026, 10 pm. PM2.5 ${fmt(fs.pm2_5[22], 0)} µg/m³ (CAMS model): "${aqiOf(fs.pm2_5[22]).name}". The air could mix only up to ${fmt(fs.boundary_layer_height[22], 0)} m (ERA5), about rooftop height. The smoke had nowhere to go.` },
    { eye: 'Trapped', site: 'walled', day: 'smog', hour: 22, layer: 'sky', fit: 1,
      cap: `Under that lid, streets that see more sky clear faster. The Walled City's lanes see ${Math.round(ws.skyMed * 100)}% of the sky, DHA's streets ${Math.round(ds.skyMed * 100)}%. Every day of the past year, PM2.5 was above the WHO safe limit.` },
    { eye: 'GIS', site: 'walled', day: 'heat', hour: 15, layer: 'lst', fit: 1,
      cap: `Heat has an address. GIS finds it: satellites, weather records and building heights on one map show which streets and buildings need help first. Developed by Muhammad Mehdi & Hussain Ahmad.` }
  ];
}
async function startTour() {
  $('#intro').hidden = true; document.body.classList.remove('intro'); document.body.classList.add('touring'); state.tour = true; state.idleSpin = false;
  $('#capText').textContent = 'Preparing…'; resize();
  await Promise.all([ensureSite('walled'), ensureSite('dha')]);
  getSim('walled', 'base'); getSim('walled', 'cool');
  SCENES = buildScenes(); showScene(0);
}
async function showScene(i) {
  sceneIdx = clamp(i, 0, SCENES.length - 1); const S = SCENES[sceneIdx];
  $('#capEye').textContent = `${sceneIdx + 1} · ${S.eye}`; $('#capText').textContent = S.cap; $('#tourCount').textContent = `${sceneIdx + 1} / ${SCENES.length}`;
  $('#tourNext').textContent = sceneIdx === SCENES.length - 1 ? 'Finish' : 'Next';
  $('#yearCard').hidden = !S.year; if (S.year) requestAnimationFrame(() => drawYear($('#yearChart')));
  closeBrief(); stopPlay();
  state.hour = S.hour;
  if (state.day !== S.day) { state.day = S.day; document.querySelectorAll('[data-day]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.day === S.day)); document.querySelector('[data-layer="lst"]').disabled = S.day !== 'heat'; document.querySelector('[data-layer="roof"]').disabled = S.day !== 'heat'; }
  if (state.site !== S.site || S.rise) await setSite(S.site, { animate: !!S.rise });
  setLayer(S.layer);
  const cam = S.fit ? fitPose(S.fit, S.fitAz ?? -0.4, S.fitEl ?? 0.6) : S.cam; flyTo(cam[0], cam[1], 2000);
  if (S.brief) openBrief(S.brief.r * N + S.brief.c, S.brief.name);
  $('#side').scrollTop = 0;
}
function nextScene() { if (sceneIdx < SCENES.length - 1) showScene(sceneIdx + 1); else endTour(); }
function prevScene() { showScene(sceneIdx - 1); }
function endTour() { state.tour = false; document.body.classList.remove('touring'); $('#yearCard').hidden = true; resize(); }
$('#tourNext').addEventListener('click', nextScene); $('#tourPrev').addEventListener('click', prevScene); $('#tourExit').addEventListener('click', endTour);
$('#tourBtn').addEventListener('click', () => { if (state.tour) endTour(); else startTour(); });

// ================================================================== boot
async function boot() {
  document.body.classList.add('intro'); resize();
  { const p = fitPose(0.95, -0.55, 0.55); camera.position.set(...p[0]); camera.position.x += HALF * 0.55; controls.target.set(HALF * 0.55, 0, 0); }
  requestAnimationFrame(loop);
  $('#bootStatus').textContent = 'Loading building heights and satellite data…';
  await setSite('walled', { animate: true });
  state.hour = 10; setLayer('lst');
  $('#bootStatus').textContent = '';
  $('#startTour').disabled = false; $('#startMap').disabled = false;
  ensureSite('dha');
}
$('#startTour').addEventListener('click', startTour);
$('#startMap').addEventListener('click', () => { $('#intro').hidden = true; document.body.classList.remove('intro'); state.idleSpin = false; updateSun(); requestAnimationFrame(() => { resize(); const p = fitPose(1.1); flyTo(p[0], p[1], 1500); }); });
boot();
