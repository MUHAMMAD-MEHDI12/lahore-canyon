import numpy as np, json, copy, io, contextlib
import canyon
exec(open('validate.py').read().split("res = {}")[0])
def run(scale):
    P = copy.deepcopy(canyon.PARAMS)
    for k in P: P[k]['a'] *= scale
    out = {}
    for site in ['walled','dha']:
        H = np.load(f'../data/{site}_h.npy'); g = dict(np.load(f'geom_{site}.npz'))
        lst = np.array([int(v) for v in L[site+'_vals'].split(',')]).reshape(41,41)/10+40
        ndv = np.array([int(v) for v in V[site].split(',')]).reshape(41,41)/100
        i, j = lst_idx(site, None)
        S = canyon.simulate(H, w['val'], 158, ndvi_cells=ndv[i,j].ravel(), params=P, geom=g)
        f = 35/60; plan = np.zeros(N*N)
        plan[g['roofs']] = (1-f)*S['Tr'][10] + f*S['Tr'][11]; plan[g['ground']] = (1-f)*S['Tg'][10] + f*S['Tg'][11]
        plan = plan.reshape(N,N)
        agg = np.zeros((41,41)); cnt = np.zeros((41,41)); np.add.at(agg,(i,j),plan); np.add.at(cnt,(i,j),1)
        ok = cnt >= 50; m = agg[ok]/cnt[ok]; o = lst[ok]
        A = np.where(ok,agg,0)[:39,:39].reshape(13,3,13,3).sum((1,3)); C = np.where(ok,cnt,0)[:39,:39].reshape(13,3,13,3).sum((1,3))
        O = np.where(ok,lst*cnt,0)[:39,:39].reshape(13,3,13,3).sum((1,3)); k3 = C>400
        m3, o3 = A[k3]/C[k3], O[k3]/C[k3]
        out[site] = (np.median(m), np.median(o), np.mean(m-o), np.sqrt(np.mean((m-o)**2)), np.corrcoef(m,o)[0,1], np.corrcoef(m3,o3)[0,1], np.sqrt(np.mean((m3-o3)**2)), k3.sum())
    return out
for s in [1.0, 0.9, 0.85, 0.8]:
    o = run(s)
    print(s, ' | '.join(f"{k}: mod {v[0]:.1f} obs {v[1]:.1f} bias {v[2]:+.2f} rmse30 {v[3]:.2f} r30 {v[4]:.2f} r90 {v[5]:.2f} rmse90 {v[6]:.2f} n90 {v[7]}" for k,v in o.items()),
          ' diff mod %.2f obs %.2f' % (o['walled'][0]-o['dha'][0], o['walled'][1]-o['dha'][1]))
