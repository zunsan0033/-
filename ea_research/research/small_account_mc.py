"""Block-bootstrap outcomes from 150,000 JPY.  python -I small_account_mc.py <unit_returns.csv> <out.csv>"""
import sys, os
import numpy as np, pandas as pd
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import small_account as S
U = pd.read_csv(sys.argv[1], index_col=0, parse_dates=True)
R0 = U[S.MODS].fillna(0.0).values
LEV0 = U['IM_US100_lev'].fillna(0.0).values
def haircut(R, h):
    R = R.copy()
    for j in range(R.shape[1]):
        nz = R[:, j] != 0
        if nz.sum():
            R[nz, j] -= h * R[:, j].mean() * len(R) / nz.sum()
    return R
cfgs = {
    'D2 IR US500 A+B + IM':           {'IR_US500_A': (1.0, 2), 'IR_US500_B': (1.0, 2), 'IM_US100': (1.0, 4)},
    'D3 + IR US100 A (recommended)':  {'IR_US500_A': (1.0, 2), 'IR_US500_B': (1.0, 2), 'IM_US100': (1.0, 4), 'IR_US100_A': (1.0, 3)},
    'D5 D3 x1.5':                     {'IR_US500_A': (1.5, 2), 'IR_US500_B': (1.5, 2), 'IM_US100': (1.5, 4), 'IR_US100_A': (1.5, 3)},
}
rng = np.random.default_rng(7)
def boot_idx(n, T, block=20):
    idx = np.empty(T, dtype=int); i = rng.integers(n)
    for t in range(T):
        if t % block == 0:
            i = rng.integers(n)
        idx[t] = i; i = (i + 1) % n
    return idx
rows = []
for h_label, h in [('same edge as history', 0.0), ('edge halved', 0.5)]:
    R = haircut(R0, h)
    for name, cfg in cfgs.items():
        for T, lab in [(252, '1y'), (756, '3y')]:
            fin = []; mins = []
            for b in range(1000):
                ix = boot_idx(len(R), T)
                eq = 150_000.0; peak = eq; mn = eq
                for t in ix:
                    pnl = 0.0
                    for j, m in enumerate(S.MODS):
                        if m not in cfg: continue
                        tgt, cap = cfg[m]
                        if m == 'IM_US100':
                            tgt = LEV0[t] * tgt
                            if tgt <= 0: continue
                        sym = 'US500' if 'US500' in m else 'US100'
                        x = S.exposure(tgt, eq, S.N01[sym], cap)
                        pnl += x * eq * R[t, j]
                    eq = max(eq + pnl, 1.0); mn = min(mn, eq)
                fin.append(eq); mins.append(mn)
            fin = np.array(fin); mins = np.array(mins)
            rows.append(dict(scenario=h_label, config=name, horizon=lab, median=f'{np.median(fin):,.0f}',
                             p10=f'{np.percentile(fin, 10):,.0f}', p90=f'{np.percentile(fin, 90):,.0f}',
                             P_loss=f'{(fin < 150_000).mean()*100:.0f}%', P_double=f'{(fin >= 300_000).mean()*100:.0f}%',
                             P_below_100k=f'{(mins < 100_000).mean()*100:.0f}%', P_below_75k=f'{(mins < 75_000).mean()*100:.0f}%'))
out = pd.DataFrame(rows)
print(out.to_string(index=False))
out.to_csv(sys.argv[2], index=False)
