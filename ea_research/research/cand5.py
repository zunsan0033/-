"""Round-5 candidate (12), pre-registered in CANDIDATES.md (commit f96cb3b): candidate A's intraday momentum rules,
unchanged, on JP225 in the Tokyo session (09:00-15:00 Tokyo), on the broker's M5 bars.

  python -I cand5.py <folder with JP225 *_M5*.csv> [--out ../results]

Pass: net Sharpe >= 0.3 and positive in both halves (split at the middle of the data period).
"""
import argparse, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pandas as pd

import broker_data as BD
import metrics as M
from cand_a import run, summarize


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('folder')
    ap.add_argument('--out', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'results'))
    a = ap.parse_args()
    raw, _ = BD.load_dir(a.folder, 'M5')
    data = BD.to_generic(raw)
    d = data['JP225']
    print('JP225 M5 bars:', len(d), d.index[0], '->', d.index[-1])
    res, tr, spr_bp = run(d, 'JP225')
    res0, _, _ = run(d, 'JP225', cost_scale=0.0)                # diagnostic only: no spread, no slippage
    r = res.ret
    first = tr.date.min()
    r = r.loc[first:]
    mid = r.index[0] + (r.index[-1] - r.index[0]) / 2
    rows = []
    for label, lo, hi in [('full', None, None), ('first half', None, mid), ('second half', mid + pd.Timedelta(days=1), None)]:
        rr = r.loc[lo:hi]
        t = tr[(tr.date >= rr.index[0]) & (tr.date <= rr.index[-1])]
        row = summarize(rr, t, label)
        row.update(index='JP225 (Tokyo 09:00-15:00)', median_spread_bp=spr_bp, avg_leverage=float(res.lev.loc[rr.index].mean()),
                   sharpe_zero_cost=M.summarize_daily(res0.ret.loc[rr.index])['sharpe'])
        rows.append(row)
    summ = pd.DataFrame(rows)[['index', 'period', 'start', 'end', 'sharpe', 'cagr', 'vol', 'maxdd', 't_stat', 'trades',
                               'win_rate', 'avg_trade_bp_unlevered', 'days_traded', 'avg_leverage', 'median_spread_bp',
                               'sharpe_zero_cost']]
    os.makedirs(a.out, exist_ok=True)
    summ.to_csv(os.path.join(a.out, 'round5_summary.csv'), index=False, float_format='%.4f')
    r.to_frame('ret').to_csv(os.path.join(a.out, 'round5_jp225_daily.csv'), float_format='%.6f')
    pd.set_option('display.width', 250)
    print(summ.round(3).to_string(index=False))
    print('yearly:', {int(y): round(v * 100, 1) for y, v in M.yearly_table(r).ret.items()})
    s = dict(zip(summ.period, summ.sharpe))
    ok = s['full'] >= 0.3 and s['first half'] > 0 and s['second half'] > 0
    print('VERDICT (pre-registered criteria): (12)', 'PASS' if ok else 'fail')


if __name__ == '__main__':
    main()
