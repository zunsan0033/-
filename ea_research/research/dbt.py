"""Daily-bar research engine for index CFD strategies.

Conventions (no look-ahead):
  * A signal computed on bar t uses only o/h/l/c of bars <= t.
  * pos[t] is the position held from the close of t to the close of t+1 (entered/adjusted at close t).
  * Strategy return on t+1 = pos[t] * (c[t+1]/c[t]-1) - trading costs - financing.
  * Trading cost: cost_rt/2 per unit of |pos[t]-pos[t-1]| charged on bar t (fraction of equity).
  * Financing on long CFD: (benchmark rate + markup - div_credit)/365 per calendar night held.
"""
import numpy as np
import pandas as pd

# Approximate annual-average effective Fed Funds rate (%), used for CFD financing.
USD_RATE = {1999: 4.97, 2000: 6.24, 2001: 3.88, 2002: 1.67, 2003: 1.13, 2004: 1.35, 2005: 3.22, 2006: 4.97,
            2007: 5.02, 2008: 1.92, 2009: 0.16, 2010: 0.18, 2011: 0.10, 2012: 0.14, 2013: 0.11, 2014: 0.09,
            2015: 0.13, 2016: 0.40, 2017: 1.00, 2018: 1.83, 2019: 2.16, 2020: 0.38, 2021: 0.08, 2022: 1.68,
            2023: 5.03, 2024: 5.14, 2025: 4.20, 2026: 3.60}


# Approximate annual-average policy rates (%) by currency, for CFD financing / FX carry models.
# Sources: central-bank decision histories (ECB deposit rate, BoE Bank Rate, BoJ, SNB, BoC, RBA, RBNZ),
# averaged by calendar year from memory; 2026 values are assumptions. Good enough for cost modelling only.
CCY_RATE = {
    'USD': USD_RATE,
    'EUR': {2013: 0.0, 2014: -0.05, 2015: -0.2, 2016: -0.37, 2017: -0.4, 2018: -0.4, 2019: -0.43, 2020: -0.5,
            2021: -0.5, 2022: 0.07, 2023: 3.3, 2024: 3.7, 2025: 2.3, 2026: 2.0},
    'GBP': {2013: 0.5, 2014: 0.5, 2015: 0.5, 2016: 0.4, 2017: 0.29, 2018: 0.6, 2019: 0.75, 2020: 0.23, 2021: 0.1,
            2022: 1.5, 2023: 4.7, 2024: 5.1, 2025: 4.2, 2026: 3.6},
    'JPY': {2013: 0.05, 2014: 0.05, 2015: 0.05, 2016: -0.1, 2017: -0.1, 2018: -0.1, 2019: -0.1, 2020: -0.1,
            2021: -0.1, 2022: -0.1, 2023: -0.1, 2024: 0.1, 2025: 0.48, 2026: 0.75},
    'CHF': {2013: 0.0, 2014: 0.0, 2015: -0.75, 2016: -0.75, 2017: -0.75, 2018: -0.75, 2019: -0.75, 2020: -0.75,
            2021: -0.75, 2022: -0.2, 2023: 1.55, 2024: 1.25, 2025: 0.15, 2026: 0.0},
    'CAD': {2013: 1.0, 2014: 1.0, 2015: 0.7, 2016: 0.5, 2017: 0.7, 2018: 1.4, 2019: 1.75, 2020: 0.55, 2021: 0.25,
            2022: 2.0, 2023: 4.8, 2024: 4.4, 2025: 2.7, 2026: 2.25},
    'AUD': {2013: 2.8, 2014: 2.5, 2015: 2.1, 2016: 1.7, 2017: 1.5, 2018: 1.5, 2019: 1.1, 2020: 0.35, 2021: 0.1,
            2022: 1.3, 2023: 3.9, 2024: 4.35, 2025: 3.9, 2026: 3.6},
    'NZD': {2013: 2.5, 2014: 3.1, 2015: 3.0, 2016: 2.2, 2017: 1.75, 2018: 1.75, 2019: 1.4, 2020: 0.4, 2021: 0.35,
            2022: 2.4, 2023: 5.2, 2024: 5.2, 2025: 3.3, 2026: 2.25},
}


def prep(df):
    """df: columns o,h,l,c (daily). Adds indicators."""
    d = df[['o', 'h', 'l', 'c']].copy().astype(float)
    rng = (d.h - d.l)
    d['ibs'] = np.where(rng > 0, (d.c - d.l) / rng.replace(0, np.nan), 0.5)
    d['ret'] = d.c.pct_change()
    d['ret_fwd'] = d.ret.shift(-1)                    # c[t+1]/c[t]-1 (only used for evaluation)
    d['sma200'] = d.c.rolling(200).mean()
    d['sma5'] = d.c.rolling(5).mean()
    d['rsi2'] = rsi(d.c, 2)
    tr = pd.concat([d.h - d.l, (d.h - d.c.shift()).abs(), (d.l - d.c.shift()).abs()], axis=1).max(axis=1)
    d['atr10'] = tr.rolling(10).mean()
    d['vol20'] = d.ret.rolling(20).std()
    d['low7'] = d.c.rolling(7).min()
    d['high7'] = d.c.rolling(7).max()
    d['prev_h'] = d.h.shift()
    # trading-day-of-month index: +1,+2,.. from month start; -1,-2,.. from month end (computed per calendar month)
    ym = d.index.year * 100 + d.index.month
    d['tdm'] = d.groupby(ym).cumcount() + 1
    d['tdm_rev'] = -(d.groupby(ym).cumcount(ascending=False) + 1)
    d['nights'] = pd.Series(d.index, index=d.index).diff().shift(-1).dt.days.fillna(1).astype(int)  # nights t->t+1
    return d


def rsi(c, n):
    """Wilder RSI."""
    delta = c.diff()
    up = delta.clip(lower=0)
    dn = -delta.clip(upper=0)
    au = up.ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    ad = dn.ewm(alpha=1 / n, adjust=False, min_periods=n).mean()
    rs = au / ad.replace(0, np.nan)
    out = 100 - 100 / (1 + rs)
    return out.fillna(100.0).where(ad.notna())


def run(d, pos, cost_rt=4e-4, markup=0.025, div_credit=0.0, rates=USD_RATE, short_markup=0.025):
    """Return DataFrame with daily strategy returns (indexed by the day the return is realised)."""
    pos = pd.Series(pos, index=d.index).fillna(0.0).astype(float)
    turn = (pos - pos.shift().fillna(0.0)).abs()
    cost = turn * cost_rt / 2.0                               # charged at close t
    yr = d.index.year
    r_bench = np.array([rates.get(y, 2.0) for y in yr]) / 100.0
    fin_long = (r_bench + markup - div_credit) / 365.0
    fin_short = -(r_bench - short_markup - div_credit) / 365.0   # short receives rate - markup (may pay)
    fin = np.where(pos > 0, pos * fin_long, np.where(pos < 0, -pos * fin_short, 0.0)) * d['nights'].values
    gross = pos * d['ret_fwd']                                 # realised on t+1
    net_t = gross - fin                                        # attribute to t+1
    out = pd.DataFrame(index=d.index)
    out['gross'] = gross.shift(1)
    out['fin'] = pd.Series(fin, index=d.index).shift(1)
    out['cost'] = cost
    out['net'] = (net_t.shift(1).fillna(0.0) - cost.fillna(0.0))
    out['pos'] = pos.shift(1).fillna(0.0)                     # position held during the return day
    return out.iloc[1:]


def trades_from_pos(d, pos, cost_rt=4e-4, markup=0.025, div_credit=0.0, rates=USD_RATE):
    """Per-trade net returns for a position series with values in {-1,0,1} (simple additive within trade)."""
    pos = pd.Series(pos, index=d.index).fillna(0.0).values
    retf = d['ret_fwd'].values
    nights = d['nights'].values
    yrs = d.index.year
    trades = []
    cur = None
    for t in range(len(pos)):
        p_prev = pos[t - 1] if t > 0 else 0.0
        p = pos[t]
        if cur is not None and p != p_prev:           # close existing trade at close t
            cur['ret'] -= cost_rt / 2
            cur['exit'] = d.index[t]
            trades.append(cur)
            cur = None
        if p != 0 and p != p_prev:                     # open new trade at close t
            cur = {'entry': d.index[t], 'side': p, 'ret': -cost_rt / 2, 'days': 0}
        if cur is not None and t + 1 < len(pos) and np.isfinite(retf[t]):
            rb = rates.get(yrs[t], 2.0) / 100.0
            fin = ((rb + markup - div_credit) if p > 0 else -(rb - markup - div_credit)) / 365.0 * nights[t]
            cur['ret'] += p * retf[t] - fin
            cur['days'] += 1
    return pd.DataFrame(trades)


def split(res, start=None, end=None):
    return res.loc[start:end]
