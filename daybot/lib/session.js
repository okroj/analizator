/* Jedna sesja giełdowa bota: plan przed otwarciem, kupno po otwarciu, sprzedaż przed zamknięciem.
   Cały stan dnia jest zapisywany po każdym kroku, więc po restarcie bot kończy to, co zaczął, i nie dubluje zleceń.
   Broker, zegar i zapis stanu są wstrzykiwane (ctx), dzięki czemu ten sam kod działa w teście z atrapą brokera. */
"use strict";
var St = require("./strategy.js");

var DONE = { filled: 1, canceled: 1, expired: 1, rejected: 1, done_for_day: 1 };

function addDays(d, n) { var t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); }
function num(x) { var v = Number(x); return isFinite(v) ? v : 0; }

async function runSession(ctx) {
  var broker = ctx.broker, cfg = ctx.cfg, log = ctx.log, P = St.params(cfg.strategy);
  var clock = await broker.clock();
  if (!clock || !clock.timestamp) throw new Error("Broker nie zwrócił zegara giełdy.");
  var today = String(clock.timestamp).slice(0, 10), offset = String(clock.timestamp).slice(-6);
  if (!/^[+-]\d\d:\d\d$/.test(offset)) throw new Error("Nieoczekiwany format czasu giełdy: " + clock.timestamp);
  var skew = Date.parse(clock.timestamp) - ctx.nowMs();              // różnica między zegarem brokera a lokalnym
  function serverNow() { return ctx.nowMs() + skew; }
  function sleepUntil(serverMs) { return ctx.sleepUntil(serverMs - skew); }

  var days = await broker.calendar(addDays(today, -10), today), row = null, prevDay = null;
  (days || []).forEach(function (r) { var d = String(r.date).slice(0, 10); if (d === today) row = r; else if (d < today) prevDay = d; });
  if (!row) { log("Dziś (" + today + ") giełda jest zamknięta. Koniec."); return { date: today, phase: "closed" }; }
  var openMs = Date.parse(today + "T" + row.open + ":00" + offset), closeMs = Date.parse(today + "T" + row.close + ":00" + offset);
  if (!(openMs > 0 && closeMs > openMs)) throw new Error("Nie udało się odczytać godzin sesji z kalendarza.");
  var exitMs = closeMs - cfg.exitMinutesBeforeClose * 60000;

  var state = ctx.store.load(today) || { date: today, phase: "new", mode: cfg.mode, dryRun: !!cfg.dryRun, entries: {}, exits: {}, notes: [] };
  function save() { ctx.store.save(today, state); }
  function note(msg) { state.notes.push(msg); log(msg); }
  if (state.phase === "done") { log("Sesja " + today + " jest już zakończona, nic do zrobienia."); return state; }
  if (serverNow() >= closeMs && state.phase === "new") { log("Sesja " + today + " już się skończyła. Koniec."); return { date: today, phase: "closed" }; }

  /* ---------- 1. Plan ---------- */
  if (!state.plan) {
    if (serverNow() > openMs + cfg.entryWindowSec * 1000) {
      state.plan = { picks: [], signals: [], skipped: "start po czasie" };
      note("Bot ruszył za późno po otwarciu (limit " + cfg.entryWindowSec + " s). Dziś bez zakupów.");
    } else if (!prevDay) {
      state.plan = { picks: [], signals: [], skipped: "brak kalendarza" };
      note("Nie znam poprzedniej sesji z kalendarza. Dziś bez zakupów.");
    } else {
      var H = await broker.dailyBars(cfg.symbols, addDays(today, -90), prevDay), hist = {}, stale = [];
      cfg.symbols.forEach(function (s) {
        var b = (H.bars[s] || []).filter(function (x) { return x.d <= prevDay; });
        if (b.length >= 30 && b[b.length - 1].d === prevDay) hist[s] = b; else stale.push(s);
      });
      if (stale.length) note("Brak aktualnych notowań z " + prevDay + " dla: " + stale.join(", ") + ". Te spółki są dziś pominięte.");
      var pl = St.plan(hist, P);
      state.plan = { prevDay: prevDay, feed: H.feed, universe: Object.keys(hist).length,
        signals: pl.all.map(function (x) { return { symbol: x.symbol, rsi2: +x.rsi2.toFixed(2), ibs: +x.ibs.toFixed(3), atr: +x.atr.toFixed(4), prevClose: x.prevClose }; }),
        picks: pl.picks.map(function (x) { return x.symbol; }) };
      note("Plan na " + today + ": sygnał ma " + pl.all.length + " spółek" + (pl.all.length ? " (" + pl.all.map(function (x) { return x.symbol; }).join(", ") + ")" : "") +
        ", wymagane minimum " + P.minSignals + ". Do kupienia: " + (state.plan.picks.length ? state.plan.picks.join(", ") : "nic") + ".");
    }
    state.phase = "planned"; save();
  }

  /* ---------- 2. Kupno po otwarciu ---------- */
  var slot = Math.floor(Math.min(cfg.capitalUsd / P.maxPos, cfg.maxOrderUsd) * 100) / 100;
  if (state.phase === "planned") {
    if (state.plan.picks.length && serverNow() < openMs + cfg.entryDelaySec * 1000) {
      log("Czekam na otwarcie sesji (" + row.open + " czasu nowojorskiego) + " + cfg.entryDelaySec + " s.");
      await sleepUntil(openMs + cfg.entryDelaySec * 1000);
    }
    if (ctx.stopRequested()) note("Znaleziono plik STOP: dziś bez zakupów.");
    else if (state.plan.picks.length && serverNow() > openMs + cfg.entryWindowSec * 1000) note("Minęło okno na zakupy po otwarciu. Dziś bez zakupów.");
    else if (state.plan.picks.length && serverNow() >= exitMs) note("Za blisko zamknięcia sesji. Dziś bez zakupów.");
    else if (state.plan.picks.length) {
      if (!(slot >= 1)) note("Kwota na pozycję poniżej 1 USD. Dziś bez zakupów.");
      else await enter();
    }
    state.phase = "entered"; save();
  }

  async function knownOrders() {
    var map = {}, list = await broker.listOrders(today + "T00:00:00" + offset);
    (list || []).forEach(function (o) { if (o.client_order_id) map[o.client_order_id] = o; });
    return map;
  }
  function adopt(rec, o) { rec.id = o.id; rec.status = o.status; rec.qty = num(o.filled_qty); rec.price = num(o.filled_avg_price); }
  async function settle(recs, seconds) {                    // czekaj, aż zlecenia się rozstrzygną
    var until = serverNow() + seconds * 1000;
    for (;;) {
      var open = 0;
      for (var i = 0; i < recs.length; i++) { var r = recs[i]; if (!r.id || r.sim || DONE[r.status]) continue; adopt(r, await broker.getOrder(r.id)); if (!DONE[r.status]) open++; }
      save();
      if (!open || serverNow() >= until) return open;
      await sleepUntil(serverNow() + 2000);
    }
  }
  async function place(rec, order) {                         // jedno zlecenie; nigdy nie ponawiane na ślepo
    try { adopt(rec, await broker.submitOrder(order)); }
    catch (e) {
      if (e.status === 0 || e.status >= 500 || e.status === 429) {   // nie wiadomo, czy doszło: sprawdź po identyfikatorze
        var o = null; try { o = await broker.getOrderByClientId(order.client_order_id); } catch (e2) { o = null; }
        if (o) adopt(rec, o); else { rec.status = "unknown"; rec.error = e.message; }
      } else { rec.status = "rejected"; rec.error = e.message; }
    }
    save();
  }

  async function enter() {
    var acct = await broker.account();
    if (acct.trading_blocked || acct.account_blocked || (acct.status && acct.status !== "ACTIVE")) { note("Konto u brokera nie pozwala teraz handlować (status " + acct.status + "). Dziś bez zakupów."); return; }
    var have = await knownOrders(), prices = cfg.dryRun ? await broker.snapshots(state.plan.picks) : {}, bp = num(acct.buying_power);
    for (var i = 0; i < state.plan.picks.length; i++) {
      var s = state.plan.picks[i], cid = cfg.botId + "-" + today + "-" + s + "-buy";
      if (state.entries[s] && state.entries[s].status !== "new_local") continue;
      var rec = state.entries[s] = { cid: cid, status: "new_local", usd: slot, qty: 0, price: 0, at: new Date(serverNow()).toISOString() };
      if (have[cid]) { adopt(rec, have[cid]); note(s + ": zlecenie kupna już istnieje u brokera, przejmuję je."); save(); continue; }
      if (cfg.dryRun) {
        var px = prices[s] && prices[s].price;
        if (px > 0) { rec.sim = true; rec.status = "filled"; rec.price = px; rec.qty = +(slot / px).toFixed(6); note("[na sucho] " + s + ": kupno za " + slot.toFixed(2) + " USD po " + px); }
        else { rec.status = "rejected"; rec.error = "brak ceny"; note("[na sucho] " + s + ": brak ceny, pomijam."); }
        save(); continue;
      }
      if (bp < slot) { rec.status = "rejected"; rec.error = "za mała siła nabywcza"; note(s + ": za mało środków na koncie (" + bp.toFixed(2) + " USD), pomijam."); save(); continue; }
      await place(rec, { symbol: s, notional: slot.toFixed(2), side: "buy", type: "market", time_in_force: "day", client_order_id: cid });
      if (rec.status === "rejected" || rec.status === "unknown") note(s + ": zlecenie kupna nieprzyjęte (" + rec.error + ").");
      else { bp -= slot; note(s + ": złożono zlecenie kupna za " + slot.toFixed(2) + " USD."); }
    }
    var recs = Object.keys(state.entries).map(function (k) { return state.entries[k]; });
    if (await settle(recs, 60)) note("Część zleceń kupna nie została jeszcze zrealizowana. Sprawdzę je ponownie przed sprzedażą.");
    recs.forEach(function (r) { if (r.qty > 0) log("  kupiono " + r.cid.split("-").slice(-2)[0] + ": " + r.qty + " szt. po " + r.price); });
  }

  /* Uzgodnienie z brokerem: zlecenia bota z dzisiaj, których nie ma w zapisanym stanie (np. po utracie pliku stanu). */
  if (!cfg.dryRun && state.phase !== "done") {
    var mine = await knownOrders(), re = new RegExp("^" + cfg.botId + "-" + today + "-([A-Z.]+)-(buy|sell)$"), found = 0;
    Object.keys(mine).forEach(function (cid) {
      var m = re.exec(cid); if (!m) return;
      var box = m[2] === "buy" ? state.entries : state.exits;
      if (box[m[1]] && box[m[1]].id) return;
      box[m[1]] = { cid: cid, why: m[2] === "sell" ? "przejęte" : undefined, at: mine[cid].created_at || null }; adopt(box[m[1]], mine[cid]); found++;
      if (m[2] === "sell" && DONE[box[m[1]].status]) box[m[1]].final = true;
    });
    if (found) { note("Przejęto z konta brokera " + found + " dzisiejszych zleceń bota, których nie było w zapisanym stanie."); save(); }
  }

  /* ---------- 3. Trzymanie pozycji do końca sesji ---------- */
  function held() { return Object.keys(state.entries).filter(function (s) { var e = state.entries[s]; return (e.qty > 0 || (e.id && !DONE[e.status])) && !(state.exits[s] && state.exits[s].final); }); }
  if (state.phase === "entered" || (state.phase === "exited" && held().length)) {
    if (held().length) log("Trzymam: " + held().join(", ") + ". Sprzedaż o " + new Date(exitMs).toISOString().slice(11, 16) + " UTC.");
    while (held().length && serverNow() < exitMs) {
      if (ctx.stopRequested()) { note("Znaleziono plik STOP: sprzedaję wszystko teraz."); break; }
      if (P.stopAtr > 0) await checkStops();
      await sleepUntil(Math.min(exitMs, serverNow() + cfg.pollSec * 1000));
    }
    await exitAll(held(), ctx.stopRequested() && serverNow() < exitMs ? "stop ręczny" : "koniec sesji");
    state.phase = "exited"; save();
  }

  async function checkStops() {
    var hs = held(), px;
    try { px = await broker.snapshots(hs); } catch (e) { log("Nie udało się pobrać cen do sprawdzenia stopów: " + e.message); return; }
    var hit = hs.filter(function (s) {
      var e = state.entries[s], sig = state.plan.signals.filter(function (x) { return x.symbol === s; })[0];
      return e.price > 0 && sig && px[s] && px[s].price <= e.price - P.stopAtr * sig.atr;
    });
    if (hit.length) { note("Stop: " + hit.join(", ") + "."); await exitAll(hit, "stop"); }
  }

  async function exitAll(symbols, why) {
    if (!symbols.length) return;
    if (serverNow() >= closeMs) { note("UWAGA: sesja jest już zamknięta, a bot ma niesprzedane pozycje: " + symbols.join(", ") + ". Zdecyduj o nich ręcznie u brokera."); return; }
    var have = cfg.dryRun ? {} : await knownOrders(), prices = cfg.dryRun ? await broker.snapshots(symbols) : {}, recs = [];
    for (var i = 0; i < symbols.length; i++) {
      var s = symbols[i], e = state.entries[s], cid = cfg.botId + "-" + today + "-" + s + "-sell";
      if (state.exits[s] && state.exits[s].id) { recs.push(state.exits[s]); continue; }
      var x = state.exits[s] = { cid: cid, status: "new_local", why: why, qty: 0, price: 0, at: new Date(serverNow()).toISOString() };
      if (e.sim) { var px = prices[s] && prices[s].price; x.sim = true; x.status = "filled"; x.qty = e.qty; x.price = px > 0 ? px : e.price; x.final = true; note("[na sucho] " + s + ": sprzedaż po " + x.price); save(); continue; }
      if (have[cid]) { adopt(x, have[cid]); recs.push(x); save(); continue; }
      if (!DONE[e.status]) { await broker.cancelOrder(e.id); adopt(e, await broker.getOrder(e.id)); }   // niezrealizowana reszta kupna
      var pos = await broker.position(s), qty = Math.min(e.qty, pos ? num(pos.qty) : 0);
      if (!(qty > 0)) { x.status = "nothing"; x.final = true; note(s + ": brak pozycji do sprzedania."); save(); continue; }
      await place(x, { symbol: s, qty: String(qty), side: "sell", type: "market", time_in_force: "day", client_order_id: cid });
      if (x.status === "rejected" || x.status === "unknown") note("UWAGA: " + s + ": zlecenie sprzedaży nieprzyjęte (" + x.error + "). Pozycja może być nadal otwarta!");
      else { recs.push(x); note(s + ": złożono zlecenie sprzedaży " + qty + " szt. (" + why + ")."); }
    }
    var open = await settle(recs, 90);
    recs.forEach(function (r) {
      if (!DONE[r.status]) return;
      r.final = true;
      if (r.status !== "filled") note("UWAGA: zlecenie sprzedaży " + r.cid + " zakończyło się statusem " + r.status + ". Pozycja może być nadal otwarta!");
    });
    if (open) note("UWAGA: " + open + " zleceń sprzedaży nadal czeka na realizację. Sprawdź konto u brokera.");
    save();
  }

  /* ---------- 4. Podsumowanie dnia ---------- */
  var trades = [], pnl = 0, problems = 0;
  Object.keys(state.entries).forEach(function (s) {
    var e = state.entries[s], x = state.exits[s];
    if (!(e.qty > 0)) return;
    if (!x || x.status !== "filled" || !(x.price > 0)) { problems++; trades.push({ symbol: s, qty: e.qty, buy: e.price, sell: null, pnl: null, ret: null, why: x ? x.why : null }); return; }
    var p = (x.price - e.price) * x.qty; pnl += p;
    trades.push({ symbol: s, qty: x.qty, buy: e.price, sell: x.price, pnl: +p.toFixed(4), ret: +(x.price / e.price - 1).toFixed(6), why: x.why, sim: !!e.sim });
  });
  state.result = { trades: trades, pnlUsd: +pnl.toFixed(2), unclosed: problems };
  state.phase = problems ? "exited" : "done"; save();
  log("Wynik dnia " + today + ": " + (trades.length ? trades.length + " transakcji, " + (pnl >= 0 ? "+" : "") + pnl.toFixed(2) + " USD" : "bez transakcji") +
    (problems ? ". UWAGA: " + problems + " pozycji bez potwierdzonej sprzedaży!" : "."));
  return state;
}

module.exports = { runSession: runSession };
