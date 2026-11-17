"""Pre-registered daily strategies (parameters fixed from literature). pos[t] = position from close t to close t+1."""
import numpy as np, pandas as pd

def state_machine(d, entry, exit_, max_hold=None):
    pos = np.zeros(len(d)); inpos = False; held = 0
    en = entry.values; ex = exit_.values
    for t in range(len(d)):
        if inpos:
            held += 1
            if ex[t] or (max_hold is not None and held >= max_hold):
                inpos = False
        if not inpos and en[t]:
            inpos = True; held = 0
        pos[t] = 1.0 if inpos else 0.0
    return pd.Series(pos, index=d.index)

def B0_buyhold(d):   return pd.Series(1.0, index=d.index)
def S1_ibs1d(d):     return (d.ibs < 0.2).astype(float)
def S2_ibs_hold(d):  return state_machine(d, d.ibs < 0.2, d.c > d.prev_h, max_hold=10)
def S3_rsi2(d):      return state_machine(d, (d.c > d.sma200) & (d.rsi2 < 10), d.c > d.sma5)
def S4_double7(d):   return state_machine(d, (d.c > d.sma200) & (d.c <= d.low7), d.c >= d.high7)
def S5_tom(d):       return (d.tdm_rev.isin([-2, -1]) | d.tdm.isin([1, 2])).astype(float)
def S6_sma200(d):    return (d.c > d.sma200).astype(float)
def S7_ibs_short(d): return -(d.ibs > 0.8).astype(float)

PREREG = dict(B0_buyhold=B0_buyhold, S1_ibs1d=S1_ibs1d, S2_ibs_hold=S2_ibs_hold, S3_rsi2=S3_rsi2,
              S4_double7=S4_double7, S5_tom=S5_tom, S6_sma200=S6_sma200, S7_ibs_short=S7_ibs_short)

# ---- planned composite variants (defined before looking at their results) ----
def C1_ens_ibs_rsi(d):   return 0.5 * S1_ibs1d(d) + 0.5 * S3_rsi2(d)
def C2_mr_committee(d):  return (S1_ibs1d(d) + S2_ibs_hold(d) + S3_rsi2(d) + S4_double7(d)) / 4.0
def C3_committee_vol(d, target=0.15, cap=2.0):
    w = (target / np.sqrt(252) / d.vol20).clip(upper=cap).fillna(0.0)
    return C2_mr_committee(d) * w
def C4_ibs_hold_trend(d): return state_machine(d, (d.ibs < 0.2) & (d.c > d.sma200), d.c > d.prev_h, max_hold=10)
def C5_committee_tom(d):  return (S1_ibs1d(d) + S2_ibs_hold(d) + S3_rsi2(d) + S4_double7(d) + S5_tom(d)) / 5.0

PLANNED = dict(C1_ens_ibs_rsi=C1_ens_ibs_rsi, C2_mr_committee=C2_mr_committee, C3_committee_vol=C3_committee_vol,
               C4_ibs_hold_trend=C4_ibs_hold_trend, C5_committee_tom=C5_committee_tom)
