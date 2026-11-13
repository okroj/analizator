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
    splitYear: 2019,
    /* zestaw reguł: "classic" (średnie i zysk spółki) albo "tx4" (sygnały świecowe, strefy, dwie ramy czasowe) */
    mode: "classic",
    xFrames: "WM",                                  // ramy zarządzania + charakteru: "DW" dzień i tydzień, "WM" tydzień i miesiąc
    xFws: true, xFwd: true, xTr: true,              // sygnały: fałszywe wybicie pojedyncze, podwójne, trójka
    xUseReact: true, xReact: 50,                    // świeca reakcji: zamknięcie w górnych (dla spadków: dolnych) X% zakresu świecy
    xUseChar: true,                                 // kupuj tylko, gdy ostatni sygnał na ramach charakteru był wzrostowy
    xUseSup: true, xSupTol: 2,                      // sygnał przy strefie wsparcia, tolerancja w %
    xUseRoom: false, xRoom: 5,                      // minimalne miejsce do najbliższego oporu w %
    xPivot: 2, xZoneMem: 150,                       // punkt zwrotny: świec z każdej strony; pamięć stref w świecach
    xExitSig: true, xUseDef: true, xExitChar: false, xUseTrail: false, xTrail: 25,
    xCool: 2,                                       // przerwa w tygodniach przed ponownym zakupem tego samego waloru
    xAll: true                                      // test także na walorach z samymi kursami (GPW, ETF-y, złoto)
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

  /* poniedziałek tygodnia, do którego należy sesja (w dniach od epoki) */
  function weekOf(n) { var d = ymd(n), day = Math.round(d / 864e5); return day - ((d.getUTCDay() + 6) % 7); }
  function evalDays(M, P) {
    var N = M.dates.length, ev = new Uint8Array(N);
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

  /* ================= Tx4 (szkic) =================
     Klocki z techniki Tx4: sygnały z 2–3 świec, strefy wsparcia i oporu ze zmianą funkcji, ramy zarządzania i charakteru.
     Sposób złożenia klocków w decyzje kupna i sprzedaży jest roboczy i w całości sterowany parametrami x*. */
  /* Świece wybranych ram z notowań dziennych. at[i] = numer świecy zakończonej sesją i (albo -1), of[i] = ostatnia zakończona świeca na zamknięciu sesji i. */
  function candles(M, T, frame) {
    var N = M.dates.length, O = [], H = [], L = [], C = [], end = [], key = null, n = -1, i;
    for (i = T.start; i < N; i++) {
      var d = M.dates[i], k = frame === "D" ? i : frame === "W" ? weekOf(d) : Math.floor(d / 100);
      var hi = T.h && T.h[i] != null ? T.h[i] : Math.max(T.o[i], T.c[i]), lo = T.l && T.l[i] != null ? T.l[i] : Math.min(T.o[i], T.c[i]);
      if (k !== key) { key = k; n++; O[n] = T.o[i]; H[n] = hi; L[n] = lo; }
      else { if (hi > H[n]) H[n] = hi; if (lo < L[n]) L[n] = lo; }
      C[n] = T.c[i]; end[n] = i;
    }
    n++;
    var lastDone = true;
    if (n && frame !== "D") {
      var ld = ymd(M.dates[N - 1]);
      if (frame === "W") lastDone = ld.getUTCDay() === 5;
      else { var nx = new Date(ld.getTime() + 864e5); while (nx.getUTCDay() === 0 || nx.getUTCDay() === 6) nx = new Date(nx.getTime() + 864e5); lastDone = nx.getUTCMonth() !== ld.getUTCMonth(); }
    }
    var at = new Int32Array(N).fill(-1), of = new Int32Array(N).fill(-1), last = -1;
    for (var j = 0; j < n; j++) if (j < n - 1 || lastDone) at[end[j]] = j;
    for (i = 0; i < N; i++) { if (at[i] >= 0) last = at[i]; of[i] = last; }
    return { O: O, H: H, L: L, C: C, end: end, n: n, at: at, of: of };
  }
  /* Sygnały na świecach K. Dla każdego rodzaju tablica 0/1; extU/extD = skrajna cena układu (minimum dla wzrostowych, maksimum dla spadkowych). */
  function tx4Signals(K, P) {
    var n = K.n, O = K.O, H = K.H, L = K.L, C = K.C, rx = P.xReact / 100;
    var S = { fwsU: new Uint8Array(n), fwdU: new Uint8Array(n), trU: new Uint8Array(n), fwsD: new Uint8Array(n), fwdD: new Uint8Array(n), trD: new Uint8Array(n) };
    function reactUp(h, l, c) { if (!P.xUseReact) return true; var r = h - l; return r > 0 && (c - l) / r >= rx; }
    function reactDn(h, l, c) { if (!P.xUseReact) return true; var r = h - l; return r > 0 && (h - c) / r >= rx; }
    /* formacje świecowe na parach (otwarcie, zamknięcie): objęcie hossy lub przenikanie; objęcie bessy lub zasłona ciemnej chmury */
    function bull(oa, ca, ob, cb) { return ca < oa && cb > ob && ((ob <= ca && cb >= oa) || (ob < ca && cb > (oa + ca) / 2 && cb < oa)); }
    function bear(oa, ca, ob, cb) { return ca > oa && cb < ob && ((ob >= ca && cb <= oa) || (ob > ca && cb < (oa + ca) / 2 && cb > oa)); }
    for (var j = 1; j < n; j++) {
      var a = j - 2, b = j - 1;
      /* fałszywe wybicie pojedyncze: świeca wychodzi poza skrajną cenę poprzedniej i zamyka się z powrotem */
      if (L[j] < L[b] && C[j] > L[b] && reactUp(H[j], L[j], C[j])) S.fwsU[j] = 1;
      if (H[j] > H[b] && C[j] < H[b] && reactDn(H[j], L[j], C[j])) S.fwsD[j] = 1;
      if (a < 0) continue;
      /* fałszywe wybicie podwójne: druga świeca zamyka się poza skrajną ceną pierwszej, trzecia wraca */
      if (C[b] < O[b] && C[b] < L[a] && C[j] > L[a] && reactUp(Math.max(H[b], H[j]), Math.min(L[b], L[j]), C[j])) S.fwdU[j] = 1;
      if (C[b] > O[b] && C[b] > H[a] && C[j] < H[a] && reactDn(Math.max(H[b], H[j]), Math.min(L[b], L[j]), C[j])) S.fwdD[j] = 1;
      /* trójka: niższy szczyt i dołek, potem wyższy szczyt i dołek (lub odwrotnie) razem z formacją świecową, której trzecia świeca nie zaprzecza */
      if (H[b] < H[a] && L[b] < L[a] && H[j] > H[b] && L[j] > L[b] &&
        (bull(O[b], C[b], O[j], C[j]) || bull(O[a], C[a], O[b], C[j]) || (bull(O[a], C[a], O[b], C[b]) && C[j] >= O[j]))) S.trU[j] = 1;
      if (H[b] > H[a] && L[b] > L[a] && H[j] < H[b] && L[j] < L[b] &&
        (bear(O[b], C[b], O[j], C[j]) || bear(O[a], C[a], O[b], C[j]) || (bear(O[a], C[a], O[b], C[b]) && C[j] <= O[j]))) S.trD[j] = 1;
    }
    return S;
  }
  function sigUp(S, P, j) { return (P.xFws && S.fwsU[j]) || (P.xFwd && S.fwdU[j]) || (P.xTr && S.trU[j]) ? 1 : 0; }
  function sigDn(S, P, j) { return (P.xFws && S.fwsD[j]) || (P.xFwd && S.fwdD[j]) || (P.xTr && S.trD[j]) ? 1 : 0; }
  function extLow(K, j) { return Math.min(K.L[j], K.L[j - 1], j >= 2 ? K.L[j - 2] : Infinity); }
  /* Strefy. Wsparcie: od minimum punktu zwrotnego do otwarcia pierwszej białej świecy. Opór: od otwarcia pierwszej czarnej świecy do maksimum.
     Zamknięcie czarnej świecy pod strefą wsparcia zmienia jej funkcję na opór (i odwrotnie); drugie pokonanie usuwa strefę. */
  function tx4Zones(K, S, P) {
    var n = K.n, O = K.O, H = K.H, L = K.L, C = K.C, k = Math.max(1, Math.round(P.xPivot)), mem = P.xZoneMem, tol = P.xSupTol / 100, zones = [];
    var supOK = new Uint8Array(n), room = new Float64Array(n).fill(Infinity), sup = new Float64Array(n).fill(NaN), res = new Float64Array(n).fill(NaN);
    for (var j = 0; j < n; j++) {
      var p = j - k, q, w, z;
      if (p >= k) {
        var isLow = true, isHigh = true;
        for (q = 1; q <= k; q++) { if (!(L[p] < L[p - q]) || !(L[p] <= L[p + q])) isLow = false; if (!(H[p] > H[p - q]) || !(H[p] >= H[p + q])) isHigh = false; }
        if (isLow) for (w = p; w <= j; w++) if (C[w] > O[w]) { if (O[w] > L[p]) zones.push({ kind: "S", lo: L[p], hi: O[w], src: p, born: j, flip: false }); break; }
        if (isHigh) for (w = p; w <= j; w++) if (C[w] < O[w]) { if (O[w] < H[p]) zones.push({ kind: "R", lo: O[w], hi: H[p], src: p, born: j, flip: false }); break; }
      }
      var keep = [];
      for (q = 0; q < zones.length; q++) {
        z = zones[q];
        if (j - z.src > mem) continue;
        if (z.born < j) {
          if (z.kind === "S" && C[j] < O[j] && C[j] < z.lo) { if (z.flip) continue; z.kind = "R"; z.flip = true; }
          else if (z.kind === "R" && C[j] > O[j] && C[j] > z.hi) { if (z.flip) continue; z.kind = "S"; z.flip = true; }
        }
        keep.push(z);
      }
      zones = keep;
      var ext = j >= 1 ? extLow(K, j) : L[j], nearRes = Infinity, nearSup = -Infinity;
      for (q = 0; q < zones.length; q++) {
        z = zones[q];
        if (z.kind === "S") { if (z.src <= j - 3 && ext <= z.hi * (1 + tol) && C[j] >= z.lo) supOK[j] = 1; if (z.hi <= C[j] && z.hi > nearSup) nearSup = z.hi; }
        else if (z.lo > C[j] && z.lo < nearRes) nearRes = z.lo;
      }
      if (isFinite(nearRes)) { room[j] = (nearRes / C[j] - 1) * 100; res[j] = nearRes; }
      if (isFinite(nearSup)) sup[j] = nearSup;
    }
    return { supOK: supOK, room: room, sup: sup, res: res, now: zones };
  }
  /* Wszystko, czego potrzebuje test dla jednej spółki, przeliczone na sesje dzienne. */
  function tx4Prep(M, T, P) {
    var N = M.dates.length, fz = P.xFrames === "WM" ? "W" : "D", fc = P.xFrames === "WM" ? "M" : "W";
    var K = candles(M, T, fz), KC = candles(M, T, fc), S = tx4Signals(K, P), SC = tx4Signals(KC, P), Z = tx4Zones(K, S, P);
    var ch = new Int8Array(KC.n), cur = 0, j, i;
    for (j = 0; j < KC.n; j++) { var u = SC.fwsU[j] || SC.fwdU[j] || SC.trU[j], d = SC.fwsD[j] || SC.fwdD[j] || SC.trD[j]; if (u && !d) cur = 1; else if (d && !u) cur = -1; ch[j] = cur; }
    var entry = new Uint8Array(N), exitSig = new Uint8Array(N), charDn = new Uint8Array(N), ext = new Float64Array(N).fill(NaN);
    for (i = T.start; i < N; i++) {
      j = K.at[i]; if (j < 1) continue;
      var c = KC.of[i] >= 0 ? ch[KC.of[i]] : 0;
      if (c < 0) charDn[i] = 1;
      if (sigDn(S, P, j)) exitSig[i] = 1;
      if (sigUp(S, P, j)) {
        ext[i] = extLow(K, j);
        if ((!P.xUseChar || c > 0) && (!P.xUseSup || Z.supOK[j]) && (!P.xUseRoom || Z.room[j] >= P.xRoom)) entry[i] = 1;
      }
    }
    return { K: K, KC: KC, S: S, Z: Z, ch: ch, entry: entry, exitSig: exitSig, charDn: charDn, ext: ext };
  }
  function tx4Exit(X, P, T, i, peak, def) {
    var c = T.c[i];
    if (P.xUseTrail && c <= peak * (1 - P.xTrail / 100)) return "stop";
    if (P.xUseDef && isFinite(def) && c < def) return "obrona";
    if (P.xExitSig && X.exitSig[i]) return "sig";
    if (P.xExitChar && X.charDn[i]) return "char";
    return null;
  }
  function tx4Stop(P, peak, def) {
    var s = Math.max(P.xUseTrail ? peak * (1 - P.xTrail / 100) : -Infinity, P.xUseDef && isFinite(def) ? def : -Infinity);
    return isFinite(s) ? s : NaN;
  }
  /* Poziom obrony dla pozycji kupionej w sesji e0: minimum ostatniego sygnału wzrostowego z 10 świec przed zakupem, a gdy go nie było, minimum 3 ostatnich świec. */
  function tx4Def(X, P, e0) {
    var K = X.K, j0 = e0 > 0 ? K.of[e0 - 1] : -1, j;
    if (j0 < 0) return NaN;
    for (j = j0; j >= Math.max(1, j0 - 9); j--) if (sigUp(X.S, P, j)) return extLow(K, j);
    return Math.min(K.L[j0], j0 >= 1 ? K.L[j0 - 1] : Infinity, j0 >= 2 ? K.L[j0 - 2] : Infinity);
  }
  /* Warunki kupna Tx4 na ostatniej zakończonej świecy – dla Skanera. */
  function tx4Checks(X, P, i) {
    var K = X.K, j = K.of[i], out = [];
    if (j < 1) return out;
    var c = X.KC.of[i] >= 0 ? X.ch[X.KC.of[i]] : 0;
    out.push(["xsig", !!sigUp(X.S, P, j), NaN]);
    if (P.xUseChar) out.push(["xchar", c > 0, c]);
    if (P.xUseSup) out.push(["xsup", !!X.Z.supOK[j], X.Z.sup[j]]);
    if (P.xUseRoom) out.push(["xroom", X.Z.room[j] >= P.xRoom, X.Z.room[j]]);
    return out;
  }
  var TX_TYPES = [["fwsU", "fws", 1], ["fwdU", "fwd", 1], ["trU", "tr", 1], ["fwsD", "fws", -1], ["fwdD", "fwd", -1], ["trD", "tr", -1]];
  /* Badanie sygnałów: jak często po sygnale kurs zamknął się po właściwej stronie po 5, 10 i 20 świecach. */
  function tx4Study(M, R) {
    var P = R.P, hs = [5, 10, 20], rows = TX_TYPES.map(function (t) { return { key: t[0], type: t[1], dir: t[2], n: 0, hit: [0, 0, 0], cnt: [0, 0, 0], sum: 0 }; });
    rows.push({ key: "entry", type: "entry", dir: 1, n: 0, hit: [0, 0, 0], cnt: [0, 0, 0], sum: 0 });   // sygnał wzrostowy razem ze wszystkimi włączonymi warunkami kupna
    var base = { n: 0, up: [0, 0, 0], cnt: [0, 0, 0], sum: 0 };
    M.tickers.forEach(function (T, t) {
      var X = R.tx && R.tx[t]; if (!X || !R.inU[t]) return;
      var K = X.K, C = K.C;
      for (var j = 2; j < K.n; j++) {
        if (K.end[j] < R.start) continue;
        var done = j < K.n - 1 || K.at[K.end[j]] === j; if (!done) continue;
        for (var h = 0; h < 3; h++) if (j + hs[h] < K.n) { base.cnt[h]++; if (C[j + hs[h]] > C[j]) base.up[h]++; if (h === 1) base.sum += C[j + 10] / C[j] - 1; }
        base.n++;
        rows.forEach(function (r) {
          if (r.key === "entry" ? !X.entry[K.end[j]] : !X.S[r.key][j]) return;
          r.n++;
          for (var h2 = 0; h2 < 3; h2++) if (j + hs[h2] < K.n) { r.cnt[h2]++; if (r.dir > 0 ? C[j + hs[h2]] > C[j] : C[j + hs[h2]] < C[j]) r.hit[h2]++; if (h2 === 1) r.sum += C[j + 10] / C[j] - 1; }
        });
      }
    });
    return { rows: rows, base: base, horizons: hs };
  }
  /* Sygnały z trzech ostatnich zakończonych świec każdego waloru. */
  function tx4Now(M, R) {
    var P = R.P, N = M.dates.length, out = [];
    M.tickers.forEach(function (T, t) {
      var X = R.tx && R.tx[t]; if (!X) return;
      var K = X.K, j1 = K.of[N - 1];
      for (var j = j1; j >= Math.max(1, j1 - 2); j--) TX_TYPES.forEach(function (ty) {
        if (!X.S[ty[0]][j]) return;
        var c = X.KC.of[K.end[j]] >= 0 ? X.ch[X.KC.of[K.end[j]]] : 0;
        out.push({ t: t, s: T.s, n: T.n, type: ty[1], dir: ty[2], i: K.end[j], age: j1 - j, close: K.C[j], sup: !!X.Z.supOK[j], ch: c, on: !!P[ty[1] === "fws" ? "xFws" : ty[1] === "fwd" ? "xFwd" : "xTr"], level: ty[2] > 0 ? extLow(K, j) : Math.max(K.H[j], K.H[j - 1], j >= 2 ? K.H[j - 2] : -Infinity) });
      });
    });
    return out.sort(function (a, b) { return a.age - b.age || b.dir - a.dir || (a.s < b.s ? -1 : 1); });
  }

  function run(M, Pin) {
    var P = {}; for (var k in DEFAULTS) P[k] = (Pin && Pin[k] !== undefined) ? Pin[k] : DEFAULTS[k];
    var N = M.dates.length, TT = M.tickers, nT = TT.length;
    var I = TT.map(function (T) { return indicators(M, T, P); });
    var tx4 = P.mode === "tx4", X = tx4 ? TT.map(function (T) { return tx4Prep(M, T, P); }) : null;
    var ev = evalDays(M, tx4 ? { weekly: P.xFrames === "WM" } : P);
    var inU = TT.map(function (T) { return tx4 && P.xAll ? true : !T.x; });   // walory biorące udział w teście
    function entF(t, i) { return tx4 ? i >= TT[t].start && X[t].entry[i] === 1 : entryOk(TT[t], I[t], P, i); }
    function exF(t, i, peak, def) { return tx4 ? tx4Exit(X[t], P, TT[t], i, peak, def) : exitReason(TT[t], I[t], P, i, peak); }
    var s0 = firstIndexOfYear(M, P.startYear);
    var cool = Math.round((tx4 ? P.xCool : P.cooldownWeeks) * 5), costF = P.cost / 100;

    /* 1. Sygnały każdej spółki osobno (bez limitu kapitału) – dla skanera i wykresu. */
    var signals = TT.map(function (T, t) {
      var st = { inPos: false, peak: 0, def: NaN, entrySig: -1, lastExit: -1e9, events: [] };
      for (var i = Math.max(s0, T.start); i < N; i++) {
        if (st.inPos && T.c[i] > st.peak) st.peak = T.c[i];
        if (!ev[i]) continue;
        if (st.inPos) {
          var why = exF(t, i, st.peak, st.def);
          if (why) { st.inPos = false; st.lastExit = i; st.events.push({ i: i, type: "sell", why: why }); }
        } else if (i - st.lastExit >= cool && entF(t, i)) {
          st.inPos = true; st.peak = T.c[i]; st.entrySig = i; st.def = tx4 ? X[t].ext[i] : NaN; st.events.push({ i: i, type: "buy" });
        }
      }
      return st;
    });

    /* 2. Portfel z limitem pozycji i kosztami. */
    var eq = new Float64Array(N), expo = new Float64Array(N), bench = new Float64Array(N);
    var cash = P.capital, held = {}, heldCount = 0, trades = [], lastExit = new Float64Array(nT).fill(-1e9);
    var pendSell = [], pendBuy = [], pendSig = -1, t, i;
    var weight = 1 / P.maxPos;
    if (!tx4 && P.useRisk && P.useTrail) weight = Math.min(weight, (P.riskPct / 100) / (P.trail / 100));
    /* Tx4: ryzyko liczone od odległości kursu do poziomu obrony z sygnału wejścia */
    function wFor(t, sig, px) { if (!tx4 || !P.useRisk || !P.xUseDef) return weight; var d = X[t].ext[sig], dist = isFinite(d) && px > 0 ? 1 - d / px : NaN; return dist > 0 ? Math.min(weight, (P.riskPct / 100) / Math.max(dist, 0.005)) : weight; }
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
          px = TT[t].o[i];
          var spend = Math.min(eqOpen * wFor(t, pendSig, px), cash);
          if (spend < 1) continue;
          var sh = spend / (px * (1 + costF));
          cash -= spend;
          var tr = { t: t, s: TT[t].s, entryIdx: i, entryPx: px, costBasis: spend, open: true, exitIdx: N - 1, exitPx: null, pnl: 0, ret: 0, why: null };
          trades.push(tr); held[t] = { sh: sh, peak: px, tr: tr, def: tx4 ? X[t].ext[pendSig] : NaN }; heldCount++;
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
        for (t = 0; t < nT; t++) if (inU[t] && TT[t].start <= i - 1) { rs += TT[t].c[i] / TT[t].c[i - 1] - 1; rn++; }
        bench[i] = bench[i - 1] * (1 + (rn ? rs / rn : 0));
      }
      /* decyzje na zamknięciu dnia oceny */
      if (ev[i] && i + 1 < N) {
        for (t in held) {
          var why = exF(+t, i, held[t].peak, held[t].def);
          if (why) pendSell.push({ t: +t, why: why, sig: i });
        }
        var free = P.maxPos - heldCount + pendSell.length;
        if (free > 0) {
          var cand = [];
          for (t = 0; t < nT; t++) {
            if (!inU[t] || held[t] || i - lastExit[t] < cool) continue;   // w regułach klasycznych spółki z samymi kursami nie biorą udziału w teście
            if (entF(t, i)) cand.push(t);
          }
          cand.sort(function (x, y) {
            var mx = isNaN(I[x].mom[i]) ? -1e9 : I[x].mom[i], my = isNaN(I[y].mom[i]) ? -1e9 : I[y].mom[i];
            return my - mx || x - y;
          });
          pendBuy = cand.slice(0, free); pendSig = i;
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
      equity: eq, bench: bench, exposure: expo, trades: trades, signals: signals, ind: I, evalDays: ev, tx: X, inU: inU,
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
      if (S.inPos && R.tx) stop = tx4Stop(P, S.peak, S.def);
      else if (S.inPos) {
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
        checks: R.tx ? tx4Checks(R.tx[t], P, i) : entryChecks(T, I, P, i)
      };
    }).filter(function (r) { return R.inU[r.t]; });
  }

  /* ---------- Portfel: polecenia dla prawdziwych pozycji ---------- */
  function dateInt(s) { return +String(s).replace(/-/g, ""); }
  function dstr(n) { var s = String(n); return s.slice(6) + "." + s.slice(4, 6) + "." + s.slice(0, 4); }
  var WHY = { stop: "spadek od szczytu", trend: "kurs pod średnią", zysk: "spadek zysku spółki", obrona: "zamknięcie pod poziomem obrony", sig: "sygnał spadkowy Tx4", char: "spadkowy charakter na wyższych ramach" };

  /* st = { positions: [{s, date: "RRRR-MM-DD", px, qty}], cash, fx }. Ceny pozycji są w walucie notowań spółki (pole cur spółki: brak = USD, "PLN" = złote).
     Wartości i sumy wychodzą w dolarach: pozycje w złotych dzielone są przez fx (kurs dolara w złotych), cash jest w dolarach.
     Każda pozycja jest prowadzona regułami sprzedaży od dnia zakupu; wolne miejsca dostają kandydatów do kupna. */
  /* live = { SYMBOL: bieżący kurs } (opcjonalnie): zastępuje ostatnie zamknięcie w wycenie i w zapasie do progu */
  function actions(M, R, st, live) {
    var P = R.P, N = M.dates.length, TT = M.tickers, ev = R.evalDays, lastEval = -1, prevEval = -1, i;
    for (i = N - 1; i >= 0; i--) if (ev[i]) { if (lastEval < 0) lastEval = i; else { prevEval = i; break; } }
    var bySym = {}; TT.forEach(function (T, t) { bySym[T.s] = t; });
    var positions = (st && st.positions) || [], cash = st && st.cash > 0 ? +st.cash : 0;
    var fx = st && st.fx > 0 ? +st.fx : (M.fx && M.fx.USDPLN > 0 ? M.fx.USDPLN : 3.91);
    var items = [], heldSyms = {}, value = 0, cost = 0, sellValue = 0, keep = 0;
    positions.forEach(function (p) {
      heldSyms[p.s] = true;
      var t = bySym[p.s];
      var lp = live && live[p.s] > 0 ? live[p.s] : 0;
      if (t === undefined) {   // bez historii notowań: wartość po kursie na żywo, a gdy go nie ma, po cenie zakupu
        var v0 = p.qty * (lp || p.px); value += v0; cost += p.qty * p.px; keep++;
        items.push(lp ? { type: "nodata", s: p.s, p: p, value: v0, close: lp, ret: lp / p.px - 1, pnl: v0 - p.qty * p.px, hasPx: true } : { type: "nodata", s: p.s, p: p, value: v0 });
        return;
      }
      var T = TT[t], I = R.ind[t], d = dateInt(p.date), e0 = N - 1, k;
      for (k = 0; k < N; k++) if (M.dates[k] >= d) { e0 = k; break; }
      if (e0 < T.start) e0 = T.start;
      var peak = p.px, sig = null, X = R.tx ? R.tx[t] : null, def = X ? tx4Def(X, P, e0) : NaN;
      for (k = e0; k < N; k++) {
        if (T.c[k] > peak) peak = T.c[k];
        if (ev[k] && !sig) { var why = X ? tx4Exit(X, P, T, k, peak, def) : exitReason(T, I, P, k, peak); if (why) sig = { i: k, why: why }; }
      }
      var toUsd = T.cur === "PLN" ? 1 / fx : 1, c = lp || T.c[N - 1], val = p.qty * c * toUsd, paid = p.qty * p.px * toUsd;
      if (c > peak) peak = c;
      var a = P.useTrail ? peak * (1 - P.trail / 100) : -Infinity;
      var b = P.useTrendExit && isFinite(I.smaL[N - 1]) ? I.smaL[N - 1] * (1 - P.exitBuffer / 100) : -Infinity;
      var stop = Math.max(a, b); if (!isFinite(stop)) stop = NaN;
      if (X) stop = tx4Stop(P, peak, def);
      value += val; cost += paid;
      if (sig) sellValue += val; else keep++;
      items.push({ type: sig ? "sell" : (c <= stop ? "watch" : "hold"), s: p.s, n: T.n, t: t, p: p, cur: T.cur === "PLN" ? "PLN" : "USD", close: c, value: val, ret: c / p.px - 1, pnl: val - paid,
        stop: stop, toStop: isNaN(stop) ? NaN : stop / c - 1, sig: sig, fresh: !!sig && sig.i >= lastEval });
    });
    var total = value + cash, free = Math.max(0, P.maxPos - keep), cand = [];
    function entA(t, i) { return R.tx ? i >= TT[t].start && R.tx[t].entry[i] === 1 : entryOk(TT[t], R.ind[t], P, i); }
    if (lastEval >= 0) TT.forEach(function (T, t) { if (R.inU[t] && !heldSyms[T.s] && entA(t, lastEval)) cand.push(t); });
    cand.sort(function (x, y) {
      var mx = isNaN(R.ind[x].mom[lastEval]) ? -1e9 : R.ind[x].mom[lastEval], my = isNaN(R.ind[y].mom[lastEval]) ? -1e9 : R.ind[y].mom[lastEval];
      return my - mx || x - y;
    });
    var left = cash + sellValue;   // gotówka dostępna po wykonaniu sprzedaży, rozdzielana po kolei
    var buys = cand.slice(0, free).map(function (t) {
      var T = TT[t], c = live && live[T.s] > 0 ? live[T.s] : T.c[N - 1], amount = total > 0 ? Math.max(0, Math.min(total * R.weight, left)) : NaN;
      if (total > 0) left -= amount;
      return { type: "buy", s: T.s, n: T.n, t: t, close: c, amount: amount, shares: amount / c, mom: R.ind[t].mom[lastEval],
        fresh: prevEval < 0 || !entA(t, prevEval) };
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

  var api = { DEFAULTS: DEFAULTS, run: run, scan: scan, actions: actions, summary: summary, WHY: WHY, ymd: ymd, firstIndexOfYear: firstIndexOfYear,
    tx4Study: tx4Study, tx4Now: tx4Now, _tx4: { candles: candles, signals: tx4Signals, zones: tx4Zones } };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.Engine = api;
})(typeof window !== "undefined" ? window : globalThis);
