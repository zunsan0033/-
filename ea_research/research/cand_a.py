"""Candidate A: intraday momentum, 'noise area' breakout (Zarattini, Aziz & Barbon 2024) on broker M5 bars.

  python -I cand_a.py <folder with *_M5*.csv> [--d1 <folder with *_D1*.csv>] [--out ../results]

Pre-registered rules (CANDIDATES.md):
  * session: US indices 09:30-16:00 New York; GER40 09:00-17:30 Frankfurt (same idea on the local cash session)
  * open = first bar open; prev close = previous session's last bar close
  * sigma(k) = mean over the previous 14 complete sessions of |close(k)/open - 1| at the same bar k
  * upper = max(open, prev close) * (1 + sigma(k)); lower = min(open, prev close) * (1 - sigma(k))
  * decisions every 30 minutes from 30 min after the open to 30 min before the close, on the bar close:
      flat  -> long if price > upper, short if price < lower
      long  -> exit if price < max(upper, VWAP); short -> exit if price > min(lower, VWAP); may re-enter at once
  * everything closed at the session close; nothing held overnight (no financing)
  * leverage = min(4, 2% / 14-day realised daily vol)
Costs per side: half the broker spread of that bar (instrument median if missing) + 0.5 bp slippage.
Server time = Europe/Athens rules (GMT+2 winter / GMT+3 summer, EU DST dates), as documented in the export.
"""
import argparse, math, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import pandas as pd

import broker_data as BD
import metrics as M

SESSIONS = {'US500': ('America/New_York', 9 * 60 + 30, 16 * 60),
            'US100': ('America/New_York', 9 * 60 + 30, 16 * 60),
            'US30': ('America/New_York', 9 * 60 + 30, 16 * 60),
            'GER40': ('Europe/Berlin', 9 * 60, 17 * 60 + 30)}
PUBLISHED = pd.Timestamp('2024-05-31')
SERVER_TZ = 'Europe/Athens'


def point_size(px):
    for dec in range(0, 6):
        if np.all(np.abs(px * 10 ** dec - np.round(px * 10 ** dec)) < 1e-6):
            return 10.0 ** -dec
    return 1e-5


def session_arrays(d, tz, s0, s1):
    """Pivot M5 bars into per-session arrays (rows = local dates, cols = bar index within the session)."""
    idx = d.index.tz_localize(SERVER_TZ, ambiguous='NaT', nonexistent='shift_forward').tz_convert(tz)
    x = d.copy()
    x.index = idx
    x = x[x.index.notna()]
    mins = x.index.hour * 60 + x.index.minute
    n = (s1 - s0) // 5
    m = (mins >= s0) & (mins < s1)
    x = x[m]
    k = ((mins[m] - s0) // 5).astype(int)
    date = pd.Index(x.index.date)
    frame = pd.DataFrame({'date': date, 'k': k, 'o': x.o.values, 'h': x.h.values, 'l': x.l.values, 'c': x.c.values,
                          'tv': x.tv.values, 'spr': x.spr.values})
    piv = {f: frame.pivot_table(index='date', columns='k', values=f, aggfunc='last').reindex(columns=range(n))
           for f in ['o', 'h', 'l', 'c', 'tv', 'spr']}
    # complete sessions: first and last bar present and at most 3 bars missing in between
    nmiss = piv['c'].isna().sum(axis=1)
    ok = piv['c'][0].notna() & piv['c'][n - 1].notna() & (nmiss <= 3)
    for f in piv:
        piv[f] = piv[f][ok]
    piv['c'] = piv['c'].ffill(axis=1)
    piv['h'] = piv['h'].fillna(piv['c'])
    piv['l'] = piv['l'].fillna(piv['c'])
    piv['tv'] = piv['tv'].fillna(0.0)
    piv['spr'] = piv['spr'].ffill(axis=1).fillna(0.0)
    return piv, n


def run(d, sym, lookback=14, target=0.02, max_lev=4.0, slip_bp=0.5, cost_scale=1.0, stop_pct=0.0):
    """Simulate the rules on complete sessions. stop_pct > 0 adds a protective stop at entry*(1 -/+ stop_pct),
    checked on every M5 bar after the entry bar (fill at the stop, or at the bar open if it gapped through)."""
    tz, s0, s1 = SESSIONS[sym]
    P, n = session_arrays(d, tz, s0, s1)
    dates = pd.to_datetime(P['c'].index)
    C = P['c'].values; O = P['o'][0].values
    Hh = P['h'].values; Ll = P['l'].values; Ob = P['o'].values
    typ = (Hh + Ll + C) / 3.0
    tv = np.maximum(P['tv'].values, 1.0)
    vwap = np.cumsum(typ * tv, axis=1) / np.cumsum(tv, axis=1)
    pt = point_size(np.concatenate([C[:, -1], O]))
    spr = P['spr'].values * pt
    med_spr_bp = np.nanmedian(np.where(spr > 0, spr / C, np.nan)) * 1e4
    spr_bp = np.where(spr > 0, spr / C * 1e4, med_spr_bp)
    move = np.abs(C / O[:, None] - 1.0)
    close_px = C[:, -1]
    dret = np.r_[np.nan, close_px[1:] / close_px[:-1] - 1]
    dec_k = [(t - s0) // 5 - 1 for t in range(s0 + 30, s1 - 29, 30)]     # bar whose close is the decision time
    dec_set = set(dec_k)
    daily = np.zeros(len(dates)); lev_used = np.zeros(len(dates)); ntr = np.zeros(len(dates), dtype=int)
    trades = []
    for i in range(lookback + 1, len(dates)):
        sigma = move[i - lookback:i].mean(axis=0)
        vol14 = np.nanstd(dret[i - lookback:i], ddof=1)          # previous 14 session-to-session returns
        if not np.isfinite(vol14) or vol14 <= 0:
            continue
        lev = min(max_lev, target / vol14)
        o = O[i]; pc = close_px[i - 1]
        ub = max(o, pc) * (1 + sigma); lb = min(o, pc) * (1 - sigma)
        pos, entry, pnl, ek = 0, 0.0, 0.0, -1

        def close_trade(k, px, reason):
            nonlocal pos, pnl
            cost = cost_scale * (spr_bp[i, k] / 2 + slip_bp) / 1e4
            r = (px / entry - 1) if pos == 1 else (1 - px / entry)
            pnl += r - cost
            trades.append((dates[i], pos, r - 2 * cost, ek, k, entry, px, reason))
            pos = 0

        for k in range(dec_k[0], n):
            if pos != 0 and stop_pct > 0 and k > ek:
                if pos == 1:
                    sp = entry * (1 - stop_pct)
                    if Ll[i, k] <= sp:
                        ob = Ob[i, k]
                        close_trade(k, ob if (np.isfinite(ob) and ob < sp) else sp, 'stop')
                else:
                    sp = entry * (1 + stop_pct)
                    if Hh[i, k] >= sp:
                        ob = Ob[i, k]
                        close_trade(k, ob if (np.isfinite(ob) and ob > sp) else sp, 'stop')
            if k not in dec_set:
                continue
            p = C[i, k]
            # state at each check: long above max(upper, VWAP), short below min(lower, VWAP), otherwise flat
            # (the exit rule of the paper is exactly the complement of this entry rule, so nothing churns)
            want = 1 if p > max(ub[k], vwap[i, k]) else (-1 if p < min(lb[k], vwap[i, k]) else 0)
            if want == pos:
                continue
            if pos != 0:
                close_trade(k, p, 'rule')
            if want != 0:
                cost = cost_scale * (spr_bp[i, k] / 2 + slip_bp) / 1e4
                entry, ek = p, k
                pnl -= cost; ntr[i] += 1
                pos = want
        if pos != 0:
            close_trade(n - 1, C[i, n - 1], 'close')
        daily[i] = lev * pnl
        lev_used[i] = lev
    out = pd.DataFrame({'ret': daily, 'lev': lev_used, 'trades': ntr}, index=dates).iloc[lookback + 1:]
    tr = pd.DataFrame(trades, columns=['date', 'side', 'ret', 'ek', 'xk', 'entry', 'exit', 'reason'])
    return out, tr, med_spr_bp


def summarize(r, tr, label):
    sm = M.summarize_daily(r)
    ts = M.summarize_trades(tr.ret.values) if len(tr) else {}
    return dict(period=label, start=str(r.index[0].date()), end=str(r.index[-1].date()), sharpe=sm['sharpe'],
                cagr=sm['cagr'], vol=sm['vol'], maxdd=sm['maxdd'], t_stat=sm['t_stat'],
                trades=ts.get('trades', 0), win_rate=ts.get('win_rate', np.nan),
                avg_trade_bp_unlevered=ts.get('avg', np.nan) * 1e4, days_traded=float((r != 0).mean()))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('folder')
    ap.add_argument('--d1', default=None, help='folder with D1 exports, to correlate/combine with the daily EA')
    ap.add_argument('--out', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'results'))
    a = ap.parse_args()
    raw, _ = BD.load_dir(a.folder, 'M5')
    data = BD.to_generic(raw)
    rows, daily, yearly = [], {}, []
    for sym in ['US500', 'US100', 'US30', 'GER40']:
        if sym not in data:
            continue
        res, tr, spr_bp = run(data[sym], sym)
        res0, _, _ = run(data[sym], sym, cost_scale=0.0)           # diagnostic only: no spread, no slippage
        daily[sym] = res.ret
        for label, lo, hi in [('full', None, None), ('pre-publication', None, PUBLISHED),
                              ('post-publication', PUBLISHED + pd.Timedelta(days=1), None)]:
            r = res.ret.loc[lo:hi]
            t = tr[(tr.date >= (lo if lo is not None else tr.date.min())) & (tr.date <= (hi if hi is not None else tr.date.max()))]
            row = summarize(r, t, label)
            row.update(index=sym, median_spread_bp=spr_bp, avg_leverage=float(res.lev.loc[lo:hi].mean()),
                       sharpe_zero_cost=M.summarize_daily(res0.ret.loc[lo:hi])['sharpe'])
            rows.append(row)
        for y, v in M.yearly_table(res.ret).ret.items():
            yearly.append(dict(index=sym, year=int(y), ret=v))
    summ = pd.DataFrame(rows)[['index', 'period', 'start', 'end', 'sharpe', 'cagr', 'vol', 'maxdd', 't_stat', 'trades',
                               'win_rate', 'avg_trade_bp_unlevered', 'days_traded', 'avg_leverage', 'median_spread_bp', 'sharpe_zero_cost']]
    D = pd.DataFrame(daily).fillna(0.0)
    os.makedirs(a.out, exist_ok=True)
    summ.to_csv(os.path.join(a.out, 'cand_a_summary.csv'), index=False, float_format='%.4f')
    pd.DataFrame(yearly).pivot(index='year', columns='index', values='ret').to_csv(os.path.join(a.out, 'cand_a_yearly.csv'), float_format='%.4f')
    D.to_csv(os.path.join(a.out, 'cand_a_daily_returns.csv'), float_format='%.6f')
    pd.set_option('display.width', 250)
    print(summ.round(3).to_string(index=False))
    print((pd.DataFrame(yearly).pivot(index='year', columns='index', values='ret') * 100).round(1).to_string())
    print('corr between indices:'); print(D.corr().round(2).to_string())
    if a.d1:
        import dbt as B, sim_final as F
        from cand_c import broker_cost_bp
        raw1, _ = BD.load_dir(a.d1, 'D1')
        d1 = BD.to_generic(raw1)
        sp_bp, _ = broker_cost_bp(d1['US500'])
        ea = F.simulate(B.prep(d1['US500']), cost_rt=(sp_bp + 1) / 1e4, rates=B.CCY_RATE['USD'], markup=0.025,
                        use_stop=True, stop_atr=3.0)[0].ret
        # broker D1 bars are dated by their server-date open (17:00 NY the evening before); the EA's return on bar t
        # is realised at 17:00 NY of date t, i.e. after the NY session of date t: align on the same calendar date
        both = pd.concat([ea.rename('EA_US500'), D['US500'].rename('A_US500'), D['US100'].rename('A_US100')], axis=1,
                         sort=True).fillna(0.0).loc[D.index[0]:]
        print('daily correlation:'); print(both.corr().round(2).to_string())
        combos = {'EA alone': both.EA_US500, 'A US500 alone': both.A_US500,
                  'EA + A(US500), equal risk': 0.5 * both.EA_US500 / both.EA_US500.std() + 0.5 * both.A_US500 / both.A_US500.std(),
                  'EA + A(US500+US100), equal risk': 0.5 * both.EA_US500 / both.EA_US500.std()
                  + 0.25 * both.A_US500 / both.A_US500.std() + 0.25 * both.A_US100 / both.A_US100.std()}
        crow = []
        for k, r in combos.items():
            r = r / r.std() * both.EA_US500.std() if 'equal risk' in k else r
            for label, lo, hi in [('full', None, None), ('post-publication', PUBLISHED + pd.Timedelta(days=1), None)]:
                sm = M.summarize_daily(r.loc[lo:hi])
                crow.append(dict(series=k, period=label, sharpe=sm['sharpe'], cagr=sm['cagr'], maxdd=sm['maxdd']))
        crow = pd.DataFrame(crow)
        crow.to_csv(os.path.join(a.out, 'cand_a_combo.csv'), index=False, float_format='%.4f')
        print(crow.round(3).to_string(index=False))


if __name__ == '__main__':
    main()
