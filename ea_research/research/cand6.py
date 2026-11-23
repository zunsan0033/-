"""Round-6 candidates (13) and (14), pre-registered in CANDIDATES.md (commit 9058778): the EA's index reversion
rules, unchanged, on daily bars cut at the local cash close, built from the broker's M5 bars.

  python -I cand6.py <M5 folder> [<M5 folder> ...] [--d1 <D1 folder>] [--out ../results]

(13) JP225: Tokyo 09:00-15:00 (15:30 from 2024-11-05).   (14) GER40: Frankfurt 09:00-17:30.
A bar runs from the previous session's close to this session's close (moving averages, RSI and ATR use it);
IBS uses the cash session's high, low and close. Rules A and B at 0.5x equity each, stop 3 x ATR10 (as candidate C).
Costs: half the spread of the closing bar + 0.5 bp per side; financing = policy rate + 2.5%/yr per night.
Evaluation from one year after the first bar; halves split at the middle. Pass: net Sharpe >= 0.3, both halves > 0.
"""
import argparse, math, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import pandas as pd

import broker_data as BD
import dbt as B
import metrics as M
import sim_final as F
from cand_a import session_arrays, point_size, SERVER_TZ
from cand_c import broker_cost_bp

# symbol: (time zone, session start minute, [(first local date or None, session end minute)], financing currency)
SESS = {'JP225': ('Asia/Tokyo', 9 * 60, [(None, 15 * 60), ('2024-11-05', 15 * 60 + 30)], 'JPY'),
        'GER40': ('Europe/Berlin', 9 * 60, [(None, 17 * 60 + 30)], 'EUR')}
FINAL = dict(use_stop=True, stop_atr=3.0)
SLIP = 0.5


def local_bars(d, tz, s0, segments):
    """Daily frame indexed by local date: o/h/l/c of the bar from the previous close to this close, the
    cash-session high/low (hs/ls) and the spread (bp) of the session's last M5 bar."""
    parts = []
    for i, (first, s1) in enumerate(segments):
        piv, n = session_arrays(d, tz, s0, s1)
        dates = pd.to_datetime(piv['c'].index)
        lo = pd.Timestamp(first) if first else pd.Timestamp.min
        hi = pd.Timestamp(segments[i + 1][0]) if i + 1 < len(segments) else pd.Timestamp.max
        keep = (dates >= lo) & (dates < hi)
        part = pd.DataFrame({'os': piv['o'][0].values, 'hs': piv['h'].max(axis=1).values, 'ls': piv['l'].min(axis=1).values,
                             'c': piv['c'][n - 1].values, 'spr': piv['spr'][n - 1].values, 'end_min': s1}, index=dates)[keep]
        parts.append(part)
    x = pd.concat(parts).sort_index()
    # close time of each session on the server clock
    close_local = pd.DatetimeIndex(x.index.values + pd.to_timedelta(x.end_min.values, unit='m'))
    close_srv = close_local.tz_localize(tz).tz_convert(SERVER_TZ).tz_localize(None)
    t = d.index.values
    pos = np.searchsorted(t, close_srv.values, 'left')              # first M5 bar at or after the close
    o, h, l = d.o.values, d.h.values, d.l.values
    O, H, L = x.os.values.copy(), x.hs.values.copy(), x.ls.values.copy()
    for k in range(1, len(x)):
        a, b = pos[k - 1], pos[k]
        if b > a:
            O[k] = o[a]; H[k] = max(h[a:b].max(), x.c.values[k]); L[k] = min(l[a:b].min(), x.c.values[k])
    out = pd.DataFrame({'o': O, 'h': H, 'l': L, 'c': x.c.values, 'hs': x.hs.values, 'ls': x.ls.values}, index=x.index)
    pt = point_size(np.concatenate([d.c.values[-3000:], d.o.values[-3000:]]))
    sbp = np.where(x.spr.values > 0, x.spr.values * pt / x.c.values * 1e4, np.nan)
    out['sbp'] = np.where(np.isfinite(sbp), sbp, np.nanmedian(sbp))
    return out


def run_rules(d, ccy, side_cost, rules=('A', 'B')):
    """Gross simulation (financing and stops inside), then the costs of each trade on its entry and exit days."""
    eq, tr = F.simulate(d, cost_rt=0.0, rates=B.CCY_RATE[ccy], markup=0.025, rules=rules, **FINAL)
    cost = np.zeros(len(d))
    tr = tr.copy()
    if len(tr):
        e, x = pd.DatetimeIndex(tr.entry_date), pd.DatetimeIndex(tr.exit_date)
        ce, cx = side_cost.reindex(e).values, side_cost.reindex(x).values
        np.add.at(cost, d.index.get_indexer(e), tr.w.values * ce)
        np.add.at(cost, d.index.get_indexer(x), tr.w.values * cx)
        tr['ret_net'] = tr.ret.values - ce - cx
    return eq.ret - pd.Series(cost, index=d.index), tr


def block(name, r, tr, start):
    r = r.loc[start:]
    mid = r.index[0] + (r.index[-1] - r.index[0]) / 2
    rows = []
    for per, x in [('full', r), ('first half', r.loc[:mid]), ('second half', r.loc[mid + pd.Timedelta(days=1):])]:
        sm = M.summarize_daily(x)
        t = tr[(pd.to_datetime(tr.entry_date) >= x.index[0]) & (pd.to_datetime(tr.entry_date) <= x.index[-1])] if len(tr) else tr
        rows.append(dict(candidate=name, period=per, start=str(x.index[0].date()), end=str(x.index[-1].date()),
                         sharpe=sm['sharpe'], cagr=sm['cagr'], maxdd=sm['maxdd'], t_stat=sm['t_stat'], trades=len(t),
                         win_rate=float((t.ret_net > 0).mean()) if len(t) else np.nan,
                         avg_trade_bp=float(t.ret_net.mean() * 1e4) if len(t) else np.nan))
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('m5', nargs='+')
    ap.add_argument('--d1', default=None)
    ap.add_argument('--out', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'results'))
    a = ap.parse_args()
    m5 = {}
    for folder in a.m5:
        raw, _ = BD.load_dir(folder, 'M5')
        m5.update(BD.to_generic(raw))
    d1 = {}
    if a.d1:
        raw, _ = BD.load_dir(a.d1, 'D1'); d1 = BD.to_generic(raw)
    rows, daily, verdict = [], {}, {}
    for num, sym in [('(13)', 'JP225'), ('(14)', 'GER40')]:
        if sym not in m5:
            print('no M5 data for', sym); continue
        tz, s0, segs, ccy = SESS[sym]
        lb = local_bars(m5[sym], tz, s0, segs)
        d = B.prep(lb)
        ibs24 = d['ibs'].copy()
        rng = lb.hs - lb.ls
        d['ibs'] = np.where(rng > 0, (lb.c - lb.ls) / rng.replace(0, np.nan), 0.5)
        side = (lb.sbp / 2 + SLIP) / 1e4
        start = d.index[0] + pd.Timedelta(days=366)
        print(f'{sym}: {len(d)} local bars {d.index[0].date()}..{d.index[-1].date()}, evaluation from {start.date()}, '
              f'closing-bar spread median {lb.sbp.median():.2f} bp (2017: {lb.sbp.loc["2017"].median():.2f}, 2026: {lb.sbp.loc["2026"].median():.2f}), '
              f'share of days with IBS < 0.2: {float((d.ibs < 0.2).mean()):.1%}')
        r, tr = run_rules(d, ccy, side)
        name = f'{num} {sym} reversion at the local close (A+B)'
        rr = block(name, r, tr, start); rows += rr; daily[name] = r.loc[start:]
        s = {x['period']: x['sharpe'] for x in rr}
        verdict[num] = s['full'] >= 0.3 and s['first half'] > 0 and s['second half'] > 0
        # self-check of the cost bookkeeping: a constant cost applied both ways must agree
        c0 = float(2 * side.median())
        eq_in, _ = F.simulate(d, cost_rt=c0, rates=B.CCY_RATE[ccy], markup=0.025, **FINAL)
        r_out, _ = run_rules(d, ccy, pd.Series(c0 / 2, index=d.index))
        print(f'   cost check (constant cost, inside the simulator vs applied after): Sharpe '
              f'{M.summarize_daily(eq_in.ret.loc[start:])["sharpe"]:.3f} vs {M.summarize_daily(r_out.loc[start:])["sharpe"]:.3f}')
        # references (not part of the verdict)
        for lab, rules in [('rule A only', ('A',)), ('rule B only', ('B',))]:
            r1, t1 = run_rules(d, ccy, side, rules=rules)
            rows += block(f'({num[1:-1]} ref) {sym} local close, {lab}', r1, t1, start)
            daily[f'{sym} local {lab}'] = r1.loc[start:]
        d24 = d.copy(); d24['ibs'] = ibs24
        r2, t2 = run_rules(d24, ccy, side)
        rows += block(f'({num[1:-1]} ref) {sym} local close, IBS from the 24-hour range (A+B)', r2, t2, start)
        if sym in d1:
            ds = B.prep(d1[sym])
            cs = (broker_cost_bp(d1[sym])[0] + 1.0) / 1e4
            eq3, t3 = F.simulate(ds, cost_rt=cs, rates=B.CCY_RATE[ccy], markup=0.025, **FINAL)
            t3 = t3.assign(ret_net=t3.ret)
            rows += block(f'({num[1:-1]} ref) {sym} server-day bars (A+B)', eq3.ret, t3, start)
            daily[f'{sym} server-day (A+B)'] = eq3.ret.loc[start:]
    # correlation with the US reversion on server-day bars (reference)
    if d1:
        for us in ['US500', 'US100']:
            if us in d1:
                ds = B.prep(d1[us])
                cs = (broker_cost_bp(d1[us])[0] + 1.0) / 1e4
                eq, _ = F.simulate(ds, cost_rt=cs, rates=B.USD_RATE, markup=0.025, **FINAL)
                daily[f'{us} server-day (A+B)'] = eq.ret
    D = pd.DataFrame(daily)
    tab = pd.DataFrame(rows)
    os.makedirs(a.out, exist_ok=True)
    tab.to_csv(os.path.join(a.out, 'round6_summary.csv'), index=False, float_format='%.4f')
    D.to_csv(os.path.join(a.out, 'round6_daily_returns.csv'), float_format='%.6f')
    pd.set_option('display.width', 250)
    print(tab.round(3).to_string(index=False))
    main_cols = [c for c in D.columns if c.startswith('(1')]
    us_cols = [c for c in D.columns if c.startswith('US')]
    if main_cols and us_cols:
        first = min(D[c].first_valid_index() for c in main_cols)
        X = D.loc[first:].fillna(0.0)
        W = X.resample('W-FRI').sum()
        print('correlation of weekly returns (reference):')
        print(W.corr().loc[[c for c in D.columns if not c.startswith('US')], us_cols].round(2).to_string())
        print('correlation of same-date daily returns (reference):')
        print(X.corr().loc[main_cols, us_cols].round(2).to_string())
    print('VERDICT (pre-registered criteria):', {k: ('PASS' if v else 'fail') for k, v in verdict.items()})


if __name__ == '__main__':
    main()
