"""Exact daily simulation of the EA logic (mirrors the MQL implementation).

Rules (evaluated on the completed daily bar t, executed at its close / next-bar open):
  A  "IBS"   : if IBS(t) < ibs_th  -> hold long for exactly one bar (re-armed if the signal repeats)
  B  "RSI2"  : enter if C(t) > SMA200(t) and RSI2(t) < rsi_th ; exit when C(t) > SMA5(t) or after max_hold_b bars
Each rule has its own slice of capital. Size per rule (fraction of equity, notional):
  sizing='fixed' : w = w_fixed
  sizing='risk'  : w = risk_per_rule / (stop_atr * ATR10(t) / C(t))   capped at w_cap
Protective stop (optional): stop = entry - stop_atr*ATR10(entry). Day t+1: if O<=stop exit at O, elif L<=stop exit at stop.
Costs: cost_rt per unit notional traded (half at entry, half at exit); long financing (rate+markup)/365 per night.
"""
import numpy as np
import pandas as pd
import dbt as B


def simulate(d, ibs_th=0.2, rsi_th=10.0, max_hold_b=10, sizing='fixed', w_fixed=0.5, risk_per_rule=0.01,
             stop_atr=3.0, use_stop=True, w_cap=2.0, cost_rt=4e-4, markup=0.025, rates=B.USD_RATE,
             rules=('A', 'B')):
    o, h, l, c = (d[k].values for k in ('o', 'h', 'l', 'c'))
    ibs, rsi2, sma200, sma5, atr = (d[k].values for k in ('ibs', 'rsi2', 'sma200', 'sma5', 'atr10'))
    nights = d['nights'].values
    yrs = d.index.year
    n = len(d)
    eq = np.ones(n)
    expo = np.zeros(n)
    # per-rule state: weight (notional fraction of equity at entry), entry price, stop, bars held
    st = {r: dict(w=0.0, entry=np.nan, stop=-np.inf, held=0) for r in rules}
    trades = []
    E = 1.0
    for t in range(n):
        # 1) mark-to-market from close t-1 to bar t (path: open -> low -> ... -> close), stops first
        if t > 0:
            pnl = 0.0
            fin_rate = (rates.get(yrs[t - 1], 2.0) / 100.0 + markup) / 365.0 * nights[t - 1]
            for r, s in st.items():
                if s['w'] <= 0:
                    continue
                prev = c[t - 1]
                stopped = False
                if use_stop and np.isfinite(s['stop']):
                    if o[t] <= s['stop']:
                        px, stopped = o[t], True
                    elif l[t] <= s['stop']:
                        px, stopped = s['stop'], True
                if stopped:
                    pnl += s['w'] * (px / prev - 1) - s['w'] * fin_rate - s['w'] * cost_rt / 2
                    trades.append(dict(rule=r, entry_date=s['entry_date'], exit_date=d.index[t], ret=s['tr'] + (px / prev - 1) - fin_rate - cost_rt / 2,
                                       days=s['held'] + 1, w=s['w'], reason='stop'))
                    s.update(w=0.0, entry=np.nan, stop=-np.inf, held=0)
                    s['just_stopped'] = True
                else:
                    pnl += s['w'] * (c[t] / prev - 1) - s['w'] * fin_rate
                    s['tr'] += (c[t] / prev - 1) - fin_rate
                    s['held'] += 1
            E *= (1 + pnl)
        # 2) decisions at close t
        if not np.isfinite(sma200[t]) or not np.isfinite(atr[t]) or not np.isfinite(rsi2[t]):
            eq[t] = E
            continue
        if sizing == 'fixed':
            w_new = w_fixed
        else:
            w_new = min(w_cap, risk_per_rule / (stop_atr * atr[t] / c[t]))
        want = {}
        if 'A' in st:
            want['A'] = ibs[t] < ibs_th
        if 'B' in st:
            sB = st['B']
            if sB['w'] > 0:
                want['B'] = not (c[t] > sma5[t] or sB['held'] >= max_hold_b)
            else:
                want['B'] = (c[t] > sma200[t]) and (rsi2[t] < rsi_th)
        cost_now = 0.0
        for r, s in st.items():
            s.pop('just_stopped', None)
            if s['w'] > 0 and not want[r]:          # exit at close t
                cost_now += s['w'] * cost_rt / 2
                trades.append(dict(rule=r, entry_date=s['entry_date'], exit_date=d.index[t], ret=s['tr'] - cost_rt / 2,
                                   days=s['held'], w=s['w'], reason='rule'))
                s.update(w=0.0, entry=np.nan, stop=-np.inf, held=0)
            elif s['w'] == 0 and want[r]:            # entry at close t
                cost_now += w_new * cost_rt / 2
                s.update(w=w_new, entry=c[t], stop=c[t] - stop_atr * atr[t], held=0, entry_date=d.index[t], tr=-cost_rt / 2)
            # A held for exactly one bar: if still wanted (signal repeated) keep it but refresh nothing (EA keeps position)
        E *= (1 - cost_now)
        eq[t] = E
        expo[t] = sum(s['w'] for s in st.values())
    out = pd.DataFrame({'eq': eq, 'expo': expo}, index=d.index)
    out['ret'] = out['eq'].pct_change().fillna(0.0)
    return out, pd.DataFrame(trades)
