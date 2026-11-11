#!/usr/bin/env node
/* Bot dzienny do "Pulpitu sygnałów". Użycie:
     node bot.js plan [--csv KATALOG]     co bot kupiłby na najbliższej sesji
     node bot.js run [--dry-run]          obsłuż dzisiejszą sesję (uruchamiać przed otwarciem giełdy w USA)
     node bot.js status                   konto, zegar giełdy i dzisiejszy stan bota
     node bot.js flatten                  awaryjnie sprzedaj wszystko, co bot dziś kupił
     node bot.js backtest --csv KATALOG   wynik strategii na danych historycznych
     node bot.js review [--csv KATALOG]   porównaj prawdziwe ceny transakcji z założeniami backtestu
   Wyłącznik awaryjny: plik o nazwie STOP w katalogu bota. */
"use strict";
var fs = require("fs"), path = require("path");
var St = require("./lib/strategy.js"), Bt = require("./lib/backtest.js"), Data = require("./lib/data.js");
var Session = require("./lib/session.js"), Alp = require("./lib/alpaca.js");
var ROOT = __dirname, LIVE_PHRASE = "TAK-PRAWDZIWE-PIENIADZE";

var DEFAULT_CFG = {
  mode: "paper",                 // "paper" = konto testowe, "live" = prawdziwe pieniądze
  liveConfirmed: "",             // tryb live wymaga wpisania tu: TAK-PRAWDZIWE-PIENIADZE
  liveMaxCapitalUsd: 500,        // bezpiecznik: w trybie live bot odmówi pracy z większym kapitałem
  botId: "daybot",
  symbols: ["AAPL", "ACN", "ADBE", "CRM", "DELL", "GOOG", "INTU", "LRCX", "META", "MSFT", "NFLX", "NVDA", "RMD", "SAP", "TSLA", "TSM"],
  capitalUsd: 1000,              // kapitał oddany botowi; jedna pozycja = capitalUsd / strategy.maxPos
  maxOrderUsd: 300,              // twardy limit wartości jednego zlecenia
  entryDelaySec: 30,             // ile sekund po otwarciu składać zlecenia kupna
  entryWindowSec: 600,           // po tylu sekundach od otwarcia bot już nie kupuje
  exitMinutesBeforeClose: 5,     // sprzedaż tyle minut przed zamknięciem sesji
  pollSec: 60,                   // co ile sekund bot sprawdza plik STOP (i stopy, jeśli włączone)
  dataFeed: "iex",               // źródło bieżących cen: "iex" (darmowe) albo "sip" (płatny plan)
  dryRun: false,                 // true = nic nie zlecaj, tylko zapisuj, co bot by zrobił
  strategy: {}
};

function fail(msg) { console.error("BŁĄD: " + msg); process.exit(1); }
function args() { var a = { _: [] }, v = process.argv.slice(2); for (var i = 0; i < v.length; i++) { if (v[i].slice(0, 2) === "--") { var k = v[i].slice(2); if (v[i + 1] !== undefined && v[i + 1].slice(0, 2) !== "--") a[k] = v[++i]; else a[k] = true; } else a._.push(v[i]); } return a; }
function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  fs.readFileSync(file, "utf8").split(/\r?\n/).forEach(function (line) {
    var m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line); if (!m || process.env[m[1]] !== undefined) return;
    process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  });
}
function loadConfig(file) {
  var cfg = JSON.parse(JSON.stringify(DEFAULT_CFG)), user = {};
  if (file && fs.existsSync(file)) { try { user = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { throw new Error("Plik config.json nie jest poprawnym JSON-em: " + e.message); } }
  Object.keys(user).forEach(function (k) { if (k in DEFAULT_CFG) cfg[k] = user[k]; });
  return validateConfig(cfg);
}
function validateConfig(cfg) {
  function bad(m) { throw new Error("Błąd konfiguracji: " + m); }
  function n(k, lo, hi) { if (typeof cfg[k] !== "number" || !(cfg[k] >= lo && cfg[k] <= hi)) bad(k + " musi być liczbą z zakresu " + lo + "–" + hi); }
  if (cfg.mode !== "paper" && cfg.mode !== "live") bad('mode musi być "paper" albo "live"');
  if (!Array.isArray(cfg.symbols) || !cfg.symbols.length || cfg.symbols.length > 30) bad("symbols musi być listą 1–30 spółek");
  cfg.symbols.forEach(function (s) { if (!/^[A-Z][A-Z.]{0,5}$/.test(s)) bad("nieprawidłowy symbol: " + s); });
  if (!/^[a-z0-9]{1,12}$/.test(cfg.botId)) bad("botId: tylko małe litery i cyfry, najwyżej 12 znaków");
  n("capitalUsd", 4, 1e6); n("maxOrderUsd", 1, 1e5); n("entryDelaySec", 0, 300); n("entryWindowSec", 30, 3600);
  n("exitMinutesBeforeClose", 1, 60); n("pollSec", 10, 600); n("liveMaxCapitalUsd", 1, 1e6);
  if (cfg.entryWindowSec <= cfg.entryDelaySec) bad("entryWindowSec musi być większe niż entryDelaySec");
  if (cfg.dataFeed !== "iex" && cfg.dataFeed !== "sip") bad('dataFeed musi być "iex" albo "sip"');
  if (cfg.strategy === null || typeof cfg.strategy !== "object") bad("strategy musi być obiektem");
  var P = St.params(cfg.strategy);
  if (!(P.maxPos >= 1 && P.maxPos <= 10) || !(P.minSignals >= 1) || !(P.rsiMax > 0 && P.rsiMax <= 100) || !(P.ibsMax > 0) || P.stopAtr < 0) bad("nieprawidłowe parametry strategii");
  if (cfg.mode === "live") {
    if (cfg.liveConfirmed !== LIVE_PHRASE) bad('tryb live wymaga pola liveConfirmed o treści "' + LIVE_PHRASE + '"');
    if (cfg.capitalUsd > cfg.liveMaxCapitalUsd) bad("w trybie live capitalUsd nie może przekraczać liveMaxCapitalUsd (" + cfg.liveMaxCapitalUsd + ")");
  }
  return cfg;
}

function stamp() { return new Date().toISOString().replace("T", " ").slice(0, 19) + "Z"; }
function logger() { var dir = path.join(ROOT, "logs"); fs.mkdirSync(dir, { recursive: true }); return function (msg) { var line = stamp() + "  " + msg; console.log(line); fs.appendFileSync(path.join(dir, "bot.log"), line + "\n"); }; }
function store() {
  var dir = path.join(ROOT, "state"); fs.mkdirSync(dir, { recursive: true });
  return {
    load: function (d) { var f = path.join(dir, d + ".json"); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : null; },
    save: function (d, s) { var f = path.join(dir, d + ".json"), tmp = f + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(s, null, 1)); fs.renameSync(tmp, f); },
    all: function () { return fs.readdirSync(dir).filter(function (f) { return /^\d{4}-\d{2}-\d{2}\.json$/.test(f); }).sort().map(function (f) { return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")); }); }
  };
}
function broker(cfg) { return new Alp.Alpaca({ keyId: process.env.ALPACA_KEY_ID, secret: process.env.ALPACA_SECRET_KEY, mode: cfg.mode, feed: cfg.dataFeed }); }
function sleepUntil(ms) { return new Promise(function (res) { (function tick() { var left = ms - Date.now(); if (left <= 0) return res(); setTimeout(tick, Math.min(left, 30000)); })(); }); }
function appendTrades(state) {
  var f = path.join(ROOT, "logs", "trades.csv");
  if (!fs.existsSync(f)) fs.writeFileSync(f, "date,symbol,qty,buy,sell,pnl_usd,ret_pct,why,mode,dry_run\n");
  state.result.trades.forEach(function (t) { fs.appendFileSync(f, [state.date, t.symbol, t.qty, t.buy, t.sell === null ? "" : t.sell, t.pnl === null ? "" : t.pnl, t.ret === null ? "" : (t.ret * 100).toFixed(3), t.why || "", state.mode, state.dryRun ? 1 : 0].join(",") + "\n"); });
}
function pct(x) { return (x * 100).toFixed(1) + "%"; }
function csvHistory(dir, symbols) { var h = {}; symbols.forEach(function (s) { var f = path.join(dir, s + ".csv"); if (fs.existsSync(f)) h[s] = Data.loadCsv(f, "2004-01-01"); }); return h; }

async function cmdRun(cfg, a, forceStop) {
  if (a["dry-run"]) cfg.dryRun = true;
  var log = logger(), st = store();
  log("Start: tryb " + (cfg.mode === "live" ? "LIVE (prawdziwe pieniądze)" : "paper (konto testowe)") + (cfg.dryRun ? ", na sucho" : "") + ", kapitał " + cfg.capitalUsd + " USD.");
  var state = await Session.runSession({ broker: broker(cfg), cfg: cfg, log: log, store: st, nowMs: Date.now, sleepUntil: sleepUntil,
    stopRequested: function () { return !!forceStop || fs.existsSync(path.join(ROOT, "STOP")); } });
  if (state.result && state.result.trades.length && !state.logged) { appendTrades(state); state.logged = true; st.save(state.date, state); }
  if (state.result && state.result.unclosed) process.exitCode = 2;
}

async function cmdPlan(cfg, a) {
  var hist, label;
  if (a.csv) {
    hist = csvHistory(a.csv, cfg.symbols);
    var last = Object.keys(hist).map(function (s) { return hist[s][hist[s].length - 1].d; }).sort().pop();
    Object.keys(hist).forEach(function (s) { if (hist[s][hist[s].length - 1].d !== last) delete hist[s]; });
    label = "pierwszą sesję po " + last + " (dane z plików CSV)";
  } else {
    var b = broker(cfg), c = await b.clock(), today = String(c.timestamp).slice(0, 10), from = new Date(Date.parse(today) - 90 * 864e5).toISOString().slice(0, 10);
    var yest = new Date(Date.parse(today) - 864e5).toISOString().slice(0, 10), H = await b.dailyBars(cfg.symbols, from, c.is_open ? yest : today);
    hist = {}; var lastD = "";
    cfg.symbols.forEach(function (s) { var x = H.bars[s] || []; if (x.length && x[x.length - 1].d > lastD) lastD = x[x.length - 1].d; });
    cfg.symbols.forEach(function (s) { var x = H.bars[s] || []; if (x.length >= 30 && x[x.length - 1].d === lastD) hist[s] = x; });
    label = "pierwszą sesję po " + lastD + " (dane: " + H.feed + ")";
  }
  var pl = St.plan(hist, cfg.strategy), P = pl.params;
  console.log("Plan na " + label + ", spółek z danymi: " + Object.keys(hist).length);
  console.log("Warunek: RSI(2) < " + P.rsiMax + " i zamknięcie w dolnych " + Math.round(P.ibsMax * 100) + "% zakresu dnia; co najmniej " + P.minSignals + " takie spółki naraz.");
  if (!pl.all.length) console.log("Żadna spółka nie ma sygnału.");
  pl.all.forEach(function (x) { console.log("  " + x.symbol.padEnd(6) + "RSI(2)=" + x.rsi2.toFixed(1).padStart(5) + "  IBS=" + x.ibs.toFixed(2) + "  zamknięcie " + x.prevClose); });
  console.log(pl.picks.length ? "Do kupienia na otwarciu: " + pl.picks.map(function (x) { return x.symbol; }).join(", ") + " (po " + (Math.min(cfg.capitalUsd / P.maxPos, cfg.maxOrderUsd)).toFixed(2) + " USD)."
    : "Bot nic nie kupi" + (pl.all.length ? " (za mało spółek z sygnałem)." : "."));
}

async function cmdStatus(cfg) {
  var b = broker(cfg), c = await b.clock(), acct = await b.account(), today = String(c.timestamp).slice(0, 10), s = store().load(today);
  console.log("Tryb: " + cfg.mode + ". Giełda " + (c.is_open ? "otwarta" : "zamknięta") + ", czas giełdy " + c.timestamp + ", następne otwarcie " + c.next_open + ".");
  console.log("Konto: status " + acct.status + ", wartość " + acct.equity + " USD, siła nabywcza " + acct.buying_power + " USD.");
  if (!s) { console.log("Bot nie ma dziś zapisanego stanu."); return; }
  console.log("Stan bota na " + today + ": etap " + s.phase + ", do kupienia: " + ((s.plan && s.plan.picks.join(", ")) || "nic") + ".");
  Object.keys(s.entries).forEach(function (k) { var e = s.entries[k], x = s.exits[k]; console.log("  " + k.padEnd(6) + "kupno " + e.status + " " + e.qty + " szt. po " + e.price + (x ? "; sprzedaż " + x.status + " po " + x.price : "")); });
  if (fs.existsSync(path.join(ROOT, "STOP"))) console.log("UWAGA: plik STOP istnieje, bot nie otwiera pozycji.");
}

function cmdBacktest(cfg, a) {
  if (!a.csv) fail("podaj katalog z notowaniami: --csv KATALOG");
  var from = typeof a.from === "string" ? a.from : "2008-01-01", data = csvHistory(a.csv, cfg.symbols), syms = Object.keys(data);
  if (!syms.length) fail("w katalogu nie ma plików SYMBOL.csv");
  var R = Bt.run(data, cfg.strategy, from), P = R.P, last = R.daily[R.daily.length - 1].d, split = "2019-01-01";
  var y3 = (Number(last.slice(0, 4)) - 3) + last.slice(4);
  console.log("Backtest: " + syms.length + " spółek, " + from + " – " + last + ". Kupno na otwarciu, sprzedaż na zamknięciu tej samej sesji.");
  console.log("Parametry: RSI(2) < " + P.rsiMax + ", IBS < " + P.ibsMax + ", min. " + P.minSignals + " sygnały naraz, maks. " + P.maxPos + " pozycje, koszt " + P.costBps + " pb na stronę" + (P.stopAtr ? ", stop " + P.stopAtr + " ATR" : "") + ".");
  function row(name, s) { console.log(name.padEnd(24) + ("transakcji " + s.trades).padEnd(18) + ("śr. " + s.avgBps.toFixed(1) + " pb").padEnd(13) + ("trafność " + pct(s.winRate)).padEnd(16) + ("rocznie " + pct(s.cagr)).padEnd(15) + ("maks. spadek " + pct(s.maxDD)).padEnd(21) + ("Sharpe " + s.sharpe.toFixed(2)).padEnd(13) + "dni z transakcją " + pct(s.activeDays)); }
  row("Całość", Bt.stats(R));
  row("Do 2018 (dobór reguł)", Bt.stats(R, null, split));
  row("Od 2019 (sprawdzenie)", Bt.stats(R, split));
  row("Ostatnie 3 lata", Bt.stats(R, y3));
  console.log("Rok po roku:");
  for (var y = Number(from.slice(0, 4)); y <= Number(last.slice(0, 4)); y++) { var s = Bt.stats(R, y + "-01-01", (y + 1) + "-01-01"); console.log("  " + y + "  wynik " + pct(s.total).padStart(7) + "  maks. spadek " + pct(s.maxDD).padStart(7) + "  transakcji " + String(s.trades).padStart(4)); }
  if (a.json) fs.writeFileSync(a.json, JSON.stringify({ params: P, from: from, to: last, all: Bt.stats(R), is: Bt.stats(R, null, split), oos: Bt.stats(R, split), last3y: Bt.stats(R, y3) }, null, 1));
}

async function cmdReview(cfg, a) {
  var days = store().all().filter(function (s) { return s.result && s.result.trades.length; });
  if (!days.length) { console.log("Brak zapisanych transakcji do porównania."); return; }
  var bars;
  if (a.csv) bars = csvHistory(a.csv, cfg.symbols);
  else { var to = new Date(Date.now() - 864e5).toISOString().slice(0, 10); bars = (await broker(cfg).dailyBars(cfg.symbols, days[0].date, to)).bars; }
  var idx = {}; Object.keys(bars).forEach(function (s) { idx[s] = {}; bars[s].forEach(function (b) { idx[s][b.d] = b; }); });
  var n = 0, sIn = 0, sOut = 0, real = 0, model = 0;
  console.log("data        spółka  kupno     otwarcie  różnica   sprzedaż  zamknięcie różnica   wynik     model");
  days.forEach(function (d) { d.result.trades.forEach(function (t) {
    var b = idx[t.symbol] && idx[t.symbol][d.date]; if (!b || t.sell === null) return;
    var i = (t.buy / b.o - 1) * 1e4, o = (b.c / t.sell - 1) * 1e4, m = b.c / b.o - 1; n++; sIn += i; sOut += o; real += t.ret; model += m;
    console.log(d.date + "  " + t.symbol.padEnd(8) + String(t.buy).padEnd(10) + String(b.o).padEnd(10) + (i.toFixed(1) + " pb").padEnd(10) + String(t.sell).padEnd(10) + String(b.c).padEnd(11) + (o.toFixed(1) + " pb").padEnd(10) + pct(t.ret).padEnd(10) + pct(m));
  }); });
  if (!n) { console.log("Brak oficjalnych notowań dla zapisanych dni (są dostępne dzień po sesji)."); return; }
  console.log("Transakcji: " + n + ". Średnio: kupno " + (sIn / n).toFixed(1) + " pb drożej niż otwarcie, sprzedaż " + (sOut / n).toFixed(1) + " pb taniej niż zamknięcie.");
  console.log("Średni wynik rzeczywisty " + (real / n * 1e4).toFixed(1) + " pb, według modelu (otwarcie→zamknięcie, bez kosztów) " + (model / n * 1e4).toFixed(1) + " pb. Backtest zakłada koszt " + St.params(cfg.strategy).costBps + " pb na stronę.");
}

async function main() {
  var a = args(), cmd = a._[0];
  loadEnv(path.join(ROOT, ".env"));
  var cfg = loadConfig(typeof a.config === "string" ? a.config : path.join(ROOT, "config.json"));
  if (cmd === "run") return cmdRun(cfg, a, false);
  if (cmd === "flatten") return cmdRun(cfg, a, true);
  if (cmd === "plan") return cmdPlan(cfg, a);
  if (cmd === "status") return cmdStatus(cfg);
  if (cmd === "backtest") return cmdBacktest(cfg, a);
  if (cmd === "review") return cmdReview(cfg, a);
  console.log("Użycie: node bot.js plan|run|status|flatten|backtest|review  (szczegóły w README.md)");
}

if (require.main === module) main().catch(function (e) { fail(e && e.message ? e.message : String(e)); });
module.exports = { DEFAULT_CFG: DEFAULT_CFG, validateConfig: validateConfig, loadConfig: loadConfig, LIVE_PHRASE: LIVE_PHRASE };
