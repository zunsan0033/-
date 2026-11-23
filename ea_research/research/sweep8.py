"""Round 8 (pre-registered in CANDIDATES.md, commit e14564a): a two-stage broad search on the broker's bars.

  python -I sweep8.py --d1 <D1 folder> --m5 <M5 folder> [<M5 folder> ...] --stage discovery [--out ../results]
  python -I sweep8.py --d1 ... --m5 ... --stage holdout [--out ../results]

Stage "discovery" evaluates every rule on the discovery period only and writes round8_discovery.csv and
round8_nominations.csv (rules kept by the pre-registered criteria). Stage "holdout" evaluates only the rules
listed in round8_nominations.csv on the holdout period and writes round8_holdout.csv. Stage "gross" is a diagnostic on the
discovery period only: the same rules before spread and slippage (financing kept), written to
round8_discovery_gross.csv.

Groups:  A  windows of the day after a weak close (US500, US100)     A' the same windows every day
         B  momentum / reversal after an announcement-time shock    C  lower-turnover intraday momentum
         D  calendar effects (D1)                                    E  daily reversal outside equity indices (D1)
         F  FX cross mean reversion (D1)                             G  index-pair spreads (D1)
         H  session-to-session momentum / reversal
Costs and financing as pre-registered: M5 groups half the bar's spread + 0.5 bp per side and no swap inside a
server day; D1 groups |change in position| x (median spread bp + 1 bp) / 2 and financing per calendar night.
"""
import argparse, math, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import pandas as pd

import broker_data as BD
import dbt as B
from cand_a import run as im_run, point_size, SERVER_TZ
from cand_c import broker_cost_bp
from im_emulator import is_nyse_holiday

PERIODS = {'discovery': {'D1': ('2014-07-01', '2020-12-31'), 'M5': ('2017-02-01', '2021-12-31')},
           'holdout': {'D1': ('2021-01-01', '2026-12-31'), 'M5': ('2022-01-01', '2026-12-31')}}
NY, TOKYO, BERLIN = 'America/New_York', 'Asia/Tokyo', 'Europe/Berlin'
IDX_CCY = {'US500': 'USD', 'US100': 'USD', 'US30': 'USD', 'US2000': 'USD', 'GER40': 'EUR', 'EU50': 'EUR', 'UK100': 'GBP',
           'JP225': 'JPY'}
FX = {'EURUSD': ('EUR', 'USD'), 'USDJPY': ('USD', 'JPY'), 'GBPUSD': ('GBP', 'USD'), 'AUDUSD': ('AUD', 'USD'),
      'USDCAD': ('USD', 'CAD'), 'USDCHF': ('USD', 'CHF'), 'NZDUSD': ('NZD', 'USD')}
MIN_TRADES = 30


# ------------------------------------------------------------------ shared
def rate(ccy, y):
    if ccy == 'USD':
        return B.USD_RATE.get(y, 3.0) / 100
    t = B.CCY_RATE[ccy]
    return t.get(y, t[max(t)]) / 100


def cfd_fin(ccy):
    return (lambda y: -(rate(ccy, y) + 0.025)), (lambda y: rate(ccy, y) - 0.025)


def fx_fin(base, quote):
    return (lambda y: rate(base, y) - rate(quote, y) - 0.01), (lambda y: rate(quote, y) - rate(base, y) - 0.01)


def daily_net(ret, pos, cost_rt_bp, fin_long, fin_short):
    """ret[t]: return of bar t (close t-1 -> close t). pos[t]: position decided at close t, held to close t+1.
    fin_long / fin_short: year -> annual rate earned (+) or paid (-) per unit of long / short notional."""
    held = pos.shift(1).fillna(0.0)
    nights = pd.Series(ret.index, index=ret.index).diff().dt.days.fillna(1).values
    yrs = ret.index.year
    fl = np.array([fin_long(y) for y in yrs]); fs = np.array([fin_short(y) for y in yrs])
    fin = np.where(held > 0, held * fl, np.where(held < 0, -held * fs, 0.0)) * nights / 365.0
    turn = pos.diff().abs(); turn.iloc[0] = abs(pos.iloc[0])
    return (held * ret).fillna(0.0) + fin - turn * cost_rt_bp / 2 / 1e4


def entries_of(pos):
    """True on the bars where a new position starts (from flat, or a flip)."""
    prev = pos.shift(1).fillna(0.0)
    return (pos != 0) & (np.sign(pos) != np.sign(prev))


def welch_t(a, b):
    a, b = pd.Series(a).dropna(), pd.Series(b).dropna()
    if len(a) < 5 or len(b) < 5:
        return float('nan')
    return float((a.mean() - b.mean()) / math.sqrt(a.var(ddof=1) / len(a) + b.var(ddof=1) / len(b)))


def stat(x):
    x = pd.Series(x).dropna()
    if len(x) < 60 or x.std(ddof=1) == 0:
        return float('nan'), float('nan')
    return float(x.mean() / x.std(ddof=1) * math.sqrt(252)), float(x.mean() / x.std(ddof=1) * math.sqrt(len(x)))


def evaluate(rec, lo, hi):
    r = rec['r'].loc[lo:hi]
    out = dict(group=rec['group'], id=rec['id'], inst=rec['inst'], rule=rec['rule'], days=len(r))
    if len(r) < 120:
        return dict(out, sharpe=float('nan'), t=float('nan'))
    mid = r.index[0] + (r.index[-1] - r.index[0]) / 2
    a, b = r.loc[:mid], r.loc[mid + pd.Timedelta(days=1):]
    sh, t = stat(r)
    out.update(start=str(r.index[0].date()), end=str(r.index[-1].date()), sharpe=sh, t=t, mean_bp=float(r.mean() * 1e4),
               h1_bp=float(a.mean() * 1e4), h2_bp=float(b.mean() * 1e4), trades=int(rec['entry'].loc[lo:hi].sum()),
               per_trade_bp=float(r.sum() / max(int(rec['entry'].loc[lo:hi].sum()), 1) * 1e4))
    if rec.get('flag') is not None:                      # long-only calendar rule: rule days against the other days
        f, x = rec['flag'].loc[lo:hi], rec['ret'].loc[lo:hi]
        out['excess_t'] = welch_t(x[f], x[~f]); out['excess_bp'] = float((x[f].mean() - x[~f].mean()) * 1e4)
    for key in ('bench', 'incumbent'):
        if rec.get(key) is not None:
            out[key + '_sharpe'] = stat(rec[key].loc[lo:hi])[0]
    return out


def bb_positions(x, L, z):
    """Fade closes beyond mean +/- z*sd of the last L closes; exit at the mean or after 2L bars; no entry on an exit bar."""
    v = x.values
    m = x.rolling(L).mean().values; s = x.rolling(L).std(ddof=1).values
    pos = np.zeros(len(v)); cur, held = 0, 0
    for t in range(len(v)):
        if not np.isfinite(s[t]) or s[t] <= 0:
            pos[t] = cur
            continue
        if cur != 0:
            held += 1
            if (cur > 0 and v[t] >= m[t]) or (cur < 0 and v[t] <= m[t]) or held >= 2 * L:
                cur = 0
        elif v[t] < m[t] - z * s[t]:
            cur, held = 1, 0
        elif v[t] > m[t] + z * s[t]:
            cur, held = -1, 0
        pos[t] = cur
    return pd.Series(pos, index=x.index)


def spread_bp(d):
    v = broker_cost_bp(d)[0]
    if not np.isfinite(v):
        pt = point_size(pd.concat([d.o, d.h, d.l, d.c]).values[-4000:])
        s = d.spr[d.spr > 0]
        v = float((s * pt / d.c.reindex(s.index)).median() * 1e4) if len(s) else float('nan')
    return v


# ------------------------------------------------------------------ D1 groups
def third_friday(y, m):
    first = pd.Timestamp(y, m, 1)
    return first + pd.Timedelta(days=(4 - first.dayofweek) % 7 + 14)


def group_d(d1, recs):
    for sym, ccy in IDX_CCY.items():
        if sym not in d1:
            continue
        d = B.prep(d1[sym]); idx = d.index
        tf = pd.DatetimeIndex([third_friday(t.year, t.month) for t in idx])
        delta = np.asarray((idx - tf).days)
        ym = np.asarray(idx.year * 100 + idx.month)
        prev_last = d.c.groupby(ym).last().shift(1)
        sel = (d.tdm_rev == -5).values
        refc = pd.Series(d.c.values[sel], index=ym[sel])
        refc = refc[~refc.index.duplicated()]
        mtd = (refc / prev_last - 1).reindex(ym).values
        last4 = (d.tdm_rev >= -4).values
        flags = {f'weekday {k} only (0 = Monday)': np.asarray(idx.dayofweek == k) for k in range(5)}
        flags['last day and first 3 days of the month'] = ((d.tdm_rev == -1) | (d.tdm <= 3)).values
        flags['first day of the month'] = (d.tdm == 1).values
        flags['last 4 days of the month'] = last4
        flags['last 4 days, month down so far'] = last4 & (mtd < 0)
        flags['last 4 days, month up so far'] = last4 & (mtd >= 0)
        flags['option-expiry week'] = (delta >= -4) & (delta <= 0)
        flags['week after option expiry'] = (delta >= 3) & (delta <= 7)
        if ccy == 'USD':
            key = lambda t: t.year * 10000 + t.month * 100 + t.day
            flags['day before a US market holiday'] = np.array(
                [(not is_nyse_holiday(key(t))) and is_nyse_holiday(key(t + pd.offsets.BDay(1))) for t in idx])
        fl, fs = cfd_fin(ccy)
        cost = spread_bp(d1[sym]) + 1.0
        for name, f in flags.items():
            f = pd.Series(np.asarray(f, dtype=bool), index=idx)
            pos = f.shift(-1, fill_value=False).astype(float)          # held while the flagged bar forms
            recs.append(dict(group='D', id=f'D|{sym}|{name}', inst=sym, rule=name, tf='D1', nominate=sym in ('US500', 'US100', 'JP225'),
                             r=daily_net(d.ret, pos, cost, fl, fs), g=daily_net(d.ret, pos, 0.0, fl, fs), entry=entries_of(pos), flag=f, ret=d.ret))


def group_e(d1, recs):
    for sym in list(FX) + ['XAUUSD', 'XAGUSD', 'WTI', 'BRENT']:
        if sym not in d1:
            continue
        d = B.prep(d1[sym])
        fl, fs = fx_fin(*FX[sym]) if sym in FX else cfd_fin('USD')
        cost = spread_bp(d1[sym]) + 1.0
        for name, pos in [('buy after IBS < 0.2, one day', (d.ibs < 0.2).astype(float)),
                          ('sell after IBS > 0.8, one day', -(d.ibs > 0.8).astype(float))]:
            recs.append(dict(group='E', id=f'E|{sym}|{name}', inst=sym, rule=name, tf='D1', nominate=True,
                             r=daily_net(d.ret, pos, cost, fl, fs), g=daily_net(d.ret, pos, 0.0, fl, fs), entry=entries_of(pos)))


def group_f(d1, recs):
    crosses = {'AUDNZD': ('AUDUSD', 'NZDUSD', '/', 'AUD', 'NZD'), 'EURGBP': ('EURUSD', 'GBPUSD', '/', 'EUR', 'GBP'),
               'EURCHF': ('EURUSD', 'USDCHF', '*', 'EUR', 'CHF'), 'AUDCAD': ('AUDUSD', 'USDCAD', '*', 'AUD', 'CAD'),
               'NZDCAD': ('NZDUSD', 'USDCAD', '*', 'NZD', 'CAD')}
    for name, (a, b, op, base, quote) in crosses.items():
        if a not in d1 or b not in d1:
            continue
        j = pd.concat([d1[a].c.rename('a'), d1[b].c.rename('b')], axis=1, sort=True).dropna()
        j = j[j.index.dayofweek < 5]
        x = j.a / j.b if op == '/' else j.a * j.b
        ret = x.pct_change()
        fl, fs = fx_fin(base, quote)
        cost = spread_bp(d1[a]) + spread_bp(d1[b]) + 1.0
        for L in (10, 20):
            for z in (1.5, 2.0):
                pos = bb_positions(x, L, z)
                rule = f'fade {z} sd from the {L}-day mean'
                recs.append(dict(group='F', id=f'F|{name}|{rule}', inst=name, rule=rule, tf='D1', nominate=True,
                                 r=daily_net(ret, pos, cost, fl, fs), g=daily_net(ret, pos, 0.0, fl, fs), entry=entries_of(pos)))


def group_g(d1, recs):
    for a, b in [('US100', 'US500'), ('US30', 'US500'), ('US2000', 'US500'), ('GER40', 'EU50'), ('UK100', 'EU50')]:
        if a not in d1 or b not in d1:
            continue
        j = pd.concat([d1[a].c.rename('a'), d1[b].c.rename('b')], axis=1, sort=True).dropna()
        j = j[j.index.dayofweek < 5]
        x = np.log(j.a / j.b)
        ret = j.a.pct_change() - j.b.pct_change()
        la, sa = cfd_fin(IDX_CCY[a]); lb, sb = cfd_fin(IDX_CCY[b])
        fl = lambda y, la=la, sb=sb: la(y) + sb(y)            # long a, short b
        fs = lambda y, lb=lb, sa=sa: lb(y) + sa(y)            # long b, short a
        cost = spread_bp(d1[a]) + spread_bp(d1[b]) + 2.0
        for L in (10, 20):
            pos = bb_positions(x, L, 2.0)
            rule = f'fade 2 sd of the log ratio from its {L}-day mean'
            recs.append(dict(group='G', id=f'G|{a}/{b}|{rule}', inst=f'{a}/{b}', rule=rule, tf='D1', nominate=True,
                             r=daily_net(ret, pos, cost, fl, fs), g=daily_net(ret, pos, 0.0, fl, fs), entry=entries_of(pos)))


# ------------------------------------------------------------------ M5 groups
class Bars:
    """M5 bars of one instrument with helpers to find the bar at a local clock time on every server day."""

    def __init__(self, d):
        d = d[d.index.dayofweek < 5]
        self.t = d.index.values
        self.o = d.o.values.astype(float); self.c = d.c.values.astype(float)
        pt = point_size(np.concatenate([self.c[-3000:], self.o[-3000:]]))
        sb = np.where(d.spr.values > 0, d.spr.values * pt / self.c * 1e4, np.nan)
        self.sbp = np.where(np.isfinite(sb), sb, np.nanmedian(sb))
        self.days = pd.DatetimeIndex(np.unique(d.index.normalize()))
        self.first = np.searchsorted(self.t, self.days.values, 'left')
        self.n = len(self.t)

    def at(self, tz, hh, mm, prev=False, exact=False):
        """Index of the first bar at or after hh:mm local time (of the previous calendar day when prev) on each
        server day, within 15 minutes (or exactly at it) and inside that server day; -1 when there is none."""
        base = self.days - pd.Timedelta(days=1) if prev else self.days
        loc = (base + pd.Timedelta(hours=hh, minutes=mm)).tz_localize(tz, ambiguous='NaT', nonexistent='NaT')
        ts = loc.tz_convert(SERVER_TZ).tz_localize(None)
        ok = np.asarray(ts.notna())
        tv = np.where(ok, ts.values, self.t[0])
        i = np.searchsorted(self.t, tv, 'left')
        ok &= i < self.n
        ii = np.where(ok, i, 0)
        gap = (self.t[ii] - tv) / np.timedelta64(1, 'm')
        ok &= (gap >= 0) & (gap <= (0 if exact else 15))
        ok &= np.asarray(pd.DatetimeIndex(self.t[ii]).normalize() == self.days)
        return np.where(ok, ii, -1)

    def leg(self, ia, ib):
        """Long from the open of bar ia to the open of bar ib: (valid, gross return, cost as a fraction)."""
        ok = (ia >= 0) & (ib >= 0) & (ib > ia)
        a, b = np.where(ok, ia, 0), np.where(ok, ib, 0)
        gross = self.o[b] / self.o[a] - 1
        cost = (self.sbp[a] / 2 + self.sbp[b] / 2 + 1.0) / 1e4
        return ok, gross, cost

    def series(self, values, ok):
        return pd.Series(np.where(ok, values, 0.0), index=self.days)


def group_a(bars, d1p, sym, recs):
    names = ['reopen', '20:00', '02:00', '04:00', '09:30', '16:00']
    idx = [bars.first.copy(), bars.at(NY, 20, 0, prev=True), bars.at(NY, 2, 0), bars.at(NY, 4, 0), bars.at(NY, 9, 30),
           bars.at(NY, 16, 0)]
    sig = np.asarray((d1p.ibs.shift(1) < 0.2).reindex(bars.days, fill_value=False))
    # the rule as it is traded now: reopen to the next reopen, one swap per night, no cost while the signal repeats
    nxt = np.r_[bars.first[1:], -1]
    ok, gross, _ = bars.leg(bars.first, nxt)
    nights = np.r_[np.diff(bars.days.values) / np.timedelta64(1, 'D'), 1.0]
    fin = np.array([rate('USD', y) + 0.025 for y in bars.days.year]) * nights / 365.0
    a, b = np.where(ok, bars.first, 0), np.where(ok, nxt, 0)
    sig_prev, sig_next = np.r_[False, sig[:-1]], np.r_[sig[1:], False]
    cost = (np.where(sig_prev, 0.0, bars.sbp[a] / 2 + 0.5) + np.where(sig_next, 0.0, bars.sbp[b] / 2 + 0.5)) / 1e4
    incumbent = bars.series(gross - cost - fin, ok & sig)
    hold = bars.series(gross - fin, ok)                              # buy and hold, financing only
    recs.append(dict(group='A', id=f'A|{sym}|current rule A (reopen to next reopen)', inst=sym, rule='current rule A (reopen to next reopen)',
                     tf='M5', nominate=False, r=incumbent, entry=pd.Series(ok & sig & ~sig_prev, index=bars.days)))
    for i in range(len(names)):
        for j in range(i + 1, len(names)):
            ok, gross, cost = bars.leg(idx[i], idx[j])
            rule = f'buy {names[i]} -> {names[j]} New York'
            recs.append(dict(group='A', id=f'A|{sym}|{rule}', inst=sym, rule=rule + ' after a weak close', tf='M5', nominate=True,
                             r=bars.series(gross - cost, ok & sig), g=bars.series(gross, ok & sig),
                             entry=pd.Series(ok & sig, index=bars.days), incumbent=incumbent))
            recs.append(dict(group="A'", id=f"A'|{sym}|{rule}", inst=sym, rule=rule + ' every day', tf='M5', nominate=True,
                             r=bars.series(gross - cost, ok), g=bars.series(gross, ok), entry=pd.Series(ok, index=bars.days),
                             bench=hold))


def group_b(bars, sym, recs):
    for (hh, mm), exits in [((8, 30), [(9, 30), (10, 30), (16, 0)]), ((10, 0), [(11, 0), (12, 0), (16, 0)])]:
        i0 = bars.at(NY, hh, mm, exact=True)
        ok0 = (i0 >= 0) & (i0 + 1 < bars.n)
        a = np.where(ok0, i0, 0)
        ok0 &= (bars.t[np.minimum(a + 1, bars.n - 1)] - bars.t[a]) == np.timedelta64(5, 'm')
        r0 = bars.c[a] / bars.o[a] - 1
        size = pd.Series(np.where(ok0, np.abs(r0), np.nan), index=bars.days)
        scale = size.rolling(60, min_periods=40).median().shift(1).values
        ie = np.where(ok0, a + 1, -1)
        for k in (2, 3, 4):
            shock = ok0 & np.isfinite(scale) & (np.abs(r0) >= k * np.where(np.isfinite(scale), scale, np.inf))
            for xh, xm in exits:
                ok, gross, cost = bars.leg(ie, bars.at(NY, xh, xm))
                ok &= shock
                g = np.sign(r0) * gross
                for name, sgn in [('with the move', 1.0), ('against the move', -1.0)]:
                    rule = f'{hh:02d}:{mm:02d} bar >= {k}x usual, trade {name} to {xh:02d}:{xm:02d}'
                    recs.append(dict(group='B', id=f'B|{sym}|{rule}', inst=sym, rule=rule, tf='M5', nominate=True,
                                     r=bars.series(sgn * g - cost, ok), g=bars.series(sgn * g, ok), entry=pd.Series(ok, index=bars.days)))


def group_h(bars, sym, recs):
    if sym in ('US500', 'US100', 'US30'):
        b = {'re': bars.first.copy(), '0930': bars.at(NY, 9, 30), '1000': bars.at(NY, 10, 0), '1200': bars.at(NY, 12, 0),
             '1600': bars.at(NY, 16, 0)}
        pairs = [('overnight -> cash session', b['re'], b['0930'], b['0930'], b['1600']),
                 ('morning -> afternoon', b['0930'], b['1200'], b['1200'], b['1600']),
                 ('first 30 minutes -> rest of the session', b['0930'], b['1000'], b['1000'], b['1600'])]
    else:
        tz, op, mid_a, mid_b, cl = (TOKYO, (9, 0), (11, 30), (12, 30), (15, 0)) if sym == 'JP225' else (BERLIN, (9, 0), (13, 0), (13, 0), (17, 30))
        i_op, i_ma, i_mb, i_cl = bars.at(tz, *op), bars.at(tz, *mid_a), bars.at(tz, *mid_b), bars.at(tz, *cl)
        i_f = bars.at(tz, op[0], op[1] + 30)
        pairs = [('previous close to the open -> cash session', np.r_[-1, i_cl[:-1]], i_op, i_op, i_cl),
                 ('morning -> afternoon', i_op, i_ma, i_mb, i_cl),
                 ('first 30 minutes -> rest of the session', i_op, i_f, i_f, i_cl)]
    for name, s0, s1, t0, t1 in pairs:
        oks = (s0 >= 0) & (s1 >= 0)
        sig = np.where(oks, bars.o[np.where(oks, s1, 0)] / bars.o[np.where(oks, s0, 0)] - 1, np.nan)
        size = pd.Series(np.abs(sig), index=bars.days)
        scale = size.rolling(60, min_periods=40).median().shift(1).values
        big = np.isfinite(scale) & (np.abs(np.nan_to_num(sig)) >= 1.5 * np.where(np.isfinite(scale), scale, np.inf))
        ok, gross, cost = bars.leg(t0, t1)
        ok &= np.isfinite(sig) & (np.nan_to_num(sig) != 0)
        g = np.sign(np.nan_to_num(sig)) * gross
        for scope, m in [('every day', ok), ('large moves only', ok & big)]:
            for side, sgn in [('follow', 1.0), ('fade', -1.0)]:
                rule = f'{name}: {side}, {scope}'
                recs.append(dict(group='H', id=f'H|{sym}|{rule}', inst=sym, rule=rule, tf='M5', nominate=True,
                                 r=bars.series(sgn * g - cost, m), g=bars.series(sgn * g, m), entry=pd.Series(m, index=bars.days)))


def group_c(m5, recs, with_gross=False):
    variants = {'V0 current rule': {}, 'V1 one entry a day': dict(one_entry=True),
                'V2 first signal, hold to the close, 2% stop': dict(hold_to_close=True, stop_pct=0.02),
                'V3 decisions every 60 minutes': dict(step=60), 'V4 band 1.5x wide': dict(band_mult=1.5)}
    for sym in ['US500', 'US100', 'US30', 'GER40', 'JP225']:
        if sym not in m5:
            continue
        base = None
        for name, kw in variants.items():
            res, tr, _ = im_run(m5[sym], sym, **kw)
            ent = (res.trades > 0)
            rec = dict(group='C', id=f'C|{sym}|{name}', inst=sym, rule=name, tf='M5', nominate=name[:2] != 'V0', r=res.ret, entry=ent)
            if with_gross:
                rec['g'] = im_run(m5[sym], sym, cost_scale=0.0, **kw)[0].ret
            if base is None:
                base = res.ret
            else:
                rec['incumbent'] = base
            recs.append(rec)


# ------------------------------------------------------------------ stages
def nominate(tab):
    """The pre-registered stage-1 criteria: net t >= 2.0, both halves positive, enough trades, the group's extra
    condition; the best t per instrument and at most three per group."""
    keep = (tab.t >= 2.0) & (tab.h1_bp > 0) & (tab.h2_bp > 0) & (tab.trades >= MIN_TRADES) & tab.nominate
    keep &= ~((tab.group == 'D') & ~(tab.excess_t >= 2.0))
    keep &= ~((tab.group == "A'") & ~(tab.sharpe > tab.bench_sharpe))
    cand = tab[keep].sort_values('t', ascending=False)
    cand = cand.groupby(['group', 'inst'], sort=False).head(1)
    return cand.groupby('group', sort=False).head(3).sort_values(['group', 't'], ascending=[True, False])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--d1', required=True)
    ap.add_argument('--m5', nargs='+', required=True)
    ap.add_argument('--stage', choices=['discovery', 'holdout', 'gross'], required=True)
    ap.add_argument('--out', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'results'))
    ap.add_argument('--rules', default='round8_nominations.csv', help='holdout stage: file in --out with the rule ids to test')
    ap.add_argument('--result', default='round8_holdout.csv', help='holdout stage: output file name in --out')
    a = ap.parse_args()
    raw, _ = BD.load_dir(a.d1, 'D1'); d1 = BD.to_generic(raw)
    m5 = {}
    for folder in a.m5:
        raw, _ = BD.load_dir(folder, 'M5'); m5.update(BD.to_generic(raw))
    print('median spread (bp) used for the D1 groups:', {k: round(spread_bp(v), 2) for k, v in d1.items()})
    recs = []
    group_d(d1, recs); group_e(d1, recs); group_f(d1, recs); group_g(d1, recs)
    for sym in ['US500', 'US100', 'US30', 'GER40', 'JP225']:
        if sym not in m5:
            continue
        bars = Bars(m5[sym])
        if sym in ('US500', 'US100'):
            group_a(bars, B.prep(d1[sym]), sym, recs)
            group_b(bars, sym, recs)
        group_h(bars, sym, recs)
    group_c(m5, recs, with_gross=a.stage == 'gross')
    by_id = {r['id']: r for r in recs}
    assert len(by_id) == len(recs), 'duplicate rule ids'
    os.makedirs(a.out, exist_ok=True)
    pd.set_option('display.width', 250); pd.set_option('display.max_colwidth', 80); pd.set_option('display.max_rows', 500)
    if a.stage == 'discovery':
        rows = []
        for r in recs:
            lo, hi = PERIODS['discovery'][r['tf']]
            rows.append(dict(evaluate(r, lo, hi), nominate=r['nominate']))
        tab = pd.DataFrame(rows)
        for c in ('excess_t', 'bench_sharpe', 'incumbent_sharpe', 'trades', 'h1_bp', 'h2_bp'):
            if c not in tab:
                tab[c] = np.nan
        tab.to_csv(os.path.join(a.out, 'round8_discovery.csv'), index=False, float_format='%.4f')
        nom = nominate(tab)
        nom.to_csv(os.path.join(a.out, 'round8_nominations.csv'), index=False, float_format='%.4f')
        print(f'{len(tab)} rules evaluated on the discovery period; rules per group:', tab.groupby('group').size().to_dict())
        print('with net t >= 2.0:', int((tab.t >= 2.0).sum()), '| nominated:', len(nom))
        cols = ['id', 'days', 'trades', 'sharpe', 't', 'mean_bp', 'per_trade_bp', 'h1_bp', 'h2_bp', 'excess_t', 'bench_sharpe', 'incumbent_sharpe']
        print(nom[cols].round(2).to_string(index=False))
    elif a.stage == 'gross':
        # diagnostic only, discovery period only: where does an effect exist before spread and slippage?
        rows = []
        for r in recs:
            if r.get('g') is None:
                continue
            lo, hi = PERIODS['discovery'][r['tf']]
            net, gro = r['r'].loc[lo:hi], r['g'].loc[lo:hi]
            n = max(int(r['entry'].loc[lo:hi].sum()), 1)
            half = (net + gro) / 2                              # spread and slippage at half the modelled size
            mid = half.index[0] + (half.index[-1] - half.index[0]) / 2
            rows.append(dict(group=r['group'], id=r['id'], trades=n, gross_sharpe=stat(gro)[0], gross_t=stat(gro)[1],
                             net_sharpe=stat(net)[0], net_t=stat(net)[1], gross_per_trade_bp=float(gro.sum() / n * 1e4),
                             cost_per_trade_bp=float((gro.sum() - net.sum()) / n * 1e4),
                             half_cost_sharpe=stat(half)[0], half_cost_t=stat(half)[1],
                             half_cost_both_halves=bool(half.loc[:mid].mean() > 0 and half.loc[mid + pd.Timedelta(days=1):].mean() > 0)))
        tab = pd.DataFrame(rows)
        tab.to_csv(os.path.join(a.out, 'round8_discovery_gross.csv'), index=False, float_format='%.4f')
        print('rules with gross t >= 3.0 on the discovery period:', int((tab.gross_t >= 3.0).sum()), 'of', len(tab))
        print(tab[tab.gross_t >= 3.0].sort_values('gross_t', ascending=False).round(2).to_string(index=False))
        hc = tab[(tab.half_cost_t >= 2.0) & tab.half_cost_both_halves].sort_values('half_cost_t', ascending=False)
        print('rules that would reach t >= 2.0 with both halves positive at half the costs (discovery period):', len(hc))
        print(hc[['id', 'trades', 'net_t', 'half_cost_sharpe', 'half_cost_t', 'gross_t', 'gross_per_trade_bp', 'cost_per_trade_bp']].round(2).to_string(index=False))
    else:
        nom = pd.read_csv(os.path.join(a.out, a.rules))
        rows = []
        for rid in nom.id:
            r = by_id[rid]
            lo, hi = PERIODS['holdout'][r['tf']]
            e = evaluate(r, lo, hi)
            ok = e['sharpe'] >= 0.5 and e['h1_bp'] > 0 and e['h2_bp'] > 0
            if r['group'] == 'D':
                ok = ok and e['excess_bp'] > 0
            if r['group'] == "A'":                               # long every day: must also beat holding the index
                ok = ok and e['sharpe'] > e['bench_sharpe']
            e['verdict'] = 'PASS' if ok else 'fail'
            rows.append(e)
        tab = pd.DataFrame(rows)
        tab.to_csv(os.path.join(a.out, a.result), index=False, float_format='%.4f')
        cols = [c for c in ['id', 'days', 'trades', 'sharpe', 't', 'per_trade_bp', 'h1_bp', 'h2_bp', 'excess_bp', 'bench_sharpe', 'incumbent_sharpe', 'verdict'] if c in tab]
        print(tab[cols].round(2).to_string(index=False))


if __name__ == '__main__':
    main()
