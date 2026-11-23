"""Round-7 candidates (15) and (16), pre-registered in CANDIDATES.md (commit ca932e1), on the broker's bars.

  python -I cand7.py <folder with *_H1*.csv> <folder with *_D1*.csv> [--out ../results]

(15) Tokyo-fix "gotobi" effect: buy USDJPY at 09:00 Tokyo, sell at 10:00, on the 5th, 10th, 15th, 20th, 25th and
     the last day of the month (moved to the Friday before when on a weekend). Fills at the open of the H1 bar that
     starts at that time; costs = half the bar's spread + 0.5 bp per side; 1x notional; no swap (no server midnight).
     Pass: net Sharpe >= 0.3, both halves > 0, and the gross mean beats the same hour on other weekdays in both halves.
(16) FOMC-cycle even weeks (Cieslak, Morse & Vissing-Jorgensen 2019): day 0 = scheduled statement day, counted in
     NYSE trading days; week w = days 5w-1 .. 5w+3; the day before the next meeting starts its week 0; weeks 7+ are
     outside. Long US500 (1x) on even-week days only, on server-day D1 bars. Costs: |change in position| x (median
     spread bp + 1 bp) / 2; financing = US rate + 2.5%/yr per night.
     Pass: net Sharpe >= 0.3, both halves > 0, even-week mean daily return above odd-week mean in both halves, and
     the full-sample difference with t >= 2.
"""
import argparse, math, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import pandas as pd

import broker_data as BD
import dbt as B
import metrics as M
from cand3 import to_tz, stats_block
from cand4 import FOMC as FOMC_2016
from cand_c import broker_cost_bp
from im_emulator import is_nyse_holiday

SLIP = 0.5
FOMC = ['2013-12-18',
        '2014-01-29', '2014-03-19', '2014-04-30', '2014-06-18', '2014-07-30', '2014-09-17', '2014-10-29', '2014-12-17',
        '2015-01-28', '2015-03-18', '2015-04-29', '2015-06-17', '2015-07-29', '2015-09-17', '2015-10-28', '2015-12-16',
        '2016-01-27', '2016-03-16', '2016-04-27', '2016-06-15', '2016-07-27', '2016-09-21'] + FOMC_2016 + ['2026-12-09']


# ------------------------------------------------------------------ (15) gotobi
def gotobi_days(start, end):
    days = set()
    for per in pd.period_range(start, end, freq='M'):
        for dd in [5, 10, 15, 20, 25, per.days_in_month]:
            t = pd.Timestamp(per.year, per.month, dd)
            if t.dayofweek == 5:
                t -= pd.Timedelta(days=1)
            elif t.dayofweek == 6:
                t -= pd.Timedelta(days=2)
            days.add(t)
    return pd.DatetimeIndex(sorted(days))


def hour_window(x, h_in, h_out, side, costs=True):
    """Return per local date: side * (open at h_out / open at h_in - 1), net of costs when asked. Weekdays only."""
    ent = x[x.hour == h_in].groupby('date').first()
    ext = x[x.hour == h_out].groupby('date').first()
    j = ent[['o', 'sbp']].join(ext[['o', 'sbp']], lsuffix='_in', rsuffix='_out', how='inner')
    j = j[j.index.dayofweek < 5]
    r = side * (j.o_out / j.o_in - 1)
    if costs:
        r = r - (j.sbp_in / 2 + SLIP + j.sbp_out / 2 + SLIP) / 1e4
    return r


def tstat(x):
    x = pd.Series(x).dropna()
    return float(x.mean() / x.std(ddof=1) * math.sqrt(len(x))) if len(x) > 2 else float('nan')


def run_gotobi(h1, rows):
    x = to_tz(h1, 'Asia/Tokyo')
    start, end = x.date.min(), x.date.max()
    g = gotobi_days(start, end)
    out = {}
    for name, h_in, h_out, side in [('(15) gotobi: USDJPY long 09:00-10:00 Tokyo', 9, 10, +1),
                                    ('(15 ref) gotobi: USDJPY long 08:00-10:00 Tokyo', 8, 10, +1),
                                    ('(15 ref) gotobi: USDJPY short 10:00-15:00 Tokyo', 10, 15, -1)]:
        net, gross = hour_window(x, h_in, h_out, side), hour_window(x, h_in, h_out, side, costs=False)
        is_g = net.index.isin(g)
        rr, _ = stats_block(name, net[is_g], net.index.min(), net.index.max())
        for r in rr:
            lo, hi = pd.Timestamp(r['start']), pd.Timestamp(r['end'])
            gg, oo = gross[is_g].loc[lo:hi], gross[~is_g].loc[lo:hi]
            r.update(gross_bp=float(gg.mean() * 1e4), gross_t=tstat(gg), other_days_gross_bp=float(oo.mean() * 1e4),
                     diff_t=float((gg.mean() - oo.mean()) / math.sqrt(gg.var(ddof=1) / len(gg) + oo.var(ddof=1) / len(oo))),
                     cost_bp=float((gross[is_g].loc[lo:hi] - net[is_g].loc[lo:hi]).mean() * 1e4))
        rows += rr
        out[name] = rr
    main = {r['period']: r for r in out['(15) gotobi: USDJPY long 09:00-10:00 Tokyo']}
    ok = (main['full']['sharpe'] >= 0.3 and main['first half']['sharpe'] > 0 and main['second half']['sharpe'] > 0 and
          main['first half']['gross_bp'] > main['first half']['other_days_gross_bp'] and
          main['second half']['gross_bp'] > main['second half']['other_days_gross_bp'])
    return ok


# ------------------------------------------------------------------ (16) FOMC cycle
def cycle_weeks():
    """NYSE trading days 2013-12 .. 2026-12 with their week in FOMC cycle time (-1 = outside weeks 0-6)."""
    days = [d for d in pd.bdate_range('2013-12-02', '2026-12-31') if not is_nyse_holiday(d.year * 10000 + d.month * 100 + d.day)]
    idx = {d: i for i, d in enumerate(days)}
    f = [pd.Timestamp(x) for x in FOMC]
    assert all(x in idx for x in f), 'an FOMC date is not an NYSE trading day'
    fpos = np.array([idx[x] for x in f])
    week = {}
    for d in days:
        i = idx[d]
        k = np.searchsorted(fpos, i, 'right') - 1          # last meeting at or before this day
        if k < 0:
            continue
        day = i - fpos[k]
        if k + 1 < len(fpos) and fpos[k + 1] - i == 1:      # the day before the next meeting: its day -1
            day = -1
        w = (day + 1) // 5
        week[d] = w if w <= 6 else -1
    return pd.Series(week)


def run_fomc_cycle(d1, sym, rows, label):
    d = B.prep(d1[sym])
    wk = cycle_weeks()
    w = wk.reindex(d.index)                                  # NaN on bars that are not NYSE trading days
    hold_td = (w >= 0) & (w % 2 == 0)
    hold = hold_td.astype(float).where(w.notna()).ffill().fillna(0.0)     # holiday bars carry the previous state
    pos = hold.shift(-1).fillna(0.0)                         # held from close t to close t+1 when bar t+1 is an even-week day
    cost_rt = (broker_cost_bp(d1[sym])[0] + 1.0) / 1e4
    res = B.run(d, pos, cost_rt=cost_rt, markup=0.025, rates=B.USD_RATE)
    r = res.net
    mid = r.index[0] + (r.index[-1] - r.index[0]) / 2
    ret = d.ret                                              # close-to-close return of each bar
    td = w.notna() & ret.notna()
    even, odd = td & (w >= 0) & (w % 2 == 0), td & (w >= 0) & (w % 2 == 1)
    out = {}
    for per, lo, hi in [('full', r.index[0], r.index[-1]), ('first half', r.index[0], mid), ('second half', mid + pd.Timedelta(days=1), r.index[-1])]:
        x = r.loc[lo:hi]
        sm = M.summarize_daily(x)
        e, o = ret[even].loc[lo:hi], ret[odd].loc[lo:hi]
        row = dict(candidate=label, period=per, start=str(x.index[0].date()), end=str(x.index[-1].date()), sharpe=sm['sharpe'],
                   cagr=sm['cagr'], maxdd=sm['maxdd'], t_stat=sm['t_stat'], time_in_market=float((res.pos.loc[lo:hi] > 0).mean()),
                   even_bp=float(e.mean() * 1e4), odd_bp=float(o.mean() * 1e4), even_days=len(e), odd_days=len(o),
                   diff_t=float((e.mean() - o.mean()) / math.sqrt(e.var(ddof=1) / len(e) + o.var(ddof=1) / len(o))))
        rows.append(row); out[per] = row
    by_week = pd.DataFrame({'week': w[td & (w >= 0)].astype(int), 'ret': ret[td & (w >= 0)]}).groupby('week').ret.agg(['mean', 'count'])
    print(f'{sym} mean daily return by FOMC-cycle week (bp):', {int(k): round(v * 1e4, 1) for k, v in by_week['mean'].items()},
          'days:', {int(k): int(v) for k, v in by_week['count'].items()})
    ok = (out['full']['sharpe'] >= 0.3 and out['first half']['sharpe'] > 0 and out['second half']['sharpe'] > 0 and
          out['first half']['even_bp'] > out['first half']['odd_bp'] and out['second half']['even_bp'] > out['second half']['odd_bp'] and
          out['full']['diff_t'] >= 2.0)
    return ok, r


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('h1')
    ap.add_argument('d1')
    ap.add_argument('--out', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'results'))
    a = ap.parse_args()
    rawh, _ = BD.load_dir(a.h1, 'H1'); h1 = BD.to_generic(rawh)
    rawd, _ = BD.load_dir(a.d1, 'D1'); d1 = BD.to_generic(rawd)
    rows, verdict = [], {}
    verdict['(15)'] = run_gotobi(h1['USDJPY'], rows)
    ok, r500 = run_fomc_cycle(d1, 'US500', rows, '(16) FOMC-cycle even weeks, US500')
    verdict['(16)'] = ok
    _, r100 = run_fomc_cycle(d1, 'US100', rows, '(16 ref) FOMC-cycle even weeks, US100')
    tab = pd.DataFrame(rows)
    os.makedirs(a.out, exist_ok=True)
    tab.to_csv(os.path.join(a.out, 'round7_summary.csv'), index=False, float_format='%.4f')
    pd.DataFrame({'(16) US500 even weeks': r500, '(16 ref) US100 even weeks': r100}).to_csv(
        os.path.join(a.out, 'round7_fomc_cycle_daily.csv'), float_format='%.6f')
    pd.set_option('display.width', 260); pd.set_option('display.max_columns', 30)
    print(tab.round(3).to_string(index=False))
    print('VERDICT (pre-registered criteria):', {k: ('PASS' if v else 'fail') for k, v in verdict.items()})


if __name__ == '__main__':
    main()
