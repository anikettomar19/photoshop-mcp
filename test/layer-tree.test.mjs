import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jsonStringifyHelper } from '../dist/api/extendscript.js';
import { formatLayerTree } from '../dist/tools/layer-tree-format.js';

// The ExtendScript serializer, run in Node (it is plain ES3).
const psJSON = new Function(`${jsonStringifyHelper}; return psJSON;`)();

test('psJSON output is valid JSON, including text with line breaks', () => {
  const value = {
    name: 'VIEW\rCLAN', // what toSource() left raw, breaking the whole result
    quote: 'say "hi" \\ back\n\ttab',
    odd: '\u0001    ',
    n: 3.5,
    inf: Infinity,
    flags: [true, false, null],
    nested: { empty: [], obj: {} },
  };
  const parsed = JSON.parse(psJSON(value));
  assert.deepEqual(parsed, { ...value, inf: null });
});

function layer(name, depth, children) {
  return {
    name,
    type: children ? 'GROUP' : 'LayerKind.NORMAL',
    visible: true,
    opacity: 100,
    blendMode: children ? 'BlendMode.PASSTHROUGH' : 'BlendMode.NORMAL',
    depth,
    bounds: { left: 1, top: 2, right: 11, bottom: 22, width: 10, height: 20 },
    ...(children ? { children } : {}),
  };
}

// 4 levels: 3 top groups x 10 subgroups x 10 sub-subgroups x 10 layers.
const range = (n) => [...Array(n).keys()];
const leaves = () => range(10).map((d) => layer(`L${d}`, 3));
const level2 = (a, b) => range(10).map((c) => layer(`G${a}.${b}.${c}`, 2, leaves()));
const level1 = (a) => range(10).map((b) => layer(`G${a}.${b}`, 1, level2(a, b)));
const big = {
  documentName: 'Big.psd',
  width: 1080,
  height: 1920,
  root: null,
  maxDepth: null,
  layers: range(3).map((a) => layer(`G${a}`, 0, level1(a))),
};

test('compact format drops defaults and is much smaller than full', () => {
  const small = { ...big, layers: [layer('Only', 0)] };
  const c = JSON.parse(formatLayerTree(small, { compact: true }));
  assert.deepEqual(c.layers, [{ n: 'Only', b: [1, 2, 10, 20] }]);
  const full = formatLayerTree(big, { compact: false, maxChars: 1e9 });
  const compact = formatLayerTree(big, { compact: true, maxChars: 1e9 });
  assert.ok(compact.length < full.length * 0.5, `${compact.length} vs ${full.length}`);
});

test('a tree over budget is cut to the deepest level that fits, with a note', () => {
  const text = formatLayerTree(big, { compact: true, maxChars: 20_000 });
  assert.ok(text.length <= 20_000);
  const out = JSON.parse(text);
  assert.match(out.note, /Output limited to \d level\(s\)/);
  // Cut groups say how much they hide instead of looking empty.
  const cut = [];
  (function walk(ls) { for (const l of ls) { if (l.count !== undefined) cut.push(l); if (l.c) walk(l.c); } })(out.layers);
  assert.ok(cut.length > 0 && cut.every((l) => l.count === 10));
});

test('a tree within budget is returned whole, without a note', () => {
  const out = JSON.parse(formatLayerTree(big, { compact: true, maxChars: 1e9 }));
  assert.equal(out.note, undefined);
  assert.equal(out.layers[0].c[0].c[0].c.length, 10);
});
