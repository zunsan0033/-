"""Candidate C: the unchanged IndexReversion_EA logic on other equity indices (broker D1 bars).

  python -I cand_c.py <folder with *_D1*.csv> [--out ../results] [--duka-root DIR]

Pre-registered: identical rules and parameters to the EA (IBS<0.2 one bar; RSI2<10 above SMA200, exit above SMA5,
max 10 bars; stop signal close - 3*ATR10). Costs: the symbol's recent median broker spread (bp) + 1 bp slippage per
round trip; long financing = policy rate of the index currency + 2.5%. Evaluation starts after a 1-year warm-up.
"""
import argparse, json, math, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import pandas as pd

import broker_data as BD
import dbt as B
import metrics as M
import sim_final as F

INDICES = {'US500': 'USD', 'US100': 'USD', 'US30': 'USD', 'US2000': 'USD',
           'GER40': 'EUR', 'EU50': 'EUR', 'UK100': 'GBP', 'JP225': 'JPY'}
FINAL = dict(use_stop=True, stop_atr=3.0)


def point_size(d):
    """Smallest price increment actually used in the data (e.g. 0.01 or 1.0)."""
    px = pd.concat([d.o, d.h, d.l, d.c]).values
    for dec in range(0, 6):
        if np.all(np.abs(px * 10 ** dec - np.round(px * 10 ** dec)) < 1e-6):
            return 10.0 ** -dec
    return 1e-5


def broker_cost_bp(d):
    pt = point_size(d)
    recent = d.loc['2023':]
    spr = recent.spr[recent.spr > 0]
    if len(spr) == 0:
        return np.nan, pt
    return float((spr * pt / recent.c.reindex(spr.index)).median() * 1e4), pt


def sharpe(r):
    r = pd.Series(r).dropna()
    return float(r.mean() / r.std() * math.sqrt(252)) if r.std() > 0 else float('nan')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('folder')
    ap.add_argument('--out', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'results'))
    ap.add_argument('--duka-root', default=None)
    a = ap.parse_args()
    raw, _ = BD.load_dir(a.folder, 'D1')
    data = BD.to_generic(raw)
    rows, rets, rets_risk, yearly = [], {}, {}, []
    for sym, ccy in INDICES.items():
        if sym not in data:
            continue
        df = data[sym]
        d = B.prep(df)
        spread_bp, pt = broker_cost_bp(df)
        cost_rt = (spread_bp + 1.0) / 1e4
        start = d.index[0] + pd.Timedelta(days=366)
        for label, cfg in [('fixed', dict()), ('risk1', dict(sizing='risk', risk_per_rule=0.01, w_cap=1.5))]:
            eq, tr = F.simulate(d, cost_rt=cost_rt, rates=B.CCY_RATE[ccy], markup=0.025, **FINAL, **cfg)
            r = eq.ret.loc[start:]
            sm = M.summarize_daily(r)
            t2 = tr[pd.to_datetime(tr.entry_date) >= start]
            ts = M.summarize_trades(t2.ret.values)
            row = dict(index=sym, ccy=ccy, sizing=label, start=str(start.date()), end=str(d.index[-1].date()),
                       spread_bp=spread_bp, cost_rt_bp=cost_rt * 1e4, sharpe=sm['sharpe'], cagr=sm['cagr'],
                       maxdd=sm['maxdd'], t_stat=sm['t_stat'], trades=ts['trades'], win_rate=ts['win_rate'],
                       avg_trade_bp=ts['avg'] * 1e4, profit_factor=ts['profit_factor'])
            if label == 'fixed':
                eq4, _ = F.simulate(d, cost_rt=4e-4, rates=B.CCY_RATE[ccy], markup=0.025, **FINAL)
                row['sharpe_cost4bp'] = sharpe(eq4.ret.loc[start:])
                bh = B.run(d, pd.Series(1.0, index=d.index), cost_rt=cost_rt, rates=B.CCY_RATE[ccy], markup=0.025).net.loc[start:]
                row['bh_sharpe'] = sharpe(bh); row['bh_cagr'] = M.summarize_daily(bh)['cagr']; row['bh_maxdd'] = M.summarize_daily(bh)['maxdd']
                rets[sym] = r
                for y, v in M.yearly_table(r).ret.items():
                    yearly.append(dict(index=sym, year=int(y), ret=v))
            else:
                rets_risk[sym] = r
            rows.append(row)
    summ = pd.DataFrame(rows)
    R = pd.DataFrame(rets).fillna(0.0)
    RR = pd.DataFrame(rets_risk).fillna(0.0)
    common = R.loc['2018-07-01':]                      # all eight indices live (US2000 warm-up ends mid-2018)
    us = [s for s in ['US500', 'US100', 'US30', 'US2000'] if s in R]
    non_us = [s for s in ['GER40', 'EU50', 'UK100', 'JP225'] if s in R]
    port = {
        'all8_eq': common.mean(axis=1), 'us4_eq': common[us].mean(axis=1), 'nonus4_eq': common[non_us].mean(axis=1),
        'us500_only': common['US500'], 'all8_eq_risk1': RR.loc['2018-07-01':].mean(axis=1),
    }
    prow = []
    for k, r in port.items():
        sm = M.summarize_daily(r)
        prow.append(dict(portfolio=k, start='2018-07-01', sharpe=sm['sharpe'], cagr=sm['cagr'], maxdd=sm['maxdd'],
                         vol=sm['vol'], t_stat=sm['t_stat']))
    prow = pd.DataFrame(prow)
    corr = common.corr()
    os.makedirs(a.out, exist_ok=True)
    summ.to_csv(os.path.join(a.out, 'cand_c_summary.csv'), index=False, float_format='%.4f')
    prow.to_csv(os.path.join(a.out, 'cand_c_portfolios.csv'), index=False, float_format='%.4f')
    corr.to_csv(os.path.join(a.out, 'cand_c_corr.csv'), float_format='%.3f')
    pd.DataFrame(yearly).to_csv(os.path.join(a.out, 'cand_c_yearly.csv'), index=False, float_format='%.4f')
    R.to_csv(os.path.join(a.out, 'cand_c_daily_returns.csv'), float_format='%.6f')
    pd.set_option('display.width', 250)
    print(summ.round(3).to_string(index=False))
    print(prow.round(3).to_string(index=False))
    print(corr.round(2).to_string())
    # sanity check: broker US500 vs Dukascopy US500 CFD (same rules, 2019-2025)
    if a.duka_root:
        import data_sources as DS
        cfd = DS.us500_cfd_duka(a.duka_root)
        if cfd is not None:
            dd = B.prep(cfd)
            ed, _ = F.simulate(dd, **FINAL)
            xm = F.simulate(B.prep(data['US500']), **FINAL)[0]
            y1 = M.yearly_table(ed.ret.loc['2019':'2025']).ret
            y2 = M.yearly_table(xm.ret.loc['2019':'2025']).ret
            cmp_ = pd.DataFrame({'dukascopy_utc_bars': y1, 'broker_ny_close_bars': y2})
            print('US500 yearly, same rules & 4bp costs:'); print((cmp_ * 100).round(1).to_string())
            print('Sharpe 2019-2025: dukascopy', round(sharpe(ed.ret.loc['2019':'2025']), 2), ' broker', round(sharpe(xm.ret.loc['2019':'2025']), 2))
            cmp_.to_csv(os.path.join(a.out, 'cand_c_us500_source_check.csv'), float_format='%.4f')


if __name__ == '__main__':
    main()
