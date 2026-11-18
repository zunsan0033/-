//+------------------------------------------------------------------+
//|                                              IndexGrowth_EA.mq5  |
//|  Small-account growth version of IndexPortfolio_EA (one chart): |
//|    1. IndexReversion  on the S&P500 symbol   (daily, long only)  |
//|    2. IndexReversion  on the NASDAQ100 symbol (daily, long only) |
//|    3. IntradayMomentum on the NASDAQ100 symbol (intraday, both)  |
//|  Same signals, magic numbers and global-variable names as         |
//|  IndexPortfolio_EA. Differences (sizing only): per-symbol rule |
//|  switches (NASDAQ100 rule B off), 1.0x notional per rule,         |
//|  IntradayMomentum at the research size, minimum-lot acceptance   |
//|  under exposure caps, and a pause of new entries after a 50%     |
//|  drawdown from the equity peak. Do not run together with the     |
//|  other EAs of this research on the same account.                 |
//|  Attach to any chart (the NASDAQ100 chart is recommended).       |
//|  Needs a HEDGING account when an IndexReversion module is on.    |
//|  Research notes: ea_research/REPORT.md chapter 11.               |
//+------------------------------------------------------------------+
#property copyright "IndexReversion research build"
#property version   "1.00"
#property description "Small-account growth set-up of the three index strategies, from one chart."

#include <Trade\Trade.mqh>

#define MAXK 128

enum ENUM_SIZING
  {
   SIZING_NOTIONAL     = 0,   // Notional = x times equity per rule (research setting)
   SIZING_RISK_PERCENT = 1,   // Risk % of equity per rule (to the stop)
   SIZING_FIXED_LOTS   = 2    // Fixed lots per rule
  };

enum ENUM_DST_RULE
  {
   DST_EU   = 0,   // Server adds 1h on European summer-time dates (most GMT+2/+3 brokers)
   DST_US   = 1,   // Server adds 1h on US summer-time dates
   DST_NONE = 2    // Server never changes its offset
  };

input group "Symbols and modules"
input string InpSymbolSPX       = "US500Cash"; // S&P500 symbol at your broker
input string InpSymbolNDX       = "US100Cash"; // NASDAQ100 symbol at your broker
input bool   InpRunReversionSPX = true;        // Module 1: IndexReversion on the S&P500 symbol
input bool   InpRunReversionNDX = true;        // Module 2: IndexReversion on the NASDAQ100 symbol
input bool   InpRunMomentumNDX  = true;        // Module 3: IntradayMomentum on the NASDAQ100 symbol

input group "IndexReversion signals (research defaults; do not optimise)"
input bool   InpUseRuleA_SPX  = true;   // Rule A (IBS) on the S&P500 symbol
input bool   InpUseRuleB_SPX  = true;   // Rule B (RSI2) on the S&P500 symbol
input bool   InpUseRuleA_NDX  = true;   // Rule A (IBS) on the NASDAQ100 symbol
input bool   InpUseRuleB_NDX  = false;  // Rule B (RSI2) on the NASDAQ100 symbol (weak per unit of risk)
input double InpIbsThreshold  = 0.20;   // Rule A: enter when IBS < x
input int    InpRsiPeriod     = 2;      // Rule B: RSI period
input double InpRsiThreshold  = 10.0;   // Rule B: enter when RSI < x
input int    InpTrendMaPeriod = 200;    // Rule B: trend filter Close > SMA(n)
input int    InpExitMaPeriod  = 5;      // Rule B: exit when Close > SMA(n)
input int    InpMaxHoldBarsB  = 10;     // Rule B: maximum holding bars

input group "IndexReversion risk and execution"
input ENUM_SIZING InpSizing   = SIZING_NOTIONAL; // Position sizing mode
input double InpNotionalMult  = 1.0;    // Notional per rule as a multiple of equity (notional mode)
input double InpRiskPercent   = 1.0;    // Risk % of equity per rule if the stop is hit (risk mode)
input double InpFixedLots     = 0.10;   // Lots per rule (fixed mode)
input int    InpAtrPeriod     = 10;     // ATR period (stop distance)
input double InpStopAtrMult   = 3.0;    // Protective stop = signal close - k*ATR
input int    InpMaxSpreadPoints = 0;    // Wait while spread > x points (0 = no check)
input int    InpMaxWaitMinutes  = 180;  // Entries allowed only this long after the D1 bar opens
input bool   InpSkipSundayBars  = true; // Ignore short Sunday D1 bars (GMT brokers)
input long   InpReversionMagic  = 26111700; // Magic base (rule A = +1, rule B = +2)

input group "IntradayMomentum broker clock and session (New York time)"
input int           InpServerWinterGMT = 2;        // Server GMT offset in winter (hours)
input ENUM_DST_RULE InpServerDST       = DST_EU;   // Summer-time rule of the server clock
input int    InpSessionStartMin = 570;   // Session start, minutes after midnight NY (570 = 09:30)
input int    InpSessionEndMin   = 960;   // Session end, minutes after midnight NY (960 = 16:00)

input group "IntradayMomentum signal and risk"
input int    InpLookbackDays    = 14;    // Sessions used for the noise area and the volatility
input double InpTargetDailyVol  = 2.0;   // Target daily volatility % (exposure = target / realised vol)
input double InpMaxLeverage     = 4.0;   // Cap on exposure (x equity) before the scale below
input double InpExposureScale   = 1.0;   // Scale on the exposure (1.0 = the research size)
input double InpStopPct         = 2.0;   // Protective stop, % from entry (0 = none)
input int    InpMaxSpreadPointsIM = 0;   // No new entry while spread > x points (0 = no check)
input int    InpMaxDelayMin     = 5;     // Enter only within x minutes after a decision time
input bool   InpSkipUSHolidays  = true;  // No trading on NYSE holidays and half days
input int    InpBarsToLoad      = 6000;  // M5 bars read at each decision (>= 15 sessions)
input long   InpMomentumMagic   = 26111800; // Magic number

input group "Small account"
input double InpMinLotCapSPX    = 2.0;   // Below the minimum lot: still trade it while it is <= x equity (S&P500)
input double InpMinLotCapNDX    = 3.0;   // Same, IndexReversion on the NASDAQ100 symbol
input double InpMinLotCapIM     = 4.0;   // Same, IntradayMomentum
input double InpPauseDrawdownPct = 50.0; // Pause new entries while equity is this % below its peak (0 = off)

input group "Common"
input int    InpSlippagePoints  = 50;    // Max deviation for market orders (points)
input double InpMaxTotalExposure = 0.0;  // Cap on the notional of all modules together, x equity (0 = none)
input bool   InpShowPanel       = true;  // Show the modules' state on the chart

//+------------------------------------------------------------------+
//| Shared helpers                                                   |
//+------------------------------------------------------------------+
double SymPoint(const string s)  { return(SymbolInfoDouble(s, SYMBOL_POINT)); }
int    SymDigits(const string s) { return((int)SymbolInfoInteger(s, SYMBOL_DIGITS)); }

double NormalizeLotsSym(const string s, double lots)
  {
   double vmin  = SymbolInfoDouble(s, SYMBOL_VOLUME_MIN);
   double vmax  = SymbolInfoDouble(s, SYMBOL_VOLUME_MAX);
   double vstep = SymbolInfoDouble(s, SYMBOL_VOLUME_STEP);
   if(vstep <= 0.0)
      vstep = vmin;
   lots = MathFloor(lots / vstep + 1e-9) * vstep;
   if(lots < vmin - 1e-12)
      return(0.0);                    // too small for the budget: skip rather than over-risk
   if(lots > vmax)
      lots = vmax;
   return(NormalizeDouble(lots, 8));
  }

// value of 1 lot at this price, in account currency (from the broker's own profit formula)
double NotionalPerLotSym(const string s, double price)
  {
   double profit = 0.0;
   if(OrderCalcProfit(ORDER_TYPE_BUY, s, 1.0, price, price * 1.01, profit) && profit > 0.0)
      return(profit * 100.0);
   double tv = SymbolInfoDouble(s, SYMBOL_TRADE_TICK_VALUE);
   double ts = SymbolInfoDouble(s, SYMBOL_TRADE_TICK_SIZE);
   if(tv <= 0.0 || ts <= 0.0)
      return(0.0);
   return(price / ts * tv);
  }

// money lost by 1 lot between entry and sl, in account currency
double LossPerLotSym(const string s, double entry, double sl)
  {
   double profit = 0.0;
   if(OrderCalcProfit(ORDER_TYPE_BUY, s, 1.0, entry, sl, profit) && profit < 0.0)
      return(-profit);
   double tv = SymbolInfoDouble(s, SYMBOL_TRADE_TICK_VALUE_LOSS);
   if(tv <= 0.0)
      tv = SymbolInfoDouble(s, SYMBOL_TRADE_TICK_VALUE);
   double ts = SymbolInfoDouble(s, SYMBOL_TRADE_TICK_SIZE);
   if(tv <= 0.0 || ts <= 0.0)
      return(0.0);
   return((entry - sl) / ts * tv);
  }

bool IsOurMagic(long mg)
  {
   return(mg == InpReversionMagic + 1 || mg == InpReversionMagic + 2 || mg == InpMomentumMagic);
  }

// notional of all positions of this EA, as a multiple of equity
double TotalExposure()
  {
   double eq = AccountInfoDouble(ACCOUNT_EQUITY);
   if(eq <= 0.0)
      return(0.0);
   double tot = 0.0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong t = PositionGetTicket(i);
      if(t == 0)
         continue;
      if(!IsOurMagic(PositionGetInteger(POSITION_MAGIC)))
         continue;
      string s = PositionGetString(POSITION_SYMBOL);
      double v = PositionGetDouble(POSITION_VOLUME);
      double px = PositionGetDouble(POSITION_PRICE_CURRENT);
      tot += v * NotionalPerLotSym(s, px);
     }
   return(tot / eq);
  }

// lots allowed by the optional portfolio exposure cap
double CapLots(const string s, double price, double lots)
  {
   if(InpMaxTotalExposure <= 0.0)
      return(lots);
   double npl = NotionalPerLotSym(s, price);
   if(npl <= 0.0)
      return(lots);
   double room = (InpMaxTotalExposure - TotalExposure()) * AccountInfoDouble(ACCOUNT_EQUITY) / npl;
   return(MathMax(0.0, MathMin(lots, room)));
  }

//--- drawdown pause: no new entries while equity is far below its peak (exits and stops keep working)
double g_peakEquity = 0.0;
bool   g_paused     = false;
string PeakGvName() { return("IG_peak_" + IntegerToString(InpMomentumMagic)); }

void UpdatePeak()
  {
   double eq = AccountInfoDouble(ACCOUNT_EQUITY);
   if(eq > g_peakEquity * 1.001 || g_peakEquity <= 0.0)
     {
      g_peakEquity = MathMax(g_peakEquity, eq);
      if(!(bool)MQLInfoInteger(MQL_TESTER))
         GlobalVariableSet(PeakGvName(), g_peakEquity);
     }
   bool paused = InpPauseDrawdownPct > 0.0 && eq < g_peakEquity * (1.0 - InpPauseDrawdownPct / 100.0);
   if(paused != g_paused)
     {
      g_paused = paused;
      PrintFormat("IndexGrowth_EA: new entries %s (equity %.0f, peak %.0f)", paused ? "PAUSED" : "resumed", eq, g_peakEquity);
     }
  }

bool EntriesAllowed() { return(!g_paused); }

// lots normalised to the step; if that is zero, the minimum lot while its exposure is at most cap x equity
double SizeWithMinLot(const string s, double price, double rawLots, double cap)
  {
   double lots = NormalizeLotsSym(s, CapLots(s, price, rawLots));
   if(lots > 0.0 || cap <= 0.0)
      return(lots);
   double vmin = SymbolInfoDouble(s, SYMBOL_VOLUME_MIN);
   double npl  = NotionalPerLotSym(s, price);
   double eq   = AccountInfoDouble(ACCOUNT_EQUITY);
   if(vmin <= 0.0 || npl <= 0.0 || eq <= 0.0)
      return(0.0);
   double x = vmin * npl / eq;
   if(x > cap)
      return(0.0);
   if(InpMaxTotalExposure > 0.0 && TotalExposure() + x > InpMaxTotalExposure)
      return(0.0);
   return(vmin);
  }

bool TradeDone(CTrade &tr)
  {
   uint rc = tr.ResultRetcode();
   return(rc == TRADE_RETCODE_DONE || rc == TRADE_RETCODE_PLACED || rc == TRADE_RETCODE_DONE_PARTIAL);
  }

//+------------------------------------------------------------------+
//| Indicators on series-ordered bars (r[0] = newest)                |
//+------------------------------------------------------------------+
double SMA(const MqlRates &r[], int shift, int n)
  {
   double s = 0.0;
   for(int i = shift; i < shift + n; i++)
      s += r[i].close;
   return(s / n);
  }

double ATR(const MqlRates &r[], int shift, int n)
  {
   double s = 0.0;
   for(int i = shift; i < shift + n; i++)
     {
      double pc = r[i + 1].close;
      s += MathMax(r[i].high, pc) - MathMin(r[i].low, pc);
     }
   return(s / n);
  }

double RSIWilder(const MqlRates &r[], int count, int n)
  {
   int oldest = count - 1;
   double ag = 0.0, al = 0.0;
   for(int k = 0; k < n; k++)
     {
      int i = oldest - 1 - k;
      double ch = r[i].close - r[i + 1].close;
      if(ch > 0.0)
         ag += ch;
      else
         al -= ch;
     }
   ag /= n;
   al /= n;
   for(int i = oldest - 1 - n; i >= 0; i--)
     {
      double ch = r[i].close - r[i + 1].close;
      double g = (ch > 0.0) ? ch : 0.0;
      double l = (ch < 0.0) ? -ch : 0.0;
      ag = (ag * (n - 1) + g) / n;
      al = (al * (n - 1) + l) / n;
     }
   if(al <= 0.0)
      return(ag <= 0.0 ? 50.0 : 100.0);
   return(100.0 - 100.0 / (1.0 + ag / al));
  }

//+------------------------------------------------------------------+
//| Clock and NYSE calendar                                          |
//+------------------------------------------------------------------+
datetime MakeDate(int y, int mo, int d)
  {
   MqlDateTime t;
   t.year = y; t.mon = mo; t.day = d; t.hour = 0; t.min = 0; t.sec = 0;
   t.day_of_week = 0; t.day_of_year = 0;
   return(StructToTime(t));
  }

int DowOf(datetime t)
  {
   MqlDateTime s;
   TimeToStruct(t, s);
   return(s.day_of_week);      // 0 = Sunday
  }

datetime NthWeekday(int y, int mo, int wd, int n)
  {
   datetime first = MakeDate(y, mo, 1);
   int add = (wd - DowOf(first) + 7) % 7;
   return(first + (datetime)((add + 7 * (n - 1)) * 86400));
  }

datetime LastWeekday(int y, int mo, int wd)
  {
   datetime nextFirst = (mo == 12) ? MakeDate(y + 1, 1, 1) : MakeDate(y, mo + 1, 1);
   datetime last = nextFirst - 86400;
   int back = (DowOf(last) - wd + 7) % 7;
   return(last - (datetime)(back * 86400));
  }

bool UsDstUTC(datetime utc)
  {
   MqlDateTime s;
   TimeToStruct(utc, s);
   datetime st = NthWeekday(s.year, 3, 0, 2) + 7 * 3600;
   datetime en = NthWeekday(s.year, 11, 0, 1) + 6 * 3600;
   return(utc >= st && utc < en);
  }

bool EuDstUTC(datetime utc)
  {
   MqlDateTime s;
   TimeToStruct(utc, s);
   datetime st = LastWeekday(s.year, 3, 0) + 3600;
   datetime en = LastWeekday(s.year, 10, 0) + 3600;
   return(utc >= st && utc < en);
  }

datetime ServerToUTC(datetime srv)
  {
   datetime u = srv - (datetime)(InpServerWinterGMT * 3600);
   bool dst = false;
   if(InpServerDST == DST_EU)
      dst = EuDstUTC(u);
   else if(InpServerDST == DST_US)
      dst = UsDstUTC(u);
   return(dst ? u - 3600 : u);
  }

datetime ServerToNY(datetime srv)
  {
   datetime utc = ServerToUTC(srv);
   return(utc - (datetime)((UsDstUTC(utc) ? 4 : 5) * 3600));
  }

int DateKey(datetime t)
  {
   MqlDateTime s;
   TimeToStruct(t, s);
   return(s.year * 10000 + s.mon * 100 + s.day);
  }

datetime Easter(int y)
  {
   int a = y % 19, b = y / 100, c = y % 100, d = b / 4, e = b % 4;
   int f = (b + 8) / 25, g = (b - f + 1) / 3, h = (19 * a + b - d - g + 15) % 30;
   int i = c / 4, k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
   int m = (a + 11 * h + 22 * l) / 451;
   int month = (h + l - 7 * m + 114) / 31;
   int day = ((h + l - 7 * m + 114) % 31) + 1;
   return(MakeDate(y, month, day));
  }

int ObservedKey(int y, int mo, int d)
  {
   datetime t = MakeDate(y, mo, d);
   int w = DowOf(t);
   if(w == 6)
      t -= 86400;
   if(w == 0)
      t += 86400;
   return(DateKey(t));
  }

void PushKey(int &arr[], int k)
  {
   int n = ArraySize(arr);
   ArrayResize(arr, n + 1);
   arr[n] = k;
  }

bool IsNyseHoliday(int key)
  {
   int y = key / 10000;
   int hol[];
   ArrayResize(hol, 0);
   if(DowOf(MakeDate(y, 1, 1)) != 6)
      PushKey(hol, ObservedKey(y, 1, 1));
   PushKey(hol, DateKey(NthWeekday(y, 1, 1, 3)));
   PushKey(hol, DateKey(NthWeekday(y, 2, 1, 3)));
   PushKey(hol, DateKey(Easter(y) - 2 * 86400));
   PushKey(hol, DateKey(LastWeekday(y, 5, 1)));
   if(y >= 2022)
      PushKey(hol, ObservedKey(y, 6, 19));
   PushKey(hol, ObservedKey(y, 7, 4));
   PushKey(hol, DateKey(NthWeekday(y, 9, 1, 1)));
   PushKey(hol, DateKey(NthWeekday(y, 11, 4, 4)));
   PushKey(hol, ObservedKey(y, 12, 25));
   PushKey(hol, 20181205);
   PushKey(hol, 20250109);
   for(int i = 0; i < ArraySize(hol); i++)
      if(hol[i] == key)
         return(true);
   return(false);
  }

bool IsNyseHalfDay(int key)
  {
   int y = key / 10000;
   if(key == DateKey(NthWeekday(y, 11, 4, 4) + 86400))
      return(true);
   datetime d24 = MakeDate(y, 12, 24);
   if(key == DateKey(d24) && DowOf(d24) >= 1 && DowOf(d24) <= 5)
      return(true);
   datetime d3 = MakeDate(y, 7, 3), d4 = MakeDate(y, 7, 4);
   if(key == DateKey(d3) && DowOf(d3) >= 1 && DowOf(d3) <= 5 && DowOf(d4) >= 1 && DowOf(d4) <= 5)
      return(true);
   return(false);
  }

//+------------------------------------------------------------------+
//| New York session bars (IntradayMomentum)                         |
//+------------------------------------------------------------------+
struct SessionDay
  {
   int    key;
   double o[MAXK];
   double h[MAXK];
   double l[MAXK];
   double c[MAXK];
   double tv[MAXK];
   bool   has[MAXK];
  };

int SessionBars()
  {
   return((InpSessionEndMin - InpSessionStartMin) / 5);
  }

void ClearDay(SessionDay &d)
  {
   d.key = 0;
   for(int k = 0; k < MAXK; k++)
     {
      d.o[k] = 0.0; d.h[k] = 0.0; d.l[k] = 0.0; d.c[k] = 0.0; d.tv[k] = 0.0; d.has[k] = false;
     }
  }

int BuildSessions(const string sym, SessionDay &days[])
  {
   int n = SessionBars();
   MqlRates r[];
   ArraySetAsSeries(r, false);
   int got = CopyRates(sym, PERIOD_M5, 0, InpBarsToLoad, r);
   ArrayResize(days, 0);
   if(got <= 0)
      return(0);
   int nd = 0;
   for(int i = 0; i < got; i++)
     {
      datetime ny = ServerToNY(r[i].time);
      MqlDateTime t;
      TimeToStruct(ny, t);
      int mins = t.hour * 60 + t.min;
      if(mins < InpSessionStartMin || mins >= InpSessionStartMin + 5 * n)
         continue;
      int k = (mins - InpSessionStartMin) / 5;
      int key = t.year * 10000 + t.mon * 100 + t.day;
      if(nd == 0 || days[nd - 1].key != key)
        {
         nd++;
         ArrayResize(days, nd);
         ClearDay(days[nd - 1]);
         days[nd - 1].key = key;
        }
      days[nd - 1].o[k] = r[i].open;
      days[nd - 1].h[k] = r[i].high;
      days[nd - 1].l[k] = r[i].low;
      days[nd - 1].c[k] = r[i].close;
      days[nd - 1].tv[k] = (double)r[i].tick_volume;
      days[nd - 1].has[k] = true;
     }
   return(nd);
  }

bool IsComplete(const SessionDay &d)
  {
   int n = SessionBars();
   if(!d.has[0] || !d.has[n - 1])
      return(false);
   int miss = 0;
   for(int k = 0; k < n; k++)
      if(!d.has[k])
         miss++;
   return(miss <= 3);
  }

void FillForward(SessionDay &d)
  {
   int n = SessionBars();
   for(int k = 1; k < n; k++)
      if(!d.has[k])
        {
         d.c[k] = d.c[k - 1];
         d.h[k] = d.c[k];
         d.l[k] = d.c[k];
         d.tv[k] = 0.0;
        }
  }

//+------------------------------------------------------------------+
//| Module: IndexReversion on one symbol                             |
//+------------------------------------------------------------------+
class CReversion
  {
private:
   string            m_sym;
   string            m_tag;
   datetime          m_doneBar;
   datetime          m_pendingBar;
   datetime          m_lastFail;
   CTrade            m_trade;
   string            m_status;
   bool              m_useA;
   bool              m_useB;
   double            m_minLotCap;

   long              MagicA(void) { return(InpReversionMagic + 1); }
   long              MagicB(void) { return(InpReversionMagic + 2); }
   string            GvName(void) { return("IR_" + m_sym + "_" + IntegerToString(InpReversionMagic) + "_done"); }

   ulong             FindPos(long magic)
     {
      for(int i = PositionsTotal() - 1; i >= 0; i--)
        {
         ulong t = PositionGetTicket(i);
         if(t == 0)
            continue;
         if(PositionGetString(POSITION_SYMBOL) == m_sym && PositionGetInteger(POSITION_MAGIC) == magic &&
            PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY)
            return(t);
        }
      return(0);
     }

   int               BarsHeld(ulong ticket)
     {
      if(!PositionSelectByTicket(ticket))
         return(0);
      datetime t0 = (datetime)PositionGetInteger(POSITION_TIME);
      int sh = iBarShift(m_sym, PERIOD_D1, t0, false);
      return(MathMax(0, sh));
     }

   bool              ClosePos(ulong ticket, const string why)
     {
      if(!m_trade.PositionClose(ticket) || !TradeDone(m_trade))
        {
         Print("IndexGrowth_EA [IR ", m_tag, "]: close failed ", m_trade.ResultRetcode(), " ", m_trade.ResultRetcodeDescription());
         return(false);
        }
      Print("IndexGrowth_EA [IR ", m_tag, "]: ", why, " ticket ", ticket);
      return(true);
     }

   bool              CloseAllMagic(long magic, const string why)
     {
      bool ok = true;
      for(int i = PositionsTotal() - 1; i >= 0; i--)
        {
         ulong t = PositionGetTicket(i);
         if(t == 0)
            continue;
         if(PositionGetString(POSITION_SYMBOL) == m_sym && PositionGetInteger(POSITION_MAGIC) == magic &&
            PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY)
            if(!ClosePos(t, why))
               ok = false;
        }
      return(ok);
     }

   // returns false only when an order should be retried
   bool              OpenLong(long magic, double sl, const string cmt)
     {
      double ask = SymbolInfoDouble(m_sym, SYMBOL_ASK);
      double bid = SymbolInfoDouble(m_sym, SYMBOL_BID);
      double pt  = SymPoint(m_sym);
      int    dg  = SymDigits(m_sym);
      double minDist = (double)SymbolInfoInteger(m_sym, SYMBOL_TRADE_STOPS_LEVEL) * pt;
      if(sl <= 0.0 || sl >= bid - minDist)
        {
         Print("IndexGrowth_EA [IR ", m_tag, "]: price already at/below the planned stop; entry skipped (", cmt, ")");
         return(true);
        }
      sl = NormalizeDouble(sl, dg);
      double lots;
      if(InpSizing == SIZING_FIXED_LOTS)
         lots = InpFixedLots;
      else if(InpSizing == SIZING_NOTIONAL)
        {
         double npl = NotionalPerLotSym(m_sym, ask);
         if(npl <= 0.0)
           {
            Print("IndexGrowth_EA [IR ", m_tag, "]: cannot compute notional per lot; entry skipped");
            return(true);
           }
         lots = AccountInfoDouble(ACCOUNT_EQUITY) * InpNotionalMult / npl;
        }
      else
        {
         double lpl = LossPerLotSym(m_sym, ask, sl);
         if(lpl <= 0.0)
           {
            Print("IndexGrowth_EA [IR ", m_tag, "]: cannot compute loss per lot; entry skipped");
            return(true);
           }
         lots = AccountInfoDouble(ACCOUNT_EQUITY) * InpRiskPercent / 100.0 / lpl;
        }
      lots = SizeWithMinLot(m_sym, ask, lots, m_minLotCap);
      if(lots <= 0.0)
        {
         Print("IndexGrowth_EA [IR ", m_tag, "]: lot size below the symbol minimum (or exposure cap); entry skipped (", cmt, ")");
         return(true);
        }
      m_trade.SetExpertMagicNumber((ulong)magic);
      if(!m_trade.Buy(lots, m_sym, 0.0, sl, 0.0, cmt) || !TradeDone(m_trade))
        {
         Print("IndexGrowth_EA [IR ", m_tag, "]: buy failed ", m_trade.ResultRetcode(), " ", m_trade.ResultRetcodeDescription());
         return(false);
        }
      PrintFormat("IndexGrowth_EA [IR %s]: %s BUY %.2f lots, SL %s", m_tag, cmt, lots, DoubleToString(sl, dg));
      return(true);
     }

   void              Evaluate(bool allowEntries, bool &exitOk, bool &entryOk)
     {
      int need = (int)MathMax(InpTrendMaPeriod, MathMax(InpExitMaPeriod, InpAtrPeriod + 1)) + 10 * InpRsiPeriod + 30;
      MqlRates r[];
      ArraySetAsSeries(r, true);
      int got = CopyRates(m_sym, PERIOD_D1, 1, need + 100, r);
      if(got < need)
        {
         Print("IndexGrowth_EA [IR ", m_tag, "]: not enough D1 history (", got, " < ", need, "), bar skipped");
         return;
        }
      MqlDateTime dt;
      TimeToStruct(r[0].time, dt);
      if(InpSkipSundayBars && dt.day_of_week == 0)
         return;
      int    dg   = SymDigits(m_sym);
      double c0   = r[0].close;
      double rng  = r[0].high - r[0].low;
      double ibs  = (rng > 0.0) ? (c0 - r[0].low) / rng : 0.5;
      double smaT = SMA(r, 0, InpTrendMaPeriod);
      double smaX = SMA(r, 0, InpExitMaPeriod);
      double rsi  = RSIWilder(r, got, InpRsiPeriod);
      double atr  = ATR(r, 0, InpAtrPeriod);
      double stop = c0 - InpStopAtrMult * atr;

      bool  wantA = m_useA && (ibs < InpIbsThreshold);
      ulong tA    = FindPos(MagicA());
      if(tA != 0 && !wantA)
        {
         if(!CloseAllMagic(MagicA(), "A exit"))
            exitOk = false;
        }
      else if(tA == 0 && wantA && allowEntries)
        {
         if(!OpenLong(MagicA(), stop, "IR-A"))
            entryOk = false;
        }

      ulong tB = FindPos(MagicB());
      if(tB != 0)
        {
         int held = BarsHeld(tB);
         if(c0 > smaX || held >= InpMaxHoldBarsB)
           {
            if(!CloseAllMagic(MagicB(), "B exit"))
               exitOk = false;
           }
        }
      else if(m_useB && allowEntries && c0 > smaT && rsi < InpRsiThreshold)
        {
         if(!OpenLong(MagicB(), stop, "IR-B"))
            entryOk = false;
        }
      m_status = StringFormat("[IR %s] %s  bar %s  IBS=%.3f  RSI(%d)=%.1f  close=%s SMA%d=%s SMA%d=%s  A:%s B:%s",
                              m_tag, m_sym, TimeToString(r[0].time, TIME_DATE), ibs, InpRsiPeriod, rsi,
                              DoubleToString(c0, dg), InpTrendMaPeriod, DoubleToString(smaT, dg), InpExitMaPeriod,
                              DoubleToString(smaX, dg), (FindPos(MagicA()) != 0 ? "LONG" : "flat"),
                              (FindPos(MagicB()) != 0 ? "LONG" : "flat"));
     }

public:
   bool              Init(const string sym, const string tag, bool useA, bool useB, double minLotCap)
     {
      m_sym = sym;
      m_tag = tag;
      m_useA = useA;
      m_useB = useB;
      m_minLotCap = minLotCap;
      m_status = "[IR " + tag + "] " + sym + "  waiting for the next daily bar";
      m_trade.SetDeviationInPoints((ulong)MathMax(0, InpSlippagePoints));
      m_trade.SetTypeFillingBySymbol(sym);
      m_trade.LogLevel(LOG_LEVEL_ERRORS);
      if(GlobalVariableCheck(GvName()))
         m_doneBar = (datetime)GlobalVariableGet(GvName());
      else
         m_doneBar = iTime(m_sym, PERIOD_D1, 0);
      m_pendingBar = 0;
      m_lastFail = 0;
      return(true);
     }

   void              Process(void)
     {
      datetime bar0 = iTime(m_sym, PERIOD_D1, 0);
      if(bar0 == 0)
         return;
      if(bar0 != m_doneBar && bar0 != m_pendingBar)
         m_pendingBar = bar0;
      if(m_pendingBar == 0)
         return;
      double ask = SymbolInfoDouble(m_sym, SYMBOL_ASK);
      double bid = SymbolInfoDouble(m_sym, SYMBOL_BID);
      if(ask <= 0.0 || bid <= 0.0)
         return;
      double pt = SymPoint(m_sym);
      bool spreadOk = (InpMaxSpreadPoints <= 0) || ((ask - bid) <= InpMaxSpreadPoints * pt + pt * 0.5);
      bool timedOut = (long)(TimeCurrent() - m_pendingBar) > (long)InpMaxWaitMinutes * 60;
      if(!spreadOk && !timedOut)
         return;
      if(m_lastFail != 0 && (long)(TimeCurrent() - m_lastFail) < 5)
         return;
      bool allowEntries = spreadOk && !timedOut && EntriesAllowed();
      bool exitOk = true, entryOk = true;
      Evaluate(allowEntries, exitOk, entryOk);
      if(exitOk && (entryOk || timedOut))
        {
         m_doneBar = m_pendingBar;
         m_pendingBar = 0;
         m_lastFail = 0;
         GlobalVariableSet(GvName(), (double)m_doneBar);
        }
      else
         m_lastFail = TimeCurrent();
     }

   string            Status(void) { return(m_status); }
  };

//+------------------------------------------------------------------+
//| Module: IntradayMomentum on one symbol                           |
//+------------------------------------------------------------------+
class CMomentum
  {
private:
   string            m_sym;
   long              m_lastSlot;
   datetime          m_lastFail;
   CTrade            m_trade;
   string            m_status;

   ulong             FindPos(void)
     {
      for(int i = PositionsTotal() - 1; i >= 0; i--)
        {
         ulong t = PositionGetTicket(i);
         if(t == 0)
            continue;
         if(PositionGetString(POSITION_SYMBOL) == m_sym && PositionGetInteger(POSITION_MAGIC) == InpMomentumMagic)
            return(t);
        }
      return(0);
     }

   int               Direction(void)
     {
      ulong t = FindPos();
      if(t == 0)
         return(0);
      return(PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY ? 1 : -1);
     }

   bool              ClosePos(ulong ticket, const string why)
     {
      if(!m_trade.PositionClose(ticket) || !TradeDone(m_trade))
        {
         Print("IndexGrowth_EA [IM]: close failed ", m_trade.ResultRetcode(), " ", m_trade.ResultRetcodeDescription());
         return(false);
        }
      Print("IndexGrowth_EA [IM]: closed (", why, ") ticket ", ticket);
      return(true);
     }

   bool              CloseCurrent(const string why)
     {
      bool ok = true;
      for(int i = PositionsTotal() - 1; i >= 0; i--)
        {
         ulong t = PositionGetTicket(i);
         if(t == 0)
            continue;
         if(PositionGetString(POSITION_SYMBOL) == m_sym && PositionGetInteger(POSITION_MAGIC) == InpMomentumMagic)
            if(!ClosePos(t, why))
               ok = false;
        }
      return(ok);
     }

   // returns false only when the order should be retried
   bool              OpenPos(int dir, double lev)
     {
      double ask = SymbolInfoDouble(m_sym, SYMBOL_ASK);
      double bid = SymbolInfoDouble(m_sym, SYMBOL_BID);
      double pt  = SymPoint(m_sym);
      int    dg  = SymDigits(m_sym);
      if(ask <= 0.0 || bid <= 0.0)
         return(false);
      if(InpMaxSpreadPointsIM > 0 && (ask - bid) > InpMaxSpreadPointsIM * pt + pt * 0.5)
        {
         Print("IndexGrowth_EA [IM]: spread too wide, entry skipped");
         return(true);
        }
      double px = (dir > 0) ? ask : bid;
      double npl = NotionalPerLotSym(m_sym, px);
      if(npl <= 0.0)
        {
         Print("IndexGrowth_EA [IM]: cannot compute notional per lot; entry skipped");
         return(true);
        }
      double lots = SizeWithMinLot(m_sym, px, AccountInfoDouble(ACCOUNT_EQUITY) * lev / npl, InpMinLotCapIM);
      if(lots <= 0.0)
        {
         Print("IndexGrowth_EA [IM]: lot size below the symbol minimum (or exposure cap); entry skipped");
         return(true);
        }
      double sl = 0.0;
      if(InpStopPct > 0.0)
        {
         double minDist = (double)SymbolInfoInteger(m_sym, SYMBOL_TRADE_STOPS_LEVEL) * pt;
         double dist = MathMax(px * InpStopPct / 100.0, minDist + pt);
         sl = NormalizeDouble(dir > 0 ? bid - dist : ask + dist, dg);
        }
      m_trade.SetExpertMagicNumber((ulong)InpMomentumMagic);
      bool ok = (dir > 0) ? m_trade.Buy(lots, m_sym, 0.0, sl, 0.0, "IM") : m_trade.Sell(lots, m_sym, 0.0, sl, 0.0, "IM");
      if(!ok || !TradeDone(m_trade))
        {
         Print("IndexGrowth_EA [IM]: order failed ", m_trade.ResultRetcode(), " ", m_trade.ResultRetcodeDescription());
         return(false);
        }
      PrintFormat("IndexGrowth_EA [IM]: %s %.2f lots (exposure %.2fx), SL %s", (dir > 0 ? "BUY" : "SELL"), lots, lev,
                  DoubleToString(sl, dg));
      return(true);
     }

   // returns false only when an order failed and should be retried
   bool              Decide(int key, int slotMin, bool allowEntries)
     {
      int n = SessionBars();
      int L = InpLookbackDays;
      int kd = (slotMin - InpSessionStartMin) / 5 - 1;
      SessionDay days[];
      int nd = BuildSessions(m_sym, days);
      int cur = Direction();
      if(nd == 0 || days[nd - 1].key != key || !days[nd - 1].has[0])
         return(cur == 0 ? true : CloseCurrent("no session data today"));
      SessionDay today = days[nd - 1];
      FillForward(today);
      int idx[];
      ArrayResize(idx, 0);
      for(int i = nd - 2; i >= 0 && ArraySize(idx) < L + 1; i--)
         if(days[i].key < key && IsComplete(days[i]))
            PushKey(idx, i);
      if(ArraySize(idx) < L + 1)
        {
         Print("IndexGrowth_EA [IM]: not enough M5 history (", ArraySize(idx), " complete sessions)");
         return(cur == 0 ? true : CloseCurrent("history"));
        }
      double sigma = 0.0;
      for(int m = 0; m < L; m++)
        {
         SessionDay d = days[idx[m]];
         FillForward(d);
         sigma += MathAbs(d.c[kd] / d.o[0] - 1.0);
        }
      sigma /= L;
      double rets[];
      ArrayResize(rets, L);
      for(int m = 0; m < L; m++)
        {
         SessionDay a = days[idx[m]];
         SessionDay b = days[idx[m + 1]];
         FillForward(a);
         FillForward(b);
         rets[m] = a.c[n - 1] / b.c[n - 1] - 1.0;
        }
      double mean = 0.0, var = 0.0;
      for(int m = 0; m < L; m++)
         mean += rets[m];
      mean /= L;
      for(int m = 0; m < L; m++)
         var += (rets[m] - mean) * (rets[m] - mean);
      double vol = MathSqrt(var / (L - 1));
      if(vol <= 0.0)
         return(true);
      SessionDay prev = days[idx[0]];
      FillForward(prev);
      double pc = prev.c[n - 1];
      double op = today.o[0];
      double ub = MathMax(op, pc) * (1.0 + sigma);
      double lb = MathMin(op, pc) * (1.0 - sigma);
      double num = 0.0, den = 0.0;
      for(int k = 0; k <= kd; k++)
        {
         double w = MathMax(today.tv[k], 1.0);
         num += (today.h[k] + today.l[k] + today.c[k]) / 3.0 * w;
         den += w;
        }
      double vwap = num / den;
      double p = today.c[kd];
      int want = 0;
      if(p > MathMax(ub, vwap))
         want = 1;
      else if(p < MathMin(lb, vwap))
         want = -1;
      bool holiday = InpSkipUSHolidays && (IsNyseHoliday(key) || IsNyseHalfDay(key));
      if(holiday)
         want = 0;
      double lev = MathMin(InpMaxLeverage, (InpTargetDailyVol / 100.0) / vol) * InpExposureScale;
      int dg = SymDigits(m_sym);
      m_status = StringFormat("[IM NDX] %s  NY %02d:%02d check  price=%s upper=%s lower=%s VWAP=%s  exposure=%.2fx  target=%s%s",
                              m_sym, slotMin / 60, slotMin % 60, DoubleToString(p, dg), DoubleToString(ub, dg),
                              DoubleToString(lb, dg), DoubleToString(vwap, dg), lev,
                              (want > 0 ? "LONG" : (want < 0 ? "SHORT" : "flat")), (holiday ? " (NYSE holiday/half day)" : ""));
      if(want == cur)
         return(true);
      if(cur != 0 && !CloseCurrent("signal"))
         return(false);
      if(want == 0 || !allowEntries)
         return(true);
      return(OpenPos(want, lev));
     }

public:
   bool              Init(const string sym)
     {
      m_sym = sym;
      m_lastSlot = 0;
      m_lastFail = 0;
      m_status = "[IM NDX] " + sym + "  waiting for the New York session";
      m_trade.SetDeviationInPoints((ulong)MathMax(0, InpSlippagePoints));
      m_trade.SetTypeFillingBySymbol(sym);
      m_trade.LogLevel(LOG_LEVEL_ERRORS);
      return(true);
     }

   void              Process(void)
     {
      if(m_lastFail != 0 && (long)(TimeCurrent() - m_lastFail) < 5)
         return;
      datetime ny = ServerToNY(TimeCurrent());
      MqlDateTime t;
      TimeToStruct(ny, t);
      int mins = t.hour * 60 + t.min;
      int key = t.year * 10000 + t.mon * 100 + t.day;
      ulong tk = FindPos();
      if(tk != 0)
        {
         int openKey = DateKey(ServerToNY((datetime)PositionGetInteger(POSITION_TIME)));
         if(openKey != key || mins >= InpSessionEndMin)
           {
            if(!ClosePos(tk, "session end"))
               m_lastFail = TimeCurrent();
            return;
           }
        }
      if(mins < InpSessionStartMin + 30 || mins >= InpSessionEndMin)
         return;
      int j = (mins - InpSessionStartMin) / 30;
      int slotMin = InpSessionStartMin + 30 * j;
      if(slotMin > InpSessionEndMin - 30)
         return;
      long slotKey = (long)key * 100 + j;
      if(slotKey == m_lastSlot)
         return;
      bool allowEntries = (mins - slotMin) <= InpMaxDelayMin && EntriesAllowed();
      if(Decide(key, slotMin, allowEntries))
        {
         m_lastSlot = slotKey;
         m_lastFail = 0;
        }
      else
         m_lastFail = TimeCurrent();
     }

   string            Status(void) { return(m_status); }
  };

//+------------------------------------------------------------------+
//| EA                                                               |
//+------------------------------------------------------------------+
CReversion g_revSPX;
CReversion g_revNDX;
CMomentum  g_momNDX;

int OnInit()
  {
   if(!InpRunReversionSPX && !InpRunReversionNDX && !InpRunMomentumNDX)
     {
      Print("IndexGrowth_EA: all modules are switched off");
      return(INIT_PARAMETERS_INCORRECT);
     }
   if(InpIbsThreshold <= 0.0 || InpIbsThreshold >= 1.0 || InpRsiPeriod < 1 || InpTrendMaPeriod < 2 ||
      InpExitMaPeriod < 1 || InpAtrPeriod < 1 || InpStopAtrMult <= 0.0 || InpMaxHoldBarsB < 1 || InpMaxWaitMinutes < 1 ||
      (InpSizing == SIZING_NOTIONAL && (InpNotionalMult <= 0.0 || InpNotionalMult > 10.0)) ||
      (InpSizing == SIZING_RISK_PERCENT && (InpRiskPercent <= 0.0 || InpRiskPercent > 10.0)) ||
      (InpSizing == SIZING_FIXED_LOTS && InpFixedLots <= 0.0) ||
      InpSessionEndMin <= InpSessionStartMin + 60 || (InpSessionEndMin - InpSessionStartMin) / 5 > MAXK ||
      InpLookbackDays < 2 || InpTargetDailyVol <= 0.0 || InpMaxLeverage <= 0.0 || InpExposureScale <= 0.0 ||
      InpStopPct < 0.0 || InpMaxDelayMin < 0 || InpBarsToLoad < 1000 || InpMaxTotalExposure < 0.0 ||
      InpMinLotCapSPX < 0.0 || InpMinLotCapNDX < 0.0 || InpMinLotCapIM < 0.0 || InpPauseDrawdownPct < 0.0 ||
      InpPauseDrawdownPct >= 100.0)
     {
      Print("IndexGrowth_EA: invalid inputs");
      return(INIT_PARAMETERS_INCORRECT);
     }
   if(InpRunReversionSPX || InpRunReversionNDX)
     {
      ENUM_ACCOUNT_MARGIN_MODE mm = (ENUM_ACCOUNT_MARGIN_MODE)AccountInfoInteger(ACCOUNT_MARGIN_MODE);
      if(mm != ACCOUNT_MARGIN_MODE_RETAIL_HEDGING)
        {
         Print("IndexGrowth_EA: the IndexReversion modules need a HEDGING account. Margin mode = ", EnumToString(mm));
         return(INIT_FAILED);
        }
     }
   if((InpRunReversionSPX && !SymbolSelect(InpSymbolSPX, true)) ||
      ((InpRunReversionNDX || InpRunMomentumNDX) && !SymbolSelect(InpSymbolNDX, true)))
     {
      Print("IndexGrowth_EA: symbol not found. Check InpSymbolSPX / InpSymbolNDX against the Market Watch names.");
      return(INIT_FAILED);
     }
   if(InpRunReversionSPX)
      g_revSPX.Init(InpSymbolSPX, "SPX", InpUseRuleA_SPX, InpUseRuleB_SPX, InpMinLotCapSPX);
   if(InpRunReversionNDX)
      g_revNDX.Init(InpSymbolNDX, "NDX", InpUseRuleA_NDX, InpUseRuleB_NDX, InpMinLotCapNDX);
   // equity peak for the drawdown pause (kept across restarts in live trading; delete IG_peak_<magic> to reset)
   g_peakEquity = AccountInfoDouble(ACCOUNT_EQUITY);
   if(!(bool)MQLInfoInteger(MQL_TESTER) && GlobalVariableCheck(PeakGvName()))
      g_peakEquity = MathMax(g_peakEquity, GlobalVariableGet(PeakGvName()));
   g_paused = false;
   if(InpRunMomentumNDX)
      g_momNDX.Init(InpSymbolNDX);
   // the chart symbol's ticks drive the EA; in live trading a timer also covers quiet moments of the other symbol
   if(!(bool)MQLInfoInteger(MQL_TESTER))
      EventSetTimer(5);
   return(INIT_SUCCEEDED);
  }

void OnDeinit(const int reason)
  {
   EventKillTimer();
   Comment("");
  }

void RunAll()
  {
   UpdatePeak();
   if(InpRunMomentumNDX)
      g_momNDX.Process();
   if(InpRunReversionSPX)
      g_revSPX.Process();
   if(InpRunReversionNDX)
      g_revNDX.Process();
   if(InpShowPanel)
     {
      string s = "IndexGrowth_EA (small-account growth)\n";
      if(InpRunReversionSPX)
         s += g_revSPX.Status() + "\n";
      if(InpRunReversionNDX)
         s += g_revNDX.Status() + "\n";
      if(InpRunMomentumNDX)
         s += g_momNDX.Status() + "\n";
      double eq = AccountInfoDouble(ACCOUNT_EQUITY);
      s += StringFormat("exposure of all modules: %.2fx equity   equity %.0f  peak %.0f  drawdown %.1f%%%s", TotalExposure(), eq,
                        g_peakEquity, (g_peakEquity > 0.0 ? (1.0 - eq / g_peakEquity) * 100.0 : 0.0),
                        (g_paused ? "  NEW ENTRIES PAUSED" : ""));
      Comment(s);
     }
  }

void OnTick()
  {
   RunAll();
  }

void OnTimer()
  {
   RunAll();
  }
//+------------------------------------------------------------------+
