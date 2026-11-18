"""Cross-check IntradayMomentum_EA (via its Python transcription im_emulator.py) against cand_a.py.

  python -I check_im_parity.py <folder with *_M5*.csv> US100,US500
"""
import sys, time
sys.path.insert(0, __import__('os').path.dirname(__import__('os').path.abspath(__file__)))
import numpy as np, pandas as pd
import broker_data as BD, cand_a as A, im_emulator as E
raw, _ = BD.load_dir(sys.argv[1], 'M5'); data = BD.to_generic(raw)
for sym in sys.argv[2].split(','):
    t0 = time.time()
    res, tr, _ = A.run(data[sym], sym, stop_pct=0.02, cost_scale=0.0)
    em, etr = E.run(data[sym], stop_pct=0.02, spr_bp=None)
    r1 = res.ret; r2 = em.ret
    common = r1.index.intersection(r2.index)
    only_res = r1.index.difference(r2.index); only_em = r2.index.difference(r1.index)
    diff = (r1.reindex(common) - r2.reindex(common)).abs()
    nz_only_em = (r2.reindex(only_em).abs() > 0).sum()
    print(f'== {sym}: research days {len(r1)}, EA-emulator days {len(r2)}, common {len(common)}; '
          f'only research {len(only_res)}, only EA {len(only_em)} (of which with trades: {nz_only_em})')
    print(f'   common days: max |daily return diff| = {diff.max():.2e}; days differing >1e-9: {(diff > 1e-9).sum()}')
    # trade-level comparison on common days
    tr = tr.copy(); tr['key'] = tr.date.dt.strftime('%Y%m%d').astype(int)
    keys = set(int(d.strftime('%Y%m%d')) for d in common)
    a = tr[tr.key.isin(keys)][['key', 'side', 'ek', 'xk']].sort_values(['key', 'ek']).reset_index(drop=True)
    b = etr[etr.key.isin(keys)][['key', 'side', 'ek', 'xk']].sort_values(['key', 'ek']).reset_index(drop=True)
    same = len(a) == len(b) and (a.values == b.values).all()
    print(f'   trades on common days: research {len(a)}, EA {len(b)}, identical={same}')
    if len(only_em):
        print('   EA-only days sample:', [d.strftime('%Y-%m-%d') for d in only_em[:8]])
    if len(only_res):
        print('   research-only days sample:', [d.strftime('%Y-%m-%d') for d in only_res[:8]])
    print(f'   sharpe (gross, 2% stop): research {r1.mean()/r1.std()*np.sqrt(252):.3f}  EA {r2.loc[r1.index[0]:].mean()/r2.loc[r1.index[0]:].std()*np.sqrt(252):.3f}  [{time.time()-t0:.0f}s]')
