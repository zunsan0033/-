"""Round-4 candidates (9) and (10), pre-registered in CANDIDATES.md (commit cd39082), on the broker's bars.

  python -I cand4.py <folder with *_D1*.csv> <folder with *_M5*.csv> [--out ../results]

(9) carry with a trend filter (candidate F): USDJPY, AUDJPY, NZDJPY long while the previous close is above
    its 200-day average, flat while 20-day volatility exceeds twice its 252-day median; 10% volatility target
    per pair (cap 3x); equal-weight average of the three pairs. Crosses are AUDUSD x USDJPY and NZDUSD x USDJPY.
    Costs |change in weight| x (median spread bp + 1 bp) / 2; financing = rate differential - 1%/yr per night.
(10) pre-FOMC drift (candidate H): US500 bought at the first 5-minute bar from 14:00 New York on the day before
    a scheduled statement, sold at the first bar from 13:55 on the statement day. Costs: half the bar spread +
    0.5 bp per side, one night of CFD financing (US rate + 2.5%/yr). US100 and US30 for reference only.
The (11) test (1-hour breakout in the carry direction) uses the combined EA's unpublished USDJPY module rules and
is run outside this repository; only its results are recorded.
"""
import argparse, math, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import pandas as pd

import broker_data as BD
from cand_a import point_size
from cand_c import broker_cost_bp
from dbt import USD_RATE, CCY_RATE

SLIP = 0.5
EXTRA = {'JPY': {2013: 0.05}, 'AUD': {}, 'NZD': {}}

# scheduled FOMC statements (14:00 New York), November 2016 - October 2026
FOMC = ['2016-11-02', '2016-12-14', '2017-02-01', '2017-03-15', '2017-05-03', '2017-06-14', '2017-07-26', '2017-09-20',
        '2017-11-01', '2017-12-13', '2018-01-31', '2018-03-21', '2018-05-02', '2018-06-13', '2018-08-01', '2018-09-26',
        '2018-11-08', '2018-12-19', '2019-01-30', '2019-03-20', '2019-05-01', '2019-06-19', '2019-07-31', '2019-09-18',
        '2019-10-30', '2019-12-11', '2020-01-29', '2020-04-29', '2020-06-10', '2020-07-29', '2020-09-16', '2020-11-05',
        '2020-12-16', '2021-01-27', '2021-03-17', '2021-04-28', '2021-06-16', '2021-07-28', '2021-09-22', '2021-11-03',
        '2021-12-15', '2022-01-26', '2022-03-16', '2022-05-04', '2022-06-15', '2022-07-27', '2022-09-21', '2022-11-02',
        '2022-12-14', '2023-02-01', '2023-03-22', '2023-05-03', '2023-06-14', '2023-07-26', '2023-09-20', '2023-11-01',
        '2023-12-13', '2024-01-31', '2024-03-20', '2024-05-01', '2024-06-12', '2024-07-31', '2024-09-18', '2024-11-07',
        '2024-12-18', '2025-01-29', '2025-03-19', '2025-05-07', '2025-06-18', '2025-07-30', '2025-09-17', '2025-10-29',
        '2025-12-10', '2026-01-28', '2026-03-18', '2026-04-29', '2026-06-17', '2026-07-29', '2026-09-16', '2026-10-28']


def rate(ccy, year):
    if ccy == 'USD':
        return USD_RATE.get(year, 3.0) / 100
    return CCY_RATE[ccy].get(year, list(CCY_RATE[ccy].values())[-1]) / 100


def stats(r, ann=252):
    r = pd.Series(r).dropna()
    sd = r.std()
    return dict(sharpe=float(r.mean() / sd * math.sqrt(ann)) if sd > 0 else float('nan'),
                cagr=float((1 + r).prod() ** (ann / max(len(r), 1)) - 1),
                maxdd=float(((1 + r).cumprod() / (1 + r).cumprod().cummax() - 1).min()),
                t=float(r.mean() / sd * math.sqrt(len(r))) if sd > 0 else float('nan'))


# ------------------------------------------------------------------ (9) carry with a trend filter
def carry_trend(d1):
    usdjpy, audusd, nzdusd = d1['USDJPY'], d1['AUDUSD'], d1['NZDUSD']
    cost = {'USDJPY': broker_cost_bp(usdjpy)[0] + 1.0}
    cost['AUDJPY'] = broker_cost_bp(audusd)[0] + broker_cost_bp(usdjpy)[0] + 1.0
    cost['NZDJPY'] = broker_cost_bp(nzdusd)[0] + broker_cost_bp(usdjpy)[0] + 1.0
    close = pd.DataFrame({'USDJPY': usdjpy.c, 'AUDJPY': audusd.c * usdjpy.c, 'NZDJPY': nzdusd.c * usdjpy.c}).dropna()
    close = close[close.index.dayofweek < 5]                       # no short Sunday bars
    base = {'USDJPY': 'USD', 'AUDJPY': 'AUD', 'NZDJPY': 'NZD'}
    ret = close.pct_change()
    lr = np.log(close).diff()
    vol = lr.rolling(20).std() * math.sqrt(252)
    med = vol.rolling(252).median()
    sma = close.rolling(200).mean()
    hold = (close > sma) & (vol <= 2 * med)
    w = (hold * (0.10 / vol).clip(upper=3.0)).where(med.notna() & sma.notna(), 0.0).fillna(0.0)
    nights = pd.Series(close.index, index=close.index).diff().dt.days.shift(-1).fillna(1).values
    out = {}
    for p in close.columns:
        wp = w[p]
        gross = wp.shift(1) * ret[p]
        tc = wp.diff().abs().fillna(wp.abs()) * cost[p] / 2 / 1e4
        carry = np.array([rate(base[p], t.year) - rate('JPY', t.year) - 0.01 for t in close.index])
        fin = (wp * carry * nights / 365.0).shift(1)
        out[p] = (gross - tc + fin).fillna(0.0)
    daily = pd.DataFrame(out)
    port = daily.mean(axis=1)
    start = w.mean(axis=1).ne(0).idxmax() if w.mean(axis=1).ne(0).any() else close.index[0]
    port = port.loc[start:]
    return port, daily.loc[start:], w.loc[start:]


# ------------------------------------------------------------------ (10) pre-FOMC drift
def ny_to_server(day, hhmm):
    return (pd.Timestamp(f'{day} {hhmm}', tz='America/New_York').tz_convert('Europe/Athens').tz_localize(None))


def pre_fomc(m5):
    pt = point_size(np.concatenate([m5.c.values[-3000:], m5.o.values[-3000:]]))
    sbp = np.where(m5.spr.values > 0, m5.spr.values * pt / m5.c.values * 1e4, np.nan)
    sbp = np.where(np.isfinite(sbp), sbp, np.nanmedian(sbp))
    t = m5.index
    rows = []
    for day in FOMC:
        d = pd.Timestamp(day)
        t_in = ny_to_server((d - pd.Timedelta(days=1)).strftime('%Y-%m-%d'), '14:00')
        t_out = ny_to_server(day, '13:55')
        i, j = t.searchsorted(t_in), t.searchsorted(t_out)
        if i >= len(t) or j >= len(t) or t[i] >= t_out:
            continue
        r = m5.o.values[j] / m5.o.values[i] - 1 - (sbp[i] / 2 + SLIP + sbp[j] / 2 + SLIP) / 1e4
        nights = (t[j].normalize() - t[i].normalize()).days
        r -= (USD_RATE.get(d.year, 3.0) / 100 + 0.025) * nights / 365.0
        rows.append(dict(statement=day, entry=t[i], exit=t[j], entry_late_min=(t[i] - t_in).total_seconds() / 60, ret=r))
    return pd.DataFrame(rows)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('d1')
    ap.add_argument('m5')
    ap.add_argument('--out', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'results'))
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    rawd, _ = BD.load_dir(a.d1, 'D1'); d1 = BD.to_generic(rawd)
    verdict, rows = {}, []

    port, daily, w = carry_trend(d1)
    mid = port.index[0] + (port.index[-1] - port.index[0]) / 2
    for per, x in [('full', port), ('first half', port.loc[:mid]), ('second half', port.loc[mid + pd.Timedelta(days=1):])]:
        rows.append(dict(candidate='(9) carry + trend (USDJPY, AUDJPY, NZDJPY)', period=per, start=str(x.index[0].date()),
                         end=str(x.index[-1].date()), **stats(x), time_in_market=float((w.loc[x.index].sum(axis=1) > 0).mean())))
    for p in daily.columns:
        rows.append(dict(candidate=f'(9 ref) {p} alone', period='full', start=str(daily.index[0].date()),
                         end=str(daily.index[-1].date()), **stats(daily[p])))
    s9 = {r['period']: r['sharpe'] for r in rows if r['candidate'].startswith('(9) ')}
    verdict['(9)'] = s9['full'] >= 0.3 and s9['first half'] > 0 and s9['second half'] > 0
    port.to_frame('ret').to_csv(os.path.join(a.out, 'round4_carry_daily.csv'), float_format='%.6f')

    rawm, _ = BD.load_dir(a.m5, 'M5'); m5 = BD.to_generic(rawm)
    ev = {}
    for sym in ['US500', 'US100', 'US30']:
        if sym not in m5:
            continue
        e = pre_fomc(m5[sym]); ev[sym] = e
        n = len(e); h = n // 2
        for per, x in [('all events', e), ('first half', e.iloc[:h]), ('second half', e.iloc[h:])]:
            r = x.ret
            rows.append(dict(candidate=('(10) ' if sym == 'US500' else '(10 ref) ') + f'pre-FOMC {sym}', period=per,
                             start=x.statement.iloc[0], end=x.statement.iloc[-1], events=len(x),
                             mean_bp=float(r.mean() * 1e4), t=float(r.mean() / r.std(ddof=1) * math.sqrt(len(r))),
                             win_rate=float((r > 0).mean()), max_entry_delay_min=float(x.entry_late_min.max())))
    e = [r for r in rows if r['candidate'] == '(10) pre-FOMC US500']
    if e:
        full = [r for r in e if r['period'] == 'all events'][0]
        verdict['(10)'] = full['mean_bp'] > 0 and full['t'] >= 2.0 and all(r['mean_bp'] > 0 for r in e if r['period'] != 'all events')
    pd.concat([v.assign(symbol=k) for k, v in ev.items()]).to_csv(os.path.join(a.out, 'round4_fomc_events.csv'), index=False,
                                                                 float_format='%.6f')
    tab = pd.DataFrame(rows)
    tab.to_csv(os.path.join(a.out, 'round4_summary.csv'), index=False, float_format='%.4f')
    pd.set_option('display.width', 250)
    print(tab.round(3).to_string(index=False))
    print('VERDICT (pre-registered criteria):', {k: ('PASS' if v else 'fail') for k, v in verdict.items()})


if __name__ == '__main__':
    main()
