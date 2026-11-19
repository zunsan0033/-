"""Small-account comparison with a Nikkei (JP225Cash) IndexReversion module.

  python -I small_account_jp225.py <unit_returns with IR_JP225_A/B columns> <out.csv>
JP225Cash at the broker: 1 JPY per point per lot, min lot 0.1 (about 5,900 JPY of exposure).
"""
import sys
import numpy as np, pandas as pd
U = pd.read_csv(sys.argv[1], index_col=0, parse_dates=True)
N01 = {'US500': 7346.01 * 159.349 * 0.1, 'US100': 27038.93 * 159.349 * 0.1, 'JP225': 59198 * 1 * 0.1}
MODS = ['IR_US500_A', 'IR_US500_B', 'IR_US100_A', 'IM_US100', 'IR_JP225_A', 'IR_JP225_B']
R0 = U[MODS].fillna(0.0).values; LEV0 = U['IM_US100_lev'].fillna(0.0).values; dates = U.index
def sym_of(m): return 'US500' if 'US500' in m else ('JP225' if 'JP225' in m else 'US100')
def exposure(target, eq, n01, cap):
    lots = np.floor(target * eq / n01 + 1e-9)
    if lots < 1 and n01 / eq <= cap: lots = 1
    return lots * n01 / eq
def path(cfg, R, LEV, idx, eq0=150_000.0):
    eq = eq0; out = np.empty(len(idx))
    cols = [(j, m, cfg[m]) for j, m in enumerate(MODS) if m in cfg]
    for n, t in enumerate(idx):
        pnl = 0.0
        for j, m, (tgt, cap) in cols:
            if m == 'IM_US100':
                tgt = LEV[t] * tgt
                if tgt <= 0: continue
            pnl += exposure(tgt, eq, N01[sym_of(m)], cap) * eq * R[t, j]
        eq = max(eq + pnl, 1.0); out[n] = eq
    return out
def hist_stats(p, eq0=150_000.0):
    s = pd.Series(p, index=dates); yrs = (dates[-1] - dates[0]).days / 365.25
    mdd = (s / np.maximum.accumulate(np.r_[eq0, s.values])[1:] - 1).min()
    y = s.groupby(s.index.year).last(); yr = y.values / np.r_[eq0, y.values[:-1]] - 1
    return dict(final=f'{s.iloc[-1]:,.0f}', cagr=f'{((s.iloc[-1]/eq0)**(1/yrs)-1)*100:.1f}%', maxdd=f'{mdd*100:.1f}%',
                worst_year=f'{yr.min()*100:.1f}%', losing_years=int((yr < 0).sum()))
def haircut(R, h):
    R = R.copy()
    for j in range(R.shape[1]):
        nz = R[:, j] != 0
        if nz.sum(): R[nz, j] -= h * R[:, j].mean() * len(R) / nz.sum()
    return R
G0 = {'IR_US500_A': (1.0, 2), 'IR_US500_B': (1.0, 2), 'IM_US100': (1.0, 4), 'IR_US100_A': (1.0, 3)}
cfgs = {'G0 current IndexGrowth': G0,
        'G1 G0 + JP225 A,B 1.0x': {**G0, 'IR_JP225_A': (1.0, 2), 'IR_JP225_B': (1.0, 2)},
        'G2 G0 + JP225 A,B 0.5x': {**G0, 'IR_JP225_A': (0.5, 2), 'IR_JP225_B': (0.5, 2)},
        'G3 JP225 instead of US100 rev': {'IR_US500_A': (1.0, 2), 'IR_US500_B': (1.0, 2), 'IM_US100': (1.0, 4), 'IR_JP225_A': (1.0, 2), 'IR_JP225_B': (1.0, 2)}}
print('== history replay 2016-11..2026-11 from 150,000 JPY (current lot sizes)')
print(pd.DataFrame([dict(config=k, **hist_stats(path(c, R0, LEV0, np.arange(len(R0))))) for k, c in cfgs.items()]).to_string(index=False))
rng = np.random.default_rng(7)
def boot(n, T, block=20):
    idx = np.empty(T, dtype=int); i = rng.integers(n)
    for t in range(T):
        if t % block == 0: i = rng.integers(n)
        idx[t] = i; i = (i + 1) % n
    return idx
rows = []
for lab, h in [('same edge', 0.0), ('edge halved', 0.5)]:
    R = haircut(R0, h)
    boots = {T: [boot(len(R), T) for _ in range(1000)] for T in (252, 756)}   # same resampled paths for every config
    for k, c in cfgs.items():
        for T, hz in [(252, '1y'), (756, '3y')]:
            fin, mins = [], []
            for ix in boots[T]:
                p = path(c, R, LEV0, ix); fin.append(p[-1]); mins.append(p.min())
            fin, mins = np.array(fin), np.array(mins)
            rows.append(dict(scenario=lab, config=k, horizon=hz, median=f'{np.median(fin):,.0f}', p10=f'{np.percentile(fin,10):,.0f}',
                             p90=f'{np.percentile(fin,90):,.0f}', P_loss=f'{(fin<150000).mean()*100:.0f}%', P_double=f'{(fin>=300000).mean()*100:.0f}%',
                             P_below_100k=f'{(mins<100000).mean()*100:.0f}%'))
out = pd.DataFrame(rows); print(out.to_string(index=False)); out.to_csv(sys.argv[2], index=False)
