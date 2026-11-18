//+------------------------------------------------------------------+
//|                                        IntradayMomentum_EA.mq5   |
//|  Intraday momentum "noise area" breakout for US index CFDs       |
//|  (NASDAQ100 primary). Same rules as research/cand_a.py:          |
//|   * New York session 09:30-16:00, decisions every 30 minutes     |
//|     (10:00 ... 15:30) on the close of the M5 bar ending then     |
//|   * sigma(k) = mean |close(k)/open - 1| over the previous 14     |
//|     complete sessions; upper = max(open, prev close)*(1+sigma),  |
//|     lower = min(open, prev close)*(1-sigma)                      |
//|   * long if price > max(upper, VWAP); short if price <           |
//|     min(lower, VWAP); otherwise flat                             |
//|   * everything closed at 16:00 New York (never held overnight)   |
//|   * exposure = min(4, 2% / 14-session realised vol) x equity      |
//|   * protective stop 2% from entry (broker side)                  |
//|  NYSE holidays and half days are skipped. Works on hedging and   |
//|  netting accounts (one position at a time). Research notes:      |
//|  ea_research/REPORT.md section 8.3 and 9.                        |
//+------------------------------------------------------------------+
#property copyright "IndexReversion research build"
#property version   "1.00"
#property description "Intraday momentum (noise-area breakout) for US index CFDs, closed every day at 16:00 NY."

#include <Trade\Trade.mqh>

#define MAXK 128

enum ENUM_DST_RULE
  {
   DST_EU   = 0,   // Server adds 1h on European summer-time dates (most GMT+2/+3 brokers)
   DST_US   = 1,   // Server adds 1h on US summer-time dates
   DST_NONE = 2    // Server never changes its offset
  };

input group "Broker clock (needed to find New York time)"
input int           InpServerWinterGMT = 2;        // Server GMT offset in winter (hours)
input ENUM_DST_RULE InpServerDST       = DST_EU;   // Summer-time rule of the server clock

input group "Session in New York time (US index defaults)"
input int    InpSessionStartMin = 570;   // Session start, minutes after midnight NY (570 = 09:30)
input int    InpSessionEndMin   = 960;   // Session end, minutes after midnight NY (960 = 16:00)

input group "Signal (research defaults; do not optimise)"
input int    InpLookbackDays    = 14;    // Sessions used for the noise area and the volatility

input group "Risk"
input double InpTargetDailyVol  = 2.0;   // Target daily volatility % (exposure = target / realised vol)
input double InpMaxLeverage     = 4.0;   // Cap on exposure (x equity)
input double InpExposureScale   = 1.0;   // Extra scale on the exposure (0.5 = half the research size)
input double InpStopPct         = 2.0;   // Protective stop, % from entry (0 = none)
input double InpMaxLots         = 0.0;   // Cap on lots (0 = none)

input group "Execution"
input int    InpMaxSpreadPoints = 0;     // No new entry while spread > x points (0 = no check)
input int    InpMaxDelayMin     = 5;     // Enter only within x minutes after a decision time
input int    InpSlippagePoints  = 50;    // Max deviation for market orders (points)
input bool   InpSkipUSHolidays  = true;  // No trading on NYSE holidays and half days
input int    InpBarsToLoad      = 6000;  // M5 bars read at each decision (>= 15 sessions)
input long   InpMagic           = 26111800; // Magic number
input bool   InpShowPanel       = true;  // Show the signal values on the chart

struct SessionDay
  {
   int    key;                // yyyymmdd (New York date)
   double o[MAXK];
   double h[MAXK];
   double l[MAXK];
   double c[MAXK];
   double tv[MAXK];
   bool   has[MAXK];
  };

CTrade g_trade;
long   g_lastSlot = 0;        // yyyymmdd*100 + slot index already processed
datetime g_lastFail = 0;

//+------------------------------------------------------------------+
//| Calendar helpers (all in a "local clock" expressed as datetime)  |
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

// US summer time at a UTC instant: 2nd Sunday of March 07:00 UTC .. 1st Sunday of November 06:00 UTC
bool UsDstUTC(datetime utc)
  {
   MqlDateTime s;
   TimeToStruct(utc, s);
   datetime st = NthWeekday(s.year, 3, 0, 2) + 7 * 3600;
   datetime en = NthWeekday(s.year, 11, 0, 1) + 6 * 3600;
   return(utc >= st && utc < en);
  }

// EU summer time at a UTC instant: last Sunday of March 01:00 UTC .. last Sunday of October 01:00 UTC
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
   datetime u = srv - (datetime)(InpServerWinterGMT * 3600);   // winter-offset guess (exact except at the switch hour)
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

// holiday observed on the nearest weekday (Saturday -> Friday, Sunday -> Monday)
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

bool IsNyseHoliday(int key)
  {
   int y = key / 10000;
   int hol[];
   ArrayResize(hol, 0);
   // New Year: Sunday -> Monday; Saturday -> not observed
   datetime ny1 = MakeDate(y, 1, 1);
   if(DowOf(ny1) != 6)
      PushKey(hol, ObservedKey(y, 1, 1));
   PushKey(hol, DateKey(NthWeekday(y, 1, 1, 3)));        // MLK
   PushKey(hol, DateKey(NthWeekday(y, 2, 1, 3)));        // Presidents
   PushKey(hol, DateKey(Easter(y) - 2 * 86400));         // Good Friday
   PushKey(hol, DateKey(LastWeekday(y, 5, 1)));          // Memorial
   if(y >= 2022)
      PushKey(hol, ObservedKey(y, 6, 19));               // Juneteenth
   PushKey(hol, ObservedKey(y, 7, 4));                   // Independence
   PushKey(hol, DateKey(NthWeekday(y, 9, 1, 1)));        // Labor
   PushKey(hol, DateKey(NthWeekday(y, 11, 4, 4)));       // Thanksgiving
   PushKey(hol, ObservedKey(y, 12, 25));                 // Christmas
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
   if(key == DateKey(NthWeekday(y, 11, 4, 4) + 86400))   // day after Thanksgiving
      return(true);
   datetime d24 = MakeDate(y, 12, 24);
   if(key == DateKey(d24) && DowOf(d24) >= 1 && DowOf(d24) <= 5)
      return(true);
   datetime d3 = MakeDate(y, 7, 3), d4 = MakeDate(y, 7, 4);
   if(key == DateKey(d3) && DowOf(d3) >= 1 && DowOf(d3) <= 5 && DowOf(d4) >= 1 && DowOf(d4) <= 5)
      return(true);
   return(false);
  }

void PushKey(int &arr[], int k)
  {
   int n = ArraySize(arr);
   ArrayResize(arr, n + 1);
   arr[n] = k;
  }

//+------------------------------------------------------------------+
//| Session data from M5 bars                                        |
//+------------------------------------------------------------------+
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

// group the last InpBarsToLoad M5 bars into New York sessions (chronological)
int BuildSessions(SessionDay &days[])
  {
   int n = SessionBars();
   MqlRates r[];
   ArraySetAsSeries(r, false);
   int got = CopyRates(_Symbol, PERIOD_M5, 0, InpBarsToLoad, r);
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

// missing bars: close carried forward, high/low = close, volume 0 (weighted as 1 in the VWAP)
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
int OnInit()
  {
   if(InpSessionEndMin <= InpSessionStartMin + 60 || (InpSessionEndMin - InpSessionStartMin) / 5 > MAXK ||
      InpLookbackDays < 2 || InpTargetDailyVol <= 0.0 || InpMaxLeverage <= 0.0 || InpExposureScale <= 0.0 ||
      InpStopPct < 0.0 || InpMaxDelayMin < 0 || InpBarsToLoad < 1000)
     {
      Print("IntradayMomentum_EA: invalid inputs");
      return(INIT_PARAMETERS_INCORRECT);
     }
   g_trade.SetExpertMagicNumber((ulong)InpMagic);
   g_trade.SetDeviationInPoints((ulong)MathMax(0, InpSlippagePoints));
   g_trade.SetTypeFillingBySymbol(_Symbol);
   g_trade.LogLevel(LOG_LEVEL_ERRORS);
   return(INIT_SUCCEEDED);
  }

void OnDeinit(const int reason)
  {
   Comment("");
  }

//+------------------------------------------------------------------+
void OnTick()
  {
   if(g_lastFail != 0 && (long)(TimeCurrent() - g_lastFail) < 5)
      return;                                         // throttle retries after a failed order
   datetime ny = ServerToNY(TimeCurrent());
   MqlDateTime t;
   TimeToStruct(ny, t);
   int mins = t.hour * 60 + t.min;
   int key = t.year * 10000 + t.mon * 100 + t.day;

   //--- never hold past the session end, nor across days (also after a restart)
   ulong tk = FindPosition();
   if(tk != 0)
     {
      int openKey = DateKey(ServerToNY((datetime)PositionGetInteger(POSITION_TIME)));
      if(openKey != key || mins >= InpSessionEndMin)
        {
         if(!ClosePosition(tk, "session end"))
            g_lastFail = TimeCurrent();
         return;
        }
     }
   if(mins < InpSessionStartMin + 30 || mins >= InpSessionEndMin)
      return;

   //--- decision slots: 30, 60, ... minutes after the open, the last one 30 minutes before the close
   int j = (mins - InpSessionStartMin) / 30;
   int slotMin = InpSessionStartMin + 30 * j;
   if(slotMin > InpSessionEndMin - 30)
      return;
   long slotKey = (long)key * 100 + j;
   if(slotKey == g_lastSlot)
      return;
   bool allowEntries = (mins - slotMin) <= InpMaxDelayMin;

   if(Decide(key, slotMin, allowEntries))
     {
      g_lastSlot = slotKey;
      g_lastFail = 0;
     }
   else
      g_lastFail = TimeCurrent();
  }

//+------------------------------------------------------------------+
//| Returns false only when an order failed and should be retried.   |
//+------------------------------------------------------------------+
bool Decide(int key, int slotMin, bool allowEntries)
  {
   int n = SessionBars();
   int L = InpLookbackDays;
   int kd = (slotMin - InpSessionStartMin) / 5 - 1;     // bar whose close is the decision time
   SessionDay days[];
   int nd = BuildSessions(days);
   int cur = PositionDirection();
   if(nd == 0 || days[nd - 1].key != key || !days[nd - 1].has[0])
      return(cur == 0 ? true : CloseCurrent("no session data today"));
   SessionDay today = days[nd - 1];
   FillForward(today);

   //--- previous complete sessions (newest first), need L + 1 of them
   int idx[];
   ArrayResize(idx, 0);
   for(int i = nd - 2; i >= 0 && ArraySize(idx) < L + 1; i--)
      if(days[i].key < key && IsComplete(days[i]))
         PushKey(idx, i);
   if(ArraySize(idx) < L + 1)
     {
      Print("IntradayMomentum_EA: not enough M5 history (", ArraySize(idx), " complete sessions)");
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
   //--- realised volatility of the last L session-to-session returns (16:00 to 16:00)
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

   if(InpShowPanel)
      Comment(StringFormat("IntradayMomentum_EA  NY %04d-%02d-%02d %02d:%02d check\n", key / 10000, (key / 100) % 100, key % 100,
                           slotMin / 60, slotMin % 60) +
              StringFormat("price=%s  upper=%s  lower=%s  VWAP=%s\nsigma=%.3f%%  vol14=%.2f%%  exposure=%.2fx  target=%s%s",
                           DoubleToString(p, _Digits), DoubleToString(ub, _Digits), DoubleToString(lb, _Digits),
                           DoubleToString(vwap, _Digits), sigma * 100.0, vol * 100.0, lev,
                           (want > 0 ? "LONG" : (want < 0 ? "SHORT" : "flat")), (holiday ? "  (NYSE holiday/half day)" : "")));

   if(want == cur)
      return(true);
   if(cur != 0 && !CloseCurrent("signal"))
      return(false);
   if(want == 0 || !allowEntries)
      return(true);
   return(OpenPosition(want, lev));
  }

//+------------------------------------------------------------------+
ulong FindPosition()
  {
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong t = PositionGetTicket(i);
      if(t == 0)
         continue;
      if(PositionGetString(POSITION_SYMBOL) == _Symbol && PositionGetInteger(POSITION_MAGIC) == InpMagic)
         return(t);
     }
   return(0);
  }

int PositionDirection()
  {
   ulong t = FindPosition();
   if(t == 0)
      return(0);
   return(PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY ? 1 : -1);
  }

bool CloseCurrent(string why)
  {
   bool ok = true;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong t = PositionGetTicket(i);
      if(t == 0)
         continue;
      if(PositionGetString(POSITION_SYMBOL) == _Symbol && PositionGetInteger(POSITION_MAGIC) == InpMagic)
         if(!ClosePosition(t, why))
            ok = false;
     }
   return(ok);
  }

bool ClosePosition(ulong ticket, string why)
  {
   if(!g_trade.PositionClose(ticket))
     {
      Print("IntradayMomentum_EA: close failed ", g_trade.ResultRetcode(), " ", g_trade.ResultRetcodeDescription());
      return(false);
     }
   uint rc = g_trade.ResultRetcode();
   if(rc != TRADE_RETCODE_DONE && rc != TRADE_RETCODE_PLACED && rc != TRADE_RETCODE_DONE_PARTIAL)
     {
      Print("IntradayMomentum_EA: close not done ", rc, " ", g_trade.ResultRetcodeDescription());
      return(false);
     }
   Print("IntradayMomentum_EA: closed (", why, ") ticket ", ticket);
   return(true);
  }

double NotionalPerLot(double price)
  {
   double profit = 0.0;
   if(OrderCalcProfit(ORDER_TYPE_BUY, _Symbol, 1.0, price, price * 1.01, profit) && profit > 0.0)
      return(profit * 100.0);
   double tv = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
   double ts = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   if(tv <= 0.0 || ts <= 0.0)
      return(0.0);
   return(price / ts * tv);
  }

double NormalizeLots(double lots)
  {
   double vmin  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double vmax  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   double vstep = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   if(vstep <= 0.0)
      vstep = vmin;
   lots = MathFloor(lots / vstep + 1e-9) * vstep;
   if(lots < vmin - 1e-12)
      return(0.0);
   if(lots > vmax)
      lots = vmax;
   return(NormalizeDouble(lots, 8));
  }

// returns false only when the order should be retried
bool OpenPosition(int dir, double lev)
  {
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   if(ask <= 0.0 || bid <= 0.0)
      return(false);
   if(InpMaxSpreadPoints > 0 && (ask - bid) > InpMaxSpreadPoints * _Point + _Point * 0.5)
     {
      Print("IntradayMomentum_EA: spread too wide, entry skipped");
      return(true);
     }
   double px = (dir > 0) ? ask : bid;
   double npl = NotionalPerLot(px);
   if(npl <= 0.0)
     {
      Print("IntradayMomentum_EA: cannot compute notional per lot; entry skipped");
      return(true);
     }
   double lots = AccountInfoDouble(ACCOUNT_EQUITY) * lev / npl;
   if(InpMaxLots > 0.0)
      lots = MathMin(lots, InpMaxLots);
   lots = NormalizeLots(lots);
   if(lots <= 0.0)
     {
      Print("IntradayMomentum_EA: lot size below the symbol minimum; entry skipped");
      return(true);
     }
   double sl = 0.0;
   if(InpStopPct > 0.0)
     {
      double minDist = (double)SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL) * _Point;
      double dist = MathMax(px * InpStopPct / 100.0, minDist + _Point);
      sl = NormalizeDouble(dir > 0 ? bid - dist : ask + dist, _Digits);
     }
   bool ok = (dir > 0) ? g_trade.Buy(lots, _Symbol, 0.0, sl, 0.0, "IM") : g_trade.Sell(lots, _Symbol, 0.0, sl, 0.0, "IM");
   uint rc = g_trade.ResultRetcode();
   if(!ok || (rc != TRADE_RETCODE_DONE && rc != TRADE_RETCODE_PLACED && rc != TRADE_RETCODE_DONE_PARTIAL))
     {
      Print("IntradayMomentum_EA: order failed ", rc, " ", g_trade.ResultRetcodeDescription());
      return(false);
     }
   PrintFormat("IntradayMomentum_EA: %s %.2f lots (exposure %.2fx), SL %s", (dir > 0 ? "BUY" : "SELL"), lots, lev,
               DoubleToString(sl, _Digits));
   return(true);
  }
//+------------------------------------------------------------------+
