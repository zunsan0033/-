"""Reproduce every table and figure of ea_research/REPORT.md.

  pip install numpy pandas scipy matplotlib arch
  python run_all.py --duka-root <dir with raw/USA500IDXUSD/day/*.bi5>   # CFD holdout (optional)
  python run_all.py --csv US500_D1.csv                                   # also test your broker's D1 export

Costs (baseline): 4 bp round trip per unit notional (spread + slippage) and long CFD financing of
(benchmark rate + 2.5%)/365 per night, no dividend credit (conservative).
"""
import argparse, json, math, os
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from scipy import stats as sst

import data_sources as DS
import dbt as B
import metrics as M
import rules as R
import sim_final as F
import ea_emulator as EA

COST, MARKUP = 4e-4, 0.025
FINAL = dict(use_stop=True, stop_atr=3.0)            # EA logic, 0.5 notional per rule (max 1.0x), 3*ATR stop
NAMES_JA = {'SPX_IS': 'S&P500 現物 1999–2012（ルール選定期間）', 'SPX_OOS': 'S&P500 現物 2013–2018（時間外検証）',
            'NDQ': 'NASDAQ 総合 1999–2018（別指数で検証）', 'CFD': 'US500 CFD 2019–2025（最終確認・24時間足）',
            'USER': 'ユーザー CSV'}
# palette (reference light theme of the dataviz method)
INK, INK2, MUTED, GRID, BASE, SURF = '#0b0b0b', '#52514e', '#898781', '#e1e0d9', '#c3c2b7', '#fcfcfb'
SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100']


def style():
    plt.rcParams.update({'font.family': ['IPAGothic', 'IPAPGothic', 'DejaVu Sans'], 'font.size': 10,
                         'axes.edgecolor': BASE, 'axes.labelcolor': INK2, 'xtick.color': MUTED, 'ytick.color': MUTED,
                         'axes.grid': True, 'grid.color': GRID, 'grid.linewidth': 0.6, 'axes.axisbelow': True,
                         'figure.facecolor': SURF, 'axes.facecolor': SURF, 'savefig.facecolor': SURF,
                         'axes.spines.top': False, 'axes.spines.right': False, 'text.color': INK,
                         'axes.titlesize': 10.5, 'axes.titlecolor': INK, 'legend.frameon': False})


def sharpe(r):
    r = pd.Series(r).dropna()
    return float(r.mean() / r.std() * math.sqrt(252)) if r.std() > 0 else float('nan')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--duka-root', default=None)
    ap.add_argument('--csv', default=None)
    ap.add_argument('--out', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'results'))
    a = ap.parse_args()
    out = os.path.abspath(a.out)
    os.makedirs(out, exist_ok=True)
    style()

    sets = DS.default_sets(a.duka_root)
    P = {k: (B.prep(v[0]), v[1], v[2]) for k, v in sets.items()}
    roles = {k: v[3] for k, v in sets.items()}
    print('sets:', {k: (str(v[0].index.min().date()), str(v[0].index.max().date()), v[1], v[2]) for k, v in sets.items()})

    # ---------------- 1. diagnostics: next-day return by IBS / RSI(2) bucket ----------------
    diag = []
    for k, (d, y0, y1) in P.items():
        x = d.loc[y0:y1]
        for var, bins in [('ibs', [-0.01, 0.2, 0.4, 0.6, 0.8, 1.01]), ('rsi2', [-1, 5, 10, 30, 70, 90, 95, 101])]:
            g = x.groupby(pd.cut(x[var], bins), observed=True).ret_fwd
            for b, s in g:
                s = s.dropna()
                diag.append(dict(set=k, var=var, bucket=str(b), n=len(s), mean_bp=s.mean() * 1e4,
                                 se_bp=s.std() / math.sqrt(len(s)) * 1e4, t=s.mean() / s.std() * math.sqrt(len(s))))
        diag.append(dict(set=k, var='all', bucket='all', n=int(x.ret_fwd.count()), mean_bp=x.ret_fwd.mean() * 1e4,
                         se_bp=x.ret_fwd.std() / math.sqrt(x.ret_fwd.count()) * 1e4,
                         t=x.ret_fwd.mean() / x.ret_fwd.std() * math.sqrt(x.ret_fwd.count())))
    diag = pd.DataFrame(diag)
    diag.to_csv(os.path.join(out, 'diag_buckets.csv'), index=False, float_format='%.4f')

    # ---------------- 2. all pre-registered and planned strategies, net of costs ----------------
    rows = []
    allrules = {**R.PREREG, **R.PLANNED}
    for k, (d, y0, y1) in P.items():
        for name, fn in allrules.items():
            pos = fn(d)
            res = B.run(d, pos, cost_rt=COST, markup=MARKUP)
            r = res.net.loc[y0:y1]
            sm = M.summarize_daily(r, pos=res.pos.loc[y0:y1])
            tr = B.trades_from_pos(d, pos.clip(-1, 1).round(), cost_rt=COST, markup=MARKUP) if name in R.PREREG else pd.DataFrame()
            if len(tr):
                tr = tr[(tr.entry >= y0) & (tr.entry <= y1 + '-12-31')]
            ts = M.summarize_trades(tr.ret.values) if len(tr) else {}
            rows.append(dict(set=k, strategy=name, sharpe=sm['sharpe'], cagr=sm['cagr'], maxdd=sm['maxdd'],
                             exposure=sm['pct_days_active'], t_stat=sm['t_stat'], trades=ts.get('trades', np.nan),
                             win_rate=ts.get('win_rate', np.nan), avg_trade_bp=ts.get('avg', np.nan) * 1e4,
                             profit_factor=ts.get('profit_factor', np.nan)))
    strat = pd.DataFrame(rows)
    strat.to_csv(os.path.join(out, 'strategies_net.csv'), index=False, float_format='%.4f')

    # ---------------- 3. sensitivity (plateau check, not used for selection) ----------------
    sens = []
    for k, (d, y0, y1) in P.items():
        for th in [0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5]:
            r = B.run(d, (d.ibs < th).astype(float), cost_rt=COST, markup=MARKUP).net.loc[y0:y1]
            sens.append(dict(set=k, family='ibs_threshold', value=th, sharpe=sharpe(r)))
        for n in [1, 2, 3, 5]:
            pos = R.state_machine(d, d.ibs < 0.2, pd.Series(False, index=d.index), max_hold=n)
            sens.append(dict(set=k, family='ibs_hold_days', value=n, sharpe=sharpe(B.run(d, pos, cost_rt=COST, markup=MARKUP).net.loc[y0:y1])))
        for th in [5, 10, 15, 20, 30]:
            pos = R.state_machine(d, (d.c > d.sma200) & (d.rsi2 < th), d.c > d.sma5)
            sens.append(dict(set=k, family='rsi2_threshold', value=th, sharpe=sharpe(B.run(d, pos, cost_rt=COST, markup=MARKUP).net.loc[y0:y1])))
    sens = pd.DataFrame(sens)
    sens.to_csv(os.path.join(out, 'sensitivity.csv'), index=False, float_format='%.4f')

    # ---------------- 4. final logic (= EA) ----------------
    fin, fin_rets, yearly, bh_rets = [], {}, [], {}
    for k, (d, y0, y1) in P.items():
        eqdf, tr = F.simulate(d, **FINAL)
        r = eqdf.ret.loc[y0:y1]
        fin_rets[k] = r
        bh = B.run(d, R.B0_buyhold(d), cost_rt=COST, markup=MARKUP).net.loc[y0:y1]
        bh_rets[k] = bh
        sm = M.summarize_daily(r, pos=eqdf.expo.loc[y0:y1])
        ci, p0 = M.stationary_bootstrap_sharpe(r, n_boot=1000, mean_block=20, seed=1)
        t2 = tr[(tr.entry_date >= y0) & (tr.entry_date <= y1 + '-12-31')]
        ts = M.summarize_trades(t2.ret.values)
        bhs = M.summarize_daily(bh)
        fin.append(dict(set=k, role=roles[k], sharpe=sm['sharpe'], sharpe_ci_lo=ci[0], sharpe_ci_hi=ci[2], p_sr_le_0=p0,
                        cagr=sm['cagr'], vol=sm['vol'], maxdd=sm['maxdd'], exposure=float((eqdf.expo.loc[y0:y1] > 0).mean()),
                        trades=ts['trades'], win_rate=ts['win_rate'], avg_trade_bp=ts['avg'] * 1e4,
                        profit_factor=ts['profit_factor'], stops_hit=int((t2.reason == 'stop').sum()),
                        bh_sharpe=bhs['sharpe'], bh_cagr=bhs['cagr'], bh_maxdd=bhs['maxdd']))
        for yy, v in M.yearly_table(r).ret.items():
            yearly.append(dict(set=k, year=int(yy), ret=v, bh=float((1 + bh[bh.index.year == yy]).prod() - 1)))
    fin = pd.DataFrame(fin)
    fin.to_csv(os.path.join(out, 'final_summary.csv'), index=False, float_format='%.4f')
    pd.DataFrame(yearly).to_csv(os.path.join(out, 'final_yearly.csv'), index=False, float_format='%.4f')
    pd.DataFrame(fin_rets).to_csv(os.path.join(out, 'final_daily_returns.csv'), float_format='%.6f')

    # cost stress
    cs = []
    for crt in [0, 2, 4, 6, 8, 12, 16, 20]:
        for mk in [0.025, 0.04]:
            for k, (d, y0, y1) in P.items():
                cs.append(dict(cost_rt_bp=crt, markup=mk, set=k,
                               sharpe=sharpe(F.simulate(d, cost_rt=crt * 1e-4, markup=mk, **FINAL)[0].ret.loc[y0:y1])))
    cs = pd.DataFrame(cs)
    cs.to_csv(os.path.join(out, 'cost_stress.csv'), index=False, float_format='%.4f')

    # sizing variants of the EA (risk % per rule to a 3*ATR stop)
    sz = []
    for k, (d, y0, y1) in P.items():
        for label, cfg in [('fixed 0.5x/rule', dict()), ('risk 1%/rule', dict(sizing='risk', risk_per_rule=0.01, w_cap=1.5)),
                           ('risk 2%/rule', dict(sizing='risk', risk_per_rule=0.02, w_cap=1.5)),
                           ('risk 3%/rule', dict(sizing='risk', risk_per_rule=0.03, w_cap=1.5))]:
            eqdf, _ = F.simulate(d, **FINAL, **cfg)
            r = eqdf.ret.loc[y0:y1]
            sm = M.summarize_daily(r)
            sz.append(dict(set=k, sizing=label, sharpe=sm['sharpe'], cagr=sm['cagr'], maxdd=sm['maxdd'], vol=sm['vol'],
                           avg_notional_when_in=float(eqdf.expo.loc[y0:y1][eqdf.expo.loc[y0:y1] > 0].mean())))
    pd.DataFrame(sz).to_csv(os.path.join(out, 'sizing.csv'), index=False, float_format='%.4f')

    # ---------------- 5. multiple-testing control ----------------
    d, y0, y1 = P['SPX_IS']
    trial_srs = []
    for fn in list(R.PREREG.values()) + list(R.PLANNED.values()):
        r = B.run(d, fn(d), cost_rt=COST, markup=MARKUP).net.loc[y0:y1]; trial_srs.append(r.mean() / r.std())
    for _, s in sens[(sens.set == 'SPX_IS')].iterrows():
        trial_srs.append(s.sharpe / math.sqrt(252))
    for cfg in [dict(use_stop=False), dict(use_stop=True, stop_atr=2.0),
                dict(use_stop=True, stop_atr=3.0, sizing='risk', risk_per_rule=0.01, w_cap=1.5), dict(use_stop=False, max_hold_b=999)]:
        r = F.simulate(d, **cfg)[0].ret.loc[y0:y1]; trial_srs.append(r.mean() / r.std())
    n_trials = len(trial_srs) + 1
    dsr_is, sr_star = M.dsr(fin_rets['SPX_IS'], n_trials, float(np.var(trial_srs, ddof=1)))
    sig = dict(n_trials=n_trials, sr_star_annual=sr_star, dsr_is=dsr_is)
    oos_keys = [k for k in ['SPX_OOS', 'CFD'] if k in fin_rets]
    oos = pd.concat([fin_rets[k] for k in oos_keys])
    sr = oos.mean() / oos.std()
    sig.update(oos_sets=oos_keys, oos_sharpe=sr * math.sqrt(252), oos_days=len(oos), oos_t=sr * math.sqrt(len(oos)),
               oos_psr=M.psr(sr, len(oos), sst.skew(oos), sst.kurtosis(oos, fisher=False), 0.0))
    nd = fin_rets['NDQ']; s2 = nd.mean() / nd.std()
    sig.update(ndq_sharpe=s2 * math.sqrt(252), ndq_t=s2 * math.sqrt(len(nd)))
    spx_full = F.simulate(P['SPX_IS'][0], **FINAL)[0].ret.loc['1999':'2018']
    sig.update(corr_spx_ndq=float(spx_full.corr(nd)), port_spx_ndq_sharpe=sharpe(0.5 * spx_full + 0.5 * nd))

    # ---------------- 6. EA transcription parity (trade-for-trade) ----------------
    if 'CFD' in P:
        d, y0, y1 = P['CFD']
        em = EA.run(d)
        em = em[em.entry_date >= y0]
        _, tr = F.simulate(d, **FINAL)
        tr = tr[tr.entry_date >= y0]
        idx = d.index
        nxt = set(idx[np.searchsorted(idx, pd.to_datetime(tr.entry_date).values) + 1])
        sig.update(parity_sim_entries=len(nxt), parity_matched=len(nxt & set(pd.to_datetime(em.entry_date))),
                   parity_emulator_only=len(set(pd.to_datetime(em.entry_date)) - nxt))
    with open(os.path.join(out, 'significance.json'), 'w') as f:
        json.dump(sig, f, indent=1, default=float)

    # ---------------- 7. user CSV (optional) ----------------
    if a.csv:
        u = B.prep(DS.mt_csv(a.csv))
        eqdf, tr = F.simulate(u, **FINAL)
        r = eqdf.ret.iloc[250:]
        sm = M.summarize_daily(r)
        print('USER CSV', a.csv, M.fmt(sm, ['years', 'cagr', 'sharpe', 'maxdd', 't_stat']), 'trades', len(tr))

    figures(out, diag, sens, cs, fin_rets, bh_rets, pd.DataFrame(yearly), list(P))
    print(fin[['set', 'sharpe', 'sharpe_ci_lo', 'sharpe_ci_hi', 'cagr', 'maxdd', 'trades', 'win_rate', 'avg_trade_bp']].round(3).to_string(index=False))
    print(json.dumps(sig, indent=1, default=float))


def figures(out, diag, sens, cs, fin_rets, bh_rets, yearly, keys):
    # Fig 1: next-day return by IBS bucket (small multiples, one series each)
    labels = ['0–0.2', '0.2–0.4', '0.4–0.6', '0.6–0.8', '0.8–1']
    fig, axs = plt.subplots(1, len(keys), figsize=(3.1 * len(keys), 3.2), sharey=True)
    for ax, k in zip(np.atleast_1d(axs), keys):
        g = diag[(diag.set == k) & (diag['var'] == 'ibs')]
        ax.bar(range(5), g.mean_bp.values, width=0.62, color=SERIES[0], edgecolor=SURF, linewidth=2)
        ax.errorbar(range(5), g.mean_bp.values, yerr=1.96 * g.se_bp.values, fmt='none', ecolor=INK2, elinewidth=1, capsize=0)
        ax.axhline(0, color=BASE, lw=1)
        ax.set_xticks(range(5)); ax.set_xticklabels(labels, fontsize=8)
        ax.set_title(NAMES_JA[k], fontsize=9)
        ax.set_xlabel('当日の IBS（終値の位置）', fontsize=8.5)
    np.atleast_1d(axs)[0].set_ylabel('翌日の平均リターン（bp）')
    fig.suptitle('終値が安値圏（IBS が低い）ほど翌日は上がりやすい（縦線は 95% 信頼区間）', fontsize=11, x=0.01, ha='left')
    fig.tight_layout(); fig.savefig(os.path.join(out, 'fig1_ibs_buckets.png'), dpi=160); plt.close(fig)

    # Fig 2: equity curves, final logic vs buy-and-hold CFD (log scale)
    nr = 2 if len(keys) > 2 else 1
    nc = int(math.ceil(len(keys) / nr))
    fig, axs = plt.subplots(nr, nc, figsize=(5.2 * nc, 3.9 * nr))
    axs = np.atleast_1d(axs).ravel()
    for ax in axs[len(keys):]:
        ax.set_visible(False)
    for ax, k in zip(axs, keys):
        e1 = (1 + fin_rets[k]).cumprod(); e0 = (1 + bh_rets[k]).cumprod()
        ax.plot(e0.index, e0.values, color=MUTED, lw=1.4, label='買い持ち')
        ax.plot(e1.index, e1.values, color=SERIES[0], lw=2, label='本ロジック')
        ax.set_yscale('log')
        ax.set_title(NAMES_JA[k], fontsize=9.5, loc='left', pad=16)
        ax.text(0.0, 1.0, f"本ロジック SR {sharpe(fin_rets[k]):.2f}・最大DD {M.max_drawdown(e1.values)[0]*100:.0f}%"
                          f"　買い持ち SR {sharpe(bh_rets[k]):.2f}・最大DD {M.max_drawdown(e0.values)[0]*100:.0f}%",
                transform=ax.transAxes, va='bottom', fontsize=8, color=INK2)
        lo, hi = min(e0.min(), e1.min()), max(e0.max(), e1.max())
        ticks = [t for t in [0.2, 0.3, 0.5, 0.7, 1.0, 1.5, 2.0, 3.0, 5.0] if lo * 0.95 <= t <= hi * 1.05]
        ax.yaxis.set_major_locator(matplotlib.ticker.FixedLocator(ticks))
        ax.yaxis.set_major_formatter(matplotlib.ticker.FuncFormatter(lambda v, _: f'{v:g}'))
        ax.yaxis.set_minor_locator(matplotlib.ticker.NullLocator())
        ax.tick_params(axis='x', labelsize=8)
    for i in range(0, len(axs), nc):
        axs[i].set_ylabel('資産（開始=1、対数目盛）')
    h, l = axs[0].get_legend_handles_labels()
    fig.legend(h, l, loc='upper right', ncol=2, fontsize=9)
    fig.suptitle('資産曲線（コスト・CFD 金利控除後、本ロジックの建玉は最大 1 倍）', fontsize=11, x=0.01, ha='left')
    fig.tight_layout(rect=(0, 0, 1, 0.97)); fig.savefig(os.path.join(out, 'fig2_equity.png'), dpi=160); plt.close(fig)

    # Fig 3: IBS threshold sensitivity (plateau), Fig 4: cost stress -- 4 series, legend + direct labels
    for fname, df, xcol, title, xlabel in [
            ('fig3_sensitivity.png', sens[sens.family == 'ibs_threshold'], 'value',
             'IBS のしきい値を変えても成績は崩れない（ルール A 単体、1 日保有）', 'IBS のしきい値（これ未満で買い）'),
            ('fig4_cost.png', cs[cs.markup == 0.025], 'cost_rt_bp',
             '売買コストへの耐性（本ロジック）：往復 8bp まではプラス、12〜20bp で消える', '往復コスト（bp、スプレッド＋スリッページ）')]:
        fig, ax = plt.subplots(figsize=(7.2, 4.3))
        for i, k in enumerate(keys):
            g = df[df.set == k].sort_values(xcol)
            ax.plot(g[xcol], g.sharpe, color=SERIES[i], lw=2, marker='o', ms=4, label=NAMES_JA[k])
            ax.annotate(NAMES_JA[k].split('（')[0], (g[xcol].iloc[-1], g.sharpe.iloc[-1]), xytext=(6, 0),
                        textcoords='offset points', va='center', fontsize=7.5, color=INK2)
        ax.axhline(0, color=BASE, lw=1)
        if fname == 'fig4_cost.png':
            ax.axvline(4, color=MUTED, lw=1, ls=':')
            ax.text(4.3, ax.get_ylim()[1] * 0.95, '前提 4bp', fontsize=8, color=MUTED, va='top')
        ax.set_xlabel(xlabel); ax.set_ylabel('シャープレシオ（年率）')
        ax.set_title(title, loc='left')
        ax.legend(fontsize=7.5, loc='upper center', bbox_to_anchor=(0.5, -0.2), ncol=2)
        ax.margins(x=0.12)
        fig.tight_layout(); fig.savefig(os.path.join(out, fname), dpi=160); plt.close(fig)

    # Fig 5: yearly returns, S&P500 cash 1999-2018 then US500 CFD 2019-2025
    y = yearly[(yearly.set == 'SPX_IS') | (yearly.set == 'SPX_OOS') | (yearly.set == 'CFD')].sort_values('year')
    fig, ax = plt.subplots(figsize=(9, 3.4))
    ax.bar(y.year, y.ret * 100, width=0.66, color=SERIES[0], edgecolor=SURF, linewidth=2, label='本ロジック（最大 1 倍）')
    ax.plot(y.year, y.bh * 100, ls='none', marker='o', ms=4, color=MUTED, label='買い持ち（参考）')
    ax.axhline(0, color=BASE, lw=1)
    if (y.set == 'CFD').any():
        ax.axvline(2018.5, color=MUTED, lw=1, ls=':')
        ax.text(2018.6, ax.get_ylim()[1] * 0.92, 'ここから US500 CFD', fontsize=8, color=MUTED)
    ax.set_ylabel('年間リターン（%）'); ax.set_xticks(y.year); ax.tick_params(axis='x', labelsize=7.5, rotation=90)
    ax.set_title('年ごとの成績：負けた年は 2000〜2002 年（長い下落相場）、2018 年、2022〜2023 年', loc='left')
    ax.legend(fontsize=8, loc='upper left')
    fig.tight_layout(); fig.savefig(os.path.join(out, 'fig5_yearly.png'), dpi=160); plt.close(fig)


if __name__ == '__main__':
    main()
