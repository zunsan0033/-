"""Decode cached Dukascopy bi5 candle files into pandas DataFrames (UTC index).

Columns: o,h,l,c (BID or ASK), v. Zero-volume filler bars are dropped.
"""
import os, lzma, glob, datetime as dt
import numpy as np
import pandas as pd

DATA = os.environ.get('DUKA_DATA', os.path.join(os.path.dirname(__file__), '..', 'data'))
REC = np.dtype([('t', '>i4'), ('o', '>i4'), ('c', '>i4'), ('l', '>i4'), ('h', '>i4'), ('v', '>f4')])

# price scale (integer -> price). Dukascopy uses 1e5 for most FX, 1e3 for JPY pairs/metals/indices.
SCALE = {
    'USDJPY': 1e3, 'EURJPY': 1e3, 'GBPJPY': 1e3, 'AUDJPY': 1e3, 'CADJPY': 1e3, 'CHFJPY': 1e3, 'NZDJPY': 1e3,
    'XAUUSD': 1e3, 'XAGUSD': 1e3,
}


def scale_of(sym):
    if sym in SCALE:
        return SCALE[sym]
    if 'IDX' in sym or 'CMD' in sym or sym.endswith('TR'):
        return 1e3
    return 1e5


def _decode(path, base_ts, sym):
    with open(path, 'rb') as f:
        b = f.read()
    if not b:
        return None
    raw = lzma.decompress(b)
    a = np.frombuffer(raw, dtype=REC)
    if a.size == 0:
        return None
    sc = scale_of(sym)
    idx = pd.to_datetime(base_ts, utc=True) + pd.to_timedelta(a['t'].astype(np.int64), unit='s')
    df = pd.DataFrame({'o': a['o'] / sc, 'h': a['h'] / sc, 'l': a['l'] / sc, 'c': a['c'] / sc,
                       'v': a['v'].astype(np.float64)}, index=idx)
    return df


def load(sym, kind='hour', side='BID', keep_zero_volume=False):
    root = os.path.join(DATA, 'raw', sym, kind)
    parts = []
    if kind == 'hour':
        for p in sorted(glob.glob(os.path.join(root, '*', f'*_{side}.bi5'))):
            y = int(os.path.basename(os.path.dirname(p)))
            m = int(os.path.basename(p)[:2])
            d = _decode(p, dt.datetime(y, m + 1, 1), sym)
            if d is not None:
                parts.append(d)
    elif kind == 'min':
        for p in sorted(glob.glob(os.path.join(root, '*', f'*_{side}.bi5'))):
            y = int(os.path.basename(os.path.dirname(p)))
            md = os.path.basename(p)[:4]
            d = _decode(p, dt.datetime(y, int(md[:2]), int(md[2:])), sym)
            if d is not None:
                parts.append(d)
    elif kind == 'day':
        for p in sorted(glob.glob(os.path.join(root, f'*_{side}.bi5'))):
            y = int(os.path.basename(p)[:4])
            d = _decode(p, dt.datetime(y, 1, 1), sym)
            if d is not None:
                parts.append(d)
    if not parts:
        return pd.DataFrame(columns=['o', 'h', 'l', 'c', 'v'])
    df = pd.concat(parts).sort_index()
    df = df[~df.index.duplicated(keep='last')]
    if not keep_zero_volume:
        df = df[df['v'] > 0]
    return df


def load_bidask(sym, kind='hour'):
    """Return DataFrame with bid OHLC (o,h,l,c), ask OHLC (ao,ah,al,ac), v. Inner-joined on time."""
    b = load(sym, kind, 'BID')
    a = load(sym, kind, 'ASK')
    a = a.rename(columns={'o': 'ao', 'h': 'ah', 'l': 'al', 'c': 'ac', 'v': 'av'})
    df = b.join(a[['ao', 'ah', 'al', 'ac']], how='inner')
    return df
