//+------------------------------------------------------------------+
//|                                          IndexReversion_EA.mq4   |
//|  MQL4 port of IndexReversion_EA.mq5 (same rules and defaults).   |
//|                                                                  |
//|  Evaluated once per completed D1 bar (first tick of next D1 bar):|
//|    Rule A (IBS)  : IBS = (C-L)/(H-L) < 0.20  -> hold long 1 bar  |
//|    Rule B (RSI2) : C > SMA(200) and RSI(2) < 10 -> long          |
//|                    exit when C > SMA(5) or after 10 bars         |
//|  One order per rule (magic = base+1 / base+2), broker-side stop  |
//|  at signalClose - 3*ATR(10). No martingale / grid / averaging.   |
//+------------------------------------------------------------------+
#property copyright "IndexReversion research build"
#property version   "1.10"
#property strict
#property description "Long-only daily mean reversion (IBS + RSI2) for index CFDs."

enum ENUM_SIZING
  {
   SIZING_NOTIONAL     = 0,   // Notional = x times equity per rule (research setting)
   SIZING_RISK_PERCENT = 1,   // Risk % of equity per rule (to the stop)
   SIZING_FIXED_LOTS   = 2    // Fixed lots per rule
  };

//--- Signals (defaults fixed from published research; do not optimise)
input bool   InpUseRuleA      = true;   // Rule A: IBS reversal
input double InpIbsThreshold  = 0.20;   // Rule A: enter when IBS < x
input bool   InpUseRuleB      = true;   // Rule B: RSI(2) pullback in uptrend
input int    InpRsiPeriod     = 2;      // Rule B: RSI period
input double InpRsiThreshold  = 10.0;   // Rule B: enter when RSI < x
input int    InpTrendMaPeriod = 200;    // Rule B: trend filter Close > SMA(n)
input int    InpExitMaPeriod  = 5;      // Rule B: exit when Close > SMA(n)
input int    InpMaxHoldBarsB  = 10;     // Rule B: maximum holding bars
//--- Risk
input ENUM_SIZING InpSizing   = SIZING_NOTIONAL; // Position sizing mode
input double InpNotionalMult  = 0.5;    // Notional per rule as a multiple of equity (notional mode)
input double InpRiskPercent   = 1.0;    // Risk % of equity per rule if the stop is hit (risk mode)
input double InpFixedLots     = 0.10;   // Lots per rule (fixed mode)
input int    InpAtrPeriod     = 10;     // ATR period (stop distance)
input double InpStopAtrMult   = 3.0;    // Protective stop = signal close - k*ATR
input double InpMaxLotsTotal  = 0.0;    // Cap on total EA lots on this symbol (0 = none)
//--- Execution
input int    InpMaxSpreadPoints = 0;    // Wait while spread > x points (0 = no check)
input int    InpMaxWaitMinutes  = 180;  // Entries allowed only this long after the D1 bar opens
input int    InpSlippagePoints  = 50;   // Max slippage (points)
input bool   InpSkipSundayBars  = true; // Ignore short Sunday D1 bars (GMT brokers)
input int    InpMagicBase       = 26111700; // Magic base (rule A = +1, rule B = +2)
input bool   InpShowPanel       = true; // Show signal values on the chart

datetime g_doneBar    = 0;
datetime g_pendingBar = 0;
datetime g_lastFail   = 0;   // time of the last failed order (retry throttle)

int    MagicA() { return(InpMagicBase + 1); }
int    MagicB() { return(InpMagicBase + 2); }
string GvName() { return("IR_" + Symbol() + "_" + IntegerToString(InpMagicBase) + "_done"); }

//+------------------------------------------------------------------+
int OnInit()
  {
   if(InpIbsThreshold <= 0.0 || InpIbsThreshold >= 1.0 || InpRsiPeriod < 1 || InpTrendMaPeriod < 2 ||
      InpExitMaPeriod < 1 || InpAtrPeriod < 1 || InpStopAtrMult <= 0.0 || InpMaxHoldBarsB < 1 ||
      InpMaxWaitMinutes < 1 ||
      (InpSizing == SIZING_NOTIONAL && (InpNotionalMult <= 0.0 || InpNotionalMult > 10.0)) ||
      (InpSizing == SIZING_RISK_PERCENT && (InpRiskPercent <= 0.0 || InpRiskPercent > 10.0)) ||
      (InpSizing == SIZING_FIXED_LOTS && InpFixedLots <= 0.0))
     {
      Print("IndexReversion_EA: invalid inputs");
      return(INIT_PARAMETERS_INCORRECT);
     }
   if(GlobalVariableCheck(GvName()))
      g_doneBar = (datetime)GlobalVariableGet(GvName());
   else
      g_doneBar = iTime(Symbol(), PERIOD_D1, 0);
   g_pendingBar = 0;
   return(INIT_SUCCEEDED);
  }

void OnDeinit(const int reason)
  {
   Comment("");
  }

//+------------------------------------------------------------------+
void OnTick()
  {
   datetime bar0 = iTime(Symbol(), PERIOD_D1, 0);
   if(bar0 == 0)
      return;
   if(bar0 != g_doneBar && bar0 != g_pendingBar)
      g_pendingBar = bar0;
   if(g_pendingBar == 0)
      return;

   RefreshRates();
   if(Ask <= 0.0 || Bid <= 0.0)
      return;
   bool spreadOk = (InpMaxSpreadPoints <= 0) || ((Ask - Bid) <= InpMaxSpreadPoints * Point + Point * 0.5);
   bool timedOut = (int)(TimeCurrent() - g_pendingBar) > InpMaxWaitMinutes * 60;
   if(!spreadOk && !timedOut)
      return;

   if(g_lastFail != 0 && (int)(TimeCurrent() - g_lastFail) < 5)
      return;

   bool allowEntries = spreadOk && !timedOut;
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
void Evaluate(bool allowEntries, bool &exitOk, bool &entryOk)
  {
   int need = (int)MathMax(InpTrendMaPeriod, MathMax(InpExitMaPeriod, InpAtrPeriod + 1)) + 10 * InpRsiPeriod + 30;
   MqlRates r[];
   ArraySetAsSeries(r, true);
   int got = CopyRates(Symbol(), PERIOD_D1, 1, need + 100, r);   // r[0] = last completed D1 bar
   if(got < need)
     {
      Print("IndexReversion_EA: not enough D1 history (", got, " < ", need, "), bar skipped");
      return;
     }
   if(InpSkipSundayBars && TimeDayOfWeek(r[0].time) == 0)
      return;

   double c0   = r[0].close;
   double rng  = r[0].high - r[0].low;
   double ibs  = (rng > 0.0) ? (c0 - r[0].low) / rng : 0.5;
   double smaT = SMA(r, 0, InpTrendMaPeriod);
   double smaX = SMA(r, 0, InpExitMaPeriod);
   double rsi  = RSIWilder(r, got, InpRsiPeriod);
   double atr  = ATR(r, 0, InpAtrPeriod);
   double stop = c0 - InpStopAtrMult * atr;

   bool wantA = InpUseRuleA && (ibs < InpIbsThreshold);
   int  tA    = FindOrder(MagicA());
   if(tA > 0 && !wantA)
     {
      if(!CloseAllMagic(MagicA(), "A exit"))
         exitOk = false;
     }
   else
      if(tA <= 0 && wantA && allowEntries)
        {
         if(!OpenLong(MagicA(), stop, "IR-A"))
            entryOk = false;
        }

   int tB = FindOrder(MagicB());
   if(tB > 0)
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
                           DoubleToString(c0, Digits), InpTrendMaPeriod, DoubleToString(smaT, Digits),
                           InpExitMaPeriod, DoubleToString(smaX, Digits), InpAtrPeriod, DoubleToString(atr, Digits),
                           (FindOrder(MagicA()) > 0 ? "LONG" : "flat"), (FindOrder(MagicB()) > 0 ? "LONG" : "flat")));
  }

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
int FindOrder(int magic)
  {
   for(int i = OrdersTotal() - 1; i >= 0; i--)
     {
      if(!OrderSelect(i, SELECT_BY_POS, MODE_TRADES))
         continue;
      if(OrderSymbol() == Symbol() && OrderMagicNumber() == magic && OrderType() == OP_BUY)
         return(OrderTicket());
     }
   return(0);
  }

int BarsHeld(int ticket)
  {
   if(!OrderSelect(ticket, SELECT_BY_TICKET))
      return(0);
   int sh = iBarShift(Symbol(), PERIOD_D1, OrderOpenTime(), false);
   return(MathMax(0, sh));
  }

double TotalEaLots()
  {
   double v = 0.0;
   for(int i = OrdersTotal() - 1; i >= 0; i--)
     {
      if(!OrderSelect(i, SELECT_BY_POS, MODE_TRADES))
         continue;
      if(OrderSymbol() == Symbol() && (OrderMagicNumber() == MagicA() || OrderMagicNumber() == MagicB()))
         v += OrderLots();
     }
   return(v);
  }

double NormalizeLots(double lots)
  {
   double vmin  = MarketInfo(Symbol(), MODE_MINLOT);
   double vmax  = MarketInfo(Symbol(), MODE_MAXLOT);
   double vstep = MarketInfo(Symbol(), MODE_LOTSTEP);
   if(vstep <= 0.0)
      vstep = vmin;
   lots = MathFloor(lots / vstep + 1e-9) * vstep;
   if(lots < vmin - 1e-12)
      return(0.0);
   if(lots > vmax)
      lots = vmax;
   return(NormalizeDouble(lots, 8));
  }

// value of 1 lot at this price (account currency), from tick value
double NotionalPerLot(double price)
  {
   double tv = MarketInfo(Symbol(), MODE_TICKVALUE);
   double ts = MarketInfo(Symbol(), MODE_TICKSIZE);
   if(tv <= 0.0 || ts <= 0.0)
      return(0.0);
   return(price / ts * tv);
  }

// money lost by 1 lot between entry and sl (account currency), from tick value
double LossPerLot(double entry, double sl)
  {
   double tv = MarketInfo(Symbol(), MODE_TICKVALUE);
   double ts = MarketInfo(Symbol(), MODE_TICKSIZE);
   if(tv <= 0.0 || ts <= 0.0)
      return(0.0);
   return((entry - sl) / ts * tv);
  }

bool OpenLong(int magic, double sl, string cmt)
  {
   RefreshRates();
   double minDist = MarketInfo(Symbol(), MODE_STOPLEVEL) * Point;
   if(sl <= 0.0 || sl >= Bid - minDist)
     {
      Print("IndexReversion_EA: price already at/below the planned stop; entry skipped (", cmt, ")");
      return(true);
     }
   sl = NormalizeDouble(sl, Digits);
   double lots;
   if(InpSizing == SIZING_FIXED_LOTS)
      lots = InpFixedLots;
   else if(InpSizing == SIZING_NOTIONAL)
     {
      double npl = NotionalPerLot(Ask);
      if(npl <= 0.0)
        {
         Print("IndexReversion_EA: cannot compute notional per lot; entry skipped");
         return(true);
        }
      lots = AccountEquity() * InpNotionalMult / npl;
     }
   else
     {
      double lpl = LossPerLot(Ask, sl);
      if(lpl <= 0.0)
        {
         Print("IndexReversion_EA: cannot compute loss per lot; entry skipped");
         return(true);
        }
      lots = AccountEquity() * InpRiskPercent / 100.0 / lpl;
     }
   if(InpMaxLotsTotal > 0.0)
      lots = MathMin(lots, InpMaxLotsTotal - TotalEaLots());
   lots = NormalizeLots(lots);
   if(lots <= 0.0)
     {
      Print("IndexReversion_EA: lot size below the symbol minimum for the risk budget; entry skipped (", cmt, ")");
      return(true);
     }
   int ticket = OrderSend(Symbol(), OP_BUY, lots, Ask, InpSlippagePoints, sl, 0, cmt, magic, 0, clrNONE);
   if(ticket < 0)
     {
      Print("IndexReversion_EA: buy failed, error ", GetLastError());
      return(false);
     }
   PrintFormat("IndexReversion_EA: %s BUY %.2f lots, SL %s", cmt, lots, DoubleToString(sl, Digits));
   return(true);
  }

// close every buy order of this EA rule on this symbol (normally exactly one)
bool CloseAllMagic(int magic, string why)
  {
   bool ok = true;
   for(int i = OrdersTotal() - 1; i >= 0; i--)
     {
      if(!OrderSelect(i, SELECT_BY_POS, MODE_TRADES))
         continue;
      if(OrderSymbol() == Symbol() && OrderMagicNumber() == magic && OrderType() == OP_BUY)
        {
         if(!CloseOrder(OrderTicket(), why))
            ok = false;
        }
     }
   return(ok);
  }

bool CloseOrder(int ticket, string why)
  {
   if(!OrderSelect(ticket, SELECT_BY_TICKET))
      return(true);
   RefreshRates();
   if(!OrderClose(ticket, OrderLots(), Bid, InpSlippagePoints, clrNONE))
     {
      Print("IndexReversion_EA: close failed, error ", GetLastError());
      return(false);
     }
   Print("IndexReversion_EA: ", why, " ticket ", ticket);
   return(true);
  }
//+------------------------------------------------------------------+
