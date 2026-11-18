/* Test warstwy połączenia z brokerem na lokalnej atrapie serwera HTTP (bez internetu i bez kluczy).
   Sprawdza adresy, nagłówki, stronicowanie, ponawianie odczytów i brak ponawiania zleceń.
   Uruchom: node test/apitest.js */
"use strict";
var http = require("http"), assert = require("assert"), Alp = require("../lib/alpaca.js");
var hits = [], fail500 = {}, script = {};
var srv = http.createServer(function (req, res) {
  var body = ""; req.on("data", function (c) { body += c; }); req.on("end", function () {
    var u = new URL(req.url, "http://x"), key = req.method + " " + u.pathname;
    hits.push({ key: key, q: Object.fromEntries(u.searchParams), body: body ? JSON.parse(body) : null, auth: req.headers["apca-api-key-id"] + "/" + req.headers["apca-api-secret-key"] });
    function send(code, obj) { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); }
    if (fail500[key] > 0) { fail500[key]--; return send(500, { message: "internal" }); }
    if (script[key]) return script[key](u, send, body ? JSON.parse(body) : null);
    send(404, { message: "not found" });
  });
});
script["GET /v2/clock"] = function (u, send) { send(200, { timestamp: "2026-11-11T08:30:00-05:00", is_open: false, next_open: "2026-11-11T09:30:00-05:00", next_close: "2026-11-11T16:00:00-05:00" }); };
script["GET /v2/stocks/bars"] = function (u, send) {
  if (u.searchParams.get("feed") === "sip" && script.sipForbidden) return send(403, { message: "subscription does not permit querying recent SIP data" });
  if (!u.searchParams.get("page_token")) return send(200, { bars: { AAA: [{ t: "2026-11-09T05:00:00Z", o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }] }, next_page_token: "p2" });
  send(200, { bars: { AAA: [{ t: "2026-11-10T05:00:00Z", o: 1.5, h: 2, l: 1, c: 1.2, v: 10 }], BBB: [{ t: "2026-11-10T05:00:00Z", o: 5, h: 6, l: 4, c: 5.5, v: 3 }] }, next_page_token: null });
};
script["GET /v2/stocks/snapshots"] = function (u, send) { send(200, { AAA: { latestTrade: { p: 12.5, t: "2026-11-11T15:00:00Z" } }, BBB: {} }); };
script["POST /v2/orders"] = function (u, send, b) { send(200, { id: "id1", client_order_id: b.client_order_id, status: "accepted", filled_qty: "0", filled_avg_price: null }); };
script["GET /v2/orders:by_client_order_id"] = function (u, send) { u.searchParams.get("client_order_id") === "known" ? send(200, { id: "id9", client_order_id: "known", status: "filled" }) : send(404, { message: "order not found" }); };
script["GET /v2/positions/AAA"] = function (u, send) { send(200, { symbol: "AAA", qty: "1.5" }); };
script["GET /v2/orders"] = function (u, send) { send(200, []); };

srv.listen(0, "127.0.0.1", async function () {
  var base = "http://127.0.0.1:" + srv.address().port, failed = 0;
  var api = new Alp.Alpaca({ keyId: "K", secret: "S", mode: "paper", feed: "iex", hosts: { paper: base, live: base + "/LIVE", data: base } });
  async function t(name, fn) { hits.length = 0; try { await fn(); console.log("OK    " + name); } catch (e) { failed++; console.log("BŁĄD  " + name + "\n      " + (e.stack || e).toString().split("\n").slice(0, 3).join("\n      ")); } }
  await t("zegar: adres i nagłówki z kluczami", async function () { var c = await api.clock(); assert.strictEqual(c.is_open, false); assert.strictEqual(hits[0].key, "GET /v2/clock"); assert.strictEqual(hits[0].auth, "K/S"); });
  await t("słupki dzienne: parametry, stronicowanie, przeliczenie na {d,o,h,l,c}", async function () {
    var r = await api.dailyBars(["AAA", "BBB"], "2026-08-01", "2026-11-10");
    assert.strictEqual(r.feed, "sip"); assert.strictEqual(hits.length, 2); assert.strictEqual(hits[1].q.page_token, "p2");
    assert.deepStrictEqual({ s: hits[0].q.symbols, tf: hits[0].q.timeframe, st: hits[0].q.start, en: hits[0].q.end, adj: hits[0].q.adjustment }, { s: "AAA,BBB", tf: "1Day", st: "2026-08-01", en: "2026-11-10", adj: "split" });
    assert.deepStrictEqual(r.bars.AAA.map(function (b) { return b.d; }), ["2026-11-09", "2026-11-10"]); assert.strictEqual(r.bars.BBB[0].c, 5.5);
  });
  await t("słupki dzienne: brak dostępu do pełnego rynku -> dane IEX", async function () { script.sipForbidden = true; var r = await api.dailyBars(["AAA"], "2026-08-01", "2026-11-10"); script.sipForbidden = false; assert.strictEqual(r.feed, "iex"); assert.strictEqual(r.bars.AAA.length, 2); });
  await t("ostatnie ceny: pomija spółki bez transakcji", async function () { var s = await api.snapshots(["AAA", "BBB"]); assert.deepStrictEqual(Object.keys(s), ["AAA"]); assert.strictEqual(s.AAA.price, 12.5); assert.strictEqual(hits[0].q.feed, "iex"); });
  await t("zlecenie: treść żądania", async function () { var o = await api.submitOrder({ symbol: "AAA", notional: "250.00", side: "buy", type: "market", time_in_force: "day", client_order_id: "daybot-2026-11-11-AAA-buy" }); assert.strictEqual(o.id, "id1"); assert.deepStrictEqual(hits[0].body, { symbol: "AAA", notional: "250.00", side: "buy", type: "market", time_in_force: "day", client_order_id: "daybot-2026-11-11-AAA-buy" }); });
  await t("zlecenie przy błędzie serwera NIE jest ponawiane", async function () { fail500["POST /v2/orders"] = 5; var err = null; try { await api.submitOrder({ symbol: "AAA" }); } catch (e) { err = e; } fail500["POST /v2/orders"] = 0; assert(err && err.status === 500); assert.strictEqual(hits.length, 1); });
  await t("odczyt przy błędzie serwera jest ponawiany", async function () { fail500["GET /v2/clock"] = 2; var c = await api.clock(); assert.strictEqual(hits.length, 3); assert(c.timestamp); });
  await t("szukanie zlecenia po identyfikatorze: znalezione i brak", async function () { assert.strictEqual((await api.getOrderByClientId("known")).id, "id9"); assert.strictEqual(await api.getOrderByClientId("nope"), null); });
  await t("pozycja: istnieje i brak (404 -> null)", async function () { assert.strictEqual((await api.position("AAA")).qty, "1.5"); assert.strictEqual(await api.position("ZZZ"), null); });
  await t("tryb live używa innego adresu niż paper", async function () { var live = new Alp.Alpaca({ keyId: "K", secret: "S", mode: "live", hosts: { paper: base, live: base + "/LIVE", data: base } }); try { await live.clock(); } catch (e) {} assert.strictEqual(hits[0].key, "GET /LIVE/v2/clock"); });
  await t("brak kluczy: czytelny błąd", async function () { assert.throws(function () { new Alp.Alpaca({ mode: "paper" }); }, /ALPACA_KEY_ID/); });
  console.log(failed ? failed + " testów nie przeszło." : "Wszystkie testy połączenia przeszły.");
  srv.close(); process.exit(failed ? 1 : 0);
});
