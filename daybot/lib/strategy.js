/* Strategia dzienna "Odbicie po wyprzedaży". Czyste funkcje, używane tak samo przez backtest i przez bota.

   Zasada: jeśli spółka zamknęła wczorajszą sesję mocno wyprzedana (niski RSI z 2 sesji i zamknięcie
   blisko dołka dnia), kupujemy ją na otwarciu dzisiejszej sesji i sprzedajemy tego samego dnia przed
   zamknięciem. Żadna pozycja nie zostaje na noc.

   Słupek dzienny: { d: "RRRR-MM-DD", o, h, l, c }. */
"use strict";

var DEFAULTS = {
  rsiMax: 10,        // sygnał, gdy RSI(2) z wczorajszego zamknięcia jest poniżej tej wartości
  ibsMax: 0.2,       // ...i gdy zamknięcie wypadło w dolnych 20% wczorajszego zakresu (IBS)
  minSignals: 2,     // handluj tylko w dni, gdy sygnał ma naraz co najmniej tyle spółek z listy (szeroka wyprzedaż)
  trendSma: 0,       // 0 = bez filtra trendu; np. 200 = tylko gdy kurs nad średnią z 200 sesji
  maxPos: 4,         // najwyżej tyle pozycji jednego dnia; każda dostaje kapitał / maxPos
  stopAtr: 0,        // 0 = bez stopu; np. 2 = sprzedaj, gdy kurs spadnie 2 x ATR(14) poniżej ceny otwarcia
  costBps: 5         // zakładany koszt jednej strony transakcji (spread + poślizg), w punktach bazowych
};

function params(p) { var P = {}; for (var k in DEFAULTS) P[k] = p && typeof p[k] === typeof DEFAULTS[k] ? p[k] : DEFAULTS[k]; return P; }

/* Wskaźniki dla całej historii jednej spółki. */
function series(bars, P) {
  var n = bars.length, rsi2 = new Float64Array(n).fill(NaN), ibs = new Float64Array(n).fill(NaN);
  var atr = new Float64Array(n).fill(NaN), sma = new Float64Array(n).fill(NaN);
  var ag = 0, al = 0, trs = 0, sum = 0, L = P.trendSma;
  function tr(i) { return Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c)); }
  for (var i = 0; i < n; i++) {
    var b = bars[i];
    ibs[i] = b.h > b.l ? (b.c - b.l) / (b.h - b.l) : 0.5;
    if (L > 0) { sum += b.c; if (i >= L) sum -= bars[i - L].c; if (i >= L - 1) sma[i] = sum / L; }
    if (i === 0) continue;
    var ch = b.c - bars[i - 1].c;
    ag = (ag + Math.max(ch, 0)) / 2; al = (al + Math.max(-ch, 0)) / 2;       // wygładzanie Wildera, okres 2
    if (i >= 10) rsi2[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    trs += tr(i); if (i > 14) trs -= tr(i - 14);
    if (i >= 14) atr[i] = trs / 14;
  }
  return { rsi2: rsi2, ibs: ibs, atr: atr, sma: sma };
}

/* Czy po zamknięciu słupka i jest sygnał kupna na następną sesję. */
function signalAt(bars, S, i, P) {
  if (i < 14 || !(S.rsi2[i] < P.rsiMax) || !(S.ibs[i] < P.ibsMax)) return null;
  if (P.trendSma > 0 && !(bars[i].c > S.sma[i])) return null;
  return { rsi2: S.rsi2[i], ibs: S.ibs[i], atr: S.atr[i], prevClose: bars[i].c, signalDate: bars[i].d };
}

/* Plan na dziś: history = { SYMBOL: [słupki do wczoraj włącznie] }. Zwraca listę kandydatów, najbardziej wyprzedane pierwsze. */
function plan(history, p) {
  var P = params(p), out = [];
  Object.keys(history).forEach(function (sym) {
    var bars = history[sym]; if (!bars || bars.length < 30) return;
    var sig = signalAt(bars, series(bars, P), bars.length - 1, P);
    if (sig) { sig.symbol = sym; out.push(sig); }
  });
  out.sort(function (a, b) { return a.rsi2 - b.rsi2 || (a.symbol < b.symbol ? -1 : 1); });
  return { params: P, all: out, picks: out.length >= P.minSignals ? out.slice(0, P.maxPos) : [] };
}

module.exports = { DEFAULTS: DEFAULTS, params: params, series: series, signalAt: signalAt, plan: plan };
