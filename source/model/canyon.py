"""Lahore Canyon — facade-level surface heat model.

Inputs (all real data, see ../data):
  *_h.npy        Google Open Buildings 2.5D Temporal (2023) building heights, 4 m grid, 300x300 (1.2 km)
  weather.json   ERA5 hourly forcing (Open-Meteo archive) + CAMS PM2.5
  landsat_*.json Landsat 8 C2 L2 surface temperature + NDVI, 2026-06-07 10:35 PKT

Surfaces: every exposed wall (split into 3 m storey bands), every roof cell, every street/open cell.
Per surface: sky view factor from a horizon scan of the 3D grid; hourly sun/shade from a
shadow-volume ray march; surface energy balance with a first-order thermal-mass lag.
"""
import numpy as np, json

CELL = 4.0
N = 300
LAT, LON, TZ = 31.58, 74.32, 5.0
SIGMA = 5.67e-8
EPS = 0.92
BAND = 3.0  # storey height (m)

# ---------------------------------------------------------------- sun
def sunpos(doy, hour_local):
    g = 2 * np.pi / 365 * (doy - 1 + (hour_local - 12) / 24)
    eqt = 229.18 * (0.000075 + 0.001868 * np.cos(g) - 0.032077 * np.sin(g)
                    - 0.014615 * np.cos(2 * g) - 0.040849 * np.sin(2 * g))
    decl = (0.006918 - 0.399912 * np.cos(g) + 0.070257 * np.sin(g) - 0.006758 * np.cos(2 * g)
            + 0.000907 * np.sin(2 * g) - 0.002697 * np.cos(3 * g) + 0.00148 * np.sin(3 * g))
    tst = hour_local * 60 + eqt + 4 * LON - 60 * TZ
    ha = np.radians(tst / 4 - 180)
    lat = np.radians(LAT)
    cosz = np.sin(lat) * np.sin(decl) + np.cos(lat) * np.cos(decl) * np.cos(ha)
    zen = np.arccos(np.clip(cosz, -1, 1))
    alt = np.pi / 2 - zen
    caz = (np.sin(lat) * np.cos(zen) - np.sin(decl)) / (np.cos(lat) * np.sin(zen) + 1e-12)
    az = np.degrees(np.arccos(np.clip(caz, -1, 1)))
    az = np.where(ha > 0, (az + 180) % 360, (540 - az) % 360)
    return alt, np.radians(az)

# ---------------------------------------------------------------- geometry helpers
def sample(H, rr, cc):
    """Nearest-cell lookup with 0 outside the grid."""
    r = np.rint(rr).astype(int); c = np.rint(cc).astype(int)
    ok = (r >= 0) & (r < N) & (c >= 0) & (c < N)
    out = np.zeros(r.shape, dtype=float)
    out[ok] = H[r[ok], c[ok]]
    return out

def shadow_volume(H, alt, az):
    """Height of the shadow volume above each cell (Ratti & Richens style ray march)."""
    if alt <= np.radians(2):
        return np.full(H.shape, 1e4)
    dc, dr = np.sin(az), -np.cos(az)
    t = np.tan(alt) * CELL
    kmax = int(np.ceil(H.max() / t)) + 1
    rows, cols = np.mgrid[0:N, 0:N].astype(float)
    SH = np.full(H.shape, -1e4)
    for k in range(1, min(kmax, 400) + 1):
        h = sample(H, rows + k * dr, cols + k * dc) - k * t
        np.maximum(SH, h, out=SH)
    return SH

def horizon(H, r0, c0, z, dirs, start, kmax=30):
    """Horizon elevation (rad) seen from points (r0,c0,z) along azimuths `dirs`
    (array [npts, ndir]); march from distance `start` cells."""
    beta = np.zeros(dirs.shape)
    for k in range(kmax):
        d = start + k
        rr = r0[:, None] - np.cos(dirs) * d
        cc = c0[:, None] + np.sin(dirs) * d
        h = sample(H, rr, cc)
        b = np.arctan2(h - z[:, None], d * CELL)
        np.maximum(beta, b, out=beta)
    return beta

# ---------------------------------------------------------------- surfaces
DIRS = [(0, -1, 0), (1, 0, 1), (2, 1, 0), (3, 0, -1)]  # id, drow, dcol  (N,E,S,W)
NORMAL_AZ = np.radians([0, 90, 180, 270])

def build_surfaces(H):
    Hf = H.astype(float)
    walls = []  # (cell, dir, z0, z1)
    for d, dr, dc in DIRS:
        Hn = np.zeros_like(Hf)
        src_r = slice(max(0, dr), N + min(0, dr)); dst_r = slice(max(0, -dr), N + min(0, -dr))
        src_c = slice(max(0, dc), N + min(0, dc)); dst_c = slice(max(0, -dc), N + min(0, -dc))
        Hn[dst_r, dst_c] = Hf[src_r, src_c]
        m = (Hf - Hn) >= 1.0
        rr, cc = np.nonzero(m)
        for r, c in zip(rr, cc):
            z0, z1 = Hn[r, c], Hf[r, c]
            z = z0
            while z < z1 - 0.01:
                zt = min(z + BAND, z1)
                if z1 - zt < 1.0:
                    zt = z1
                walls.append((r * N + c, d, z, zt))
                z = zt
    W = np.array(walls, dtype=float)
    roofs = np.nonzero(H.ravel() > 0)[0]
    ground = np.nonzero(H.ravel() == 0)[0]
    return W, roofs, ground

def view_factors(H, W, roofs, ground):
    Hf = H.astype(float)
    # walls: point on the wall face, sampling from the front cell outward
    cell = W[:, 0].astype(int); d = W[:, 1].astype(int)
    r = cell // N; c = cell % N
    zc = 0.5 * (W[:, 2] + W[:, 3])
    nz = NORMAL_AZ[d]
    rel = np.radians(np.arange(-80, 81, 20))
    dirs = nz[:, None] + rel[None, :]
    # start half a cell in front of the face: wall face is at the cell edge
    fr = r + np.array([-1, 0, 1, 0])[d] * 0.5
    fc = c + np.array([0, 1, 0, -1])[d] * 0.5
    beta = horizon(Hf, fr, fc, zc, dirs, start=0.5)
    beta = np.maximum(beta, 0)
    g = np.pi / 4 - beta / 2 - np.sin(2 * beta) / 4
    wcos = np.cos(rel)[None, :]
    fsky_w = 0.5 * (wcos * g).sum(1) / wcos.sum() / (np.pi / 4)
    # horizontal surfaces
    dirs16 = np.radians(np.arange(0, 360, 22.5))
    def svf(idx, z):
        rr = (idx // N).astype(float); cc = (idx % N).astype(float)
        b = horizon(Hf, rr, cc, z, np.broadcast_to(dirs16, (len(idx), 16)), start=1.0)
        b = np.maximum(b, 0)
        return 1 - (np.sin(b) ** 2).mean(1)
    fsky_r = svf(roofs, Hf.ravel()[roofs])
    fsky_g = svf(ground, np.zeros(len(ground)))
    return fsky_w, fsky_r, fsky_g

def sun_flags(H, W, roofs, ground, doy, hours):
    """Sunlit fraction-of-hour flags (0/1) evaluated at the middle of each hour, and the
    cosine factor for the direct beam (0 when shaded)."""
    Hf = H.astype(float)
    cell = W[:, 0].astype(int); d = W[:, 1].astype(int)
    r = cell // N; c = cell % N
    front = (r + np.array([-1, 0, 1, 0])[d]).clip(0, N - 1) * N + (c + np.array([0, 1, 0, -1])[d]).clip(0, N - 1)
    zc = 0.5 * (W[:, 2] + W[:, 3])
    nz = NORMAL_AZ[d]
    kw = np.zeros((len(hours), len(W)), np.float32)
    kr = np.zeros((len(hours), len(roofs)), np.float32)
    kg = np.zeros((len(hours), len(ground)), np.float32)
    lit_w = np.zeros((len(hours), len(W)), bool)
    for i, h in enumerate(hours):
        alt, az = sunpos(doy, h - 0.5)
        if alt <= np.radians(2):
            continue
        SH = shadow_volume(Hf, float(alt), float(az)).ravel()
        cosi = np.cos(alt) * np.cos(az - nz)
        litw = (cosi > 0) & (zc > SH[front])
        lit_w[i] = litw
        kw[i] = np.where(litw, cosi, 0)
        kr[i] = np.where(Hf.ravel()[roofs] >= SH[roofs] - 0.01, np.sin(alt), 0)
        kg[i] = np.where(SH[ground] <= 0.01, np.sin(alt), 0)
    return kw, kr, kg, lit_w

# ---------------------------------------------------------------- energy balance
# absorptivities calibrated (x0.9 of a priori 0.60/0.70/0.80) against Landsat 8 LST 2026-06-07
PARAMS = {
    'wall':   dict(a=0.54, tau=2.5),
    'roof':   dict(a=0.63, tau=1.5),
    'ground': dict(a=0.72, tau=3.0),
}

def sky_lw(Ta_c, rh, cloud=0.0):
    Ta = Ta_c + 273.15
    es = 6.112 * np.exp(17.67 * Ta_c / (Ta_c + 243.5))
    e = rh / 100 * es
    eps_sky = 1.24 * (e / Ta) ** (1 / 7) * (1 + 0.22 * (cloud / 100) ** 2)
    return np.minimum(eps_sky, 1.0) * SIGMA * Ta ** 4

def run_day(forc, k, fsky, a, tau, kind, fveg=None, Tenv_offset=None, substeps=4, spinup=2):
    """Integrate surface temperature over a 24 h cycle (repeated for spin-up).
    forc: dict of 24 hourly arrays (Open-Meteo hour-ending means).
    k:    [24, n] direct-beam geometric factor (cos incidence or sin(alt), 0 if shaded).
    Returns [24, n] surface temperature (degC) at the end of each hour."""
    Ta = np.array(forc['temperature_2m']); rh = np.array(forc['relative_humidity_2m'])
    dni = np.array(forc['direct_normal_irradiance']); dhi = np.array(forc['diffuse_radiation'])
    ghi = np.array(forc['shortwave_radiation']); u10 = np.array(forc['wind_speed_10m'])
    cc = np.array(forc.get('cloud_cover', [0] * 24))
    n = k.shape[1]
    Ts = np.full(n, Ta[-1])
    out = np.zeros((24, n), np.float32)
    if kind == 'wall':
        fopen = np.clip(2 * fsky, 0, 1)
    else:
        fopen = fsky
    dt = 1.0 / substeps
    lag = 1 - np.exp(-dt / tau)
    for _ in range(spinup + 1):
        for h in range(24):
            hp = (h - 1) % 24
            for s in range(substeps):
                w = (s + 1) / substeps
                ta = Ta[hp] * (1 - w) + Ta[h] * w   # temperature: instantaneous, interpolate
                r = rh[hp] * (1 - w) + rh[h] * w
                ua = u10[h]
                Tak = ta + 273.15
                Lsky = sky_lw(ta, r, cc[h])
                Tenv = ta + (Tenv_offset[h] if Tenv_offset is not None else 0.0)
                Lenv = EPS * SIGMA * (Tenv + 273.15) ** 4
                Sabs = a * (dni[h] * k[h] + dhi[h] * fsky + 0.3 * ghi[h] * (1 - fsky) * 0.5)
                Lin = fsky * Lsky + (1 - fsky) * Lenv
                ul = ua * (0.25 + 0.75 * fopen)
                hc = 5.7 + 3.8 * ul
                hr = 4 * EPS * SIGMA * Tak ** 3
                net = Sabs + EPS * (Lin - SIGMA * Tak ** 4)
                if fveg is not None:
                    net = net - fveg * 0.6 * np.maximum(net, 0)
                Teq = ta + net / (hc + hr)
                Ts = Ts + (Teq - Ts) * lag
            out[h] = Ts
    return out

def simulate(H, forc, doy, ndvi_cells=None, params=PARAMS, geom=None):
    if geom is None:
        W, roofs, ground = build_surfaces(H)
        fw, fr, fg = view_factors(H, W, roofs, ground)
        geom = dict(W=W, roofs=roofs, ground=ground, fw=fw, fr=fr, fg=fg)
    W, roofs, ground = geom['W'], geom['roofs'], geom['ground']
    hours = np.arange(1, 25)  # hour-ending index -> mid-hour sun at h-0.5
    kw, kr, kg, lit = sun_flags(H, W, roofs, ground, doy, hours)
    # Open-Meteo index i covers (i-1, i]; our arrays index 0..23 = hour ending 0..23 -> shift
    def roll(x): return np.roll(x, 1, axis=0)
    kw, kr, kg, lit = roll(kw), roll(kr), roll(kg), roll(lit)
    fveg = None
    if ndvi_cells is not None:
        fveg = np.clip((ndvi_cells[ground] - 0.15) / 0.5, 0, 0.8)
    # pass 1 with Tenv = Ta, pass 2 with Tenv = scene-mean surface excess (canyon re-radiation)
    off = None
    for _ in range(2):
        Tw = run_day(forc, kw, geom['fw'], params['wall']['a'], params['wall']['tau'], 'wall', Tenv_offset=off)
        Tr = run_day(forc, kr, geom['fr'], params['roof']['a'], params['roof']['tau'], 'roof', Tenv_offset=off)
        Tg = run_day(forc, kg, geom['fg'], params['ground']['a'], params['ground']['tau'], 'ground', fveg=fveg, Tenv_offset=off)
        Ta = np.array(forc['temperature_2m'])
        area_w = (W[:, 3] - W[:, 2]) * CELL
        tot = area_w.sum() + CELL * CELL * (len(roofs) + len(ground))
        mean = ((Tw * area_w).sum(1) + (Tr.sum(1) + Tg.sum(1)) * CELL * CELL) / tot
        off = mean - Ta
    return dict(geom=geom, Tw=Tw, Tr=Tr, Tg=Tg, kw=kw, kr=kr, kg=kg, lit=lit, fveg=fveg, envoff=off)
