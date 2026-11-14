import numpy as np, json
exec(open('calib2.py').read().split('def run(')[0])
import canyon
from canyon import PARAMS
for site,D in SITE.items():
    S = simulate(D['H'], w['val'], 158, ndvi_cells=D['ndv'], params=PARAMS, geom=D['g'])
    p = plan(S, D['g'], 10+35/60); agg=np.zeros((41,41)); np.add.at(agg,(D['i'],D['j']),p)
    ok=D['ok']; m=agg[ok]/D['cnt'][ok]; o=D['lst'][ok]
    A=np.where(ok,agg,0)[:39,:39].reshape(13,3,13,3).sum((1,3)); C=np.where(ok,D['cnt'],0)[:39,:39].reshape(13,3,13,3).sum((1,3)); O=np.where(ok,D['lst']*D['cnt'],0)[:39,:39].reshape(13,3,13,3).sum((1,3)); k3=C>400
    m3,o3=A[k3]/C[k3],O[k3]/C[k3]
    print(site, 'model %.1f landsat %.1f bias %+.1f rmse90 %.1f r90 %.2f | landsat max %.1f' % (np.median(m), np.median(o), np.mean(m-o), np.sqrt(np.mean((m3-o3)**2)), np.corrcoef(m3,o3)[0,1], D['lst'].max()))
