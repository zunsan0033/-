"""Literal Python transcription of IntradayMomentum_EA.mq5 (its own clock conversion, NYSE calendar, session
building, decision rule and protective stop), used to cross-check the EA against research/cand_a.py.

Execution model for the comparison: the EA decides on the first tick after a decision time using the bar that
closed at that time; here that order fills at the close of that bar (the research convention).
"""
import datetime as dt
import numpy as np
import pandas as pd

DST_EU, DST_US, DST_NONE = 0, 1, 2


def _nth_weekday(y, mo, wd_sun0, n):          # wd_sun0: 0 = Sunday (MQL convention)
    first = dt.datetime(y, mo, 1)
    dow = (first.weekday() + 1) % 7
    return first + dt.timedelta(days=(wd_sun0 - dow) % 7 + 7 * (n - 1))


def _last_weekday(y, mo, wd_sun0):
    nxt = dt.datetime(y + 1, 1, 1) if mo == 12 else dt.datetime(y, mo + 1, 1)
    last = nxt - dt.timedelta(days=1)
    dow = (last.weekday() + 1) % 7
    return last - dt.timedelta(days=(dow - wd_sun0) % 7)


def us_dst_utc(u):
    return _nth_weekday(u.year, 3, 0, 2) + dt.timedelta(hours=7) <= u < _nth_weekday(u.year, 11, 0, 1) + dt.timedelta(hours=6)


def eu_dst_utc(u):
    return _last_weekday(u.year, 3, 0) + dt.timedelta(hours=1) <= u < _last_weekday(u.year, 10, 0) + dt.timedelta(hours=1)


def server_to_ny(srv, winter=2, rule=DST_EU):
    u = srv - dt.timedelta(hours=winter)
    d = eu_dst_utc(u) if rule == DST_EU else (us_dst_utc(u) if rule == DST_US else False)
    utc = u - dt.timedelta(hours=1) if d else u
    return utc - dt.timedelta(hours=4 if us_dst_utc(utc) else 5)


def _easter(y):
    a = y % 19; b = y // 100; c = y % 100; d = b // 4; e = b % 4
    f = (b + 8) // 25; g = (b - f + 1) // 3; h = (19 * a + b - d - g + 15) % 30
    i = c // 4; k = c % 4; l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    return dt.datetime(y, (h + l - 7 * m + 114) // 31, ((h + l - 7 * m + 114) % 31) + 1)


def _key(t):
    return t.year * 10000 + t.month * 100 + t.day


def _observed(y, mo, d):
    t = dt.datetime(y, mo, d)
    w = (t.weekday() + 1) % 7
    if w == 6:
        t -= dt.timedelta(days=1)
    if w == 0:
        t += dt.timedelta(days=1)
    return _key(t)


def is_nyse_holiday(key):
    y = key // 10000
    hol = []
    if (dt.datetime(y, 1, 1).weekday() + 1) % 7 != 6:
        hol.append(_observed(y, 1, 1))
    hol += [_key(_nth_weekday(y, 1, 1, 3)), _key(_nth_weekday(y, 2, 1, 3)), _key(_easter(y) - dt.timedelta(days=2)),
            _key(_last_weekday(y, 5, 1))]
    if y >= 2022:
        hol.append(_observed(y, 6, 19))
    hol += [_observed(y, 7, 4), _key(_nth_weekday(y, 9, 1, 1)), _key(_nth_weekday(y, 11, 4, 4)), _observed(y, 12, 25),
            20181205, 20250109]
    return key in hol


def is_nyse_half_day(key):
    y = key // 10000
    if key == _key(_nth_weekday(y, 11, 4, 4) + dt.timedelta(days=1)):
        return True
    d24 = dt.datetime(y, 12, 24)
    if key == _key(d24) and d24.weekday() <= 4:
        return True
    d3, d4 = dt.datetime(y, 7, 3), dt.datetime(y, 7, 4)
    return key == _key(d3) and d3.weekday() <= 4 and d4.weekday() <= 4


def build_sessions(df, s0=570, s1=960, winter=2, rule=DST_EU):
    """df: M5 bars indexed by naive server time with columns o,h,l,c,tv. Returns {key: dict of arrays}."""
    n = (s1 - s0) // 5
    days = {}
    for ts, o, h, l, c, tv in zip(df.index, df.o.values, df.h.values, df.l.values, df.c.values, df.tv.values):
        ny = server_to_ny(ts.to_pydatetime(), winter, rule)
        mins = ny.hour * 60 + ny.minute
        if mins < s0 or mins >= s0 + 5 * n:
            continue
        k = (mins - s0) // 5
        key = _key(ny)
        d = days.get(key)
        if d is None:
            d = days[key] = {a: np.zeros(n) for a in ('o', 'h', 'l', 'c', 'tv')}
            d['has'] = np.zeros(n, dtype=bool)
        d['o'][k], d['h'][k], d['l'][k], d['c'][k], d['tv'][k], d['has'][k] = o, h, l, c, tv, True
    return days, n


def is_complete(d, n):
    return bool(d['has'][0] and d['has'][n - 1] and (~d['has']).sum() <= 3)


def fill_forward(d, n):
    d = {a: v.copy() for a, v in d.items()}
    for k in range(1, n):
        if not d['has'][k]:
            d['c'][k] = d['c'][k - 1]; d['h'][k] = d['c'][k]; d['l'][k] = d['c'][k]; d['tv'][k] = 0.0
    return d


def run(df, s0=570, s1=960, L=14, target=0.02, max_lev=4.0, scale=1.0, stop_pct=0.02, skip_holidays=True,
        spr_bp=None, slip_bp=0.5):
    """Day-by-day emulation. Returns DataFrame (key, ret, lev, trades) and the trade list."""
    days, n = build_sessions(df, s0, s1)
    keys = sorted(days)
    complete = [k for k in keys if is_complete(days[k], n)]
    slots = list(range(s0 + 30, s1 - 29, 30))
    rows, trades = [], []
    for key in keys:
        today = days[key]
        if not today['has'][0]:
            continue
        prev = [k for k in complete if k < key][-(L + 1):][::-1]          # newest first
        if len(prev) < L + 1:
            continue
        td = fill_forward(today, n)
        P = {k: fill_forward(days[k], n) for k in prev}
        rets = np.array([P[prev[m]]['c'][n - 1] / P[prev[m + 1]]['c'][n - 1] - 1 for m in range(L)])
        vol = rets.std(ddof=1)
        if vol <= 0:
            continue
        lev = min(max_lev, target / vol) * scale
        pc = P[prev[0]]['c'][n - 1]
        op = td['o'][0]
        holiday = skip_holidays and (is_nyse_holiday(key) or is_nyse_half_day(key))
        pos, entry, ek, pnl, ntr = 0, 0.0, -1, 0.0, 0
        cost = lambda k: 0.0 if spr_bp is None else (spr_bp / 2 + slip_bp) / 1e4

        def close(k, px, why):
            nonlocal pos, pnl
            r = (px / entry - 1) if pos == 1 else (1 - px / entry)
            pnl += r - cost(k)
            trades.append((key, pos, ek, k, entry, px, why))
            pos = 0

        last_k = n - 1 if today['has'][n - 1] else int(np.where(today['has'])[0].max())
        first_k = (slots[0] - s0) // 5 - 1
        for k in range(first_k, last_k + 1):
            if pos != 0 and stop_pct > 0 and k > ek and today['has'][k]:
                if pos == 1 and td['l'][k] <= entry * (1 - stop_pct):
                    sp = entry * (1 - stop_pct)
                    close(k, td['o'][k] if td['o'][k] < sp else sp, 'stop')
                elif pos == -1 and td['h'][k] >= entry * (1 + stop_pct):
                    sp = entry * (1 + stop_pct)
                    close(k, td['o'][k] if td['o'][k] > sp else sp, 'stop')
            slot_min = s0 + (k + 1) * 5
            if slot_min not in slots:
                continue
            kd = k
            sigma = np.mean([abs(P[prev[m]]['c'][kd] / P[prev[m]]['o'][0] - 1) for m in range(L)])
            ub = max(op, pc) * (1 + sigma); lb = min(op, pc) * (1 - sigma)
            w = np.maximum(td['tv'][:kd + 1], 1.0)
            vwap = float(np.sum((td['h'][:kd + 1] + td['l'][:kd + 1] + td['c'][:kd + 1]) / 3.0 * w) / np.sum(w))
            p = td['c'][kd]
            want = 1 if p > max(ub, vwap) else (-1 if p < min(lb, vwap) else 0)
            if holiday:
                want = 0
            if want == pos:
                continue
            if pos != 0:
                close(k, p, 'rule')
            if want != 0:
                pos, entry, ek = want, p, k
                pnl -= cost(k); ntr += 1
        if pos != 0:
            close(last_k, td['c'][last_k], 'close')
        rows.append((key, lev * pnl, lev, ntr))
    out = pd.DataFrame(rows, columns=['key', 'ret', 'lev', 'trades'])
    out.index = pd.to_datetime(out.key.astype(str))
    return out, pd.DataFrame(trades, columns=['key', 'side', 'ek', 'xk', 'entry', 'exit', 'why'])
