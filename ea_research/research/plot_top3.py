"""Figure for the top-3 candidate results (reads the CSVs written by cand_a.py / cand_b.py / cand_c.py).

  python plot_top3.py [--res ../results]
"""
import argparse, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.gridspec import GridSpec

from run_all import style, INK2, MUTED, BASE, SURF, SERIES

NAME = {'US500': 'S&P500', 'US100': 'NASDAQ100', 'US30': 'ダウ', 'US2000': 'ラッセル2000', 'GER40': 'DAX',
        'EU50': 'STOXX50', 'UK100': 'FTSE100', 'JP225': '日経平均'}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--res', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'results'))
    a = ap.parse_args()
    style()
    c = pd.read_csv(os.path.join(a.res, 'cand_c_summary.csv'))
    c = c[c.sizing == 'fixed'].sort_values('sharpe')
    asum = pd.read_csv(os.path.join(a.res, 'cand_a_summary.csv'))
    asum = asum[asum.period == 'full'].set_index('index').loc[['US500', 'US100', 'US30', 'GER40']]
    ea = pd.read_csv(os.path.join(a.res, 'cand_c_daily_returns.csv'), index_col=0, parse_dates=True)['US500']
    am = pd.read_csv(os.path.join(a.res, 'cand_a_daily_returns.csv'), index_col=0, parse_dates=True)['US100']
    tm = pd.read_csv(os.path.join(a.res, 'cand_b_daily_returns.csv'), index_col=0, parse_dates=True)['tsmom12_net']

    fig = plt.figure(figsize=(11.5, 8.2))
    gs = GridSpec(2, 2, figure=fig, height_ratios=[1, 1.05], hspace=0.55, wspace=0.42)

    ax = fig.add_subplot(gs[0, 0])
    y = np.arange(len(c))
    ax.barh(y, c.sharpe, height=0.62, color=SERIES[0], edgecolor=SURF, linewidth=2)
    for yi, v in zip(y, c.sharpe):
        ax.text(v + 0.02 if v >= 0 else v - 0.02, yi, f'{v:.2f}', va='center', ha='left' if v >= 0 else 'right', fontsize=8, color=INK2)
    ax.set_yticks(y); ax.set_yticklabels([NAME[s] for s in c['index']], fontsize=9)
    ax.axvline(0, color=BASE, lw=1)
    ax.set_xlabel('シャープレシオ（2015〜2026 年、コスト・金利後）')
    ax.set_title('C：今の EA をそのまま他の指数へ', loc='left', fontsize=10)
    ax.set_xlim(min(-0.1, c.sharpe.min() - 0.15), c.sharpe.max() + 0.25)

    ax = fig.add_subplot(gs[0, 1])
    y = np.arange(len(asum))
    h = 0.36
    ax.barh(y + h / 2, asum.sharpe_zero_cost, height=h, color=SERIES[1], edgecolor=SURF, linewidth=1.5, label='コストなし（参考）')
    ax.barh(y - h / 2, asum.sharpe, height=h, color=SERIES[0], edgecolor=SURF, linewidth=1.5, label='コスト後')
    for yi, v0, v1 in zip(y, asum.sharpe_zero_cost, asum.sharpe):
        for yy, v in [(yi + h / 2, v0), (yi - h / 2, v1)]:
            ax.text(v + 0.03 if v >= 0 else v - 0.03, yy, f'{v:.2f}', va='center', ha='left' if v >= 0 else 'right', fontsize=8, color=INK2)
    ax.set_yticks(y); ax.set_yticklabels([NAME[s] for s in asum.index], fontsize=9)
    ax.axvline(0, color=BASE, lw=1)
    ax.set_xlabel('シャープレシオ（2016〜2026 年）')
    ax.set_title('A：日中モメンタム（優位性はあるがコストで目減り）', loc='left', fontsize=10)
    ax.legend(fontsize=8, loc='upper center', bbox_to_anchor=(0.5, -0.24), ncol=2)
    ax.set_xlim(min(asum.sharpe.min(), asum.sharpe_zero_cost.min()) - 0.35, max(asum.sharpe_zero_cost.max(), 1.0) + 0.35)

    ax = fig.add_subplot(gs[1, :])
    start = am.index[0]
    curves = [('今の EA（S&P500、日足逆張り）', ea, SERIES[0]), ('A：日中モメンタム（NASDAQ100）', am, SERIES[1]),
              ('B：15 銘柄のトレンドフォロー', tm, SERIES[2])]
    for label, r, col in curves:
        e = (1 + r.loc[start:].fillna(0.0)).cumprod()
        ax.plot(e.index, e.values, color=col, lw=2, label=label)
        ax.annotate(label.split('：')[0] if '：' in label else '今の EA', (e.index[-1], e.values[-1]), xytext=(6, 0),
                    textcoords='offset points', va='center', fontsize=8, color=INK2)
    ax.set_yscale('log')
    ticks = [0.5, 0.7, 1.0, 1.5, 2.0, 3.0]
    ax.yaxis.set_major_locator(matplotlib.ticker.FixedLocator(ticks))
    ax.yaxis.set_major_formatter(matplotlib.ticker.FuncFormatter(lambda v, _: f'{v:g}'))
    ax.yaxis.set_minor_locator(matplotlib.ticker.NullLocator())
    ax.axhline(1.0, color=BASE, lw=1)
    ax.set_ylabel('資産（開始=1、対数目盛）')
    ax.set_title('資産の推移（2016 年 11 月〜2026 年 11 月、いずれもコスト・金利後。建玉の大きさは各戦略の設定どおり）', loc='left', fontsize=10)
    ax.legend(fontsize=8, loc='upper left')
    ax.margins(x=0.06)
    fig.suptitle('上位 3 候補の検証結果（利用中の業者の MT5 データ）', fontsize=12, x=0.01, ha='left')
    fig.savefig(os.path.join(a.res, 'fig6_top3.png'), dpi=160, bbox_inches='tight')
    print('saved', os.path.join(a.res, 'fig6_top3.png'))


if __name__ == '__main__':
    main()
