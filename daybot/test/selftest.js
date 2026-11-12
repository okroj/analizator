/* Test bota z atrapą brokera i wirtualnym zegarem: cała sesja przebiega w ułamku sekundy, bez sieci i bez kluczy.
   Uruchom: node test/selftest.js */
"use strict";
var assert = require("assert");
var Session = require("../lib/session.js"), Bot = require("../bot.js"), Alp = require("../lib/alpaca.js");

var TODAY = "2026-11-11", PREV = "2026-11-10", OFF = "-05:00";
function ms(hhmm) { return Date.parse(TODAY + "T" + hhmm + ":00" + OFF); }
function iso(t) { return new Date(t - 5 * 3600e3).toISOString().slice(0, 19) + OFF; }
function weekdaysBack(end, n) { var out = [], d = new Date(end + "T00:00:00Z"); while (out.length < n) { var w = d.getUTCDay(); if (w !== 0 && w !== 6) out.unshift(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() - 1); } return out; }
function bars(kind, end) {
  var dates = weekdaysBack(end || PREV, 45), px = 100;
  return dates.map(function (d, i) {
    var last3 = i >= dates.length - 3, o = px, c, h, l;
    if (kind === "oversold" && last3) { c = o * 0.97; h = o * 1.002; l = c * 0.999; }       // trzy mocne spadki, zamknięcia przy dołku
    else { c = o * (i % 2 ? 1.006 : 0.998); h = Math.max(o, c) * 1.002; l = Math.min(o, c) * 0.998; }
    px = c; return { d: d, o: +o.toFixed(4), h: +h.toFixed(4), l: +l.toFixed(4), c: +c.toFixed(4), v: 1e6 };
  });
}

function Fake(o) {
  this.t = o.start; this.orders = []; this.pos = {}; this.hist = o.hist; this.bp = o.bp === undefined ? 100000 : o.bp;
  this.holiday = !!o.holiday; this.rejectBuy = o.rejectBuy || {}; this.lostReply = o.lostReply || {}; this.seq = 0;
}
Fake.prototype.price = function (s) { return this.t < ms("12:00") ? 50 : 51; };           // rano 50, po południu 51
Fake.prototype.clock = async function () { return { timestamp: iso(this.t), is_open: this.t >= ms("09:30") && this.t < ms("16:00"), next_open: "", next_close: "" }; };
Fake.prototype.calendar = async function () { var rows = weekdaysBack(PREV, 5).map(function (d) { return { date: d, open: "09:30", close: "16:00" }; }); if (!this.holiday) rows.push({ date: TODAY, open: "09:30", close: "16:00" }); return rows; };
Fake.prototype.account = async function () { return { status: "ACTIVE", trading_blocked: false, buying_power: String(this.bp), equity: "100000" }; };
Fake.prototype.dailyBars = async function (symbols) { var b = {}, h = this.hist; symbols.forEach(function (s) { b[s] = h[s] || []; }); return { bars: b, feed: "sip" }; };
Fake.prototype.snapshots = async function (symbols) { var out = {}, self = this; symbols.forEach(function (s) { out[s] = { price: self.price(s), time: iso(self.t) }; }); return out; };
Fake.prototype.listOrders = async function () { return this.orders.slice(); };
Fake.prototype.getOrder = async function (id) { return this.orders.filter(function (o) { return o.id === id; })[0]; };
Fake.prototype.getOrderByClientId = async function (cid) { return this.orders.filter(function (o) { return o.client_order_id === cid; })[0] || null; };
Fake.prototype.cancelOrder = async function () {};
Fake.prototype.position = async function (s) { return this.pos[s] > 1e-9 ? { symbol: s, qty: String(this.pos[s]) } : null; };
Fake.prototype.submitOrder = async function (o) {
  assert(this.t >= ms("09:30") && this.t < ms("16:00"), "zlecenie poza sesją: " + iso(this.t));
  assert(o.type === "market" && o.time_in_force === "day", "tylko zlecenia rynkowe na dziś");
  if (this.orders.some(function (x) { return x.client_order_id === o.client_order_id; })) throw new Alp.ApiError(422, "client_order_id must be unique");
  if (o.side === "buy" && this.rejectBuy[o.symbol]) throw new Alp.ApiError(403, "insufficient buying power");
  var px = this.price(o.symbol), qty = o.side === "buy" ? +(Number(o.notional) / px).toFixed(9) : Number(o.qty);
  if (o.side === "sell") { assert(qty <= (this.pos[o.symbol] || 0) + 1e-9, "sprzedaż ponad stan"); this.pos[o.symbol] -= qty; } else { this.pos[o.symbol] = (this.pos[o.symbol] || 0) + qty; this.bp -= Number(o.notional); }
  var rec = { id: "o" + (++this.seq), client_order_id: o.client_order_id, symbol: o.symbol, side: o.side, status: "filled", filled_qty: String(qty), filled_avg_price: String(px), notional: o.notional, at: this.t };
  this.orders.push(rec);
  if (this.lostReply[o.symbol + ":" + o.side]) { delete this.lostReply[o.symbol + ":" + o.side]; throw new Alp.ApiError(0, "błąd sieci: timeout"); }   // zlecenie doszło, odpowiedź zginęła
  return rec;
};

var SYMS = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF"];
function hist(oversold, stale) { var h = {}; SYMS.forEach(function (s) { h[s] = bars(oversold.indexOf(s) >= 0 ? "oversold" : "normal", (stale || []).indexOf(s) >= 0 ? "2026-11-09" : PREV); }); return h; }
function cfg(extra) { return Bot.validateConfig(Object.assign(JSON.parse(JSON.stringify(Bot.DEFAULT_CFG)), { symbols: SYMS, capitalUsd: 400, maxOrderUsd: 100 }, extra || {})); }
function ctx(f, c, o) {
  var mem = (o && o.mem) || {}, logs = [];
  return { broker: f, cfg: c, logs: logs, mem: mem, log: function (m) { logs.push(m); }, nowMs: function () { return f.t; },
    sleepUntil: async function (t) { if (o && o.onSleep) o.onSleep(t); if (t > f.t) f.t = t; },
    store: { load: function (d) { return mem[d] ? JSON.parse(JSON.stringify(mem[d])) : null; }, save: function (d, s) { mem[d] = JSON.parse(JSON.stringify(s)); } },
    stopRequested: function () { return !!(o && o.stop && o.stop(f.t)); } };
}
function buys(f) { return f.orders.filter(function (o) { return o.side === "buy"; }); }
function sells(f) { return f.orders.filter(function (o) { return o.side === "sell"; }); }

var tests = [];
function test(name, fn) { tests.push([name, fn]); }

test("zwykły dzień: kupno po otwarciu, sprzedaż dokładnie kupionej ilości przed zamknięciem", async function () {
  var f = new Fake({ start: ms("08:30"), hist: hist(["AAA", "CCC", "EEE"]) }), s = await Session.runSession(ctx(f, cfg()));
  assert.deepStrictEqual(s.plan.picks.slice().sort(), ["AAA", "CCC", "EEE"]);
  assert.strictEqual(buys(f).length, 3); assert.strictEqual(sells(f).length, 3);
  buys(f).forEach(function (b) { assert.strictEqual(b.notional, "100.00"); assert.strictEqual(b.at, ms("09:30") + 30000); });
  sells(f).forEach(function (x) { assert.strictEqual(x.at, ms("15:55")); assert.strictEqual(x.filled_qty, buys(f).filter(function (b) { return b.symbol === x.symbol; })[0].filled_qty); });
  SYMS.forEach(function (k) { assert(!(f.pos[k] > 1e-9), "pozycja została na noc: " + k); });
  assert.strictEqual(s.phase, "done"); assert.strictEqual(s.result.trades.length, 3); assert.strictEqual(s.result.pnlUsd, 6);   // 3 x 2 szt. x 1 USD
});
test("ponowne uruchomienie tego samego dnia nie składa nowych zleceń", async function () {
  var f = new Fake({ start: ms("08:30"), hist: hist(["AAA", "CCC"]) }), c = ctx(f, cfg()); await Session.runSession(c);
  var n = f.orders.length; f.t = ms("15:58"); await Session.runSession(ctx(f, cfg(), { mem: c.mem })); assert.strictEqual(f.orders.length, n);
});
test("restart w środku dnia po utracie stanu: przejmuje istniejące zlecenia, nie dubluje", async function () {
  var f = new Fake({ start: ms("08:30"), hist: hist(["AAA", "CCC"]) }), stopAt = ms("10:00"), halted = false;
  try { await Session.runSession(ctx(f, cfg(), { onSleep: function (t) { if (f.t >= ms("09:31") && !halted) { halted = true; throw new Error("awaria"); } } })); } catch (e) { assert.strictEqual(e.message, "awaria"); }
  assert.strictEqual(buys(f).length, 2); assert.strictEqual(sells(f).length, 0);
  f.t = ms("09:35"); var s = await Session.runSession(ctx(f, cfg()));           // pusty stan, zlecenia są u brokera
  assert.strictEqual(buys(f).length, 2); assert.strictEqual(sells(f).length, 2); assert.strictEqual(s.phase, "done");
});
test("późny restart po utracie stanu: nie kupuje, ale sprzedaje to, co bot kupił rano", async function () {
  var f = new Fake({ start: ms("08:30"), hist: hist(["AAA", "CCC"]) }), halted = false;
  try { await Session.runSession(ctx(f, cfg(), { onSleep: function () { if (f.t >= ms("09:31") && !halted) { halted = true; throw new Error("awaria"); } } })); } catch (e) { assert.strictEqual(e.message, "awaria"); }
  f.t = ms("11:00"); var s = await Session.runSession(ctx(f, cfg()));
  assert.strictEqual(buys(f).length, 2); assert.strictEqual(sells(f).length, 2); sells(f).forEach(function (x) { assert.strictEqual(x.at, ms("15:55")); });
  assert.strictEqual(s.phase, "done"); assert.strictEqual(s.result.trades.length, 2);
});
test("jedna spółka z sygnałem to za mało: bez transakcji", async function () {
  var f = new Fake({ start: ms("08:30"), hist: hist(["BBB"]) }), s = await Session.runSession(ctx(f, cfg()));
  assert.strictEqual(s.plan.signals.length, 1); assert.strictEqual(f.orders.length, 0); assert.strictEqual(s.phase, "done");
});
test("więcej sygnałów niż miejsc: kupuje najwyżej maxPos", async function () {
  var f = new Fake({ start: ms("08:30"), hist: hist(SYMS) }), s = await Session.runSession(ctx(f, cfg()));
  assert.strictEqual(buys(f).length, 4); assert.strictEqual(sells(f).length, 4);
});
test("plik STOP przed otwarciem: bez zakupów", async function () {
  var f = new Fake({ start: ms("08:30"), hist: hist(["AAA", "CCC"]) }); await Session.runSession(ctx(f, cfg(), { stop: function () { return true; } }));
  assert.strictEqual(f.orders.length, 0);
});
test("plik STOP w trakcie dnia: natychmiastowa sprzedaż", async function () {
  var f = new Fake({ start: ms("08:30"), hist: hist(["AAA", "CCC"]) }); await Session.runSession(ctx(f, cfg(), { stop: function (t) { return t >= ms("11:00"); } }));
  assert.strictEqual(sells(f).length, 2); sells(f).forEach(function (x) { assert(x.at >= ms("11:00") && x.at < ms("11:02"), "sprzedaż o " + iso(x.at)); });
});
test("start 20 minut po otwarciu: bez zakupów", async function () {
  var f = new Fake({ start: ms("09:50"), hist: hist(["AAA", "CCC"]) }); await Session.runSession(ctx(f, cfg())); assert.strictEqual(f.orders.length, 0);
});
test("dzień bez sesji: bot kończy od razu", async function () {
  var f = new Fake({ start: ms("08:30"), hist: hist(["AAA", "CCC"]), holiday: true }), s = await Session.runSession(ctx(f, cfg()));
  assert.strictEqual(s.phase, "closed"); assert.strictEqual(f.orders.length, 0);
});
test("odrzucone kupno jednej spółki nie blokuje pozostałych", async function () {
  var f = new Fake({ start: ms("08:30"), hist: hist(["AAA", "CCC", "EEE"]), rejectBuy: { CCC: 1 } }), s = await Session.runSession(ctx(f, cfg()));
  assert.strictEqual(buys(f).length, 2); assert.strictEqual(sells(f).length, 2); assert.strictEqual(s.entries.CCC.status, "rejected"); assert.strictEqual(s.phase, "done");
});
test("zgubiona odpowiedź brokera: zlecenie odnalezione po identyfikatorze, bez duplikatu", async function () {
  var f = new Fake({ start: ms("08:30"), hist: hist(["AAA", "CCC"]), lostReply: { "AAA:buy": 1, "CCC:sell": 1 } }), s = await Session.runSession(ctx(f, cfg()));
  assert.strictEqual(buys(f).length, 2); assert.strictEqual(sells(f).length, 2); assert.strictEqual(s.phase, "done"); assert.strictEqual(s.result.trades.length, 2);
});
test("za mało środków: bez zakupów", async function () {
  var f = new Fake({ start: ms("08:30"), hist: hist(["AAA", "CCC"]), bp: 50 }); await Session.runSession(ctx(f, cfg())); assert.strictEqual(f.orders.length, 0);
});
test("spółka z nieaktualnymi notowaniami jest pomijana", async function () {
  var f = new Fake({ start: ms("08:30"), hist: hist(["AAA", "CCC", "EEE"], ["EEE"]) }), s = await Session.runSession(ctx(f, cfg()));
  assert.deepStrictEqual(s.plan.picks.slice().sort(), ["AAA", "CCC"]); assert.strictEqual(buys(f).length, 2);
});
test("tryb na sucho: żadnych zleceń, ale wynik jest policzony", async function () {
  var f = new Fake({ start: ms("08:30"), hist: hist(["AAA", "CCC"]) }), s = await Session.runSession(ctx(f, cfg({ dryRun: true })));
  assert.strictEqual(f.orders.length, 0); assert.strictEqual(s.result.trades.length, 2); assert.strictEqual(s.result.pnlUsd, 4); assert(s.result.trades[0].sim);
});
test("stop ochronny (stopAtr) sprzedaje wcześniej, gdy cena spadnie", async function () {
  var f = new Fake({ start: ms("08:30"), hist: hist(["AAA", "CCC"]) }); f.price = function () { return this.t < ms("10:30") ? 50 : 40; };
  await Session.runSession(ctx(f, cfg({ strategy: { stopAtr: 1 } })));
  assert.strictEqual(sells(f).length, 2); sells(f).forEach(function (x) { assert(x.at >= ms("10:30") && x.at < ms("10:33"), "sprzedaż o " + iso(x.at)); });
});
test("tryb live bez potwierdzenia albo z za dużym kapitałem jest odrzucany", async function () {
  assert.throws(function () { cfg({ mode: "live" }); }, /liveConfirmed/);
  assert.throws(function () { cfg({ mode: "live", liveConfirmed: Bot.LIVE_PHRASE, capitalUsd: 5000 }); }, /liveMaxCapitalUsd/);
  assert.strictEqual(cfg({ mode: "live", liveConfirmed: Bot.LIVE_PHRASE, capitalUsd: 200 }).mode, "live");
  assert.throws(function () { cfg({ symbols: ["aapl; rm -rf"] }); }, /symbol/);
});

(async function () {
  var failed = 0;
  for (var i = 0; i < tests.length; i++) {
    try { await tests[i][1](); console.log("OK    " + tests[i][0]); } catch (e) { failed++; console.log("BŁĄD  " + tests[i][0] + "\n      " + (e && e.stack ? e.stack.split("\n").slice(0, 3).join("\n      ") : e)); }
  }
  console.log(failed ? failed + " z " + tests.length + " testów nie przeszło." : "Wszystkie testy przeszły (" + tests.length + ").");
  process.exit(failed ? 1 : 0);
})();
