"""Round-11 candidate (19), pre-registered in CANDIDATES.md (commit da4de72): buy at the close of the fifth-to-last
trading day of a month that is down so far, sell at the close of its last trading day.

  python -I cand11.py <folder with the broker's *_D1*.csv> [--out ../results]

Periods not looked at before: 1999-02..2013-12 on the S&P 500 cash index (bundled with the `arch` package) and
2021-01..2026-11 on the broker's US500. Costs 2 bp per round trip; financing = US rate + 2.5%/yr per night.
Pass: pooled trade-level t >= 2.0 on the two unseen periods, a positive mean per trade in each, and rule days
above the other days in each. NASDAQ Composite / US100 and the "month up" and "every month" variants are references.
"""
import argparse, math, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import pandas as pd

import broker_data as BD
import data_sources as DS
import dbt as B
from sweep8 import cfd_fin, daily_net

UNSEEN_A = ('1999-02-01', '2013-12-31')
SEEN = ('2014-07-01', '2020-12-31')
UNSEEN_B = ('2021-01-01', '2026-12-31')
COST_BP = 2.0


def month_end(d):
    """Daily net returns and per-month trade returns of the three variants on one daily frame (o,h,l,c)."""
    p = B.prep(d)
    ym = np.asarray(p.index.year * 100 + p.index.month)
    prev_last = p.c.groupby(ym).last().shift(1)
    sel = (p.tdm_rev == -5).values
    refc = pd.Series(p.c.values[sel], index=ym[sel])
    refc = refc[~refc.index.duplicated()]
    mtd = (refc / prev_last - 1).reindex(ym).values
    last4 = (p.tdm_rev >= -4).values
    fl, fs = cfd_fin('USD')
    out = {}
    for name, f in [('down', last4 & (mtd < 0)), ('up', last4 & (mtd >= 0)), ('all', last4 & np.isfinite(mtd))]:
        flag = pd.Series(f, index=p.index)
        pos = flag.shift(-1, fill_value=False).astype(float)
        net = daily_net(p.ret, pos, COST_BP, fl, fs)
        months = pd.Series(ym, index=p.index)
        traded = flag.groupby(months).any()
        trades = net.groupby(months).sum()[traded]
        trades.index = pd.to_datetime(trades.index.astype(str), format='%Y%m')
        out[name] = dict(net=net, trades=trades, flag=flag, ret=p.ret)
    return out


def tstat(x):
    x = pd.Series(x).dropna()
    return float(x.mean() / x.std(ddof=1) * math.sqrt(len(x))) if len(x) > 2 else float('nan')


def row(label, market, v, lo, hi):
    t = v['trades'].loc[lo:hi]
    f, r = v['flag'].loc[lo:hi], v['ret'].loc[lo:hi]
    return dict(rule=label, market=market, start=lo[:7], end=min(hi, str(r.index[-1].date()))[:7], trades=len(t),
                mean_bp=float(t.mean() * 1e4), t=tstat(t), win_rate=float((t > 0).mean()),
                rule_day_bp=float(r[f].mean() * 1e4), other_day_bp=float(r[~f].mean() * 1e4)), t


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('d1')
    ap.add_argument('--out', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'results'))
    a = ap.parse_args()
    raw, _ = BD.load_dir(a.d1, 'D1'); d1 = BD.to_generic(raw)
    src = {'S&P 500 cash': month_end(DS.spx_cash()), 'US500 (broker)': month_end(d1['US500']),
           'NASDAQ Composite cash': month_end(DS.ndq_cash()), 'US100 (broker)': month_end(d1['US100'])}
    rows, pooled = [], {}
    for fam, cash, cfd in [('S&P 500', 'S&P 500 cash', 'US500 (broker)'), ('NASDAQ', 'NASDAQ Composite cash', 'US100 (broker)')]:
        for name, label in [('down', 'last 4 days, month down so far'), ('up', 'last 4 days, month up so far'), ('all', 'last 4 days, every month')]:
            ra, ta = row(label, cash, src[cash][name], *UNSEEN_A)
            rs, _ = row(label, cfd, src[cfd][name], *SEEN)
            rb, tb = row(label, cfd, src[cfd][name], *UNSEEN_B)
            ra['period'], rs['period'], rb['period'] = 'unseen', 'seen in round 8', 'unseen'
            both = pd.concat([ta, tb])
            rp = dict(rule=label, market=fam + ' (both unseen periods)', start=UNSEEN_A[0][:7], end=rb['end'], trades=len(both),
                      mean_bp=float(both.mean() * 1e4), t=tstat(both), win_rate=float((both > 0).mean()), period='unseen, pooled')
            rows += [ra, rs, rb, rp]
            pooled[(fam, name)] = (ra, rb, rp)
    tab = pd.DataFrame(rows)
    os.makedirs(a.out, exist_ok=True)
    tab.to_csv(os.path.join(a.out, 'round11_month_end.csv'), index=False, float_format='%.4f')
    pd.set_option('display.width', 250)
    print(tab.round(2).to_string(index=False))
    ra, rb, rp = pooled[('S&P 500', 'down')]
    ok = (rp['t'] >= 2.0 and ra['mean_bp'] > 0 and rb['mean_bp'] > 0 and ra['rule_day_bp'] > ra['other_day_bp'] and
          rb['rule_day_bp'] > rb['other_day_bp'])
    print('VERDICT (pre-registered criteria): (19)', 'PASS' if ok else 'fail')


if __name__ == '__main__':
    main()
