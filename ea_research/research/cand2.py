"""Round-2 candidates (pre-registered in CANDIDATES.md on 2026-11-19), tested on the broker's M5 bars.

  python -I cand2.py <folder with *_M5*.csv> [--out ../results]

(1) IndexReversion execution: current (signal on the completed server-day bar, fill at the 01:05 reopen)
    vs pre-close (signal on the bar up to 23:55, fill at 23:55). Same rules A/B, stops, 0.5x notional per rule.
(2) 5-minute opening-range breakout (Zarattini & Aziz 2023) on the New York session.
(3) Last-half-hour momentum (Gao, Han, Li & Zhou 2018): sign(prev 16:00 -> 10:00) traded 15:30 -> 16:00
    (variant: only when 15:00 -> 15:30 has the same sign).
(4) Overnight holding: long 16:00 -> next session 09:30.
Costs: half the bar's spread + 0.5 bp slippage per side. Financing on nights held: USD policy rate + 2.5%.
"""
import argparse, math, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import pandas as pd

import broker_data as BD
import dbt as B
import metrics as M
from cand_a import session_arrays, point_size

SPLIT = pd.Timestamp('2021-11-18')
SLIP = 0.5            # bp per side
MARKUP = 0.025


def fin_rate(year):
    return (B.USD_RATE.get(year, 3.6) / 100.0 + MARKUP) / 365.0


def summarize(daily, trades, label, extra=None):
    out = []
    for per, lo, hi in [('full', None, None), ('first half', None, SPLIT), ('second half', SPLIT + pd.Timedelta(days=1), None)] + (extra or []):
        r = daily.loc[lo:hi]
        if len(r) < 50:
            continue
        sm = M.summarize_daily(r)
        t = trades[(trades.date >= (lo if lo is not None else trades.date.min())) & (trades.date <= (hi if hi is not None else trades.date.max()))] if len(trades) else trades
        ts = M.summarize_trades(t.ret.values) if len(t) else {}
        out.append(dict(candidate=label, period=per, start=str(r.index[0].date()), end=str(r.index[-1].date()),
                        sharpe=sm['sharpe'], cagr=sm['cagr'], vol=sm['vol'], maxdd=sm['maxdd'], t_stat=sm['t_stat'],
                        trades=ts.get('trades', 0), win_rate=ts.get('win_rate', np.nan), avg_trade_bp=ts.get('avg', np.nan) * 1e4))
    return out


# ------------------------------------------------------------------------------------------------------------
# (1) IndexReversion: current vs pre-close execution, simulated on M5 bars (server time)
# ------------------------------------------------------------------------------------------------------------
def ir_execution(d5, variant, w=0.5, ibs_th=0.2, rsi_th=10.0, ma_t=200, ma_x=5, max_hold=10, atr_n=10, k_atr=3.0):
    """d5: M5 bars indexed by naive server time (o,h,l,c,spr). Returns (daily returns by server date, trades)."""
    pt = point_size(np.concatenate([d5.c.values[-5000:], d5.o.values[-5000:]]))
    t = d5.index
    date = t.normalize()
    hm = t.hour * 60 + t.minute
    o, h, l, c = d5.o.values, d5.h.values, d5.l.values, d5.c.values
    spr_bp = np.where(d5.spr.values > 0, d5.spr.values * pt / c * 1e4, np.nan)
    spr_bp = pd.Series(spr_bp).fillna(pd.Series(spr_bp).median()).values
    days = pd.Index(date.unique())
    g = pd.Series(np.arange(len(t)), index=date)
    first = g.groupby(level=0).min().reindex(days).values
    last = g.groupby(level=0).max().reindex(days).values
    # index of the bar whose CLOSE is the 23:55 price (the 23:50 bar), else the last bar before 23:55
    pre = np.full(len(days), -1)
    reo = np.full(len(days), -1)                       # first bar starting at or after 01:05 (reopen fill = its open)
    for j in range(len(days)):
        a, b = first[j], last[j]
        m = hm[a:b + 1]
        cand = np.where(m <= 23 * 60 + 50)[0]
        pre[j] = a + cand[-1] if len(cand) else b
        cand2 = np.where(m >= 65)[0]
        reo[j] = a + cand2[0] if len(cand2) else a
    D = pd.DataFrame(index=days)
    D['O'] = o[first]; D['C'] = c[last]
    D['H'] = [h[a:b + 1].max() for a, b in zip(first, last)]
    D['L'] = [l[a:b + 1].min() for a, b in zip(first, last)]
    D['Cp'] = c[pre]
    D['Hp'] = [h[a:p + 1].max() for a, p in zip(first, pre)]
    D['Lp'] = [l[a:p + 1].min() for a, p in zip(first, pre)]
    D = D[D.H > D.L]                                     # drop flat filler days
    keep = np.isin(days, D.index)
    first, last, pre, reo = first[keep], last[keep], pre[keep], reo[keep]
    days = D.index
    n = len(days)
    C = D.C.values

    def indicators(j, use_pre):
        """indicators at decision for day j (completed closes before j, day j full or up to 23:55)."""
        cl = np.r_[C[max(0, j - 400):j], D.Cp.values[j] if use_pre else C[j]]
        hi = D.Hp.values[j] if use_pre else D.H.values[j]
        lo = D.Lp.values[j] if use_pre else D.L.values[j]
        c0 = cl[-1]
        rng = hi - lo
        ibs = (c0 - lo) / rng if rng > 0 else 0.5
        if len(cl) < ma_t + 30:
            return None
        smaT = cl[-ma_t:].mean(); smaX = cl[-ma_x:].mean()
        ch = np.diff(cl[-(10 * 2 + 30):])
        ag = np.clip(ch[:2], 0, None).mean(); al = np.clip(-ch[:2], 0, None).mean()
        for x in ch[2:]:
            ag = (ag + max(x, 0)) / 2; al = (al + max(-x, 0)) / 2
        rsi = 50.0 if (al <= 0 and ag <= 0) else (100.0 if al <= 0 else 100 - 100 / (1 + ag / al))
        # ATR(10): true ranges of the last 10 days, day j with its (partial) high/low
        H = np.r_[D.H.values[max(0, j - 10):j], hi]; L = np.r_[D.L.values[max(0, j - 10):j], lo]
        PC = np.r_[C[max(0, j - 11):j]]
        trs = [max(H[-k], PC[-k]) - min(L[-k], PC[-k]) for k in range(1, 11)]
        return dict(c0=c0, ibs=ibs, smaT=smaT, smaX=smaX, rsi=rsi, atr=float(np.mean(trs)))

    # Decision for signal day j happens at a "point" (a bar index) with a fill price:
    #   current  : point = first bar at/after 01:05 of day j+1, fill = its open  (stops checked up to point-1)
    #   pre-close: point = the 23:50 bar of day j,           fill = its close (stops checked up to point)
    pos = {'A': None, 'B': None}
    trades, daily = [], np.zeros(n)

    def day_of(k):
        return int(np.searchsorted(last, k))

    def book(rule, p, exit_px, exit_idx):
        cost = (spr_bp[p['k']] / 2 + SLIP + spr_bp[exit_idx] / 2 + SLIP) / 1e4
        jj, mark, xday = day_of(p['k']), p['px'], day_of(exit_idx)
        while jj < xday:                                   # mark to market at each server-day end
            daily[jj] += w * (C[jj] / mark - 1)
            nights = (days[jj + 1] - days[jj]).days
            daily[jj] -= w * fin_rate(days[jj].year) * nights   # financing for each rollover held
            mark = C[jj]
            jj += 1
        daily[xday] += w * (exit_px / mark - 1) - w * cost
        trades.append(dict(date=days[xday], rule=rule, entry_day=days[day_of(p['k'])], ret=exit_px / p['px'] - 1 - cost))

    for j in range(n):
        if variant == 'current':
            if j + 1 >= n:
                break
            point = reo[j + 1]; fill = o[point]; check_to = point - 1
        else:
            point = pre[j]; fill = c[point]; check_to = point
        # 1) protective stops on every bar since the last check, up to the decision point
        for rule in ('A', 'B'):
            p = pos[rule]
            if p is None or p['next_check'] > check_to:
                continue
            seg = np.arange(p['next_check'], check_to + 1)
            hit = seg[l[seg] <= p['stop']]
            if len(hit):
                k = int(hit[0])
                book(rule, p, o[k] if o[k] < p['stop'] else p['stop'], k)
                pos[rule] = None
            else:
                p['next_check'] = check_to + 1
        # 2) decision on the signal of day j
        ind = indicators(j, variant == 'pre')
        if ind is None:
            continue
        stop = ind['c0'] - k_atr * ind['atr']
        nxt = point if variant == 'current' else point + 1   # first bar whose range comes after the fill
        wantA = ind['ibs'] < ibs_th
        if pos['A'] is not None and not wantA:
            book('A', pos['A'], fill, point); pos['A'] = None
        elif pos['A'] is None and wantA and stop < fill:
            pos['A'] = dict(px=fill, k=point, stop=stop, next_check=nxt, held=0)
        if pos['B'] is not None:
            pos['B']['held'] += 1
            if ind['c0'] > ind['smaX'] or pos['B']['held'] >= max_hold:
                book('B', pos['B'], fill, point); pos['B'] = None
        elif ind['c0'] > ind['smaT'] and ind['rsi'] < rsi_th and stop < fill:
            pos['B'] = dict(px=fill, k=point, stop=stop, next_check=nxt, held=0)
    return pd.Series(daily, index=days), pd.DataFrame(trades)


# ------------------------------------------------------------------------------------------------------------
# New York session arrays shared by (2)-(4)
# ------------------------------------------------------------------------------------------------------------
def ny(d5):
    P, n = session_arrays(d5, 'America/New_York', 9 * 60 + 30, 16 * 60)
    dates = pd.to_datetime(P['c'].index)
    pt = point_size(np.concatenate([P['c'].values[:, -1], P['o'][0].values]))
    spr = P['spr'].values * pt
    C = P['c'].values
    med = np.nanmedian(np.where(spr > 0, spr / C, np.nan)) * 1e4
    sbp = np.where(spr > 0, spr / C * 1e4, med)
    return dict(dates=dates, O=P['o'].values, H=P['h'].values, L=P['l'].values, C=C, sbp=sbp, n=n)


def orb(S, risk=0.01, max_lev=4.0, target_r=10.0):
    dates, O, H, L, C, sbp, n = S['dates'], S['O'], S['H'], S['L'], S['C'], S['sbp'], S['n']
    daily = np.zeros(len(dates)); trades = []
    for i in range(len(dates)):
        o0, c0, h0, l0 = O[i, 0], C[i, 0], H[i, 0], L[i, 0]
        if not np.isfinite(o0) or c0 == o0:
            continue
        side = 1 if c0 > o0 else -1
        entry = O[i, 1] if np.isfinite(O[i, 1]) else c0
        stop = l0 if side == 1 else h0
        R = (entry - stop) * side
        if R <= 0:
            continue
        lev = min(max_lev, risk / (R / entry))
        target = entry + side * target_r * R
        exit_px, kx = C[i, n - 1], n - 1
        for k in range(1, n):
            ok = O[i, k] if np.isfinite(O[i, k]) else C[i, k - 1]
            if side == 1:
                if L[i, k] <= stop:
                    exit_px, kx = (ok if ok < stop else stop), k; break
                if H[i, k] >= target:
                    exit_px, kx = (ok if ok > target else target), k; break
            else:
                if H[i, k] >= stop:
                    exit_px, kx = (ok if ok > stop else stop), k; break
                if L[i, k] <= target:
                    exit_px, kx = (ok if ok < target else target), k; break
        cost = (sbp[i, 1] / 2 + SLIP + sbp[i, kx] / 2 + SLIP) / 1e4
        r = side * (exit_px / entry - 1) - cost
        daily[i] = lev * r
        trades.append(dict(date=dates[i], side=side, ret=r, lev=lev))
    return pd.Series(daily, index=dates), pd.DataFrame(trades)


def last_half_hour(S, variant='main'):
    dates, C, sbp, n = S['dates'], S['C'], S['sbp'], S['n']
    k10, k1500, k1530 = 5, 65, 71                      # bars whose close is at 10:00, 15:00, 15:30
    daily = np.zeros(len(dates)); trades = []
    for i in range(1, len(dates)):
        r1 = C[i, k10] / C[i - 1, n - 1] - 1
        if r1 == 0:
            continue
        side = 1 if r1 > 0 else -1
        if variant == 'agree':
            r12 = C[i, k1530] / C[i, k1500] - 1
            if np.sign(r12) != side:
                continue
        cost = (sbp[i, k1530] / 2 + SLIP + sbp[i, n - 1] / 2 + SLIP) / 1e4
        r = side * (C[i, n - 1] / C[i, k1530] - 1) - cost
        daily[i] = r
        trades.append(dict(date=dates[i], side=side, ret=r))
    return pd.Series(daily, index=dates), pd.DataFrame(trades)


def overnight(S):
    dates, O, C, sbp, n = S['dates'], S['O'], S['C'], S['sbp'], S['n']
    daily = np.zeros(len(dates)); trades = []
    for i in range(1, len(dates)):
        nights = (dates[i] - dates[i - 1]).days
        if nights > 4:                                   # data gap: do not count it as one overnight hold
            continue
        cost = (sbp[i - 1, n - 1] / 2 + SLIP + sbp[i, 0] / 2 + SLIP) / 1e4 + fin_rate(dates[i - 1].year) * nights
        r = O[i, 0] / C[i - 1, n - 1] - 1 - cost
        daily[i] = r
        trades.append(dict(date=dates[i], side=1, ret=r))
    return pd.Series(daily, index=dates), pd.DataFrame(trades)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('folder')
    ap.add_argument('--out', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'results'))
    a = ap.parse_args()
    raw, _ = BD.load_dir(a.folder, 'M5')
    data = BD.to_generic(raw)
    rows, series = [], {}
    pub = [('pre-publication', None, pd.Timestamp('2023-05-31')), ('post-publication', pd.Timestamp('2023-06-01'), None)]
    for sym in ['US500', 'US100']:
        d5 = data[sym]
        for var in ['current', 'pre']:
            r, t = ir_execution(d5, var)
            r = r.loc['2017-11-01':]                     # after 200 sessions of warm-up for both variants
            t = t[t.date >= '2017-11-01'] if len(t) else t
            series[f'IR_{sym}_{var}'] = r
            rows += summarize(r, t, f'(1) IR {sym} {var}')
        S = ny(d5)
        r, t = orb(S); series[f'ORB_{sym}'] = r; rows += summarize(r, t, f'(2) ORB {sym}', pub)
        r, t = last_half_hour(S); series[f'LHH_{sym}'] = r; rows += summarize(r, t, f'(3) last half hour {sym}')
        r, t = last_half_hour(S, 'agree'); series[f'LHHagree_{sym}'] = r; rows += summarize(r, t, f'(3b) last half hour agree {sym}')
        r, t = overnight(S); series[f'ON_{sym}'] = r; rows += summarize(r, t, f'(4) overnight {sym}')
    tab = pd.DataFrame(rows)
    os.makedirs(a.out, exist_ok=True)
    tab.to_csv(os.path.join(a.out, 'round2_summary.csv'), index=False, float_format='%.4f')
    pd.DataFrame(series).to_csv(os.path.join(a.out, 'round2_daily_returns.csv'), float_format='%.6f')
    pd.set_option('display.width', 250)
    print(tab.round(3).to_string(index=False))


if __name__ == '__main__':
    main()
