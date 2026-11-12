/* Codzienne odświeżenie Analizatora giełdy.
   node daily.js --csv KATALOG --engine engine.js --out data.js [--prev stare-data.js] [--state state.json]
   KATALOG zawiera pliki SYMBOL.csv (date,open,high,low,close,volume,ttm_net_eps,pe_ratio).
   Opcjonalnie --csv2 KATALOG2 z plikami SYMBOL.csv (date,open,high,low,close,volume,div,split): same kursy dla spółek z Portfela.
   Wypisuje jeden obiekt JSON: czy są nowe notowania, czy plik przeszedł kontrolę i gotowe podsumowanie. */
"use strict";
var fs = require("fs"), path = require("path");
var arg = {}; process.argv.slice(2).forEach(function (a, i, all) { if (a.slice(0, 2) === "--") arg[a.slice(2)] = all[i + 1]; });
var NAMES = { AAPL: "Apple", ACN: "Accenture", ADBE: "Adobe", CRM: "Salesforce", DELL: "Dell Technologies", GOOG: "Alphabet", INTU: "Intuit", LRCX: "Lam Research", META: "Meta Platforms", MSFT: "Microsoft", NFLX: "Netflix", NVDA: "Nvidia", RMD: "ResMed", SAP: "SAP (ADR)", TSLA: "Tesla", TSM: "TSMC (ADR)" };
var EXTRA = { AMZN: "Amazon", PLTR: "Palantir", MU: "Micron", AVGO: "Broadcom", SPCX: "SpaceX" };
/* --extra PLIK.json zastępuje domyślną listę spółek z samymi kursami: {"SYMBOL": "Nazwa"} albo {"SYMBOL": {n: "Nazwa", cur: "PLN", m: "GPW"}}
   --fx 3.9100 --fxdate RRRR-MM-DD: kurs dolara w złotych, zapisywany w danych jako fx */
if (arg.extra && fs.existsSync(arg.extra)) { try { EXTRA = JSON.parse(fs.readFileSync(arg.extra, "utf8")); } catch (err) { fail("zły plik --extra"); } }
var START = "2005-01-03", HEADER = "date,open,high,low,close,volume,ttm_net_eps,pe_ratio", HEADER2 = "date,open,high,low,close,volume,div,split";
function fail(msg) { console.log(JSON.stringify({ ok: false, error: msg })); process.exit(1); }
function load(sym) {
  var f = path.join(arg.csv, sym + ".csv"); if (!fs.existsSync(f)) fail("brak pliku " + sym + ".csv");
  var lines = fs.readFileSync(f, "utf8").trim().split(/\r?\n/);
  if (lines[0].trim() !== HEADER) fail(sym + ": nieoczekiwany nagłówek pliku");
  var rows = [];
  for (var i = 1; i < lines.length; i++) {
    var c = lines[i].split(",");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(c[0])) fail(sym + ": zła data w wierszu " + (i + 1));
    rows.push({ d: c[0], o: c[1] === "" ? NaN : +c[1], c: c[4] === "" ? NaN : +c[4], e: c[6] === "" || c[6] === undefined ? null : +c[6] });
  }
  if (rows.length < 500) fail(sym + ": za mało wierszy");
  return rows;
}
function addDays(d, n) { var t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); }
function r3(v) { return Math.round(v * 1000) / 1000; }

var all = {}, asOf = "9999-12-31";
Object.keys(NAMES).forEach(function (s) { all[s] = load(s); var last = all[s][all[s].length - 1].d; if (last < asOf) asOf = last; });
/* kalendarz: sesje AAPL od START do najstarszej z ostatnich dat wszystkich spółek */
var cal = all.AAPL.filter(function (r) { return r.d >= START && r.d <= asOf; }).map(function (r) { return r.d; });
var N = cal.length, pos = {}; cal.forEach(function (d, i) { pos[d] = i; });
function firstIdxOnOrAfter(d) { var lo = 0, hi = N; while (lo < hi) { var m = (lo + hi) >> 1; if (cal[m] < d) lo = m + 1; else hi = m; } return lo; }
var filled = 0;
var tickers = Object.keys(NAMES).map(function (s) {
  var rows = all[s], inRange = rows.filter(function (r) { return r.d >= START && r.d <= asOf; });
  var o = new Array(N).fill(null), c = new Array(N).fill(null), first = -1;
  inRange.forEach(function (r) {
    var i = pos[r.d]; if (i === undefined) fail(s + ": sesja " + r.d + " spoza kalendarza");
    if (!(r.o > 0) || !(r.c > 0)) fail(s + ": brak ceny " + r.d);
    if (first < 0) first = i; o[i] = r3(r.o); c[i] = r3(r.c);
  });
  if (first < 0) fail(s + ": brak notowań w zakresie");
  for (var i = first + 1; i < N; i++) if (c[i] === null) { c[i] = c[i - 1]; o[i] = c[i - 1]; filled++; }
  if (c[N - 1] === null) fail(s + ": brak ostatniego kursu");
  /* kwartalne wartości zysku na akcję: źródło interpoluje je między końcami kwartałów */
  var e = rows.filter(function (r) { return r.e !== null; }), q = [];
  if (e.length) {
    var lastVal = e[e.length - 1].e, k = e.length - 1; while (k > 0 && e[k - 1].e === lastVal) k--;
    var knot = e[k].d, km = +knot.slice(5, 7), months = {};
    for (var j = 0; j < 4; j++) months[((km - 1 + 3 * j) % 12) + 1] = true;
    var lastOfMonth = {}; e.forEach(function (r) { lastOfMonth[r.d.slice(0, 7)] = r; });
    Object.keys(lastOfMonth).sort().forEach(function (ym) {
      if (!months[+ym.slice(5, 7)]) return;
      var r = lastOfMonth[ym]; if (r.d > knot) return;
      if (ym === knot.slice(0, 7)) r = e[k];
      var idx = firstIdxOnOrAfter(addDays(r.d, 60));        // wynik kwartału użyty dopiero 60 dni po jego końcu
      if (idx < N) q.push([idx, Math.round(r.e * 100) / 100, r.d]);
    });
  }
  return { s: s, n: NAMES[s], start: first, o: o, c: c, q: q };
});
/* spółki dodatkowe: same kursy z drugiego źródła, tylko dla Portfela (bez testu i Skanera) */
var extraNote = [];
if (arg.csv2) Object.keys(EXTRA).forEach(function (s) {
  var f = path.join(arg.csv2, s + ".csv"); if (!fs.existsSync(f)) { extraNote.push(s + ": brak pliku"); return; }
  var lines = fs.readFileSync(f, "utf8").trim().split(/\r?\n/);
  if (lines[0].trim() !== HEADER2 || lines.length < 20) { extraNote.push(s + ": zły format"); return; }
  var o = new Array(N).fill(null), c = new Array(N).fill(null), first = -1, last = -1, bad = false;
  for (var i = 1; i < lines.length; i++) {
    var p = lines[i].split(","), d = p[0]; if (d < START || d > asOf) continue;
    var k = pos[d]; if (k === undefined) continue;                 // sesja spoza kalendarza USA: pomiń
    var op = +p[1], cl = +p[4]; if (!(op > 0) || !(cl > 0)) { bad = true; break; }
    if (first < 0) first = k; o[k] = r3(op); c[k] = r3(cl); last = k;
  }
  if (bad || first < 0) { extraNote.push(s + ": brak poprawnych kursów"); return; }
  for (i = first + 1; i < N; i++) if (c[i] === null) { c[i] = c[i - 1]; o[i] = c[i - 1]; filled++; }
  if (last < N - 1) extraNote.push(s + ": ostatni kurs z " + cal[last]);
  var meta = typeof EXTRA[s] === "string" ? { n: EXTRA[s] } : (EXTRA[s] || {}), tk = { s: s, n: meta.n || s, start: first, x: 1 };
  if (meta.cur === "PLN") tk.cur = "PLN";        // waluta notowań; brak pola oznacza dolary
  if (meta.m) tk.m = meta.m;                     // rynek poza USA (GPW, LSE): bez kursów na żywo
  tk.o = o; tk.c = c; tk.q = []; tickers.push(tk);
});
var M = { asOf: asOf, source: arg.source || "Pubmarks/datasets i yennanliu/finance_data (GitHub)", dates: cal.map(function (d) { return +d.replace(/-/g, ""); }), tickers: tickers };
if (+arg.fx > 2 && +arg.fx < 8) M.fx = { USDPLN: +arg.fx, d: +String(arg.fxdate || "").replace(/-/g, "") || 0 };

/* porównanie z poprzednią wersją danych */
var prev = null;
if (arg.prev && fs.existsSync(arg.prev)) { try { var raw = fs.readFileSync(arg.prev, "utf8"); prev = JSON.parse(raw.slice(raw.indexOf("=") + 1).trim().replace(/;$/, "")); } catch (err) { prev = null; } }
var check = { days: N, filled: filled, prevAsOf: prev ? prev.asOf : null, historyChanged: 0, extra: extraNote };
if (prev) {
  if (asOf < prev.asOf) fail("pobrane notowania (" + asOf + ") są starsze niż opublikowane (" + prev.asOf + ")");
  if (N < prev.dates.length) fail("mniej sesji niż w opublikowanych danych");
  /* historia nie powinna się zmieniać: licz kursy zamknięcia różne o ponad 2% (split lub błąd źródła) */
  prev.tickers.forEach(function (pt) {
    var nt = tickers.filter(function (x) { return x.s === pt.s; })[0]; if (!nt) { if (pt.x) return; fail("brak spółki " + pt.s); }
    for (var i = pt.start; i < prev.dates.length; i++) if (prev.dates[i] === M.dates[i] && pt.c[i] && nt.c[i] && Math.abs(nt.c[i] / pt.c[i] - 1) > 0.02) check.historyChanged++;
  });
}
function sig(t) { return t.s + t.n + (t.cur || "") + (t.m || ""); }
var out = { ok: true, asOf: asOf, newData: !prev || asOf > prev.asOf || tickers.map(sig).join() !== prev.tickers.map(sig).join() || !!M.fx !== !!prev.fx, check: check };
if (out.newData) fs.writeFileSync(arg.out, "window.MARKET=" + JSON.stringify(M) + ";\n");

/* sygnały dla zapisanych parametrów i portfela */
var E = require(path.resolve(arg.engine)), state = {};
if (arg.state && fs.existsSync(arg.state)) { try { state = JSON.parse(fs.readFileSync(arg.state, "utf8")) || {}; } catch (err) { state = {}; } }
var P = {}; Object.keys(E.DEFAULTS).forEach(function (k) { P[k] = state.params && typeof state.params[k] === typeof E.DEFAULTS[k] ? state.params[k] : E.DEFAULTS[k]; });
var positions = Array.isArray(state.positions) ? state.positions.filter(function (p) { return p && typeof p.s === "string" && p.px > 0 && p.qty > 0 && /^\d{4}-\d{2}-\d{2}$/.test(p.date); }) : [];
var R = E.run(M, P), A = E.actions(M, R, { positions: positions, cash: +state.cash || 0 }), S = E.summary(M, A);
out.hasState = !!state.params; out.positions = positions.length; out.noteworthy = S.noteworthy; out.summary = S.text;
console.log(JSON.stringify(out));
