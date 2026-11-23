"""Round 10 (pre-registered in CANDIDATES.md, commit 805aaa9): daily trend rules on all instruments (group I) and
weekly cross-sectional reversal / momentum among equity indices (group K), with the two-stage procedure of round 8.

  python -I sweep10.py <D1 folder> --stage discovery [--out ../results]
  python -I sweep10.py <D1 folder> --stage holdout [--out ../results]

Stage "discovery" writes round10_discovery.csv and round10_nominations.csv; stage "holdout" evaluates only the
nominated rules and writes round10_holdout.csv. A group I rule must also beat the better of always-long and
always-short (after financing) in the period it is judged on.
"""
import argparse, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import pandas as pd

import broker_data as BD
import dbt as B
from sweep8 import (PERIODS, IDX_CCY, FX, MIN_TRADES, cfd_fin, fx_fin, daily_net, entries_of, evaluate, spread_bp, stat)


def channel_positions(d, n_in, n_out):
    """Long above the high of the previous n_in bars, short below their low (closes against highs/lows);
    out when the close crosses the opposite side of the previous n_out bars; no entry on an exit bar."""
    c = d.c.values
    hh = d.h.rolling(n_in).max().shift(1).values; ll = d.l.rolling(n_in).min().shift(1).values
    xh = d.h.rolling(n_out).max().shift(1).values; xl = d.l.rolling(n_out).min().shift(1).values
    pos = np.zeros(len(c)); cur = 0
    for t in range(len(c)):
        if not np.isfinite(hh[t]):
            continue
        if cur > 0 and c[t] < xl[t]:
            cur = 0
        elif cur < 0 and c[t] > xh[t]:
            cur = 0
        elif cur == 0:
            cur = 1 if c[t] > hh[t] else (-1 if c[t] < ll[t] else 0)
        pos[t] = cur
    return pd.Series(pos, index=d.index)


def group_i(d1, recs):
    for sym, raw in d1.items():
        d = B.prep(raw)
        if sym in IDX_CCY:
            fl, fs = cfd_fin(IDX_CCY[sym])
        elif sym in FX:
            fl, fs = fx_fin(*FX[sym])
        else:
            fl, fs = cfd_fin('USD')
        cost = spread_bp(raw) + 1.0
        ma50, ma200 = d.c.rolling(50).mean(), d.c.rolling(200).mean()
        mom = d.c / d.c.shift(120) - 1
        rules = {'I1 channel 20/10': channel_positions(d, 20, 10), 'I2 channel 55/20': channel_positions(d, 55, 20),
                 'I3 50-day above/below 200-day average': np.sign(ma50 - ma200).fillna(0.0),
                 'I4 above/below the close 120 days ago': np.sign(mom).fillna(0.0)}
        one = pd.Series(1.0, index=d.index)
        hold_long, hold_short = daily_net(d.ret, one, 0.0, fl, fs), daily_net(d.ret, -one, 0.0, fl, fs)
        for name, pos in rules.items():
            recs.append(dict(group='I', id=f'I|{sym}|{name}', inst=sym, rule=name, tf='D1', nominate=True,
                             r=daily_net(d.ret, pos, cost, fl, fs), entry=entries_of(pos), bench=hold_long, bench2=hold_short))


def group_k(d1, recs):
    syms = [s for s in ['US500', 'US100', 'US30', 'GER40', 'EU50', 'UK100', 'JP225'] if s in d1]
    close = pd.concat([d1[s].c.rename(s) for s in syms], axis=1, sort=True)
    close = close[close.index.dayofweek < 5].ffill().dropna()
    ret = close.pct_change().fillna(0.0)
    week = close.index.to_period('W-FRI')
    last = pd.Series(week, index=close.index).ne(pd.Series(week, index=close.index).shift(-1)).values   # last bar of each week
    nights = pd.Series(close.index, index=close.index).diff().dt.days.fillna(1).values
    yrs = close.index.year
    cost = np.array([spread_bp(d1[s]) + 1.0 for s in syms])
    fin_l = np.array([[cfd_fin(IDX_CCY[s])[0](y) for s in syms] for y in yrs])        # earned per unit long
    fin_s = np.array([[cfd_fin(IDX_CCY[s])[1](y) for s in syms] for y in yrs])        # earned per unit short
    for look in (5, 20):
        past = (close / close.shift(look) - 1).values
        for side, sgn in [('reversal', 1.0), ('momentum', -1.0)]:
            W = np.zeros(close.shape); cur = np.zeros(len(syms))
            for t in range(len(close)):
                if last[t] and np.all(np.isfinite(past[t])):
                    order = np.argsort(past[t])
                    cur = np.zeros(len(syms))
                    cur[order[:2]] = 0.5 * sgn; cur[order[-2:]] = -0.5 * sgn
                W[t] = cur
            Wd = pd.DataFrame(W, index=close.index, columns=syms)
            held = Wd.shift(1).fillna(0.0).values
            gross = (held * ret.values).sum(axis=1)
            fin = (np.where(held > 0, held * fin_l, -held * fin_s) * (nights / 365.0)[:, None]).sum(axis=1)
            turn = np.abs(np.diff(W, axis=0, prepend=np.zeros((1, len(syms)))))
            tc = (turn * cost / 2 / 1e4).sum(axis=1)
            rule = f'{side}: rank the last {look} days, 2 long against 2 short, weekly'
            entry = pd.Series(last & (np.abs(W).sum(axis=1) > 0), index=close.index)
            recs.append(dict(group='K', id=f'K|7 indices|{rule}', inst='7 indices', rule=rule, tf='D1', nominate=True,
                             r=pd.Series(gross + fin - tc, index=close.index), entry=entry))


def judged(rec, lo, hi):
    e = evaluate(rec, lo, hi)
    if rec.get('bench2') is not None:
        e['bench_sharpe'] = max(stat(rec['bench'].loc[lo:hi])[0], stat(rec['bench2'].loc[lo:hi])[0])
    return e


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('d1')
    ap.add_argument('--stage', choices=['discovery', 'holdout'], required=True)
    ap.add_argument('--out', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'results'))
    a = ap.parse_args()
    raw, _ = BD.load_dir(a.d1, 'D1'); d1 = BD.to_generic(raw)
    recs = []
    group_i(d1, recs); group_k(d1, recs)
    by_id = {r['id']: r for r in recs}
    assert len(by_id) == len(recs)
    pd.set_option('display.width', 250); pd.set_option('display.max_colwidth', 80); pd.set_option('display.max_rows', 500)
    os.makedirs(a.out, exist_ok=True)
    if a.stage == 'discovery':
        lo, hi = PERIODS['discovery']['D1']
        tab = pd.DataFrame([judged(r, lo, hi) for r in recs])
        if 'bench_sharpe' not in tab:
            tab['bench_sharpe'] = np.nan
        tab.to_csv(os.path.join(a.out, 'round10_discovery.csv'), index=False, float_format='%.4f')
        keep = (tab.t >= 2.0) & (tab.h1_bp > 0) & (tab.h2_bp > 0) & (tab.trades >= MIN_TRADES)
        keep &= ~((tab.group == 'I') & ~(tab.sharpe > tab.bench_sharpe))
        nom = tab[keep].sort_values('t', ascending=False).groupby(['group', 'inst'], sort=False).head(1)
        nom = nom.groupby('group', sort=False).head(3)
        nom.to_csv(os.path.join(a.out, 'round10_nominations.csv'), index=False, float_format='%.4f')
        cols = ['id', 'trades', 'sharpe', 't', 'per_trade_bp', 'h1_bp', 'h2_bp', 'bench_sharpe']
        print(f'{len(tab)} rules on the discovery period; net t >= 2.0: {int((tab.t >= 2.0).sum())}; nominated: {len(nom)}')
        print('--- best 12 by t'); print(tab.sort_values('t', ascending=False).head(12)[cols].round(2).to_string(index=False))
        print('--- group K'); print(tab[tab.group == 'K'][cols].round(2).to_string(index=False))
        print('--- nominated'); print(nom[cols].round(2).to_string(index=False) if len(nom) else 'none')
    else:
        nom = pd.read_csv(os.path.join(a.out, 'round10_nominations.csv'))
        lo, hi = PERIODS['holdout']['D1']
        rows = []
        for rid in nom.id:
            e = judged(by_id[rid], lo, hi)
            ok = e['sharpe'] >= 0.5 and e['h1_bp'] > 0 and e['h2_bp'] > 0
            if by_id[rid]['group'] == 'I':
                ok = ok and e['sharpe'] > e['bench_sharpe']
            e['verdict'] = 'PASS' if ok else 'fail'
            rows.append(e)
        tab = pd.DataFrame(rows)
        tab.to_csv(os.path.join(a.out, 'round10_holdout.csv'), index=False, float_format='%.4f')
        print(tab[[c for c in ['id', 'trades', 'sharpe', 't', 'per_trade_bp', 'h1_bp', 'h2_bp', 'bench_sharpe', 'verdict'] if c in tab]].round(2).to_string(index=False)
              if len(tab) else 'no nominated rules')


if __name__ == '__main__':
    main()
