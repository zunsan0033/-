"""Performance statistics: Sharpe, t-stat, drawdown, PSR/DSR, bootstrap CIs."""
import math
import numpy as np
import pandas as pd
from scipy import stats as st

EULER_GAMMA = 0.5772156649015329


def ann_factor(freq='D'):
    return {'D': 252, 'W': 52, 'M': 12}[freq]


def max_drawdown(equity):
    eq = np.asarray(equity, dtype=float)
    peak = np.maximum.accumulate(eq)
    dd = eq / peak - 1.0
    return dd.min(), dd


def summarize_daily(ret, name='', rf=0.0, pos=None):
    """ret: pd.Series of daily strategy returns (fraction of equity), index = dates (all trading days)."""
    r = pd.Series(ret).dropna()
    n = len(r)
    if n < 2:
        return {}
    mu, sd = r.mean(), r.std(ddof=1)
    sr_d = mu / sd if sd > 0 else np.nan
    eq = (1 + r).cumprod()
    mdd, _ = max_drawdown(eq.values)
    years = n / 252.0
    cagr = eq.iloc[-1] ** (1 / years) - 1 if eq.iloc[-1] > 0 else -1.0
    downside = r[r < 0].std(ddof=1)
    skew = st.skew(r)
    kurt = st.kurtosis(r, fisher=False)
    out = dict(name=name, days=n, years=round(years, 2), cagr=cagr, vol=sd * math.sqrt(252),
               sharpe=sr_d * math.sqrt(252), sortino=(mu / downside * math.sqrt(252)) if downside > 0 else np.nan,
               maxdd=mdd, calmar=(cagr / -mdd) if mdd < 0 else np.nan, skew=skew, kurt=kurt,
               t_stat=sr_d * math.sqrt(n), psr0=psr(sr_d, n, skew, kurt, 0.0),
               pct_days_active=float((pd.Series(pos).reindex(r.index).abs() > 0).mean()) if pos is not None else float((r != 0).mean()))
    return out


def psr(sr, n, skew, kurt, sr_star=0.0):
    """Probabilistic Sharpe Ratio (Bailey & Lopez de Prado 2012). sr, sr_star are per-period (non-annualized)."""
    if not np.isfinite(sr) or n < 3:
        return np.nan
    denom = math.sqrt(max(1e-12, 1 - skew * sr + (kurt - 1) / 4.0 * sr * sr))
    z = (sr - sr_star) * math.sqrt(n - 1) / denom
    return float(st.norm.cdf(z))


def expected_max_sr(n_trials, var_sr):
    """Expected maximum Sharpe (per-period) among n_trials independent trials with SR variance var_sr under H0."""
    if n_trials < 2:
        return 0.0
    z1 = st.norm.ppf(1 - 1.0 / n_trials)
    z2 = st.norm.ppf(1 - 1.0 / (n_trials * math.e))
    return math.sqrt(var_sr) * ((1 - EULER_GAMMA) * z1 + EULER_GAMMA * z2)


def dsr(ret, n_trials, var_sr_trials):
    """Deflated Sharpe Ratio (Bailey & Lopez de Prado 2014). var_sr_trials = variance of per-period SRs across trials."""
    r = pd.Series(ret).dropna()
    n = len(r)
    sr = r.mean() / r.std(ddof=1)
    sr_star = expected_max_sr(n_trials, var_sr_trials)
    return psr(sr, n, st.skew(r), st.kurtosis(r, fisher=False), sr_star), sr_star * math.sqrt(252)


def stationary_bootstrap_sharpe(ret, n_boot=2000, mean_block=20, seed=0):
    """Politis-Romano stationary bootstrap CI for annualized Sharpe."""
    r = np.asarray(pd.Series(ret).dropna(), dtype=float)
    n = len(r)
    rng = np.random.default_rng(seed)
    p = 1.0 / mean_block
    out = np.empty(n_boot)
    for b in range(n_boot):
        idx = np.empty(n, dtype=np.int64)
        i = rng.integers(n)
        for k in range(n):
            if k > 0 and rng.random() < p:
                i = rng.integers(n)
            idx[k] = i
            i = (i + 1) % n
        x = r[idx]
        s = x.std(ddof=1)
        out[b] = x.mean() / s * math.sqrt(252) if s > 0 else 0.0
    return np.percentile(out, [2.5, 50, 97.5]), float((out <= 0).mean())


def summarize_trades(pnl, name=''):
    """pnl: array-like of per-trade returns (fraction, after costs)."""
    p = np.asarray(pnl, dtype=float)
    n = len(p)
    if n == 0:
        return dict(name=name, trades=0)
    wins, losses = p[p > 0], p[p <= 0]
    pf = wins.sum() / -losses.sum() if losses.sum() < 0 else np.inf
    sd = p.std(ddof=1) if n > 1 else np.nan
    return dict(name=name, trades=n, win_rate=len(wins) / n, avg=p.mean(), median=np.median(p),
                avg_win=wins.mean() if len(wins) else 0.0, avg_loss=losses.mean() if len(losses) else 0.0,
                profit_factor=pf, t_stat=p.mean() / sd * math.sqrt(n) if sd and sd > 0 else np.nan)


def yearly_table(ret):
    r = pd.Series(ret).dropna()
    g = r.groupby(r.index.year)
    return pd.DataFrame({'ret': g.apply(lambda x: (1 + x).prod() - 1),
                         'sharpe': g.apply(lambda x: x.mean() / x.std(ddof=1) * math.sqrt(252) if x.std(ddof=1) > 0 else np.nan),
                         'maxdd': g.apply(lambda x: max_drawdown((1 + x).cumprod().values)[0])})


def fmt(d, keys=None):
    keys = keys or list(d.keys())
    parts = []
    for k in keys:
        v = d.get(k)
        if isinstance(v, float):
            if k in ('cagr', 'vol', 'maxdd', 'win_rate', 'pct_days_active'):
                parts.append(f'{k}={v*100:.1f}%')
            elif k in ('avg', 'median', 'avg_win', 'avg_loss'):
                parts.append(f'{k}={v*1e4:.1f}bp')
            else:
                parts.append(f'{k}={v:.2f}')
        else:
            parts.append(f'{k}={v}')
    return ' '.join(parts)
