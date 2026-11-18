"""Load daily bars exported from MetaTrader 5 by the user's broker.

Accepted layouts (auto-detected from the header line):
  * comma separated: time,open,high,low,close,tick_volume,spread,real_volume   (time = 'YYYY-MM-DD HH:MM:SS')
  * ExportBars.mq5 / MT5 'Bars > Export': <DATE> <TIME> <OPEN> <HIGH> <LOW> <CLOSE> <TICKVOL> <VOL> <SPREAD>

Cleaning (same rules as the Dukascopy CFD data of the study):
  * Sunday bars (short sessions on some weeks) are merged into the following Monday bar.
  * Saturday bars and flat bars (high == low) are dropped.
Output columns: o, h, l, c, tv (tick volume), spr (spread in points), index = server date (tz-naive).
"""
import glob
import os
import re

import numpy as np
import pandas as pd


def read_bars(path):
    with open(path, 'r', encoding='utf-8-sig', errors='replace') as f:
        head = f.readline()
    if '<DATE>' in head.upper():
        df = pd.read_csv(path, sep='\t')
        df.columns = [c.strip('<>').upper() for c in df.columns]
        t = pd.to_datetime(df['DATE'].astype(str).str.replace('.', '-', regex=False) + ' ' + df['TIME'].astype(str))
        d = pd.DataFrame({'o': df['OPEN'], 'h': df['HIGH'], 'l': df['LOW'], 'c': df['CLOSE'],
                          'tv': df.get('TICKVOL', 0), 'spr': df.get('SPREAD', 0)})
    else:
        df = pd.read_csv(path)
        df.columns = [c.strip().lower() for c in df.columns]
        t = pd.to_datetime(df['time'])
        d = pd.DataFrame({'o': df['open'], 'h': df['high'], 'l': df['low'], 'c': df['close'],
                          'tv': df.get('tick_volume', 0), 'spr': df.get('spread', 0)})
    d.index = pd.DatetimeIndex(t.values)
    d = d.astype(float)
    return d[~d.index.duplicated(keep='last')].sort_index()


def clean_daily(d):
    """Merge Sunday bars into Monday, drop Saturday and flat bars. Returns (clean, report dict)."""
    rep = {'raw': len(d), 'sunday_merged': 0, 'saturday_dropped': 0, 'flat_dropped': 0}
    rows, pend = [], None
    for ts, r in d.iterrows():
        dow = ts.dayofweek
        if dow == 5:
            rep['saturday_dropped'] += 1
            continue
        if dow == 6:
            pend = r
            continue
        if pend is not None and (ts.normalize() - pend.name.normalize()).days == 1:
            r = r.copy()
            r['o'] = pend['o']; r['h'] = max(r['h'], pend['h']); r['l'] = min(r['l'], pend['l'])
            r['tv'] = r['tv'] + pend['tv']
            rep['sunday_merged'] += 1
        pend = None
        rows.append(r)
    out = pd.DataFrame(rows)
    flat = out.h <= out.l
    rep['flat_dropped'] = int(flat.sum())
    out = out[~flat]
    out.index = pd.DatetimeIndex(out.index).normalize()
    out.index.name = None
    rep['clean'] = len(out)
    return out, rep


def load_dir(folder, tf='D1'):
    """Return {symbol: cleaned DataFrame} for every '<SYMBOL>_<tf>*.csv' in folder."""
    out, reps = {}, {}
    for p in sorted(glob.glob(os.path.join(folder, f'*_{tf}*.csv'))):
        sym = re.split(rf'_{tf}', os.path.basename(p))[0]
        d = read_bars(p)
        if tf == 'D1':
            d, rep = clean_daily(d)
        else:
            rep = {'raw': len(d)}
        out[sym] = d
        reps[sym] = rep
    return out, reps


# generic names used in the study -> substrings that identify the broker symbol
GENERIC = {
    'US500': ['US500', 'SPX500', 'SP500'], 'US100': ['US100', 'NAS100', 'USTEC'], 'US30': ['US30', 'DJ30'],
    'US2000': ['US2000', 'RUS2000'], 'GER40': ['GER40', 'DE40', 'GER30', 'DAX'], 'JP225': ['JP225', 'JPN225'],
    'UK100': ['UK100', 'FTSE'], 'EU50': ['EU50', 'STOXX50'], 'XAUUSD': ['XAUUSD', 'GOLD'],
    'XAGUSD': ['XAGUSD', 'SILVER'], 'WTI': ['WTI', 'USOIL', 'OIL'], 'BRENT': ['BRENT', 'UKOIL'],
    'EURUSD': ['EURUSD'], 'USDJPY': ['USDJPY'], 'GBPUSD': ['GBPUSD'], 'AUDUSD': ['AUDUSD'], 'USDCAD': ['USDCAD'],
    'USDCHF': ['USDCHF'], 'NZDUSD': ['NZDUSD'],
}


def to_generic(data):
    """Rename broker symbols (e.g. 'US500Cash', 'GOLDmicro') to the study's generic names."""
    out = {}
    taken = set()
    for gen in ['BRENT', 'WTI', 'US2000', 'US500', 'US100', 'US30', 'GER40', 'JP225', 'UK100', 'EU50', 'XAUUSD',
                'XAGUSD', 'EURUSD', 'USDJPY', 'GBPUSD', 'AUDUSD', 'USDCAD', 'USDCHF', 'NZDUSD']:
        for sym in data:
            if sym in taken:
                continue
            if any(k.upper() in sym.upper() for k in GENERIC[gen]):
                out[gen] = data[sym]
                taken.add(sym)
                break
    return out
