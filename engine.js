/* Silnik reguł i backtestu. Czyste funkcje, bez dostępu do strony.
   Zasada: sygnał liczony na zamknięciu dnia oceny, zlecenie po cenie otwarcia następnej sesji. */
(function (root) {
  "use strict";

  var DEFAULTS = {
    startYear: 2008,
    weekly: true,          // ocena sygnałów raz w tygodniu (ostatnia sesja tygodnia) albo codziennie
    useTrend: true, smaLong: 200,
    useCross: false, smaFast: 50,
    useMom: true, momMonths: 6, momMin: 0,         // momMin w %
    usePosEps: true,
    useGrowth: true, growthMin: 0,                  // wzrost zysku na akcję r/r w %
    usePe: false, peMax: 60,
    useTrendExit: true, exitBuffer: 3,              // % poniżej średniej
    useTrail: true, trail: 25,                      // % od szczytu od zakupu
    useFundExit: false, growthExit: -20,            // % r/r
    cooldownWeeks: 4,
    capital: 10000, maxPos: 5,
    useRisk: false, riskPct: 2,                     // % kapitału ryzykowany na pozycję
    cost: 0.2,                                      // % wartości każdej transakcji (prowizja + poślizg)
    splitYear: 2019
  };

  function ymd(n) { return new Date(Date.UTC(Math.floor(n / 10000), Math.floor(n / 100) % 100 - 1, n % 100)); }

  /* Wskaźniki jednej spółki dla podanych parametrów. */
  function indicators(M, T, P) {
    var N = M.dates.length, c = T.c, s = T.start;
    var smaL = new Float64Array(N).fill(NaN), smaF = new Float64Array(N).fill(NaN);
    var mom = new Float64Array(N).fill(NaN), eps = new Float64Array(N).fill(NaN);
    var growth = new Float64Array(N).fill(NaN), pe = new Float64Array(N).fill(NaN);
    var pre = new Float64Array(N + 1);
    for (var i = s; i < N; i++) pre[i + 1] = pre[i] + c[i];
    var L = P.smaLong, F = P.smaFast, md = Math.round(P.momMonths * 21);
    for (i = s; i < N; i++) {
      if (i - s + 1 >= L) smaL[i] = (pre[i + 1] - pre[i + 1 - L]) / L;
      if (i - s + 1 >= F) smaF[i] = (pre[i + 1] - pre[i + 1 - F]) / F;
      if (i - md >= s) mom[i] = (c[i] / c[i - md] - 1) * 100;
    }
    var q = T.q, k = -1;
    for (i = 0; i < N; i++) {
      while (k + 1 < q.length && q[k + 1][0] <= i) k++;
      if (k < 0 || i < s) continue;
      var e = q[k][1];
      eps[i] = e;
      if (e > 0) pe[i] = c[i] / e;
      if (k >= 4) {
        var b = q[k - 4][1];
        growth[i] = b > 0 ? (e / b - 1) * 100 : (e > b ? 999 : -999);
      }
    }
    return { smaL: smaL, smaF: smaF, mom: mom, eps: eps, growth: growth, pe: pe };
  }

  /* Warunki wejścia: lista [nazwa, spełniony, wartość]. Brak danych = niespełniony. */
  function entryChecks(T, I, P, i) {
    var c = T.c[i], out = [];
    if (P.useTrend) out.push(["trend", c > I.smaL[i], I.smaL[i]]);
    if (P.useCross) out.push(["cross", I.smaF[i] > I.smaL[i], I.smaF[i]]);
    if (P.useMom) out.push(["mom", I.mom[i] >= P.momMin, I.mom[i]]);
    if (P.usePosEps) out.push(["eps", I.eps[i] > 0, I.eps[i]]);
    if (P.useGrowth) out.push(["growth", I.growth[i] >= P.growthMin, I.growth[i]]);
    if (P.usePe) out.push(["pe", I.pe[i] <= P.peMax, I.pe[i]]);
    return out;
  }
  function entryOk(T, I, P, i) {
    if (i < T.start || T.c[i] == null) return false;
    var ch = entryChecks(T, I, P, i);
    if (!ch.length) return false;
    for (var j = 0; j < ch.length; j++) if (!ch[j][1]) return false;
    return true;
  }
  /* Warunek wyjścia: zwraca powód albo null. peak = najwyższe zamknięcie od zakupu. */
  function exitReason(T, I, P, i, peak) {
    var c = T.c[i];
    if (P.useTrail && c <= peak * (1 - P.trail / 100)) return "stop";
    if (P.useTrendExit && c < I.smaL[i] * (1 - P.exitBuffer / 100)) return "trend";
    if (P.useFundExit && I.growth[i] < P.growthExit) return "zysk";
    return null;
  }

  function evalDays(M, P) {
    var N = M.dates.length, ev = new Uint8Array(N);
    /* poniedziałek tygodnia, do którego należy sesja (w dniach od epoki) */
    function weekOf(n) { var d = ymd(n), day = Math.round(d / 864e5); return day - ((d.getUTCDay() + 6) % 7); }
    for (var i = 0; i < N; i++) {
      if (!P.weekly) { ev[i] = 1; continue; }
      if (i + 1 < N) { if (weekOf(M.dates[i + 1]) !== weekOf(M.dates[i])) ev[i] = 1; }
      else if (ymd(M.dates[i]).getUTCDay() === 5) ev[i] = 1;
    }
    return ev;
  }
  function firstIndexOfYear(M, y) {
    var t = y * 10000;
    for (var i = 0; i < M.dates.length; i++) if (M.dates[i] > t) return i;
    return M.dates.length - 1;
  }
  function yearsBetween(M, a, b) { return (ymd(M.dates[b]) - ymd(M.dates[a])) / (365.25 * 864e5); }

  function periodStats(M, eq, a, b, trades, expo) {
    if (b <= a) return null;
    var tot = eq[b] / eq[a] - 1, yrs = yearsBetween(M, a, b);
    var cagr = Math.pow(eq[b] / eq[a], 1 / yrs) - 1;
    var peak = eq[a], dd = 0, sum = 0, sq = 0, n = 0;
    for (var i = a + 1; i <= b; i++) {
      if (eq[i] > peak) peak = eq[i];
      var d = eq[i] / peak - 1; if (d < dd) dd = d;
      var r = eq[i] / eq[i - 1] - 1; sum += r; sq += r * r; n++;
    }
    var mean = sum / n, vol = Math.sqrt(Math.max(0, sq / n - mean * mean)) * Math.sqrt(252);
    var st = { total: tot, cagr: cagr, maxDD: dd, vol: vol, mar: dd < 0 ? cagr / -dd : NaN, years: yrs };
    if (trades) {
      var w = 0, gw = 0, gl = 0, cnt = 0, hold = 0;
      for (var j = 0; j < trades.length; j++) {
        var t = trades[j];
        if (t.open || t.exitIdx <= a || t.exitIdx > b) continue;
        cnt++; hold += t.exitIdx - t.entryIdx;
        if (t.pnl > 0) { w++; gw += t.pnl; } else gl -= t.pnl;
      }
      st.trades = cnt; st.winRate = cnt ? w / cnt : NaN;
      st.profitFactor = gl > 0 ? gw / gl : (gw > 0 ? Infinity : NaN);
      st.avgHoldDays = cnt ? hold / cnt : NaN;
    }
    if (expo) { var es = 0; for (i = a; i <= b; i++) es += expo[i]; st.exposure = es / (b - a + 1); }
    return st;
  }

  function run(M, Pin) {
    var P = {}; for (var k in DEFAULTS) P[k] = (Pin && Pin[k] !== undefined) ? Pin[k] : DEFAULTS[k];
    var N = M.dates.length, TT = M.tickers, nT = TT.length;
    var I = TT.map(function (T) { return indicators(M, T, P); });
    var ev = evalDays(M, P);
    var s0 = firstIndexOfYear(M, P.startYear);
    var cool = Math.round(P.cooldownWeeks * 5), costF = P.cost / 100;

    /* 1. Sygnały każdej spółki osobno (bez limitu kapitału) – dla skanera i wykresu. */
    var signals = TT.map(function (T, t) {
      var st = { inPos: false, peak: 0, entrySig: -1, lastExit: -1e9, events: [] };
      for (var i = Math.max(s0, T.start); i < N; i++) {
        if (st.inPos && T.c[i] > st.peak) st.peak = T.c[i];
        if (!ev[i]) continue;
        if (st.inPos) {
          var why = exitReason(T, I[t], P, i, st.peak);
          if (why) { st.inPos = false; st.lastExit = i; st.events.push({ i: i, type: "sell", why: why }); }
        } else if (i - st.lastExit >= cool && entryOk(T, I[t], P, i)) {
          st.inPos = true; st.peak = T.c[i]; st.entrySig = i; st.events.push({ i: i, type: "buy" });
        }
      }
      return st;
    });

    /* 2. Portfel z limitem pozycji i kosztami. */
    var eq = new Float64Array(N), expo = new Float64Array(N), bench = new Float64Array(N);
    var cash = P.capital, held = {}, heldCount = 0, trades = [], lastExit = new Float64Array(nT).fill(-1e9);
    var pendSell = [], pendBuy = [], t, i;
    var weight = 1 / P.maxPos;
    if (P.useRisk && P.useTrail) weight = Math.min(weight, (P.riskPct / 100) / (P.trail / 100));
    for (i = 0; i < s0; i++) { eq[i] = P.capital; bench[i] = P.capital; }
    for (i = s0; i < N; i++) {
      /* zlecenia z poprzedniego dnia oceny – po cenie otwarcia */
      if (pendSell.length || pendBuy.length) {
        for (var a = 0; a < pendSell.length; a++) {
          t = pendSell[a].t; var h = held[t]; if (!h) continue;
          var px = TT[t].o[i], val = h.sh * px * (1 - costF);
          cash += val; h.tr.exitIdx = i; h.tr.exitPx = px; h.tr.why = pendSell[a].why;
          h.tr.pnl = val - h.tr.costBasis; h.tr.ret = val / h.tr.costBasis - 1; h.tr.open = false;
          delete held[t]; heldCount--; lastExit[t] = pendSell[a].sig;
        }
        var eqOpen = cash; for (t in held) eqOpen += held[t].sh * TT[t].o[i];
        for (a = 0; a < pendBuy.length; a++) {
          t = pendBuy[a]; if (held[t] || heldCount >= P.maxPos) continue;
          var spend = Math.min(eqOpen * weight, cash);
          if (spend < 1) continue;
          px = TT[t].o[i];
          var sh = spend / (px * (1 + costF));
          cash -= spend;
          var tr = { t: t, s: TT[t].s, entryIdx: i, entryPx: px, costBasis: spend, open: true, exitIdx: N - 1, exitPx: null, pnl: 0, ret: 0, why: null };
          trades.push(tr); held[t] = { sh: sh, peak: px, tr: tr }; heldCount++;
        }
        pendSell = []; pendBuy = [];
      }
      /* wycena na zamknięciu */
      var inv = 0;
      for (t in held) { var cc = TT[t].c[i]; if (cc > held[t].peak) held[t].peak = cc; inv += held[t].sh * cc; }
      eq[i] = cash + inv; expo[i] = eq[i] > 0 ? inv / eq[i] : 0;
      /* punkt odniesienia: równe udziały we wszystkich notowanych spółkach z listy */
      if (i === s0) bench[i] = P.capital;
      else {
        var rs = 0, rn = 0;
        for (t = 0; t < nT; t++) if (!TT[t].x && TT[t].start <= i - 1) { rs += TT[t].c[i] / TT[t].c[i - 1] - 1; rn++; }
        bench[i] = bench[i - 1] * (1 + (rn ? rs / rn : 0));
      }
      /* decyzje na zamknięciu dnia oceny */
      if (ev[i] && i + 1 < N) {
        for (t in held) {
          var why = exitReason(TT[t], I[t], P, i, held[t].peak);
          if (why) pendSell.push({ t: +t, why: why, sig: i });
        }
        var free = P.maxPos - heldCount + pendSell.length;
        if (free > 0) {
          var cand = [];
          for (t = 0; t < nT; t++) {
            if (TT[t].x || held[t] || i - lastExit[t] < cool) continue;   // spółki z samymi kursami nie biorą udziału w teście
            if (entryOk(TT[t], I[t], P, i)) cand.push(t);
          }
          cand.sort(function (x, y) {
            var mx = isNaN(I[x].mom[i]) ? -1e9 : I[x].mom[i], my = isNaN(I[y].mom[i]) ? -1e9 : I[y].mom[i];
            return my - mx || x - y;
          });
          pendBuy = cand.slice(0, free);
        }
      }
    }
    /* otwarte pozycje wyceniane po ostatnim zamknięciu */
    for (t in held) {
      var tr2 = held[t].tr, v = held[t].sh * TT[t].c[N - 1];
      tr2.exitPx = TT[t].c[N - 1]; tr2.pnl = v - tr2.costBasis; tr2.ret = v / tr2.costBasis - 1; tr2.peak = held[t].peak;
    }
    var e = N - 1, sp = Math.min(Math.max(firstIndexOfYear(M, P.splitYear), s0 + 1), e - 1);
    return {
      P: P, start: s0, end: e, split: sp, weight: weight,
      equity: eq, bench: bench, exposure: expo, trades: trades, signals: signals, ind: I, evalDays: ev,
      stats: {
        all: periodStats(M, eq, s0, e, trades, expo), allB: periodStats(M, bench, s0, e),
        ins: periodStats(M, eq, s0, sp, trades, expo), insB: periodStats(M, bench, s0, sp),
        oos: periodStats(M, eq, sp, e, trades, expo), oosB: periodStats(M, bench, sp, e)
      }
    };
  }

  /* Stan każdej spółki na dziś – dla skanera. */
  function scan(M, R) {
    var N = M.dates.length, P = R.P, fresh = 5;
    return M.tickers.map(function (T, t) {
      var S = R.signals[t], I = R.ind[t], i = N - 1, c = T.c[i];
      var last = S.events.length ? S.events[S.events.length - 1] : null;
      var status = S.inPos ? "hold" : "out";
      if (last && i - last.i <= fresh) status = last.type === "buy" ? "buy" : "sell";
      var stop = NaN;
      if (S.inPos) {
        var a = P.useTrail ? S.peak * (1 - P.trail / 100) : -Infinity;
        var b = P.useTrendExit ? I.smaL[i] * (1 - P.exitBuffer / 100) : -Infinity;
        stop = Math.max(a, b); if (!isFinite(stop)) stop = NaN;
      }
      return {
        t: t, s: T.s, n: T.n, close: c, status: status, last: last, inPos: S.inPos,
        entrySig: S.inPos ? S.entrySig : -1,
        sinceEntry: S.inPos && S.entrySig + 1 < N ? c / T.o[S.entrySig + 1] - 1 : NaN,
        stop: stop, toStop: isNaN(stop) ? NaN : stop / c - 1,
        vsSma: (c / I.smaL[i] - 1) * 100, mom: I.mom[i], pe: I.pe[i], eps: I.eps[i], growth: I.growth[i],
        checks: entryChecks(T, I, P, i)
      };
    }).filter(function (r) { return !M.tickers[r.t].x; });
  }

  /* ---------- Portfel: polecenia dla prawdziwych pozycji ---------- */
  function dateInt(s) { return +String(s).replace(/-/g, ""); }
  function dstr(n) { var s = String(n); return s.slice(6) + "." + s.slice(4, 6) + "." + s.slice(0, 4); }
  var WHY = { stop: "spadek od szczytu", trend: "kurs pod średnią", zysk: "spadek zysku spółki" };

  /* st = { positions: [{s, date: "RRRR-MM-DD", px, qty}], cash }.
     Każda pozycja jest prowadzona regułami sprzedaży od dnia zakupu; wolne miejsca dostają kandydatów do kupna. */
  function actions(M, R, st) {
    var P = R.P, N = M.dates.length, TT = M.tickers, ev = R.evalDays, lastEval = -1, prevEval = -1, i;
    for (i = N - 1; i >= 0; i--) if (ev[i]) { if (lastEval < 0) lastEval = i; else { prevEval = i; break; } }
    var bySym = {}; TT.forEach(function (T, t) { bySym[T.s] = t; });
    var positions = (st && st.positions) || [], cash = st && st.cash > 0 ? +st.cash : 0;
    var items = [], heldSyms = {}, value = 0, cost = 0, sellValue = 0, keep = 0;
    positions.forEach(function (p) {
      heldSyms[p.s] = true;
      var t = bySym[p.s];
      if (t === undefined) { var atCost = p.qty * p.px; value += atCost; cost += atCost; items.push({ type: "nodata", s: p.s, p: p, value: atCost }); keep++; return; }   // bez notowań: wartość po cenie zakupu
      var T = TT[t], I = R.ind[t], d = dateInt(p.date), e0 = N - 1, k;
      for (k = 0; k < N; k++) if (M.dates[k] >= d) { e0 = k; break; }
      if (e0 < T.start) e0 = T.start;
      var peak = p.px, sig = null;
      for (k = e0; k < N; k++) {
        if (T.c[k] > peak) peak = T.c[k];
        if (ev[k] && !sig) { var why = exitReason(T, I, P, k, peak); if (why) sig = { i: k, why: why }; }
      }
      var c = T.c[N - 1], val = p.qty * c;
      var a = P.useTrail ? peak * (1 - P.trail / 100) : -Infinity;
      var b = P.useTrendExit && isFinite(I.smaL[N - 1]) ? I.smaL[N - 1] * (1 - P.exitBuffer / 100) : -Infinity;
      var stop = Math.max(a, b); if (!isFinite(stop)) stop = NaN;
      value += val; cost += p.qty * p.px;
      if (sig) sellValue += val; else keep++;
      items.push({ type: sig ? "sell" : (c <= stop ? "watch" : "hold"), s: p.s, n: T.n, t: t, p: p, close: c, value: val, ret: c / p.px - 1, pnl: val - p.qty * p.px,
        stop: stop, toStop: isNaN(stop) ? NaN : stop / c - 1, sig: sig, fresh: !!sig && sig.i >= lastEval });
    });
    var total = value + cash, free = Math.max(0, P.maxPos - keep), cand = [];
    if (lastEval >= 0) TT.forEach(function (T, t) { if (!T.x && !heldSyms[T.s] && entryOk(T, R.ind[t], P, lastEval)) cand.push(t); });
    cand.sort(function (x, y) {
      var mx = isNaN(R.ind[x].mom[lastEval]) ? -1e9 : R.ind[x].mom[lastEval], my = isNaN(R.ind[y].mom[lastEval]) ? -1e9 : R.ind[y].mom[lastEval];
      return my - mx || x - y;
    });
    var left = cash + sellValue;   // gotówka dostępna po wykonaniu sprzedaży, rozdzielana po kolei
    var buys = cand.slice(0, free).map(function (t) {
      var T = TT[t], c = T.c[N - 1], amount = total > 0 ? Math.max(0, Math.min(total * R.weight, left)) : NaN;
      if (total > 0) left -= amount;
      return { type: "buy", s: T.s, n: T.n, t: t, close: c, amount: amount, shares: amount / c, mom: R.ind[t].mom[lastEval],
        fresh: prevEval < 0 || !entryOk(T, R.ind[t], P, prevEval) };
    });
    var order = { sell: 0, watch: 1, buy: 2, hold: 3, nodata: 4 };
    items = items.concat(buys).sort(function (x, y) { return order[x.type] - order[y.type]; });
    return { items: items, lastEval: lastEval, value: value, cost: cost, cash: cash, total: total, free: free, waiting: Math.max(0, cand.length - free), weight: R.weight };
  }

  /* Jedno krótkie podsumowanie do powiadomienia. noteworthy = jest coś nowego do zrobienia. */
  function summary(M, A) {
    var N = M.dates.length, out = [], fresh = false;
    var sells = A.items.filter(function (x) { return x.type === "sell"; }), buys = A.items.filter(function (x) { return x.type === "buy"; });
    var watch = A.items.filter(function (x) { return x.type === "watch"; }), hold = A.items.filter(function (x) { return x.type === "hold"; });
    if (sells.length) { out.push("SPRZEDAJ: " + sells.map(function (x) { if (x.fresh) fresh = true; return x.s + " (" + WHY[x.sig.why] + (x.fresh ? "" : ", zaległy sygnał z " + dstr(M.dates[x.sig.i])) + ")"; }).join(", ") + "."); }
    var nb = buys.filter(function (x) { return x.fresh; });
    if (nb.length) { fresh = true; out.push("KUP: " + nb.map(function (x) { return x.s; }).join(", ") + "."); }
    if (watch.length) { fresh = true; out.push("Poniżej progu sprzedaży, decyzja na koniec tygodnia: " + watch.map(function (x) { return x.s; }).join(", ") + "."); }
    if (hold.length) out.push("Trzymaj: " + hold.map(function (x) { return x.s; }).join(", ") + ".");
    if (!fresh && !sells.length) out.unshift("Brak nowych sygnałów.");
    return { noteworthy: fresh || sells.length > 0, text: "Analizator giełdy, notowania z " + dstr(M.dates[N - 1]) + ". " + out.join(" ") };
  }

  var api = { DEFAULTS: DEFAULTS, run: run, scan: scan, actions: actions, summary: summary, WHY: WHY, ymd: ymd, firstIndexOfYear: firstIndexOfYear };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.Engine = api;
})(typeof window !== "undefined" ? window : globalThis);
