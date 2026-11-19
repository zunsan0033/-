"""Round-3 checks (not part of the pre-registered verdict).

  python -I cand3_gross.py <folder with *_H1*.csv> <folder with *_D1*.csv> [--out ../results]

1. Time conversion: on US payroll Fridays (08:30 New York), the EURUSD bar with the largest range
   should start at 13:00 UTC in US winter and at 12:00 UTC in US summer.
2. Gross results: each round-3 trade again with no spread and no slippage, next to the net result,
   to show whether a candidate failed for lack of a move or because of the costs.
"""
import argparse, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pandas as pd

import broker_data as BD
import cand3 as C

LEGS = {'(6) USDJPY long 00-07': ('USDJPY', 0, 7, +1), '(6) EURUSD short 07-12': ('EURUSD', 7, 12, -1),
        '(6) EURUSD long 13-20': ('EURUSD', 13, 20, +1), '(6 ref) GBPUSD short 07-12': ('GBPUSD', 7, 12, -1),
        '(6 ref) GBPUSD long 13-20': ('GBPUSD', 13, 20, +1), '(6 ref) AUDUSD short 00-06': ('AUDUSD', 0, 6, -1),
        '(7) gold long 00-07 UTC': ('XAUUSD', 0, 7, +1)}
MONTH_END = [('(5) month-end EURUSD (US500 vs GER40)', 'EURUSD', 'US500', 'GER40', +1),
             ('(5b) month-end USDJPY (US500 vs JP225)', 'USDJPY', 'US500', 'JP225', -1)]


def without_costs(fn):
    """Run fn with zero slippage and a zero spread column."""
    slip, to_tz = C.SLIP, C.to_tz
    C.SLIP = 0.0
    C.to_tz = lambda d, tz: to_tz(d, tz).assign(sbp=0.0)
    try:
        return fn()
    finally:
        C.SLIP, C.to_tz = slip, to_tz


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('h1')
    ap.add_argument('d1')
    ap.add_argument('--out', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'results'))
    a = ap.parse_args()
    rawh, _ = BD.load_dir(a.h1, 'H1'); h1 = BD.to_generic(rawh)
    rawd, _ = BD.load_dir(a.d1, 'D1'); d1 = BD.to_generic(rawd)

    e = C.to_tz(h1['EURUSD'], 'UTC')
    fri = e[(e.index.dayofweek == 4) & (e.index.day <= 7)]
    fri = fri.assign(rng=(fri.h - fri.l) / fri.o,
                     us_dst=[bool(t.dst()) for t in fri.index.tz_convert('America/New_York')])
    for dst, g in fri.groupby('us_dst'):
        top = g.groupby('date').rng.idxmax().map(lambda t: t.hour).value_counts().head(3)
        print('payroll Fridays,', 'US summer' if dst else 'US winter', '- hour (UTC) of the widest EURUSD bar:',
              ', '.join(f'{h}:00 x{n}' for h, n in top.items()))

    trades = {}
    U = {k: C.to_tz(v, 'UTC') for k, v in h1.items()}
    for name, (s, h_in, h_out, side) in LEGS.items():
        if s in h1:
            trades[name] = (C.window(U[s], h_in, h_out, side),
                            without_costs(lambda: C.window(C.to_tz(h1[s], 'UTC'), h_in, h_out, side)))
    three = [k for k in list(LEGS)[:3] if k in trades]
    if len(three) == 3:
        trades['(6) combined three legs'] = tuple(
            pd.concat([trades[k][i] for k in three], axis=1, sort=True).fillna(0.0).mean(axis=1) for i in (0, 1))
    for name, s, x, y, side in MONTH_END:
        if s in h1:
            trades[name] = (C.month_end(h1[s], d1, x, y, side), without_costs(lambda: C.month_end(h1[s], d1, x, y, side)))

    rows = []
    for name, (net, gross) in trades.items():
        s0, s1 = net.index.min(), net.index.max()
        rn, _ = C.stats_block(name, net, s0, s1)
        rg, _ = C.stats_block(name, gross.reindex(net.index), s0, s1)
        for n_, g_ in zip(rn, rg):
            rows.append(dict(candidate=name, period=n_['period'], net_sharpe=n_['sharpe'], gross_sharpe=g_['sharpe'],
                             gross_t=g_['t_stat'], net_bp=n_['avg_trade_bp'], gross_bp=g_['avg_trade_bp'],
                             cost_bp=g_['avg_trade_bp'] - n_['avg_trade_bp'], trades=n_['trades']))
    tab = pd.DataFrame(rows)
    os.makedirs(a.out, exist_ok=True)
    tab.to_csv(os.path.join(a.out, 'round3_gross.csv'), index=False, float_format='%.4f')
    pd.set_option('display.width', 250)
    print(tab.round(2).to_string(index=False))


if __name__ == '__main__':
    main()
