"""Candidate B: multi-asset time-series momentum (TSMOM) on the broker's D1 bars.

  python -I cand_b.py <folder with *_D1*.csv> [--out ../results]

Pre-registered (CANDIDATES.md, written before the data was seen):
  * universe: EURUSD USDJPY GBPUSD AUDUSD USDCAD USDCHF NZDUSD, XAUUSD XAGUSD, US500 GER40 JP225 UK100, WTI BRENT
  * primary  'tsmom12': position sign = sign of the past 252-day return
  * secondary 'blend'  : average of the signs of the 21-, 63- and 252-day returns (Hurst, Ooi & Pedersen 2017)
  * sizing: weight_i = signal_i * (10% / sqrt(N_active)) / sigma_i, sigma_i = 60-day realised vol (annualised):
            equal risk per instrument, ~10% portfolio vol if the instruments were uncorrelated
  * rebalance at the close of the first trading day of each month; weights held until the next rebalance
Costs: |change in weight| * (broker median spread bp + 1 bp) / 2 at each rebalance.
Financing (an assumption, see REPORT): FX income = w*(r_base - r_quote) - |w|*1%/yr;
CFDs (indices, metals, oil) income = -w*r_ccy - |w|*2.5%/yr  (long pays r+2.5%, short receives r-2.5%).
"""
import argparse, math, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import pandas as pd

import broker_data as BD
import dbt as B
import metrics as M
import sim_final as F
from cand_c import broker_cost_bp

FX = {'EURUSD': ('EUR', 'USD'), 'USDJPY': ('USD', 'JPY'), 'GBPUSD': ('GBP', 'USD'), 'AUDUSD': ('AUD', 'USD'),
      'USDCAD': ('USD', 'CAD'), 'USDCHF': ('USD', 'CHF'), 'NZDUSD': ('NZD', 'USD')}
CFD = {'XAUUSD': 'USD', 'XAGUSD': 'USD', 'US500': 'USD', 'GER40': 'EUR', 'JP225': 'JPY', 'UK100': 'GBP',
       'WTI': 'USD', 'BRENT': 'USD'}
UNIVERSE = list(FX) + list(CFD)
CLASS = {**{s: 'FX' for s in FX}, 'XAUUSD': 'metals', 'XAGUSD': 'metals', 'US500': 'indices', 'GER40': 'indices',
         'JP225': 'indices', 'UK100': 'indices', 'WTI': 'energy', 'BRENT': 'energy'}


def rate(ccy, year):
    tab = B.CCY_RATE[ccy]
    return tab.get(year, tab[max(tab)]) / 100.0


def build(data, variant='tsmom12', target=0.10, vol_win=60, fx_markup=0.01, cfd_markup=0.025):
    """Return dict with daily gross/net returns, per-instrument P&L and weights."""
    syms = [s for s in UNIVERSE if s in data]
    close = pd.DataFrame({s: data[s].c for s in syms}).sort_index()
    dates = close.index
    ret = (close / close.ffill().shift(1) - 1).where(close.notna()).fillna(0.0)
    cost_bp = {s: broker_cost_bp(data[s])[0] for s in syms}
    ym = pd.Series(dates.year * 100 + dates.month, index=dates)
    is_rb = ym.ne(ym.shift()).values
    W = np.zeros((len(dates), len(syms)))
    w_cur = np.zeros(len(syms))
    tcost = np.zeros(len(dates))
    for i, t in enumerate(dates):
        if is_rb[i]:
            new = np.zeros(len(syms))
            active = 0
            for j, s in enumerate(syms):
                px = close[s].iloc[:i + 1].dropna()
                if len(px) < 253 + vol_win:
                    continue
                r12 = px.iloc[-1] / px.iloc[-253] - 1
                if variant == 'tsmom12':
                    sig = np.sign(r12)
                else:
                    sig = (np.sign(px.iloc[-1] / px.iloc[-22] - 1) + np.sign(px.iloc[-1] / px.iloc[-64] - 1) + np.sign(r12)) / 3.0
                vol = px.pct_change().iloc[-vol_win:].std() * math.sqrt(252)
                if np.isfinite(vol) and vol > 0:
                    new[j] = sig / vol
                    active += 1
            if active:
                new *= target / math.sqrt(active)
            tcost[i] = float(np.sum(np.abs(new - w_cur) * np.array([(cost_bp[s] + 1.0) / 2e4 for s in syms])))
            w_cur = new
        W[i] = w_cur
    W = pd.DataFrame(W, index=dates, columns=syms)
    Wl = W.shift(1).fillna(0.0)                       # weights set at close t-1 earn the return of day t
    pnl = Wl * ret                                    # per-instrument gross P&L (fraction of equity)
    nights = pd.Series(dates, index=dates).diff().dt.days.fillna(1).values
    fin = pd.DataFrame(0.0, index=dates, columns=syms)
    for s in syms:
        w = Wl[s].values
        yrs = dates.year
        if s in FX:
            b, q = FX[s]
            carry = np.array([rate(b, y) - rate(q, y) for y in yrs])
            inc = w * carry - np.abs(w) * fx_markup
        else:
            r_ = np.array([rate(CFD[s], y) for y in yrs])
            inc = -w * r_ - np.abs(w) * cfd_markup
        fin[s] = inc / 365.0 * nights
    gross = pnl.sum(axis=1)
    net = gross + fin.sum(axis=1) - pd.Series(tcost, index=dates)
    return dict(W=W, pnl=pnl, fin=fin, gross=gross, net=net, tcost=pd.Series(tcost, index=dates), syms=syms)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('folder')
    ap.add_argument('--out', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'results'))
    a = ap.parse_args()
    raw, _ = BD.load_dir(a.folder, 'D1')
    data = BD.to_generic(raw)
    start = '2015-04-01'                              # first rebalance with 252+60 days of history for the core set
    out_rows, series = [], {}
    for variant in ['tsmom12', 'blend']:
        res = build(data, variant)
        for kind in ['gross', 'net']:
            r = res[kind].loc[start:]
            sm = M.summarize_daily(r)
            out_rows.append(dict(variant=variant, costs=kind, start=start, sharpe=sm['sharpe'], cagr=sm['cagr'],
                                 vol=sm['vol'], maxdd=sm['maxdd'], t_stat=sm['t_stat'], skew=sm['skew']))
        series[variant] = res
    tab = pd.DataFrame(out_rows)
    # contribution by asset class (primary variant, gross, annualised mean P&L and Sharpe of the sleeve)
    res = series['tsmom12']
    contrib = []
    for cls in ['FX', 'metals', 'indices', 'energy']:
        cols = [s for s in res['syms'] if CLASS[s] == cls]
        p = (res['pnl'][cols].sum(axis=1) + res['fin'][cols].sum(axis=1)).loc[start:]
        contrib.append(dict(asset_class=cls, n=len(cols), ann_return=p.mean() * 252,
                            sharpe=p.mean() / p.std() * math.sqrt(252) if p.std() > 0 else np.nan))
    contrib = pd.DataFrame(contrib)
    # the EA (candidate C logic on US500, broker bars, broker costs) for the combination test
    from cand_c import broker_cost_bp as bc
    d = B.prep(data['US500'])
    sp_bp, _ = bc(data['US500'])
    ea = F.simulate(d, cost_rt=(sp_bp + 1) / 1e4, rates=B.CCY_RATE['USD'], markup=0.025, use_stop=True, stop_atr=3.0)[0].ret
    tm = series['tsmom12']['net']
    both = pd.concat([ea.rename('ea'), tm.rename('tsmom')], axis=1).fillna(0.0).loc[start:]
    corr = both.corr().iloc[0, 1]
    # combine at equal risk (scale each by its own full-sample vol: an in-sample choice, reported as such)
    comb = both.ea / both.ea.std() * 0.5 + both.tsmom / both.tsmom.std() * 0.5
    comb = comb * (both.ea.std())                     # back to the EA's vol scale for readability
    rows2 = []
    for k, r in [('EA US500 alone', both.ea), ('TSMOM-12 alone', both.tsmom), ('EA + TSMOM, equal risk', comb)]:
        sm = M.summarize_daily(r)
        rows2.append(dict(series=k, sharpe=sm['sharpe'], cagr=sm['cagr'], vol=sm['vol'], maxdd=sm['maxdd']))
    rows2 = pd.DataFrame(rows2)
    yearly = pd.DataFrame({'EA_US500': M.yearly_table(both.ea).ret, 'TSMOM12': M.yearly_table(both.tsmom).ret,
                           'TSMOM_blend': M.yearly_table(series['blend']['net'].loc[start:]).ret})
    os.makedirs(a.out, exist_ok=True)
    tab.to_csv(os.path.join(a.out, 'cand_b_summary.csv'), index=False, float_format='%.4f')
    contrib.to_csv(os.path.join(a.out, 'cand_b_by_class.csv'), index=False, float_format='%.4f')
    rows2.to_csv(os.path.join(a.out, 'cand_b_combo.csv'), index=False, float_format='%.4f')
    yearly.to_csv(os.path.join(a.out, 'cand_b_yearly.csv'), float_format='%.4f')
    pd.DataFrame({'tsmom12_net': series['tsmom12']['net'], 'blend_net': series['blend']['net']}).loc[start:].to_csv(
        os.path.join(a.out, 'cand_b_daily_returns.csv'), float_format='%.6f')
    pd.set_option('display.width', 250)
    print(tab.round(3).to_string(index=False))
    print(contrib.round(3).to_string(index=False))
    print(f'corr(EA US500, TSMOM-12) daily = {corr:.2f}')
    print(rows2.round(3).to_string(index=False))
    print((yearly * 100).round(1).to_string())


if __name__ == '__main__':
    main()
