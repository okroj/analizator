/* Backtest strategii dziennej na słupkach dziennych: kupno po cenie otwarcia, sprzedaż po cenie zamknięcia
   tej samej sesji (albo po stopie, jeśli włączony). Wybór spółek dokładnie taki jak w bocie. */
"use strict";
var St = require("./strategy.js");

function run(data, p, from) {
  var P = St.params(p), cost = P.costBps / 1e4, syms = Object.keys(data), byDay = {}, trades = [];
  syms.forEach(function (s) {
    var bars = data[s], S = St.series(bars, P);
    for (var i = Math.max(30, P.trendSma); i < bars.length - 1; i++) {
      var t = bars[i + 1]; if (from && t.d < from) continue;
      var sig = St.signalAt(bars, S, i, P); if (!sig) continue;
      var exit = t.c, why = "close";
      if (P.stopAtr > 0) { var stop = t.o - P.stopAtr * sig.atr; if (t.l <= stop) { exit = stop; why = "stop"; } }
      var ret = exit * (1 - cost) / (t.o * (1 + cost)) - 1;
      (byDay[t.d] = byDay[t.d] || []).push({ s: s, d: t.d, rsi2: sig.rsi2, entry: t.o, exit: exit, why: why, ret: ret });
    }
  });
  var cal = {}; syms.forEach(function (s) { data[s].forEach(function (b) { if (!from || b.d >= from) cal[b.d] = 1; }); });
  var days = Object.keys(cal).sort(), daily = [];
  days.forEach(function (d) {
    var c = byDay[d] || [], r = 0;
    c = c.length >= P.minSignals ? c.sort(function (a, b) { return a.rsi2 - b.rsi2 || (a.s < b.s ? -1 : 1); }).slice(0, P.maxPos) : [];
    c.forEach(function (t) { r += t.ret / P.maxPos; trades.push(t); });
    daily.push({ d: d, r: r, n: c.length });
  });
  return { P: P, daily: daily, trades: trades };
}

function stats(R, a, z) {
  var eq = 1, peak = 1, dd = 0, sum = 0, sq = 0, nd = 0, active = 0, worst = 0;
  R.daily.forEach(function (x) {
    if ((a && x.d < a) || (z && x.d >= z)) return;
    nd++; if (x.n) active++; if (x.r < worst) worst = x.r;
    eq *= 1 + x.r; if (eq > peak) peak = eq; if (eq / peak - 1 < dd) dd = eq / peak - 1; sum += x.r; sq += x.r * x.r;
  });
  var tr = R.trades.filter(function (t) { return (!a || t.d >= a) && (!z || t.d < z); }), w = 0, st = 0;
  tr.forEach(function (t) { st += t.ret; if (t.ret > 0) w++; });
  var mean = nd ? sum / nd : 0, sd = nd ? Math.sqrt(Math.max(0, sq / nd - mean * mean)) : 0, yrs = nd / 252;
  return { days: nd, trades: tr.length, avgBps: tr.length ? st / tr.length * 1e4 : 0, winRate: tr.length ? w / tr.length : 0,
    total: eq - 1, cagr: yrs > 0 ? Math.pow(eq, 1 / yrs) - 1 : 0, maxDD: dd, sharpe: sd ? mean / sd * Math.sqrt(252) : 0,
    activeDays: nd ? active / nd : 0, worstDay: worst };
}
module.exports = { run: run, stats: stats };
