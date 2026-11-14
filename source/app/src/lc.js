// Lahore Canyon — surface energy balance, ported 1:1 from model/canyon.py
// Runs in the browser so the what-if scenarios (cool roofs, street shade) recompute live.
const LC = (() => {
  const SIGMA = 5.67e-8, EPS = 0.92;
  const DIRS = [[-1, 0], [0, 1], [1, 0], [0, -1]]; // N, E, S, W  (drow, dcol)
  const NAZ = [0, Math.PI / 2, Math.PI, 1.5 * Math.PI];

  function buildSurfaces(H, N, BAND) {
    const walls = { cell: [], dir: [], z0: [], z1: [] };
    for (let d = 0; d < 4; d++) {
      const [dr, dc] = DIRS[d];
      for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
        const h = H[r * N + c];
        const rn = r + dr, cn = c + dc;
        const hn = (rn >= 0 && rn < N && cn >= 0 && cn < N) ? H[rn * N + cn] : 0;
        if (h - hn >= 1) {
          let z = hn;
          while (z < h - 0.01) {
            let zt = Math.min(z + BAND, h);
            if (h - zt < 1.0) zt = h;
            walls.cell.push(r * N + c); walls.dir.push(d); walls.z0.push(z); walls.z1.push(zt);
            z = zt;
          }
        }
      }
    }
    const roofs = [], ground = [];
    for (let i = 0; i < N * N; i++) (H[i] > 0 ? roofs : ground).push(i);
    return {
      W: { cell: Int32Array.from(walls.cell), dir: Uint8Array.from(walls.dir), z0: Float32Array.from(walls.z0), z1: Float32Array.from(walls.z1) },
      roofs: Int32Array.from(roofs), ground: Int32Array.from(ground)
    };
  }

  function skyLW(TaC, rh, cloud) {
    const Ta = TaC + 273.15;
    const es = 6.112 * Math.exp(17.67 * TaC / (TaC + 243.5));
    const e = rh / 100 * es;
    const eps = Math.min(1.24 * Math.pow(e / Ta, 1 / 7) * (1 + 0.22 * Math.pow(cloud / 100, 2)), 1.0);
    return eps * SIGMA * Ta * Ta * Ta * Ta;
  }

  // per-substep forcing shared by all elements
  function prepForcing(f, substeps) {
    const T = f.temperature_2m, R = f.relative_humidity_2m, cc = f.cloud_cover || new Array(24).fill(0);
    const n = 24 * substeps, out = { ta: new Float64Array(n), Lsky: new Float64Array(n), hr: new Float64Array(n), Tak4: new Float64Array(n), hour: new Int32Array(n) };
    for (let h = 0; h < 24; h++) {
      const hp = (h + 23) % 24;
      for (let s = 0; s < substeps; s++) {
        const w = (s + 1) / substeps, i = h * substeps + s;
        const ta = T[hp] * (1 - w) + T[h] * w, r = R[hp] * (1 - w) + R[h] * w, Tak = ta + 273.15;
        out.ta[i] = ta; out.Lsky[i] = skyLW(ta, r, cc[h]);
        out.hr[i] = 4 * EPS * SIGMA * Tak * Tak * Tak; out.Tak4[i] = SIGMA * Tak * Tak * Tak * Tak; out.hour[i] = h;
      }
    }
    return out;
  }

  // k: function(elementIndex, hour) -> direct-beam geometric factor
  function runDay(f, P, n, kAt, fsky, a, tau, kind, fveg, envOff, out, substeps = 4, spinup = 2) {
    const dni = f.direct_normal_irradiance, dhi = f.diffuse_radiation, ghi = f.shortwave_radiation, u10 = f.wind_speed_10m;
    const T = f.temperature_2m;
    const ns = 24 * substeps, lag = 1 - Math.exp(-(1 / substeps) / tau);
    const Lenv = new Float64Array(ns);
    for (let i = 0; i < ns; i++) { const Te = P.ta[i] + (envOff ? envOff[P.hour[i]] : 0) + 273.15; Lenv[i] = EPS * SIGMA * Te * Te * Te * Te; }
    for (let e = 0; e < n; e++) {
      const fs = fsky[e], fo = kind === 'wall' ? Math.min(Math.max(2 * fs, 0), 1) : fs, fv = fveg ? fveg[e] : 0;
      let Ts = T[23];
      for (let sp = 0; sp <= spinup; sp++) {
        for (let h = 0; h < 24; h++) {
          const k = kAt(e, h);
          const Sabs = a * (dni[h] * k + dhi[h] * fs + 0.3 * ghi[h] * (1 - fs) * 0.5);
          const hc = 5.7 + 3.8 * (u10[h] * (0.25 + 0.75 * fo));
          for (let s = 0; s < substeps; s++) {
            const i = h * substeps + s;
            const Lin = fs * P.Lsky[i] + (1 - fs) * Lenv[i];
            let net = Sabs + EPS * (Lin - P.Tak4[i]);
            if (fv > 0) net -= fv * 0.6 * Math.max(net, 0);
            const Teq = P.ta[i] + net / (hc + P.hr[i]);
            Ts += (Teq - Ts) * lag;
          }
          if (sp === spinup) out[h * n + e] = Ts;
        }
      }
    }
    return out;
  }

  // site: {H,N,cell,band, geom, fw,fr,fg (Float32 0..1), ndvi (per cell 0..1)}
  // day:  {alt[24], az[24], forc}; lit: {w,r,g: Uint8Array bitsets [24][ceil(n/8)]}
  // params: {wall:{a,tau}, roof:{a,tau}, ground:{a,tau}}, opts: {streetShade:0..1}
  function simulate(site, day, lit, params, opts = {}) {
    const g = site.geom, nW = g.W.cell.length, nR = g.roofs.length, nG = g.ground.length;
    const f = day.forc, P = prepForcing(f, 4);
    const rowW = Math.ceil(nW / 8), rowR = Math.ceil(nR / 8), rowG = Math.ceil(nG / 8);
    const bit = (arr, row, h, e) => (arr[h * row + (e >> 3)] >> (7 - (e & 7))) & 1;
    const cosi = new Float64Array(24 * 4), sinA = new Float64Array(24);
    for (let h = 0; h < 24; h++) {
      const al = day.alt[h], az = day.az[h];
      sinA[h] = al > 2 * Math.PI / 180 ? Math.sin(al) : 0;
      for (let d = 0; d < 4; d++) cosi[h * 4 + d] = al > 2 * Math.PI / 180 ? Math.max(Math.cos(al) * Math.cos(az - NAZ[d]), 0) : 0;
    }
    const shade = opts.streetShade || 0;
    const kW = (e, h) => bit(lit.w, rowW, h, e) ? cosi[h * 4 + g.W.dir[e]] : 0;
    const kR = (e, h) => bit(lit.r, rowR, h, e) ? sinA[h] : 0;
    const kG = (e, h) => bit(lit.g, rowG, h, e) ? sinA[h] * (1 - shade) : 0;
    const fveg = new Float32Array(nG);
    for (let e = 0; e < nG; e++) {
      const v = Math.min(Math.max((site.ndvi[g.ground[e]] - 0.15) / 0.5, 0), 0.8);
      fveg[e] = Math.min(Math.max(v, shade * 0.5), 0.8); // street trees add evapotranspiration
    }
    const Tw = new Float32Array(24 * nW), Tr = new Float32Array(24 * nR), Tg = new Float32Array(24 * nG);
    const areaW = new Float64Array(nW); let aW = 0;
    for (let e = 0; e < nW; e++) { areaW[e] = (g.W.z1[e] - g.W.z0[e]) * site.cell; aW += areaW[e]; }
    const A = site.cell * site.cell, tot = aW + A * (nR + nG);
    let off = null;
    for (let pass = 0; pass < 2; pass++) {
      runDay(f, P, nW, kW, site.fw, params.wall.a, params.wall.tau, 'wall', null, off, Tw);
      runDay(f, P, nR, kR, site.fr, params.roof.a, params.roof.tau, 'roof', null, off, Tr);
      runDay(f, P, nG, kG, site.fg, params.ground.a, params.ground.tau, 'ground', fveg, off, Tg);
      const nOff = new Float64Array(24);
      for (let h = 0; h < 24; h++) {
        let s = 0;
        for (let e = 0; e < nW; e++) s += Tw[h * nW + e] * areaW[e];
        let sr = 0; for (let e = 0; e < nR; e++) sr += Tr[h * nR + e];
        let sg = 0; for (let e = 0; e < nG; e++) sg += Tg[h * nG + e];
        nOff[h] = (s + (sr + sg) * A) / tot - f.temperature_2m[h];
      }
      off = nOff;
    }
    return { Tw, Tr, Tg, nW, nR, nG };
  }

  async function inflate(b64, Type = Uint8Array) {
    const bin = Uint8Array.from(atob(b64), ch => ch.charCodeAt(0));
    const ds = new Blob([bin]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const buf = await new Response(ds).arrayBuffer();
    return new Type(buf);
  }

  return { buildSurfaces, simulate, inflate, skyLW, NAZ };
})();
export default LC;
