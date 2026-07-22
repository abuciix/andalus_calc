"use strict";
// Run with: node tests/nesting-algorithms.test.js
//
// Extracts the exact guillotineNest (2D MDF/panel nesting) and ffdNest1D
// (1D RHS bar nesting) functions embedded in ../index.html and validates them
// against hand-computed theoretical optima, plus structural correctness
// guardrails (no overlaps, no boundary violations, explicit errors on
// infeasible pieces). This proves the algorithm actually shipped in the app
// behaves correctly — not just a standalone copy of it.
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

function extractFn(name) {
  const startMarker = `function ${name}(`;
  const start = html.indexOf(startMarker);
  if (start === -1) throw new Error(`${name} not found in index.html — has it been renamed or removed?`);
  let i = html.indexOf("{", start);
  let depth = 0;
  for (; i < html.length; i++) {
    if (html[i] === "{") depth++;
    else if (html[i] === "}") { depth--; if (depth === 0) { i++; break; } }
  }
  return html.slice(start, i);
}

const round2Src = "function round2(n) { if (!isFinite(n)) return NaN; return Math.round(n * 100) / 100; }";
const src = round2Src + "\n" + extractFn("guillotineNest") + "\n" + extractFn("ffdNest1D") +
  "\nmodule.exports = { guillotineNest, ffdNest1D };";

const sandbox = { module: { exports: {} }, console };
vm.createContext(sandbox);
vm.runInContext(src, sandbox);
const { guillotineNest, ffdNest1D } = sandbox.module.exports;

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log("  PASS  " + name); }
  catch (e) { fail++; console.log("  FAIL  " + name + "  ->  " + e.message); }
}
function overlaps(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

console.log("\n== 2D Guillotine MDF/Panel Nesting ==");

check("4x 4x2 pieces tile an 8x4 sheet exactly — matches theoretical minimum (1 sheet, 0% waste)", () => {
  const r = guillotineNest([{ id: 1, w: 4, h: 2, qty: 4, label: "Shelf" }], 8, 4, 0, true);
  assert.strictEqual(r.sheetCount, 1);
  assert.ok(Math.abs(r.utilizationPct - 100) < 1e-9, "expected 100% utilization, got " + r.utilizationPct);
});

check("no overlaps and no boundary violations across a mixed piece set", () => {
  const r = guillotineNest([
    { id: 1, w: 30, h: 20, qty: 5, label: "Door Panel" },
    { id: 2, w: 18, h: 12, qty: 8, label: "Drawer Front" },
    { id: 3, w: 96, h: 10, qty: 2, label: "Skirting" }
  ], 96, 48, 0.125, true);
  r.sheets.forEach((placements, si) => {
    placements.forEach(p => {
      assert.ok(p.x >= -1e-9 && p.y >= -1e-9 && p.x + p.w <= 96 + 1e-9 && p.y + p.h <= 48 + 1e-9,
        `sheet ${si} piece out of bounds: ${JSON.stringify(p)}`);
    });
    for (let i = 0; i < placements.length; i++)
      for (let j = i + 1; j < placements.length; j++)
        assert.ok(!overlaps(placements[i], placements[j]), `sheet ${si} overlap between pieces ${i} and ${j}`);
  });
});

check("grain-locked piece that only fits rotated throws an explicit validation error", () => {
  assert.throws(
    () => guillotineNest([{ id: 1, w: 30, h: 90, qty: 1, label: "Long Panel" }], 96, 48, 0.125, false),
    /exceeds the sheet size/
  );
});

check("same piece succeeds once rotation is allowed (grain unlocked)", () => {
  const r = guillotineNest([{ id: 1, w: 30, h: 90, qty: 1, label: "Long Panel" }], 96, 48, 0.125, true);
  assert.strictEqual(r.sheetCount, 1);
});

console.log("\n== 1D FFD RHS Bar Nesting ==");

check("4000+4000+2000+2000 into 6000mm bars, zero kerf — matches theoretical minimum (2 bars, 0% scrap)", () => {
  const r = ffdNest1D([
    { id: 1, length: 4000, qty: 2, label: "Column" },
    { id: 2, length: 2000, qty: 2, label: "Brace" }
  ], 6000, 0);
  assert.strictEqual(r.barCount, 2);
  assert.ok(Math.abs(r.scrapPct) < 1e-9, "expected 0% scrap, got " + r.scrapPct);
});

check("2x 2985mm into a single 6000mm bar with 3mm kerf — matches theoretical minimum (1 bar, 27mm remnant)", () => {
  const r = ffdNest1D([{ id: 1, length: 2985, qty: 2, label: "Purlin" }], 6000, 3);
  assert.strictEqual(r.barCount, 1);
  assert.ok(Math.abs(r.bars[0].remnant - 27) < 1e-9, "expected 27mm remnant, got " + r.bars[0].remnant);
});

check("2x 3000mm into a 6000mm bar with 3mm kerf correctly needs 2 bars (kerf leaves no room for an exact fit)", () => {
  const r = ffdNest1D([{ id: 1, length: 3000, qty: 2, label: "Purlin" }], 6000, 3);
  assert.strictEqual(r.barCount, 2);
});

check("piece longer than the stock bar throws an explicit validation error", () => {
  assert.throws(
    () => ffdNest1D([{ id: 1, length: 6500, qty: 1, label: "Truss Chord" }], 6000, 3),
    /exceeds the stock bar length/
  );
});

check("100-entry stress case never overfills a bar and completes well under the timeout budget", () => {
  const pieces = [];
  for (let i = 1; i <= 25; i++) pieces.push({ id: i, length: 500 + (i % 7) * 137, qty: 4, label: "Piece " + i });
  const t0 = Date.now();
  const r = ffdNest1D(pieces, 6000, 3);
  const ms = Date.now() - t0;
  r.bars.forEach(b => {
    const used = b.items.reduce((s, it) => s + it.length, 0) + Math.max(0, b.items.length - 1) * 3;
    assert.ok(used <= 6000 + 1e-9, `bar overfilled: ${used}`);
  });
  assert.ok(ms < 500, `expected <500ms for 100 units, took ${ms}ms`);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
