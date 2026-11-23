"""Round-6 cross-check, independent of cand6.local_bars: the next day's close-to-close return after a weak close
(IBS < 0.2) against all other days, with the day cut at the local cash close and at the server-day end.

  python -I cand6_check.py <M5 folder> [<M5 folder> ...] --d1 <D1 folder>
"""
import argparse, math, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pandas as pd

import broker_data as BD
from cand_a import SERVER_TZ
from cand6 import SESS

START = pd.Timestamp('2017-10-28')


def tstat(x):
    return x.mean() / x.std(ddof=1) * math.sqrt(len(x))


def line(label, z):
    a, b = z.next[z.ibs < 0.2], z.next[z.ibs >= 0.2]
    print(f'{label}: after IBS<0.2 {a.mean() * 1e4:+6.1f} bp (n={len(a)}, t={tstat(a):+.2f}) | other days {b.mean() * 1e4:+5.1f} bp (n={len(b)})')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('m5', nargs='+')
    ap.add_argument('--d1', required=True)
    a = ap.parse_args()
    m5 = {}
    for folder in a.m5:
        raw, _ = BD.load_dir(folder, 'M5'); m5.update(BD.to_generic(raw))
    raw, _ = BD.load_dir(a.d1, 'D1'); d1 = BD.to_generic(raw)
    for sym in ['JP225', 'GER40']:
        if sym not in m5:
            continue
        d = m5[sym]; tz, s0, segs, _ = SESS[sym]
        lt = d.index.tz_localize(SERVER_TZ, ambiguous='NaT', nonexistent='shift_forward').tz_convert(tz)
        x = d[lt.notna()].copy(); x.index = lt[lt.notna()].tz_localize(None)
        rows = []
        for day, g in x.groupby(x.index.normalize()):
            if day.dayofweek > 4:
                continue
            s1 = [e for f, e in segs if f is None or day >= pd.Timestamp(f)][-1]
            m = g.index.hour * 60 + g.index.minute
            s = g[(m >= s0) & (m < s1)]
            if len(s) < (s1 - s0) // 5 - 3 or len(s) == 0:
                continue
            ms = s.index.hour * 60 + s.index.minute
            if ms.min() != s0 or ms.max() != s1 - 5:
                continue
            rows.append((day, s.h.max(), s.l.min(), s.c.iloc[-1]))
        q = pd.DataFrame(rows, columns=['day', 'h', 'l', 'c']).set_index('day')
        q['ibs'] = (q.c - q.l) / (q.h - q.l)
        q['next'] = q.c.shift(-1) / q.c - 1
        q = q.loc[START:].dropna()
        mid = q.index[0] + (q.index[-1] - q.index[0]) / 2
        line(f'{sym} local close, full       ', q)
        line(f'{sym} local close, first half ', q.loc[:mid])
        line(f'{sym} local close, second half', q.loc[mid:])
        s = d1[sym]
        z = pd.DataFrame({'ibs': (s.c - s.l) / (s.h - s.l), 'next': s.c.shift(-1) / s.c - 1}).loc[START:].dropna()
        line(f'{sym} server day,  full       ', z)


if __name__ == '__main__':
    main()
