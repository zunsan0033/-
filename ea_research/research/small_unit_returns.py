"""Usage: python -I small_unit_returns.py <D1 folder> <M5 folder> <out.csv>

Per-module daily returns per 1.0x of equity exposure (costs and financing included), 2016-11 .. 2026-11."""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np, pandas as pd
import broker_data as BD, dbt as B, sim_final as F, cand_a as A
from cand_c import broker_cost_bp
rawd, _ = BD.load_dir(sys.argv[1], 'D1'); d1 = BD.to_generic(rawd)
rawm, _ = BD.load_dir(sys.argv[2], 'M5'); m5 = BD.to_generic(rawm)
cols = {}
for sym in ['US500', 'US100']:
    d = B.prep(d1[sym]); sp, _ = broker_cost_bp(d1[sym])
    for rule in ['A', 'B']:
        eq, tr = F.simulate(d, rules=(rule,), w_fixed=1.0, use_stop=True, stop_atr=3.0, cost_rt=(sp + 1) / 1e4,
                            rates=B.CCY_RATE['USD'], markup=0.025)
        cols[f'IR_{sym}_{rule}'] = eq.ret
        cols[f'IR_{sym}_{rule}_on'] = (eq.expo > 0).astype(float).shift(1).fillna(0.0)   # exposure held during the day
res, tr, _ = A.run(m5['US100'], 'US100', stop_pct=0.02)          # broker spreads + 0.5bp slippage per side
lev = res.lev.replace(0, np.nan)
cols['IM_US100'] = (res.ret / lev).fillna(0.0)                   # per 1.0x exposure
cols['IM_US100_lev'] = res.lev                                   # research exposure (scale 1.0)
U = pd.DataFrame(cols).sort_index()
U = U.loc['2016-11-17':'2026-11-13']
for c in [c for c in U.columns if not c.endswith(('_on', '_lev'))]:
    U[c] = U[c].fillna(0.0)
U.to_csv(sys.argv[3])
print(U.describe().T[['mean', 'std']].assign(ann_mean=lambda x: x['mean'] * 252, ann_vol=lambda x: x['std'] * np.sqrt(252)).round(4).to_string())
