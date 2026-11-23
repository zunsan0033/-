"""Round 11 sweep (pre-registered in CANDIDATES.md, commit da4de72): systems common in retail EAs, with the
two-stage procedure and criteria of round 8.

  python -I sweep11.py --d1 <D1 folder> --h1 <H1 folder> --m5 <M5 folder> [<M5 folder> ...] --stage discovery
  python -I sweep11.py ... --stage holdout

Groups:  L  weekend gap, fade / follow (5 indices on M5; 4 FX pairs and gold on H1)
         M  opening-range breakout, first 30 / 60 minutes of the cash session (5 indices, M5)
         N  Asian-range breakout during London hours (4 FX pairs and gold, H1, UTC)
         O  hourly mean reversion, 2 sd from the 20 / 50 bar mean (the same five, H1)
         P  weekday effects outside equity indices (D1)        Q  gotobi days in USDJPY (D1)
Writes round11_discovery.csv and round11_nominations.csv (stage discovery) or round11_holdout.csv (stage holdout).
"""
import argparse, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import pandas as pd

import broker_data as BD
import dbt as B
from cand_a import session_arrays, point_size, SESSIONS
from cand3 import to_tz
from cand7 import gotobi_days
from sweep8 import (Bars, FX, MIN_TRADES, NY, TOKYO, BERLIN, cfd_fin, fx_fin, daily_net, entries_of, evaluate, bb_positions,
                    spread_bp)

PER = {'discovery': {'M5': ('2017-02-01', '2021-12-31'), 'H1': ('2010-07-01', '2018-12-31'), 'D1': ('2014-07-01', '2020-12-31')},
       'holdout': {'M5': ('2022-01-01', '2026-12-31'), 'H1': ('2019-01-01', '2026-12-31'), 'D1': ('2021-01-01', '2026-12-31')}}
H1_SYMS = ['EURUSD', 'USDJPY', 'GBPUSD', 'AUDUSD', 'XAUUSD']


def fin_of(sym):
    return fx_fin(*FX[sym]) if sym in FX else cfd_fin('USD')


# ------------------------------------------------------------------ L: weekend gap
def group_l(bars, sym, tf, exit_idx, recs):
    days = bars.days
    wk = np.asarray(days.to_period('W-FRI').astype(str))
    first_of_week = np.r_[True, wk[1:] != wk[:-1]] & np.asarray(days.dayofweek == 0)
    last_idx = np.r_[bars.first[1:] - 1, bars.n - 1]
    prev_close = np.r_[np.nan, bars.c[last_idx[:-1]]]
    gap = np.where(first_of_week, bars.o[bars.first] / prev_close - 1, np.nan)
    wgap = pd.Series(np.abs(gap), index=days).dropna()
    scale = wgap.rolling(26, min_periods=13).median().shift(1).reindex(days).values
    ok, gross, cost = bars.leg(bars.first, exit_idx)
    ok &= np.isfinite(gap) & (np.nan_to_num(gap) != 0)
    big = ok & np.isfinite(scale) & (np.abs(np.nan_to_num(gap)) >= 1.5 * np.where(np.isfinite(scale), scale, np.inf))
    g = np.sign(np.nan_to_num(gap)) * gross
    for scope, m in [('every week', ok), ('large gaps only', ok & big)]:
        for side, sgn in [('fade', -1.0), ('follow', 1.0)]:
            rule = f'weekend gap: {side}, {scope}'
            recs.append(dict(group='L', id=f'L|{sym}|{rule}', inst=sym, rule=rule, tf=tf, nominate=True,
                             r=bars.series(sgn * g - cost, m), entry=pd.Series(m, index=days)))


# ------------------------------------------------------------------ M: opening-range breakout
def group_m(d, sym, recs):
    tz, s0, s1 = SESSIONS[sym]
    P, n = session_arrays(d, tz, s0, s1)
    dates = pd.to_datetime(P['c'].index)
    C, H, Lo, O = P['c'].values, P['h'].values, P['l'].values, P['o'].values
    pt = point_size(np.concatenate([C[:, -1], O[:, 0]]))
    spr = P['spr'].values * pt
    med = np.nanmedian(np.where(spr > 0, spr / C, np.nan)) * 1e4
    sbp = np.where(spr > 0, spr / C * 1e4, med)
    for minutes in (30, 60):
        nb = minutes // 5
        out = np.zeros(len(dates)); ent = np.zeros(len(dates), dtype=bool)
        for i in range(len(dates)):
            hi, lo = H[i, :nb].max(), Lo[i, :nb].min()
            pos, entry, cin = 0, 0.0, 0.0
            for k in range(nb, n):
                if pos == 0:
                    if k > n - 2:
                        break
                    c = C[i, k]
                    if c > hi or c < lo:
                        pos = 1 if c > hi else -1
                        entry, cin, ent[i] = c, (sbp[i, k] / 2 + 0.5) / 1e4, True
                    continue
                ob = O[i, k] if np.isfinite(O[i, k]) else C[i, k - 1]
                px = None
                if pos == 1 and Lo[i, k] <= lo:
                    px = ob if ob < lo else lo
                elif pos == -1 and H[i, k] >= hi:
                    px = ob if ob > hi else hi
                if px is not None:
                    out[i] = pos * (px / entry - 1) - cin - (sbp[i, k] / 2 + 0.5) / 1e4
                    pos = 0
                    break
            if pos != 0:
                out[i] = pos * (C[i, n - 1] / entry - 1) - cin - (sbp[i, n - 1] / 2 + 0.5) / 1e4
        rule = f'opening-range breakout, first {minutes} minutes'
        recs.append(dict(group='M', id=f'M|{sym}|{rule}', inst=sym, rule=rule, tf='M5', nominate=True,
                         r=pd.Series(out, index=dates), entry=pd.Series(ent, index=dates)))


# ------------------------------------------------------------------ N: Asian-range breakout in London hours
def group_n(h1, sym, recs):
    x = to_tz(h1, 'UTC')
    x = x[x.date.dt.dayofweek < 5]
    piv = {f: x.pivot_table(index='date', columns='hour', values=f, aggfunc='first').reindex(columns=range(24)) for f in ['o', 'h', 'l', 'c', 'sbp']}
    dates = piv['c'].index
    O, H, Lo, C, S = (piv[f].values for f in ['o', 'h', 'l', 'c', 'sbp'])
    out = np.zeros(len(dates)); ent = np.zeros(len(dates), dtype=bool)
    for i in range(len(dates)):
        if np.isfinite(C[i, :7]).sum() < 6 or not np.isfinite(O[i, 20]):
            continue
        hi, lo = np.nanmax(H[i, :7]), np.nanmin(Lo[i, :7])
        for hr in range(7, 12):
            c = C[i, hr]
            if not np.isfinite(c) or (lo <= c <= hi):
                continue
            side = 1 if c > hi else -1
            e = O[i, hr + 1]
            if not np.isfinite(e):
                break
            stop = lo if side == 1 else hi
            px, xb = O[i, 20], 20
            for b in range(hr + 1, 20):
                if not np.isfinite(C[i, b]):
                    continue
                if side == 1 and Lo[i, b] <= stop:
                    px, xb = (O[i, b] if O[i, b] < stop else stop), b
                    break
                if side == -1 and H[i, b] >= stop:
                    px, xb = (O[i, b] if O[i, b] > stop else stop), b
                    break
            out[i] = side * (px / e - 1) - (S[i, hr + 1] / 2 + S[i, xb] / 2 + 1.0) / 1e4
            ent[i] = True
            break
    rule = 'Asian-range (00-07 UTC) breakout in London hours, out at 20:00 UTC'
    recs.append(dict(group='N', id=f'N|{sym}|{rule}', inst=sym, rule=rule, tf='H1', nominate=True,
                     r=pd.Series(out, index=pd.DatetimeIndex(dates)), entry=pd.Series(ent, index=pd.DatetimeIndex(dates))))


# ------------------------------------------------------------------ O: hourly mean reversion
def group_o(h1, sym, recs):
    d = h1[h1.index.dayofweek < 5]
    pt = point_size(np.concatenate([d.c.values[-3000:], d.o.values[-3000:]]))
    sb = np.where(d.spr.values > 0, d.spr.values * pt / d.c.values * 1e4, np.nan)
    sbp = np.where(np.isfinite(sb), sb, np.nanmedian(sb))
    day = d.index.normalize()
    nights = np.r_[0, (day[1:] - day[:-1]).days]
    fl, fs = fin_of(sym)
    flv = np.array([fl(y) for y in d.index.year]); fsv = np.array([fs(y) for y in d.index.year])
    ret = d.c.pct_change().fillna(0.0).values
    for L in (20, 50):
        pos = bb_positions(d.c, L, 2.0)
        held = pos.shift(1).fillna(0.0).values
        turn = np.abs(np.diff(pos.values, prepend=0.0))
        fin = np.where(held > 0, held * flv, np.where(held < 0, -held * fsv, 0.0)) * nights / 365.0
        net = pd.Series(held * ret + fin - turn * (sbp / 2 + 0.5) / 1e4, index=d.index)
        rule = f'hourly mean reversion: fade 2 sd from the {L}-bar mean'
        recs.append(dict(group='O', id=f'O|{sym}|{rule}', inst=sym, rule=rule, tf='H1', nominate=True,
                         r=net.groupby(day).sum(), entry=entries_of(pos).groupby(day).sum()))


# ------------------------------------------------------------------ P, Q: daily calendar rules outside equity indices
def group_p(d1, recs):
    for sym in list(FX) + ['XAUUSD', 'XAGUSD', 'WTI', 'BRENT']:
        if sym not in d1:
            continue
        d = B.prep(d1[sym])
        fl, fs = fin_of(sym)
        cost = spread_bp(d1[sym]) + 1.0
        for k in range(5):
            f = pd.Series(np.asarray(d.index.dayofweek == k), index=d.index)
            for side, sgn in [('buy', 1.0), ('sell', -1.0)]:
                pos = sgn * f.shift(-1, fill_value=False).astype(float)
                rule = f'{side} on weekday {k} only (0 = Monday)'
                recs.append(dict(group='P', id=f'P|{sym}|{rule}', inst=sym, rule=rule, tf='D1', nominate=True,
                                 r=daily_net(d.ret, pos, cost, fl, fs), entry=entries_of(pos), flag=f, ret=sgn * d.ret))


def group_q(d1, recs):
    d = B.prep(d1['USDJPY'])
    g = gotobi_days(d.index.min(), d.index.max())
    f = pd.Series(np.asarray(d.index.isin(g)), index=d.index)
    fl, fs = fin_of('USDJPY')
    cost = spread_bp(d1['USDJPY']) + 1.0
    for side, sgn in [('buy', 1.0), ('sell', -1.0)]:
        pos = sgn * f.shift(-1, fill_value=False).astype(float)
        rule = f'{side} on gotobi days only'
        recs.append(dict(group='Q', id=f'Q|USDJPY|{rule}', inst='USDJPY', rule=rule, tf='D1', nominate=True,
                         r=daily_net(d.ret, pos, cost, fl, fs), entry=entries_of(pos), flag=f, ret=sgn * d.ret))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--d1', required=True)
    ap.add_argument('--h1', required=True)
    ap.add_argument('--m5', nargs='+', required=True)
    ap.add_argument('--stage', choices=['discovery', 'holdout'], required=True)
    ap.add_argument('--out', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'results'))
    a = ap.parse_args()
    raw, _ = BD.load_dir(a.d1, 'D1'); d1 = BD.to_generic(raw)
    raw, _ = BD.load_dir(a.h1, 'H1'); h1 = BD.to_generic(raw)
    m5 = {}
    for folder in a.m5:
        raw, _ = BD.load_dir(folder, 'M5'); m5.update(BD.to_generic(raw))
    recs = []
    for sym in ['US500', 'US100', 'US30', 'GER40', 'JP225']:
        if sym not in m5:
            continue
        bars = Bars(m5[sym])
        ex = bars.at(NY, 16, 0) if sym.startswith('US') else (bars.at(TOKYO, 15, 0) if sym == 'JP225' else bars.at(BERLIN, 17, 30))
        group_l(bars, sym, 'M5', ex, recs)
        group_m(m5[sym], sym, recs)
    for sym in H1_SYMS:
        if sym not in h1:
            continue
        bars = Bars(h1[sym])
        group_l(bars, sym, 'H1', bars.at('UTC', 20, 0), recs)
        group_n(h1[sym], sym, recs)
        group_o(h1[sym], sym, recs)
    group_p(d1, recs); group_q(d1, recs)
    by_id = {r['id']: r for r in recs}
    assert len(by_id) == len(recs), 'duplicate rule ids'
    pd.set_option('display.width', 250); pd.set_option('display.max_colwidth', 85); pd.set_option('display.max_rows', 500)
    os.makedirs(a.out, exist_ok=True)
    if a.stage == 'discovery':
        tab = pd.DataFrame([evaluate(r, *PER['discovery'][r['tf']]) for r in recs])
        if 'excess_t' not in tab:
            tab['excess_t'] = np.nan
        tab.to_csv(os.path.join(a.out, 'round11_discovery.csv'), index=False, float_format='%.4f')
        keep = (tab.t >= 2.0) & (tab.h1_bp > 0) & (tab.h2_bp > 0) & (tab.trades >= MIN_TRADES)
        keep &= ~(tab.group.isin(['P', 'Q']) & ~(tab.excess_t >= 2.0))
        nom = tab[keep].sort_values('t', ascending=False).groupby(['group', 'inst'], sort=False).head(1)
        nom = nom.groupby('group', sort=False).head(3)
        nom.to_csv(os.path.join(a.out, 'round11_nominations.csv'), index=False, float_format='%.4f')
        cols = ['id', 'trades', 'sharpe', 't', 'per_trade_bp', 'h1_bp', 'h2_bp', 'excess_t']
        print(f'{len(tab)} rules on the discovery period; per group: {tab.groupby("group").size().to_dict()}')
        print(f'net t >= 2.0: {int((tab.t >= 2.0).sum())}; nominated: {len(nom)}')
        for g, x in tab.groupby('group', sort=False):
            x = x.sort_values('t', ascending=False)
            print(f'--- group {g}: best 3 and worst 1 by t'); print(pd.concat([x.head(3), x.tail(1)])[cols].round(2).to_string(index=False))
        print('--- nominated'); print(nom[cols].round(2).to_string(index=False) if len(nom) else 'none')
    else:
        nom = pd.read_csv(os.path.join(a.out, 'round11_nominations.csv'))
        rows = []
        for rid in nom.id:
            r = by_id[rid]
            e = evaluate(r, *PER['holdout'][r['tf']])
            ok = e['sharpe'] >= 0.5 and e['h1_bp'] > 0 and e['h2_bp'] > 0
            if r['group'] in ('P', 'Q'):
                ok = ok and e['excess_bp'] > 0
            e['verdict'] = 'PASS' if ok else 'fail'
            rows.append(e)
        tab = pd.DataFrame(rows)
        tab.to_csv(os.path.join(a.out, 'round11_holdout.csv'), index=False, float_format='%.4f')
        print(tab[[c for c in ['id', 'trades', 'sharpe', 't', 'per_trade_bp', 'h1_bp', 'h2_bp', 'excess_bp', 'verdict'] if c in tab]].round(2).to_string(index=False)
              if len(tab) else 'no nominated rules')


if __name__ == '__main__':
    main()
