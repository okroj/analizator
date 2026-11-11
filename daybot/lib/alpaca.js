/* Połączenie z brokerem Alpaca (Trading API v2 + Market Data API v2). Bez zewnętrznych bibliotek: Node 18+.
   Klucze: ALPACA_KEY_ID i ALPACA_SECRET_KEY (zmienne środowiskowe albo plik .env). */
"use strict";

var HOSTS = { paper: "https://paper-api.alpaca.markets", live: "https://api.alpaca.markets", data: "https://data.alpaca.markets" };

function ApiError(status, message, body) { this.name = "ApiError"; this.status = status; this.message = message; this.body = body; }
ApiError.prototype = Object.create(Error.prototype);

function Alpaca(opt) {
  if (!opt.keyId || !opt.secret) throw new Error("Brak kluczy API: ustaw ALPACA_KEY_ID i ALPACA_SECRET_KEY (plik .env).");
  var hosts = opt.hosts || HOSTS;                       // podmieniane tylko w testach
  this.trade = opt.mode === "live" ? hosts.live : hosts.paper;
  this.data = hosts.data;
  this.headers = { "APCA-API-KEY-ID": opt.keyId, "APCA-API-SECRET-KEY": opt.secret, "Accept": "application/json" };
  this.feed = opt.feed || "iex";
}

/* Jedno żądanie. Ponawiane są tylko odczyty (GET); zlecenia nigdy, żeby nie złożyć ich dwa razy. */
Alpaca.prototype.req = async function (host, method, path, query, body) {
  var url = host + path, qs = [];
  Object.keys(query || {}).forEach(function (k) { if (query[k] !== undefined && query[k] !== null) qs.push(encodeURIComponent(k) + "=" + encodeURIComponent(query[k])); });
  if (qs.length) url += "?" + qs.join("&");
  var tries = method === "GET" ? 3 : 1, lastErr;
  for (var a = 0; a < tries; a++) {
    if (a) await new Promise(function (r) { setTimeout(r, 1500 * a); });
    var ctl = new AbortController(), timer = setTimeout(function () { ctl.abort(); }, 20000);
    try {
      var h = Object.assign({}, this.headers); if (body) h["Content-Type"] = "application/json";
      var res = await fetch(url, { method: method, headers: h, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal, redirect: "error" });
      var text = await res.text(), json = null; try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
      if (res.ok || res.status === 207) return json;
      lastErr = new ApiError(res.status, (json && json.message) || text.slice(0, 200) || ("HTTP " + res.status), json);
      if (res.status !== 429 && res.status < 500) throw lastErr;          // błąd ostateczny, bez ponawiania
    } catch (e) {
      if (e instanceof ApiError) { if (e.status !== 429 && e.status < 500) throw e; lastErr = e; }
      else lastErr = new ApiError(0, "błąd sieci: " + (e && e.message), null);  // status 0 = nie wiadomo, czy żądanie doszło
    } finally { clearTimeout(timer); }
  }
  throw lastErr;
};

Alpaca.prototype.clock = function () { return this.req(this.trade, "GET", "/v2/clock"); };
Alpaca.prototype.calendar = function (start, end) { return this.req(this.trade, "GET", "/v2/calendar", { start: start, end: end }); };
Alpaca.prototype.account = function () { return this.req(this.trade, "GET", "/v2/account"); };
Alpaca.prototype.listOrders = function (afterIso) { return this.req(this.trade, "GET", "/v2/orders", { status: "all", limit: 500, after: afterIso, direction: "asc" }); };
Alpaca.prototype.getOrder = function (id) { return this.req(this.trade, "GET", "/v2/orders/" + encodeURIComponent(id)); };
Alpaca.prototype.getOrderByClientId = async function (cid) {
  try { return await this.req(this.trade, "GET", "/v2/orders:by_client_order_id", { client_order_id: cid }); }
  catch (e) { if (e.status === 404) return null; throw e; }
};
Alpaca.prototype.submitOrder = function (o) { return this.req(this.trade, "POST", "/v2/orders", null, o); };
Alpaca.prototype.cancelOrder = async function (id) {
  try { await this.req(this.trade, "DELETE", "/v2/orders/" + encodeURIComponent(id)); } catch (e) { if (e.status !== 404 && e.status !== 422) throw e; }
};
Alpaca.prototype.position = async function (symbol) {
  try { return await this.req(this.trade, "GET", "/v2/positions/" + encodeURIComponent(symbol)); }
  catch (e) { if (e.status === 404) return null; throw e; }
};

/* Słupki dzienne do dnia `end` włącznie. Najpierw pełny rynek (dane historyczne są dostępne także w darmowym planie),
   a jeśli konto na to nie pozwala, to dane z samej giełdy IEX. Zwraca { bars: { SYMBOL: [{d,o,h,l,c,v}] }, feed }. */
Alpaca.prototype.dailyBars = async function (symbols, start, end) {
  var self = this, feeds = ["sip", "iex"], lastErr;
  for (var f = 0; f < feeds.length; f++) {
    try {
      var out = {}, token = null, pages = 0;
      symbols.forEach(function (s) { out[s] = []; });
      do {
        var r = await self.req(self.data, "GET", "/v2/stocks/bars", { symbols: symbols.join(","), timeframe: "1Day", start: start, end: end, limit: 10000, adjustment: "split", feed: feeds[f], sort: "asc", page_token: token });
        if (!r || typeof r.bars !== "object") throw new ApiError(0, "nieoczekiwana odpowiedź z danymi", r);
        Object.keys(r.bars || {}).forEach(function (s) {
          (r.bars[s] || []).forEach(function (b) { if (out[s] && b.o > 0 && b.h > 0 && b.l > 0 && b.c > 0) out[s].push({ d: String(b.t).slice(0, 10), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }); });
        });
        token = r.next_page_token || null;
      } while (token && ++pages < 50);
      return { bars: out, feed: feeds[f] };
    } catch (e) { lastErr = e; if (!(e.status === 403 || e.status === 422 || e.status === 400)) throw e; }
  }
  throw lastErr;
};

/* Ostatnia cena transakcyjna każdej spółki: { SYMBOL: { price, time } }. */
Alpaca.prototype.snapshots = async function (symbols) {
  var r = await this.req(this.data, "GET", "/v2/stocks/snapshots", { symbols: symbols.join(","), feed: this.feed }), out = {};
  Object.keys(r || {}).forEach(function (s) { var t = r[s] && r[s].latestTrade; if (t && t.p > 0) out[s] = { price: t.p, time: t.t }; });
  return out;
};

module.exports = { Alpaca: Alpaca, ApiError: ApiError };
