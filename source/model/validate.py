import numpy as np, json, sys
from canyon import *
w = json.load(open('../data/weather.json')); L = json.load(open('../data/landsat_lst_20260607.json')); V = json.load(open('../data/landsat_ndvi_20260607.json'))
XY = {'walled':(434690,3494818), 'dha':(442832,3482778)}
def lst_idx(site, key):
    gx0, gy1 = L[site]['gx0'], L[site]['gy1']; xmin, ymax = XY[site]
    rr, cc = np.mgrid[0:N, 0:N]
    x = xmin + CELL*cc + 2; y = ymax - CELL*rr - 2
    j = ((x - gx0)//30).astype(int); i = ((gy1 - y)//30).astype(int)
    return i, j
res = {}
for site in ['walled','dha']:
    H = np.load(f'../data/{site}_h.npy'); g = dict(np.load(f'geom_{site}.npz'))
    lst = np.array([int(v) for v in L[site+'_vals'].split(',')]).reshape(41,41)/10+40
    ndv = np.array([int(v) for v in V[site].split(',')]).reshape(41,41)/100
    i, j = lst_idx(site, None)
    ndvi_cells = ndv[i, j].ravel()
    doy = 158  # 2026-06-07
    S = simulate(H, w['val'], doy, ndvi_cells=ndvi_cells, geom=g)
    # plan-view temperature at 10:35 (interp between 10:00 and 11:00)
    f = 35/60
    plan = np.zeros(N*N)
    plan[g['roofs']] = (1-f)*S['Tr'][10] + f*S['Tr'][11]
    plan[g['ground']] = (1-f)*S['Tg'][10] + f*S['Tg'][11]
    plan = plan.reshape(N,N)
    # aggregate to Landsat pixels (only fully covered pixels)
    agg = np.zeros((41,41)); cnt = np.zeros((41,41))
    np.add.at(agg, (i, j), plan); np.add.at(cnt, (i, j), 1)
    ok = cnt >= 50
    m = agg[ok]/cnt[ok]; o = lst[ok]
    # 90 m blocks (3x3 pixels)
    def blk(a, c):
        A = a[:39,:39].reshape(13,3,13,3).sum((1,3)); C = c[:39,:39].reshape(13,3,13,3).sum((1,3)); return A, C
    A, C = blk(np.where(ok, agg, 0), np.where(ok, cnt, 0)); O, Oc = blk(np.where(ok, lst*cnt, 0), np.where(ok, cnt, 0))
    k3 = C > 400
    m3, o3 = A[k3]/C[k3], O[k3]/Oc[k3]
    res[site] = dict(model_med=float(np.median(m)), lst_med=float(np.median(o)), bias=float(np.mean(m-o)),
        rmse=float(np.sqrt(np.mean((m-o)**2))), r30=float(np.corrcoef(m,o)[0,1]), r90=float(np.corrcoef(m3,o3)[0,1]),
        rmse90_debiased=float(np.sqrt(np.mean(((m3-o3)-(m3-o3).mean())**2))), n=int(ok.sum()))
    print(site, {k:(round(v,2) if isinstance(v,float) else v) for k,v in res[site].items()})
d = (res['walled']['model_med']-res['dha']['model_med'], res['walled']['lst_med']-res['dha']['lst_med'])
print('walled-dha difference  model %.2f  landsat %.2f' % d)
