//+------------------------------------------------------------------+
//|                                          IndexReversion_EA.mq5   |
//|  Long-only short-term mean reversion for equity-index CFDs       |
//|  (US500 / S&P 500 primary, NAS100 secondary).                    |
//|                                                                  |
//|  Evaluated once per completed D1 bar (at the first tick of the   |
//|  next D1 bar, after an optional spread check):                   |
//|    Rule A (IBS)  : IBS = (C-L)/(H-L) < 0.20  -> hold long 1 bar  |
//|                    (kept while the signal repeats)               |
//|    Rule B (RSI2) : C > SMA(200) and RSI(2) < 10 -> long          |
//|                    exit when C > SMA(5) or after 10 bars         |
//|  Each rule owns one position (magic = base+1 / base+2) with a    |
//|  broker-side protective stop at signalClose - 3*ATR(10).         |
//|  No martingale, no grid, no averaging down: at most one position |
//|  per rule.                                                       |
//|                                                                  |
//|  Requires a HEDGING account (each rule keeps its own position).  |
//|  Research notes: ea_research/REPORT.md                           |
//+------------------------------------------------------------------+
#property copyright "IndexReversion research build"
#property version   "1.00"
#property description "Long-only daily mean reversion (IBS + RSI2) for index CFDs."

#include <Trade\Trade.mqh>

enum ENUM_SIZING
  {
   SIZING_RISK_PERCENT = 0,   // Risk % of equity per rule (to the stop)
   SIZING_FIXED_LOTS   = 1    // Fixed lots per rule
  };

input group "Signals (defaults fixed from published research; do not optimise)"
input bool   InpUseRuleA      = true;   // Rule A: IBS reversal
input double InpIbsThreshold  = 0.20;   // Rule A: enter when IBS < x
input bool   InpUseRuleB      = true;   // Rule B: RSI(2) pullback in uptrend
input int    InpRsiPeriod     = 2;      // Rule B: RSI period
input double InpRsiThreshold  = 10.0;   // Rule B: enter when RSI < x
input int    InpTrendMaPeriod = 200;    // Rule B: trend filter Close > SMA(n)
input int    InpExitMaPeriod  = 5;      // Rule B: exit when Close > SMA(n)
input int    InpMaxHoldBarsB  = 10;     // Rule B: maximum holding bars

input group "Risk"
input ENUM_SIZING InpSizing   = SIZING_RISK_PERCENT; // Position sizing mode
input double InpRiskPercent   = 1.0;    // Risk % of equity per rule if the stop is hit
input double InpFixedLots     = 0.10;   // Lots per rule (fixed mode)
input int    InpAtrPeriod     = 10;     // ATR period (stop distance)
input double InpStopAtrMult   = 3.0;    // Protective stop = signal close - k*ATR
input double InpMaxLotsTotal  = 0.0;    // Cap on total EA lots on this symbol (0 = none)

input group "Execution"
input int    InpMaxSpreadPoints = 0;    // Wait while spread > x points (0 = no check)
input int    InpMaxWaitMinutes  = 180;  // Entries allowed only this long after the D1 bar opens
input int    InpSlippagePoints  = 50;   // Max deviation for market orders (points)
input bool   InpSkipSundayBars  = true; // Ignore short Sunday D1 bars (GMT brokers)
input long   InpMagicBase       = 26111700; // Magic base (rule A = +1, rule B = +2)
input bool   InpShowPanel       = true; // Show signal values on the chart

//--- globals
CTrade   g_trade;
datetime g_doneBar    = 0;   // D1 bar (open time) already processed
datetime g_pendingBar = 0;   // D1 bar waiting to be processed
datetime g_lastFail   = 0;   // time of the last failed order (retry throttle)

//+------------------------------------------------------------------+
long   MagicA() { return(InpMagicBase + 1); }
long   MagicB() { return(InpMagicBase + 2); }
string GvName() { return("IR_" + _Symbol + "_" + IntegerToString(InpMagicBase) + "_done"); }

//+------------------------------------------------------------------+
int OnInit()
  {
   ENUM_ACCOUNT_MARGIN_MODE mm = (ENUM_ACCOUNT_MARGIN_MODE)AccountInfoInteger(ACCOUNT_MARGIN_MODE);
   if(mm != ACCOUNT_MARGIN_MODE_RETAIL_HEDGING)
     {
      Print("IndexReversion_EA: this EA needs a HEDGING account (one position per rule). Margin mode = ",
            EnumToString(mm));
      return(INIT_FAILED);
     }
   if(InpIbsThreshold <= 0.0 || InpIbsThreshold >= 1.0 || InpRsiPeriod < 1 || InpTrendMaPeriod < 2 ||
      InpExitMaPeriod < 1 || InpAtrPeriod < 1 || InpStopAtrMult <= 0.0 || InpMaxHoldBarsB < 1 ||
      InpMaxWaitMinutes < 1 ||
      (InpSizing == SIZING_RISK_PERCENT && (InpRiskPercent <= 0.0 || InpRiskPercent > 10.0)) ||
      (InpSizing == SIZING_FIXED_LOTS && InpFixedLots <= 0.0))
     {
      Print("IndexReversion_EA: invalid inputs");
      return(INIT_PARAMETERS_INCORRECT);
     }
   g_trade.SetDeviationInPoints((ulong)MathMax(0, InpSlippagePoints));
   g_trade.SetTypeFillingBySymbol(_Symbol);
   g_trade.LogLevel(LOG_LEVEL_ERRORS);

   // The backtested entry price is the close of the signal bar, so never act late on a bar that was already
   // running before the EA started; resume from the last processed bar after a restart.
   if(GlobalVariableCheck(GvName()))
      g_doneBar = (datetime)GlobalVariableGet(GvName());
   else
      g_doneBar = iTime(_Symbol, PERIOD_D1, 0);
   g_pendingBar = 0;
   return(INIT_SUCCEEDED);
  }

//+------------------------------------------------------------------+
void OnDeinit(const int reason)
  {
   Comment("");
  }

//+------------------------------------------------------------------+
void OnTick()
  {
   datetime bar0 = iTime(_Symbol, PERIOD_D1, 0);
   if(bar0 == 0)
      return;
   if(bar0 != g_doneBar && bar0 != g_pendingBar)
      g_pendingBar = bar0;
   if(g_pendingBar == 0)
      return;

   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   if(ask <= 0.0 || bid <= 0.0)
      return;
   bool spreadOk = (InpMaxSpreadPoints <= 0) || ((ask - bid) <= InpMaxSpreadPoints * _Point + _Point * 0.5);
   bool timedOut = (long)(TimeCurrent() - g_pendingBar) > (long)InpMaxWaitMinutes * 60;
   if(!spreadOk && !timedOut)
      return;                                   // wait for a normal spread (exits included)

   if(g_lastFail != 0 && (long)(TimeCurrent() - g_lastFail) < 5)
      return;                                   // throttle retries after a failed order

   bool allowEntries = spreadOk && !timedOut;  // stale or wide-spread entries are skipped, exits are not
   bool exitOk = true, entryOk = true;
   Evaluate(allowEntries, exitOk, entryOk);
   // exits are retried until they succeed; entries only until the wait window closes
   if(exitOk && (entryOk || timedOut))
     {
      g_doneBar    = g_pendingBar;
      g_pendingBar = 0;
      g_lastFail   = 0;
      GlobalVariableSet(GvName(), (double)g_doneBar);
     }
   else
      g_lastFail = TimeCurrent();
  }

//+------------------------------------------------------------------+
//| Core decision on the last completed D1 bar. exitOk / entryOk     |
//| report whether every intended close / open succeeded.            |
//+------------------------------------------------------------------+
void Evaluate(bool allowEntries, bool &exitOk, bool &entryOk)
  {
   int need = (int)MathMax(InpTrendMaPeriod, MathMax(InpExitMaPeriod, InpAtrPeriod + 1)) + 10 * InpRsiPeriod + 30;
   MqlRates r[];
   ArraySetAsSeries(r, true);
   int got = CopyRates(_Symbol, PERIOD_D1, 1, need + 100, r);   // r[0] = last completed D1 bar
   if(got < need)
     {
      Print("IndexReversion_EA: not enough D1 history (", got, " < ", need, "), bar skipped");
      return;
     }

   MqlDateTime dt;
   TimeToStruct(r[0].time, dt);
   if(InpSkipSundayBars && dt.day_of_week == 0)
      return;                                   // short Sunday bar: hold everything until Monday's bar completes

   double c0   = r[0].close;
   double rng  = r[0].high - r[0].low;
   double ibs  = (rng > 0.0) ? (c0 - r[0].low) / rng : 0.5;
   double smaT = SMA(r, 0, InpTrendMaPeriod);
   double smaX = SMA(r, 0, InpExitMaPeriod);
   double rsi  = RSIWilder(r, got, InpRsiPeriod);
   double atr  = ATR(r, 0, InpAtrPeriod);
   double stop = c0 - InpStopAtrMult * atr;

   //--- Rule A: IBS < threshold -> be long for the next bar
   bool  wantA = InpUseRuleA && (ibs < InpIbsThreshold);
   ulong tA    = FindPosition(MagicA());
   if(tA != 0 && !wantA)
     {
      if(!CloseAllMagic(MagicA(), "A exit"))
         exitOk = false;
     }
   else
      if(tA == 0 && wantA && allowEntries)
        {
         if(!OpenLong(MagicA(), stop, "IR-A"))
            entryOk = false;
        }

   //--- Rule B: RSI(2) pullback above SMA(200), exit on close above SMA(5) or time stop
   ulong tB = FindPosition(MagicB());
   if(tB != 0)
     {
      int held = BarsHeld(tB);
      if(c0 > smaX || held >= InpMaxHoldBarsB)
        {
         if(!CloseAllMagic(MagicB(), "B exit"))
            exitOk = false;
        }
     }
   else
      if(InpUseRuleB && allowEntries && c0 > smaT && rsi < InpRsiThreshold)
        {
         if(!OpenLong(MagicB(), stop, "IR-B"))
            entryOk = false;
        }

   if(InpShowPanel)
      Comment(StringFormat("IndexReversion_EA  signal bar %s\nIBS=%.3f (A if < %.2f)   RSI(%d)=%.1f (B if < %.1f)\n" +
                           "Close=%s  SMA%d=%s  SMA%d=%s  ATR%d=%s\nRule A: %s   Rule B: %s",
                           TimeToString(r[0].time, TIME_DATE), ibs, InpIbsThreshold, InpRsiPeriod, rsi, InpRsiThreshold,
                           DoubleToString(c0, _Digits), InpTrendMaPeriod, DoubleToString(smaT, _Digits),
                           InpExitMaPeriod, DoubleToString(smaX, _Digits), InpAtrPeriod, DoubleToString(atr, _Digits),
                           (FindPosition(MagicA()) != 0 ? "LONG" : "flat"), (FindPosition(MagicB()) != 0 ? "LONG" : "flat")));
  }

//+------------------------------------------------------------------+
//| Indicators computed directly from the bars (series order:        |
//| r[0] = newest). Same formulas as the Python research code.       |
//+------------------------------------------------------------------+
double SMA(const MqlRates &r[], int shift, int n)
  {
   double s = 0.0;
   for(int i = shift; i < shift + n; i++)
      s += r[i].close;
   return(s / n);
  }

// ATR = simple average of true range (as the built-in ATR indicator)
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

// Wilder RSI on closes, seeded with the simple average of the first n changes of the window.
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
ulong FindPosition(long magic)
  {
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong t = PositionGetTicket(i);
      if(t == 0)
         continue;
      if(PositionGetString(POSITION_SYMBOL) == _Symbol && PositionGetInteger(POSITION_MAGIC) == magic &&
         PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY)
         return(t);
     }
   return(0);
  }

// number of completed D1 bars since the position was opened (1 at the first evaluation after entry)
int BarsHeld(ulong ticket)
  {
   if(!PositionSelectByTicket(ticket))
      return(0);
   datetime t0 = (datetime)PositionGetInteger(POSITION_TIME);
   int sh = iBarShift(_Symbol, PERIOD_D1, t0, false);
   return(MathMax(0, sh));
  }

double TotalEaLots()
  {
   double v = 0.0;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong t = PositionGetTicket(i);
      if(t == 0)
         continue;
      long mg = PositionGetInteger(POSITION_MAGIC);
      if(PositionGetString(POSITION_SYMBOL) == _Symbol && (mg == MagicA() || mg == MagicB()))
         v += PositionGetDouble(POSITION_VOLUME);
     }
   return(v);
  }

//+------------------------------------------------------------------+
double NormalizeLots(double lots)
  {
   double vmin  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MIN);
   double vmax  = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_MAX);
   double vstep = SymbolInfoDouble(_Symbol, SYMBOL_VOLUME_STEP);
   if(vstep <= 0.0)
      vstep = vmin;
   lots = MathFloor(lots / vstep + 1e-9) * vstep;
   if(lots < vmin - 1e-12)
      return(0.0);                    // too small for the risk budget: skip rather than over-risk
   if(lots > vmax)
      lots = vmax;
   return(NormalizeDouble(lots, 8));
  }

// money lost by 1 lot between entry and sl, in account currency
double LossPerLot(double entry, double sl)
  {
   double profit = 0.0;
   if(OrderCalcProfit(ORDER_TYPE_BUY, _Symbol, 1.0, entry, sl, profit) && profit < 0.0)
      return(-profit);
   double tv = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE_LOSS);
   if(tv <= 0.0)
      tv = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_VALUE);
   double ts = SymbolInfoDouble(_Symbol, SYMBOL_TRADE_TICK_SIZE);
   if(tv <= 0.0 || ts <= 0.0)
      return(0.0);
   return((entry - sl) / ts * tv);
  }

// returns false only when an order should be retried
bool OpenLong(long magic, double sl, string cmt)
  {
   double ask = SymbolInfoDouble(_Symbol, SYMBOL_ASK);
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   double minDist = (double)SymbolInfoInteger(_Symbol, SYMBOL_TRADE_STOPS_LEVEL) * _Point;
   if(sl <= 0.0 || sl >= bid - minDist)
     {
      Print("IndexReversion_EA: price already at/below the planned stop; entry skipped (", cmt, ")");
      return(true);
     }
   sl = NormalizeDouble(sl, _Digits);

   double lots;
   if(InpSizing == SIZING_FIXED_LOTS)
      lots = InpFixedLots;
   else
     {
      double lpl = LossPerLot(ask, sl);
      if(lpl <= 0.0)
        {
         Print("IndexReversion_EA: cannot compute loss per lot; entry skipped");
         return(true);
        }
      lots = AccountInfoDouble(ACCOUNT_EQUITY) * InpRiskPercent / 100.0 / lpl;
     }
   if(InpMaxLotsTotal > 0.0)
      lots = MathMin(lots, InpMaxLotsTotal - TotalEaLots());
   lots = NormalizeLots(lots);
   if(lots <= 0.0)
     {
      Print("IndexReversion_EA: lot size below the symbol minimum for the risk budget; entry skipped (", cmt, ")");
      return(true);
     }
   g_trade.SetExpertMagicNumber((ulong)magic);
   if(!g_trade.Buy(lots, _Symbol, 0.0, sl, 0.0, cmt))
     {
      Print("IndexReversion_EA: buy failed ", g_trade.ResultRetcode(), " ", g_trade.ResultRetcodeDescription());
      return(false);
     }
   uint rc = g_trade.ResultRetcode();
   if(rc != TRADE_RETCODE_DONE && rc != TRADE_RETCODE_PLACED && rc != TRADE_RETCODE_DONE_PARTIAL)
     {
      Print("IndexReversion_EA: buy not done ", rc, " ", g_trade.ResultRetcodeDescription());
      return(false);
     }
   PrintFormat("IndexReversion_EA: %s BUY %.2f lots, SL %s", cmt, lots, DoubleToString(sl, _Digits));
   return(true);
  }

// close every long position of this EA rule on this symbol (normally exactly one)
bool CloseAllMagic(long magic, string why)
  {
   bool ok = true;
   for(int i = PositionsTotal() - 1; i >= 0; i--)
     {
      ulong t = PositionGetTicket(i);
      if(t == 0)
         continue;
      if(PositionGetString(POSITION_SYMBOL) == _Symbol && PositionGetInteger(POSITION_MAGIC) == magic &&
         PositionGetInteger(POSITION_TYPE) == POSITION_TYPE_BUY)
        {
         if(!ClosePosition(t, why))
            ok = false;
        }
     }
   return(ok);
  }

bool ClosePosition(ulong ticket, string why)
  {
   if(!g_trade.PositionClose(ticket))
     {
      Print("IndexReversion_EA: close failed ", g_trade.ResultRetcode(), " ", g_trade.ResultRetcodeDescription());
      return(false);
     }
   uint rc = g_trade.ResultRetcode();
   if(rc != TRADE_RETCODE_DONE && rc != TRADE_RETCODE_PLACED && rc != TRADE_RETCODE_DONE_PARTIAL)
     {
      Print("IndexReversion_EA: close not done ", rc, " ", g_trade.ResultRetcodeDescription());
      return(false);
     }
   Print("IndexReversion_EA: ", why, " ticket ", ticket);
   return(true);
  }
//+------------------------------------------------------------------+
