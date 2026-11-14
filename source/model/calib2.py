import numpy as np, json, copy, sys
import canyon
from canyon import *
w = json.load(open('../data/weather.json')); L = json.load(open('../data/landsat_lst_20260607.json')); V = json.load(open('../data/landsat_ndvi_20260607.json'))
XY = {'walled':(434690,3494818), 'dha':(442832,3482778)}
BASE = {'wall':(0.60,2.5),'roof':(0.70,1.5),'ground':(0.80,3.0)}
SITE = {}
for site in ['walled','dha']:
    H = np.load(f'../data/{site}_h.npy'); g = dict(np.load(f'geom_{site}.npz'))
    rr, cc = np.mgrid[0:N, 0:N]; xmin, ymax = XY[site]
    i = ((L[site]['gy1'] - (ymax - CELL*rr - 2))//30).astype(int); j = (((xmin + CELL*cc + 2) - L[site]['gx0'])//30).astype(int)
    ndv = (np.array([int(v) for v in V[site].split(',')]).reshape(41,41)/100)[i,j].ravel()
    lst = np.array([int(v) for v in L[site+'_vals'].split(',')]).reshape(41,41)/10+40
    cnt = np.zeros((41,41)); np.add.at(cnt,(i,j),1); ok = cnt>=50
    SITE[site] = dict(H=H,g=g,i=i,j=j,ndv=ndv,lst=lst,cnt=cnt,ok=ok)
inner = np.zeros((N,N),bool); inner[15:-15,15:-15]=True
def plan(S, g, t):
    h0 = int(np.floor(t)); f = t-h0; out = np.zeros(N*N)
    out[g['roofs']] = (1-f)*S['Tr'][h0]+f*S['Tr'][(h0+1)%24]; out[g['ground']] = (1-f)*S['Tg'][h0]+f*S['Tg'][(h0+1)%24]
    return out.reshape(N,N)
def run(scale, hs):
    P = {k:dict(a=BASE[k][0]*scale, tau=BASE[k][1], hs=hs) for k in BASE}
    res = {}
    for site,D in SITE.items():
        S = simulate(D['H'], w['val'], 158, ndvi_cells=D['ndv'], params=P, geom=D['g'])
        p = plan(S, D['g'], 10+35/60)
        agg = np.zeros((41,41)); np.add.at(agg,(D['i'],D['j']),p)
        m = np.median(agg[D['ok']]/D['cnt'][D['ok']])
        am = plan(S, D['g'], 9.1)[inner].mean(); pm = plan(S, D['g'], 14.6)[inner].mean()
        res[site] = (m, float(np.median(D['lst'][D['ok']])), pm-am, np.median(S['Tr'].max(0)))
    return res
for hs in [float(x) for x in sys.argv[1:]]:
    canyon.GUST_BETA = float(__import__("os").environ.get("BETA","1.2"))
    for scale in [float(x) for x in __import__("os").environ.get("SC","1.0 1.1 1.2 1.3").split()]:
        r = run(scale, hs)
        print(f"hs {hs:4.0f} scale {scale:.2f} | " + ' | '.join(f"{k}: model {v[0]:.1f} landsat {v[1]:.1f} rise9-15 {v[2]:+.1f} roofpk {v[3]:.1f}" for k,v in r.items()), flush=True)
