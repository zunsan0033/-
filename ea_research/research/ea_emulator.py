"""Literal Python transcription of IndexReversion_EA.mq5 decision code (OnTick/Evaluate), run bar by bar.

Execution model: decisions at the first tick of bar k use completed bars < k; orders fill at open[k]
(+/- half cost); broker stop fills at the stop (or open if gapped). Fixed 'notional' sizing per rule for comparability.
"""
import numpy as np, pandas as pd

def sma(c, i, n):   # series-order helper translated to forward index: bars i-n+1..i
    return c[i - n + 1:i + 1].mean()

def atr(h, l, c, i, n):
    pc = c[i - n:i]; hh = h[i - n + 1:i + 1]; ll = l[i - n + 1:i + 1]
    return (np.maximum(hh, pc) - np.minimum(ll, pc)).mean()

def rsi_wilder(c, i, n, window):
    lo = max(1, i - window + 1)
    ch = np.diff(c[lo - 1:i + 1])
    ag = np.clip(ch[:n], 0, None).sum() / n; al = np.clip(-ch[:n], 0, None).sum() / n
    for x in ch[n:]:
        ag = (ag * (n - 1) + max(x, 0)) / n; al = (al * (n - 1) + max(-x, 0)) / n
    if al <= 0: return 50.0 if ag <= 0 else 100.0
    return 100 - 100 / (1 + ag / al)

def run(df, ibs_th=0.2, rsi_n=2, rsi_th=10.0, ma_t=200, ma_x=5, max_hold=10, atr_n=10, k=3.0, w=0.5, cost_rt=4e-4,
        window=350, rates=None, markup=0.025):
    o, h, l, c = (df[x].values for x in 'ohlc')
    idx = df.index; n = len(df)
    pos = {'A': None, 'B': None}           # dict(entry_px, sl, open_bar)
    E = 1.0; eq = np.ones(n); trades = []
    for k_bar in range(1, n):
        # intrabar of previous bar k_bar-1 already processed; now mark positions through bar k_bar-1 -> done below
        i = k_bar - 1                      # last completed bar
        # ---- decisions at the first tick of bar k_bar (fill at o[k_bar]) ----
        if i >= ma_t + 10 * rsi_n + 30:
            rng = h[i] - l[i]; ibs = (c[i] - l[i]) / rng if rng > 0 else 0.5
            smaT = sma(c, i, ma_t); smaX = sma(c, i, ma_x); r = rsi_wilder(c, i, rsi_n, window); a = atr(h, l, c, i, atr_n)
            stop = c[i] - k * a
            px = o[k_bar]
            wantA = ibs < ibs_th
            if pos['A'] is not None and not wantA:
                trades.append(('A', pos['A']['open_bar'], k_bar, px / pos['A']['entry'] - 1 - cost_rt)); pos['A'] = None
            elif pos['A'] is None and wantA and stop < px:
                pos['A'] = dict(entry=px, sl=stop, open_bar=k_bar)
            if pos['B'] is not None:
                held = i - pos['B']['open_bar'] + 1
                if c[i] > smaX or held >= max_hold:
                    trades.append(('B', pos['B']['open_bar'], k_bar, px / pos['B']['entry'] - 1 - cost_rt)); pos['B'] = None
            elif c[i] > smaT and r < rsi_th and stop < px:
                pos['B'] = dict(entry=px, sl=stop, open_bar=k_bar)
        # ---- intrabar of bar k_bar: broker stops ----
        for rname in ('A', 'B'):
            p = pos[rname]
            if p is not None and l[k_bar] <= p['sl']:
                fill = min(o[k_bar], p['sl']) if o[k_bar] <= p['sl'] else p['sl']
                trades.append((rname, p['open_bar'], k_bar + 0.5, fill / p['entry'] - 1 - cost_rt)); pos[rname] = None
    t = pd.DataFrame(trades, columns=['rule', 'open_bar', 'close_bar', 'ret'])
    t['entry_date'] = idx[t.open_bar.astype(int)]
    return t
