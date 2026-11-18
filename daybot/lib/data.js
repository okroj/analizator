/* Wczytywanie dziennych notowań z plików CSV (date,open,high,low,close,volume,...). */
"use strict";
var fs = require("fs"), path = require("path");

function loadCsv(file, from) {
  var lines = fs.readFileSync(file, "utf8").trim().split(/\r?\n/), out = [];
  for (var i = 1; i < lines.length; i++) {
    var c = lines[i].split(",");
    if (from && c[0] < from) continue;
    var b = { d: c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4], v: +c[5] };
    if (!(b.o > 0 && b.h > 0 && b.l > 0 && b.c > 0)) continue;
    out.push(b);
  }
  return out;
}
function loadDir(dir, symbols, from) {
  var res = {};
  symbols.forEach(function (s) { res[s] = loadCsv(path.join(dir, s + ".csv"), from); });
  return res;
}
module.exports = { loadCsv: loadCsv, loadDir: loadDir };
