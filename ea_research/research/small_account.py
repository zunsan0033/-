"""Small-account simulator with discrete lots at current lot sizes.

  python -I small_account.py <unit_returns.csv> [out folder]
"""
import sys, os
import numpy as np, pandas as pd
U = pd.read_csv(sys.argv[1], index_col=0, parse_dates=True)
N01 = {'US500': 7346.01 * 159.349 * 0.1, 'US100': 27038.93 * 159.349 * 0.1}    # JPY notional of 0.1 lot today
MODS = ['IR_US500_A', 'IR_US500_B', 'IR_US100_A', 'IR_US100_B', 'IM_US100']
R = U[MODS].fillna(0.0).values
LEV = U['IM_US100_lev'].fillna(0.0).values
dates = U.index

def exposure(target, eq, n01, cap):
    lots = np.floor(target * eq / n01 + 1e-9)           # in units of 0.1 lot
    if lots < 1 and n01 / eq <= cap:
        lots = 1
    return lots * n01 / eq

def run(cfg, eq0=150_000, discrete=True, brake=None, R=R, LEV=LEV):
    """cfg: dict module -> (target exposure x equity, cap per position); IM target = research lev * scale."""
    eq = eq0; peak = eq0; path = np.empty(len(R)); mult = 1.0
    for t in range(len(R)):
        pnl = 0.0
        for j, m in enumerate(MODS):
            if m not in cfg:
                continue
            tgt, cap = cfg[m]
            if m == 'IM_US100':
                tgt = LEV[t] * tgt
                if tgt <= 0:
                    continue
            tgt *= mult
            sym = 'US500' if 'US500' in m else 'US100'
            x = exposure(tgt, eq, N01[sym], cap) if discrete else tgt
            pnl += x * eq * R[t, j]
        eq = max(eq + pnl, 1.0)
        peak = max(peak, eq)
        if brake:
            dd = 1 - eq / peak
            mult = brake[1] if dd >= brake[0] else 1.0
        path[t] = eq
    return pd.Series(path, index=dates)

def stats(p, eq0=150_000):
    yrs = (p.index[-1] - p.index[0]).days / 365.25
    cagr = (p.iloc[-1] / eq0) ** (1 / yrs) - 1
    mdd = (p / np.maximum.accumulate(np.r_[eq0, p.values])[1:] - 1).min()
    yr = p.groupby(p.index.year).last(); prev = np.r_[eq0, yr.values[:-1]]; yret = yr.values / prev - 1
    return dict(final=f'{p.iloc[-1]:,.0f}', cagr=f'{cagr*100:.1f}%', maxdd=f'{mdd*100:.1f}%', worst_year=f'{yret.min()*100:.1f}%',
                losing_years=int((yret < 0).sum()), min_equity=f'{p.min():,.0f}')

if __name__ == '__main__':
    base = {'IR_US500_A': (0.5, 9), 'IR_US500_B': (0.5, 9), 'IR_US100_A': (0.5, 9), 'IR_US100_B': (0.5, 9), 'IM_US100': (0.5, 9)}
    print('== leverage multiplier k on the planned portfolio, continuous sizing (no lot limits), 2016-11..2026-11')
    rows = []
    for k in [0.5, 1, 1.5, 2, 3, 4, 5, 6]:
        cfg = {m: (v[0] * k, 99) for m, v in base.items()}
        rows.append(dict(k=k, **stats(run(cfg, discrete=False))))
    print(pd.DataFrame(rows).to_string(index=False))
    if len(sys.argv) > 2:
        pd.DataFrame(rows).to_csv(os.path.join(sys.argv[2], 'small_leverage_sweep.csv'), index=False)
    print('\n== 150,000 JPY with current 0.1-lot sizes (US500 0.1 lot = %.0f JPY, US100 0.1 lot = %.0f JPY)' % (N01['US500'], N01['US100']))
    cands = {
        'D1 IR US500 A+B (1 lot-step each)':           {'IR_US500_A': (1.0, 2), 'IR_US500_B': (1.0, 2)},
        'D2 D1 + IM US100 (scale 1, cap 4x)':          {'IR_US500_A': (1.0, 2), 'IR_US500_B': (1.0, 2), 'IM_US100': (1.0, 4)},
        'D3 D2 + IR US100 A (cap 3x)':                 {'IR_US500_A': (1.0, 2), 'IR_US500_B': (1.0, 2), 'IM_US100': (1.0, 4), 'IR_US100_A': (1.0, 3)},
        'D4 IR US500 A only + IR US100 A + IM':        {'IR_US500_A': (1.0, 2), 'IM_US100': (1.0, 4), 'IR_US100_A': (1.0, 3)},
        'D5 D3 x1.5 targets':                          {'IR_US500_A': (1.5, 2), 'IR_US500_B': (1.5, 2), 'IM_US100': (1.5, 4), 'IR_US100_A': (1.5, 3)},
        'D6 D3 x2 targets':                            {'IR_US500_A': (2.0, 3), 'IR_US500_B': (2.0, 3), 'IM_US100': (2.0, 5), 'IR_US100_A': (2.0, 3)},
    }
    rows = []
    for name, cfg in cands.items():
        rows.append(dict(config=name, **stats(run(cfg))))
        rows.append(dict(config=name + ' +brake(25%->half)', **stats(run(cfg, brake=(0.25, 0.5)))))
    print(pd.DataFrame(rows).to_string(index=False))
    if len(sys.argv) > 2:
        pd.DataFrame(rows).to_csv(os.path.join(sys.argv[2], 'small_account_configs.csv'), index=False)
