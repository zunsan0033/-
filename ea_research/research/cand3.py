"""Round-3 candidates (pre-registered in CANDIDATES.md, commit e2ed6f6) on the broker's H1 bars.

  python -I cand3.py <folder with *_H1*.csv> <folder with *_D1*.csv> [--out ../results]

(5) month-end FX hedge rebalancing: last London business day of the month, 10:00 -> 16:00 London.
    EURUSD long if US500 beat GER40 month-to-date (else short); variant USDJPY short if US500 beat JP225.
(6) FX time-of-day (UTC, weekdays): USDJPY long 00-07, EURUSD short 07-12, EURUSD long 13-20.
    Reference legs (not in the verdict): GBPUSD short 07-12 / long 13-20, AUDUSD short 00-06.
(7) Gold (GOLDmicro) long 00-07 UTC, plus an hourly test that the Asian hours beat the other hours.
Fills at the open of the H1 bar starting at the given time; costs = half the bar's spread + 0.5 bp per side;
1x notional; no window crosses the server midnight, so no swap.
"""
import argparse, math, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import pandas as pd

import broker_data as BD
import metrics as M
from cand_a import point_size

SLIP = 0.5
SERVER_TZ = 'Europe/Athens'


def to_tz(d, tz):
    x = d.copy()
    x.index = d.index.tz_localize(SERVER_TZ, ambiguous='NaT', nonexistent='shift_forward').tz_convert(tz)
    x = x[x.index.notna()]
    pt = point_size(np.concatenate([x.c.values[-3000:], x.o.values[-3000:]]))
    s = np.where(x.spr.values > 0, x.spr.values * pt / x.c.values * 1e4, np.nan)
    med = np.nanmedian(s) if np.isfinite(s).any() else 1.0
    x['sbp'] = np.where(np.isfinite(s), s, med)
    x['date'] = x.index.tz_localize(None).normalize()
    x['hour'] = x.index.hour
    return x


def window(x, h_in, h_out, side):
    ent = x[x.hour == h_in].groupby('date').first()
    ext = x[x.hour == h_out].groupby('date').first()
    j = ent[['o', 'sbp']].join(ext[['o', 'sbp']], lsuffix='_in', rsuffix='_out', how='inner')
    j = j[j.index.dayofweek < 5]
    r = side * (j.o_out / j.o_in - 1) - (j.sbp_in / 2 + SLIP + j.sbp_out / 2 + SLIP) / 1e4
    return r


def month_end(fx, d1, a, b, side_if_a_wins):
    x = to_tz(fx, 'Europe/London')
    ent = x[x.hour == 10].groupby('date').first()
    ext = x[x.hour == 16].groupby('date').first()
    j = ent[['o', 'sbp']].join(ext[['o', 'sbp']], lsuffix='_in', rsuffix='_out', how='inner')
    j = j[j.index.dayofweek < 5]
    last_days = j.groupby(j.index.to_period('M')).apply(lambda g: g.index.max()).values
    ca, cb = d1[a].c, d1[b].c
    out = {}
    for T in pd.to_datetime(last_days):
        m0 = T.replace(day=1)
        pa, pb = ca[ca.index < m0], cb[cb.index < m0]
        la, lb = ca[ca.index < T], cb[cb.index < T]
        if len(pa) == 0 or len(pb) == 0 or len(la) == 0 or len(lb) == 0:
            continue
        diff = (la.iloc[-1] / pa.iloc[-1] - 1) - (lb.iloc[-1] / pb.iloc[-1] - 1)
        if diff == 0:
            continue
        side = side_if_a_wins if diff > 0 else -side_if_a_wins
        row = j.loc[T]
        out[T] = side * (row.o_out / row.o_in - 1) - (row.sbp_in / 2 + SLIP + row.sbp_out / 2 + SLIP) / 1e4
    return pd.Series(out).sort_index()


def as_daily(r, start, end):
    days = pd.bdate_range(start, end)
    return r.reindex(days).fillna(0.0)


def stats_block(name, r_trades, start, end):
    """Sharpe on business days (zeros when no trade), halves split at the midpoint of the period."""
    daily = as_daily(r_trades, start, end)
    mid = start + (end - start) / 2
    rows = []
    for per, lo, hi in [('full', start, end), ('first half', start, mid), ('second half', mid + pd.Timedelta(days=1), end)]:
        d = daily.loc[lo:hi]
        t = r_trades.loc[lo:hi]
        sm = M.summarize_daily(d)
        rows.append(dict(candidate=name, period=per, start=str(d.index[0].date()), end=str(d.index[-1].date()),
                         sharpe=sm['sharpe'], cagr=sm['cagr'], maxdd=sm['maxdd'], t_stat=sm['t_stat'], trades=len(t),
                         win_rate=float((t > 0).mean()) if len(t) else np.nan, avg_trade_bp=float(t.mean() * 1e4) if len(t) else np.nan))
    return rows, daily


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('h1')
    ap.add_argument('d1')
    ap.add_argument('--out', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'results'))
    a = ap.parse_args()
    rawh, _ = BD.load_dir(a.h1, 'H1'); h1 = BD.to_generic(rawh)
    rawd, _ = BD.load_dir(a.d1, 'D1'); d1 = BD.to_generic(rawd)
    print('H1 symbols:', {k: (str(v.index[0].date()), str(v.index[-1].date()), len(v)) for k, v in h1.items()})
    rows, daily, verdict = [], {}, {}
    U = {k: to_tz(v, 'UTC') for k, v in h1.items()}

    def add(name, r):
        if len(r) == 0:
            print('no trades for', name); return None
        start, end = r.index.min(), r.index.max()
        rr, dd = stats_block(name, r, start, end)
        rows.extend(rr); daily[name] = dd
        return {x['period']: x['sharpe'] for x in rr}

    # (5) month-end
    s5 = add('(5) month-end EURUSD (US500 vs GER40)', month_end(h1['EURUSD'], d1, 'US500', 'GER40', +1)) if 'EURUSD' in h1 else None
    s5b = add('(5b) month-end USDJPY (US500 vs JP225)', month_end(h1['USDJPY'], d1, 'US500', 'JP225', -1)) if 'USDJPY' in h1 else None
    if s5 and s5b:
        verdict['(5)'] = s5['full'] >= 0.3 and s5['first half'] > 0 and s5['second half'] > 0 and s5b['full'] > 0
    # (6) time-of-day
    legs = {}
    if 'USDJPY' in U:
        legs['USDJPY long 00-07'] = window(U['USDJPY'], 0, 7, +1)
    if 'EURUSD' in U:
        legs['EURUSD short 07-12'] = window(U['EURUSD'], 7, 12, -1)
        legs['EURUSD long 13-20'] = window(U['EURUSD'], 13, 20, +1)
    leg_sh = {k: add('(6) ' + k, v) for k, v in legs.items()}
    if len(legs) == 3:
        combo = pd.concat(legs.values(), axis=1).fillna(0.0).mean(axis=1)
        s6 = add('(6) combined three legs', combo)
        verdict['(6)'] = (s6['full'] >= 0.3 and s6['first half'] > 0 and s6['second half'] > 0 and
                          sum(v['full'] > 0 for v in leg_sh.values() if v) >= 2)
    if 'GBPUSD' in U:
        add('(6 ref) GBPUSD short 07-12', window(U['GBPUSD'], 7, 12, -1))
        add('(6 ref) GBPUSD long 13-20', window(U['GBPUSD'], 13, 20, +1))
    if 'AUDUSD' in U:
        add('(6 ref) AUDUSD short 00-06', window(U['AUDUSD'], 0, 6, -1))
    # (7) gold Asian hours
    if 'XAUUSD' in U:
        g = U['XAUUSD']
        s7 = add('(7) gold long 00-07 UTC', window(g, 0, 7, +1))
        hr = (g.c / g.o - 1)
        start, end = g.date.min(), g.date.max(); mid = start + (end - start) / 2
        better = []
        for lo, hi in [(start, mid), (mid + pd.Timedelta(days=1), end)]:
            sel = (g.date >= lo) & (g.date <= hi) & (g.index.dayofweek < 5)
            asia = hr[sel & (g.hour < 7)].mean(); other = hr[sel & (g.hour >= 7)].mean()
            better.append(asia > other)
            print(f'gold hourly mean {lo.date()}..{hi.date()}: Asian {asia*1e4:.2f}bp, other hours {other*1e4:.2f}bp')
        verdict['(7)'] = s7['full'] >= 0.3 and s7['first half'] > 0 and s7['second half'] > 0 and all(better)
    tab = pd.DataFrame(rows)
    os.makedirs(a.out, exist_ok=True)
    tab.to_csv(os.path.join(a.out, 'round3_summary.csv'), index=False, float_format='%.4f')
    pd.DataFrame(daily).to_csv(os.path.join(a.out, 'round3_daily_returns.csv'), float_format='%.6f')
    pd.set_option('display.width', 250)
    print(tab.round(3).to_string(index=False))
    print('VERDICT (pre-registered criteria):', {k: ('PASS' if v else 'fail') for k, v in verdict.items()})


if __name__ == '__main__':
    main()
