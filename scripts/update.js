/* Codzienna aktualizacja notowań Analizatora giełdy. Uruchamia ją automat GitHuba (Node 20+, bez dodatkowych bibliotek).
   1. 16 spółek do testu i Skanera: kursy i zysk na akcję ze zbioru Pubmarks.
   2. Spółki z pliku tickers.json: same kursy z Yahoo Finance, a gdy to zawiedzie, ze Stooq.
   3. Złożenie pliku data.js skryptem scripts/daily.js. Gdy coś pójdzie nie tak, stary data.js zostaje. */
"use strict";
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const ROOT = path.resolve(__dirname, ".."), TMP = path.join(ROOT, ".tmp");
const UNI = ["AAPL", "ACN", "ADBE", "CRM", "DELL", "GOOG", "INTU", "LRCX", "META", "MSFT", "NFLX", "NVDA", "RMD", "SAP", "TSLA", "TSM"];
const SRC_PUBMARKS = process.env.SRC_PUBMARKS || "https://pubmarks.github.io/datasets/stocks/{T}/combined.csv";
const SRC_YAHOO = process.env.SRC_YAHOO || "https://query1.finance.yahoo.com/v8/finance/chart/{T}?range=10y&interval=1d";
const SRC_STOOQ = process.env.SRC_STOOQ || "https://stooq.com/q/d/l/?s={T}&i=d";
const H1 = "date,open,high,low,close,volume,ttm_net_eps,pe_ratio", H2 = "date,open,high,low,close,volume,div,split";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, tries) {
  let last = "";
  for (let i = 0; i < (tries || 3); i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) analizator-gieldy" }, signal: AbortSignal.timeout(60000) });
      if (r.ok) return await r.text();
      last = "HTTP " + r.status;
    } catch (e) { last = e.message; }
    await sleep(1500 * (i + 1));
  }
  throw new Error(last);
}
function good(rows) { return rows.filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.d) && r.o > 0 && r.c > 0).sort((a, b) => (a.d < b.d ? -1 : 1)); }
function fromYahoo(text) {
  const res = JSON.parse(text).chart.result[0], q = res.indicators.quote[0], off = res.meta.gmtoffset || 0;
  return good(res.timestamp.map((t, i) => ({ d: new Date((t + off) * 1000).toISOString().slice(0, 10), o: q.open[i], c: q.close[i], v: q.volume[i] || 0 })));
}
function fromStooq(text) {
  const lines = text.trim().split(/\r?\n/);
  if (!/^Date,Open,High,Low,Close/i.test(lines[0])) throw new Error("nieoczekiwana odpowiedź Stooq");
  return good(lines.slice(1).map((l) => { const p = l.split(","); return { d: p[0], o: +p[1], c: +p[4], v: +p[5] || 0 }; }));
}
function fromPrev(prev, sym) {
  const t = prev && prev.tickers.find((x) => x.s === sym); if (!t) return [];
  const rows = [];
  for (let i = t.start; i < prev.dates.length; i++) if (t.c[i] != null) { const d = String(prev.dates[i]); rows.push({ d: d.slice(0, 4) + "-" + d.slice(4, 6) + "-" + d.slice(6), o: t.o[i], c: t.c[i], v: 0 }); }
  return rows;
}

(async () => {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(path.join(TMP, "csv"), { recursive: true }); fs.mkdirSync(path.join(TMP, "csv2"), { recursive: true });
  let prev = null;
  try { const raw = fs.readFileSync(path.join(ROOT, "data.js"), "utf8"); prev = JSON.parse(raw.slice(raw.indexOf("=") + 1).trim().replace(/;$/, "")); } catch (e) { prev = null; }

  for (const t of UNI) {
    let text;
    try { text = await get(SRC_PUBMARKS.replace("{T}", t)); } catch (e) { console.error("BŁĄD: " + t + " z Pubmarks: " + e.message + ". Dane zostają bez zmian."); process.exit(1); }
    if (text.split(/\r?\n/)[0].trim() !== H1) { console.error("BŁĄD: " + t + ": nieoczekiwany format pliku. Dane zostają bez zmian."); process.exit(1); }
    fs.writeFileSync(path.join(TMP, "csv", t + ".csv"), text);
  }

  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "tickers.json"), "utf8")), names = {}, report = [];
  for (const x of cfg.extra || []) {
    const s = String(x.s || "").toUpperCase();
    if (!/^[A-Z0-9.\-]{1,12}$/.test(s) || UNI.includes(s) || names[s]) { report.push(s + ": pominięto (zły albo powtórzony symbol)"); continue; }
    let rows = [], from = "";
    try { rows = fromYahoo(await get(SRC_YAHOO.replace("{T}", encodeURIComponent(x.yahoo || s.replace(".", "-"))), 2)); from = "Yahoo"; } catch (e) { rows = []; }
    if (rows.length < 20) { try { rows = fromStooq(await get(SRC_STOOQ.replace("{T}", encodeURIComponent(x.stooq || s.toLowerCase() + ".us")), 2)); from = "Stooq"; } catch (e) { rows = []; } }
    if (rows.length < 20) { rows = fromPrev(prev, s); from = "poprzednie dane"; }
    if (rows.length < 20) { report.push(s + ": brak notowań w obu źródłach, spółka pominięta"); continue; }
    names[s] = String(x.n || s).slice(0, 40);
    fs.writeFileSync(path.join(TMP, "csv2", s + ".csv"), H2 + "\n" + rows.map((r) => [r.d, r.o, "", "", r.c, r.v, "", ""].join(",")).join("\n") + "\n");
    report.push(s + ": " + from + ", ostatnia sesja " + rows[rows.length - 1].d);
    await sleep(400);
  }
  fs.writeFileSync(path.join(TMP, "extra.json"), JSON.stringify(names));
  console.log(report.join("\n"));

  const args = [path.join(__dirname, "daily.js"), "--csv", path.join(TMP, "csv"), "--csv2", path.join(TMP, "csv2"), "--extra", path.join(TMP, "extra.json"),
    "--engine", path.join(ROOT, "engine.js"), "--out", path.join(TMP, "data.js"), "--source", "Pubmarks (GitHub), Yahoo Finance i Stooq"];
  if (prev) args.push("--prev", path.join(ROOT, "data.js"));
  let out;
  try { out = JSON.parse(execFileSync(process.execPath, args, { encoding: "utf8", maxBuffer: 1 << 26 }).trim().split("\n").pop()); }
  catch (e) { console.error("BŁĄD przy składaniu danych: " + ((e.stdout || "") + (e.message || "")).slice(0, 400)); process.exit(1); }
  if (!out.ok) { console.error("BŁĄD: " + out.error); process.exit(1); }
  if (out.check.historyChanged > 200) { console.error("BŁĄD: historia kursów w źródle zmieniła się w " + out.check.historyChanged + " miejscach (możliwy split). Dane zostają bez zmian, potrzebny przegląd."); process.exit(1); }
  if (out.newData) { fs.copyFileSync(path.join(TMP, "data.js"), path.join(ROOT, "data.js")); console.log("Zapisano nowe dane: notowania do " + out.asOf + "."); }
  else console.log("Brak nowych notowań, ostatnie są z " + out.asOf + ".");
  fs.rmSync(TMP, { recursive: true, force: true });
})().catch((e) => { console.error("BŁĄD: " + e.message); process.exit(1); });
