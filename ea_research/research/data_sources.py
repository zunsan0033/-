"""Daily OHLC datasets used by the study, in a uniform format (columns o,h,l,c; tz-naive DatetimeIndex).

* spx_cash / ndq_cash : S&P 500 and NASDAQ Composite cash-session daily bars 1999-2018, bundled with the
                         PyPI package `arch` (pip install arch) -> no download needed.
* us500_cfd_duka      : Dukascopy USA500.IDX/USD daily BID candles (UTC days). Expects the raw yearly files
                         <root>/raw/USA500IDXUSD/day/<YYYY>_BID.bi5 (not redistributed in this repo).
* mt_csv              : any D1 history exported from MetaTrader (MT5 "Bars" export or MT4 History Center CSV),
                         so the study can be re-run on the broker's own US500 / NAS100 / GER40 ... data.
"""
import os
import pandas as pd

import duka_load


def _std(df, o='Open', h='High', l='Low', c='Close'):
    d = df.rename(columns={o: 'o', h: 'h', l: 'l', c: 'c'})[['o', 'h', 'l', 'c']].astype(float)
    d.index = pd.to_datetime(d.index)
    return d


def spx_cash():
    from arch.data import sp500
    return _std(sp500.load())


def ndq_cash():
    from arch.data import nasdaq
    return _std(nasdaq.load())


def us500_cfd_duka(root, start='2013-01-01'):
    """Daily BID bars; flat filler bars dropped; Sunday-evening bars merged into Monday."""
    duka_load.DATA = root
    c = duka_load.load('USA500IDXUSD', 'day', 'BID')
    if c.empty:
        return None
    c = c[c.index >= pd.Timestamp(start, tz='UTC')]
    c = c[c.h > c.l]
    c.index = c.index.tz_localize(None)
    rows, pending = [], None
    for ts, r in c.iterrows():
        if ts.dayofweek == 6:
            pending = r
            continue
        if ts.dayofweek == 5:
            continue
        if pending is not None and (ts - pending.name).days <= 1:
            r = r.copy()
            r['o'] = pending['o']; r['h'] = max(r['h'], pending['h']); r['l'] = min(r['l'], pending['l'])
        pending = None
        rows.append(r)
    d = pd.DataFrame(rows)[['o', 'h', 'l', 'c']]
    d.index.name = None
    return d


def mt_csv(path):
    """Read a MetaTrader D1 export.

    MT5 (Symbols > Bars > Export): tab separated with header <DATE> <TIME> <OPEN> <HIGH> <LOW> <CLOSE> ...
    MT4 (History Center > Export): comma separated, no header: Date,Time,Open,High,Low,Close,Volume
    Sunday bars (if the broker has them) are merged into Monday like the Dukascopy data.
    """
    with open(path, 'r', encoding='utf-8-sig', errors='replace') as f:
        head = f.readline()
    if '<DATE>' in head.upper():
        df = pd.read_csv(path, sep='\t')
        df.columns = [x.strip('<>').upper() for x in df.columns]
        dates = pd.to_datetime(df['DATE'].astype(str).str.replace('.', '-', regex=False))
        d = pd.DataFrame({'o': df['OPEN'], 'h': df['HIGH'], 'l': df['LOW'], 'c': df['CLOSE']}).astype(float)
    else:
        df = pd.read_csv(path, header=None)
        dates = pd.to_datetime(df[0].astype(str).str.replace('.', '-', regex=False))
        d = pd.DataFrame({'o': df[2], 'h': df[3], 'l': df[4], 'c': df[5]}).astype(float)
    d.index = dates.values
    d = d[~d.index.duplicated(keep='last')].sort_index()
    out, pend = [], None
    for ts, r in d.iterrows():
        if ts.dayofweek == 6:
            pend = r
            continue
        if ts.dayofweek == 5:
            continue
        if pend is not None and (ts - pend.name).days <= 1:
            r = r.copy(); r['o'] = pend['o']; r['h'] = max(r['h'], pend['h']); r['l'] = min(r['l'], pend['l'])
        pend = None
        out.append(r)
    return pd.DataFrame(out)


def default_sets(duka_root=None):
    """The four evaluation sets of the study: (dataframe, first year, last year, role)."""
    sets = {'SPX_IS': (spx_cash(), '1999', '2012', 'in-sample (rule selection)'),
            'SPX_OOS': (spx_cash(), '2013', '2018', 'out-of-sample in time'),
            'NDQ': (ndq_cash(), '1999', '2018', 'out-of-sample, other index')}
    if duka_root and os.path.isdir(duka_root):
        cfd = us500_cfd_duka(duka_root)
        if cfd is not None and len(cfd) > 300:
            sets['CFD'] = (cfd, '2019', '2025', 'holdout: US500 CFD, 24h bars')
    return sets
