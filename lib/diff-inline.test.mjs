import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { buildInlineDiffMap, buildInlineDiffMapForFiles, segmentsToChangedRanges } = await jiti.import("./diff-inline.ts");
const { resolvePrismTokenStyle, splitTextByChangedRanges } = await jiti.import("./diff-syntax-overlay.ts");

test("marks exact changed words on paired removed/added lines", () => {
  const removed = { kind: "removed", text: "const timeoutMs = 60;", oldLine: 10, newLine: null };
  const added = { kind: "added", text: "const timeoutMs = 500;", oldLine: null, newLine: 10 };
  const map = buildInlineDiffMap([removed, added]);
  assert.deepEqual(map.get(removed), [
    { text: "const timeoutMs = ", changed: false },
    { text: "60", changed: true },
    { text: ";", changed: false },
  ]);
  assert.deepEqual(map.get(added), [
    { text: "const timeoutMs = ", changed: false },
    { text: "500", changed: true },
    { text: ";", changed: false },
  ]);
  assert.deepEqual(segmentsToChangedRanges(map.get(added)), [{ start: 18, end: 21 }]);
});

test("omits inline highlights for unrelated completely rewritten lines and oversized lines", () => {
  const r1 = { kind: "removed", text: "alpha beta gamma", oldLine: 1, newLine: null };
  const a1 = { kind: "added", text: "12345 67890 zzz", oldLine: null, newLine: 1 };
  const r2 = { kind: "removed", text: "x".repeat(600), oldLine: 2, newLine: null };
  const a2 = { kind: "added", text: "x".repeat(599) + "y", oldLine: null, newLine: 2 };
  const map = buildInlineDiffMap([r1, a1, { kind: "context", text: "", oldLine: 3, newLine: 3 }, r2, a2]);
  assert.equal(map.has(r1), false);
  assert.equal(map.has(a1), false);
  assert.equal(map.has(r2), false);
  assert.equal(map.has(a2), false);
});

test("bounds batch inline diff work across large hunks without blocking initial render", () => {
  const longLines = [];
  for (let i = 0; i < 96; i++) {
    const base = Array.from({ length: 45 }, (_, j) => `tok_${i}_${j}_alpha_beta`).join(" ");
    longLines.push({ kind: "removed", text: base, oldLine: i + 1, newLine: null });
    longLines.push({ kind: "added", text: base.replace("tok_" + i + "_20_alpha_beta", "updated_token"), oldLine: null, newLine: i + 1 });
  }
  const t0 = performance.now();
  const longMap = buildInlineDiffMap(longLines);
  const longMs = performance.now() - t0;
  assert.equal(longMap.size, 0, "lines exceeding 500 chars skip expensive word diff immediately");
  assert.ok(longMs < 100, `expected <100ms for 192 long lines, got ${longMs.toFixed(1)}ms`);

  const mediumLines = [];
  for (let i = 0; i < 120; i++) {
    const base = Array.from({ length: 18 }, (_, j) => `item_${i}_${j}_val`).join(", ");
    mediumLines.push({ kind: "removed", text: base, oldLine: i + 1, newLine: null });
    mediumLines.push({ kind: "added", text: base.replace(`item_${i}_9_val`, `item_${i}_9_next`), oldLine: null, newLine: i + 1 });
  }
  const t1 = performance.now();
  const boundedMap = buildInlineDiffMapForFiles([{ hunks: [{ lines: mediumLines }] }], { maxPairs: 40, maxBudgetMs: 25 });
  const mediumMs = performance.now() - t1;
  assert.ok(boundedMap.size <= 80, "pair cap bounds processed lines to at most 40 pairs (80 lines)");
  assert.ok(mediumMs < 150, `expected bounded inline diff <150ms, got ${mediumMs.toFixed(1)}ms`);
});

test("overlays inline changed ranges over whole-line Prism token slices cleanly", () => {
  const pieces = splitTextByChangedRanges('"hello_world_2026"', 12, [{ start: 18, end: 24 }]);
  assert.deepEqual(pieces, [
    { text: '"hello', changed: false },
    { text: "_world", changed: true },
    { text: '_2026"', changed: false },
  ]);
  const style = resolvePrismTokenStyle(
    ["token", "keyword", "control-flow"],
    { opacity: 1 },
    { keyword: { color: "#0033b3" }, "keyword.control-flow": { fontWeight: 500 } },
  );
  assert.deepEqual(style, { opacity: 1, color: "#0033b3", fontWeight: 500 });
});
