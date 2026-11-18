//+------------------------------------------------------------------+
//|                                                ExportBars.mq5    |
//|  MT5 script: export the bar history of one or more symbols to    |
//|  CSV files (same columns as MT5's own "Bars > Export").          |
//|                                                                  |
//|  Output : <data folder>/MQL5/Files/<symbol>_<TF>.csv             |
//|           <data folder>/MQL5/Files/export_info.txt               |
//|           (File > Open Data Folder shows the data folder)        |
//|  Read-only: this script never sends, modifies or closes orders.  |
//|                                                                  |
//|  Before running: Tools > Options > Charts > "Max bars in chart"  |
//|  = Unlimited, then restart MT5 (otherwise only the most recent   |
//|  bars are available to CopyRates).                               |
//+------------------------------------------------------------------+
#property copyright "IndexReversion research build"
#property version   "1.00"
#property description "Exports bar history to CSV (read-only, no trading)."
#property script_show_inputs

input string          InpSymbols   = "";             // Symbols, comma separated (empty = this chart's symbol)
input ENUM_TIMEFRAMES InpTimeframe = PERIOD_M5;      // Timeframe to export
input datetime        InpFrom      = D'2012.01.01';  // From (server time)
input datetime        InpTo        = 0;              // To (0 = now)

//+------------------------------------------------------------------+
void OnStart()
  {
   string list = InpSymbols;
   StringTrimLeft(list);
   StringTrimRight(list);
   if(list == "")
      list = _Symbol;
   string syms[];
   int n = StringSplit(list, ',', syms);
   for(int k = 0; k < n; k++)
     {
      StringTrimLeft(syms[k]);
      StringTrimRight(syms[k]);
     }
   long maxbars = TerminalInfoInteger(TERMINAL_MAXBARS);
   if(maxbars < 5000000)
      PrintFormat("ExportBars: 'Max bars in chart' is %I64d. Set it to Unlimited (Tools > Options > Charts) and restart MT5 "
                  "to export long histories.", maxbars);
   WriteInfo(syms, n, maxbars);
   for(int k = 0; k < n && !IsStopped(); k++)
     {
      if(syms[k] == "")
         continue;
      if(!SymbolSelect(syms[k], true))
        {
         PrintFormat("ExportBars: symbol '%s' not found on this server", syms[k]);
         continue;
        }
      ExportSymbol(syms[k]);
     }
   Comment("");
  }

//+------------------------------------------------------------------+
string TfName()
  {
   string s = EnumToString(InpTimeframe);   // e.g. "PERIOD_M5"
   return(StringSubstr(s, 7));
  }

//+------------------------------------------------------------------+
void ExportSymbol(const string sym)
  {
   string fname = sym + "_" + TfName() + ".csv";
   int h = FileOpen(fname, FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE)
     {
      PrintFormat("ExportBars: cannot create %s (error %d)", fname, GetLastError());
      return;
     }
   FileWriteString(h, "<DATE>\t<TIME>\t<OPEN>\t<HIGH>\t<LOW>\t<CLOSE>\t<TICKVOL>\t<VOL>\t<SPREAD>\r\n");

   int      digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
   datetime to     = (InpTo == 0) ? TimeTradeServer() : InpTo;
   long     chunk  = (long)PeriodSeconds(InpTimeframe) * 40000;   // about 40k bars per request
   if(chunk < 86400)
      chunk = 86400;
   long     total  = 0;
   datetime first  = 0, last = 0;
   // skip the years before the server's first bar of this symbol (avoids long retries on empty ranges)
   datetime start  = InpFrom;
   datetime srvFirst = (datetime)SeriesInfoInteger(sym, InpTimeframe, SERIES_SERVER_FIRSTDATE);
   if(srvFirst > start)
      start = srvFirst;

   for(datetime t = start; t < to && !IsStopped(); t = (datetime)(t + chunk))
     {
      datetime t2 = (datetime)(t + chunk - 1);
      if(t2 > to)
         t2 = to;
      MqlRates r[];
      int got = -1;
      // the terminal downloads missing history from the server on request: retry while it synchronises
      for(int attempt = 0; attempt < 40 && got < 0 && !IsStopped(); attempt++)
        {
         ResetLastError();
         got = CopyRates(sym, InpTimeframe, t, t2, r);
         if(got < 0)
            Sleep(250);
        }
      if(got < 0)
        {
         PrintFormat("ExportBars: %s no bars for %s - %s (error %d)", sym, TimeToString(t), TimeToString(t2), GetLastError());
         continue;
        }
      for(int i = 0; i < got; i++)
        {
         if(r[i].time < t || r[i].time > t2)
            continue;
         FileWriteString(h, TimeToString(r[i].time, TIME_DATE) + "\t" + TimeToString(r[i].time, TIME_SECONDS) + "\t" +
                            DoubleToString(r[i].open, digits) + "\t" + DoubleToString(r[i].high, digits) + "\t" +
                            DoubleToString(r[i].low, digits) + "\t" + DoubleToString(r[i].close, digits) + "\t" +
                            IntegerToString(r[i].tick_volume) + "\t" + IntegerToString(r[i].real_volume) + "\t" +
                            IntegerToString(r[i].spread) + "\r\n");
         if(first == 0)
            first = r[i].time;
         last = r[i].time;
         total++;
        }
      Comment(StringFormat("ExportBars  %s %s  up to %s  bars=%I64d", sym, TfName(), TimeToString(t2, TIME_DATE), total));
     }
   FileClose(h);
   PrintFormat("ExportBars: %s %s -> MQL5\\Files\\%s  bars=%I64d  first=%s  last=%s", sym, TfName(), fname, total,
               TimeToString(first), TimeToString(last));
  }

//+------------------------------------------------------------------+
//| Broker clock and symbol specifications (needed to convert the    |
//| server time to New York time and to model costs).                |
//+------------------------------------------------------------------+
void WriteInfo(const string &syms[], int n, long maxbars)
  {
   int h = FileOpen("export_info.txt", FILE_WRITE | FILE_TXT | FILE_ANSI);
   if(h == INVALID_HANDLE)
      return;
   FileWriteString(h, "company=" + TerminalInfoString(TERMINAL_COMPANY) + "\r\n");
   FileWriteString(h, "server=" + AccountInfoString(ACCOUNT_SERVER) + "\r\n");
   FileWriteString(h, "export_time_gmt=" + TimeToString(TimeGMT(), TIME_DATE | TIME_SECONDS) + "\r\n");
   FileWriteString(h, "server_minus_gmt_hours=" + DoubleToString((double)(TimeTradeServer() - TimeGMT()) / 3600.0, 2) + "\r\n");
   FileWriteString(h, "max_bars_in_chart=" + IntegerToString(maxbars) + "\r\n");
   FileWriteString(h, "timeframe=" + TfName() + "\r\n");
   for(int k = 0; k < n; k++)
     {
      string s = syms[k];
      if(s == "" || !SymbolSelect(s, true))
         continue;
      FileWriteString(h, "[" + s + "]\r\n");
      FileWriteString(h, "description=" + SymbolInfoString(s, SYMBOL_DESCRIPTION) + "\r\n");
      FileWriteString(h, "digits=" + IntegerToString(SymbolInfoInteger(s, SYMBOL_DIGITS)) + "\r\n");
      FileWriteString(h, "point=" + DoubleToString(SymbolInfoDouble(s, SYMBOL_POINT), 10) + "\r\n");
      FileWriteString(h, "contract_size=" + DoubleToString(SymbolInfoDouble(s, SYMBOL_TRADE_CONTRACT_SIZE), 4) + "\r\n");
      FileWriteString(h, "tick_size=" + DoubleToString(SymbolInfoDouble(s, SYMBOL_TRADE_TICK_SIZE), 10) + "\r\n");
      FileWriteString(h, "tick_value=" + DoubleToString(SymbolInfoDouble(s, SYMBOL_TRADE_TICK_VALUE), 6) + "\r\n");
      FileWriteString(h, "currency_profit=" + SymbolInfoString(s, SYMBOL_CURRENCY_PROFIT) + "\r\n");
      FileWriteString(h, "spread_now_points=" + IntegerToString(SymbolInfoInteger(s, SYMBOL_SPREAD)) + "\r\n");
      FileWriteString(h, "swap_mode=" + EnumToString((ENUM_SYMBOL_SWAP_MODE)SymbolInfoInteger(s, SYMBOL_SWAP_MODE)) + "\r\n");
      FileWriteString(h, "swap_long=" + DoubleToString(SymbolInfoDouble(s, SYMBOL_SWAP_LONG), 4) + "\r\n");
      FileWriteString(h, "swap_short=" + DoubleToString(SymbolInfoDouble(s, SYMBOL_SWAP_SHORT), 4) + "\r\n");
      FileWriteString(h, "volume_min=" + DoubleToString(SymbolInfoDouble(s, SYMBOL_VOLUME_MIN), 4) + "\r\n");
      FileWriteString(h, "volume_step=" + DoubleToString(SymbolInfoDouble(s, SYMBOL_VOLUME_STEP), 4) + "\r\n");
     }
   FileClose(h);
  }
//+------------------------------------------------------------------+
