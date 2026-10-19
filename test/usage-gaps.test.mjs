// Gaps found in a usage audit of another machine: batch export time limit,
// oversized PSD trees, and export_composite's scale. No Photoshop needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { optionalTimeoutMs, MAX_TIMEOUT_SECONDS } from '../dist/utils/args.js';
import { limitPsdLayerTree } from '../dist/tools/psd-tools.js';
import { createUtilityTools } from '../dist/tools/utility-tools.js';

test('timeout_seconds is read as milliseconds, with a fallback and bounds', () => {
  assert.equal(optionalTimeoutMs({}, 300_000), 300_000);
  assert.equal(optionalTimeoutMs({}, undefined), undefined);
  assert.equal(optionalTimeoutMs({ timeout_seconds: 900 }, 300_000), 900_000);
  assert.throws(() => optionalTimeoutMs({ timeout_seconds: 0 }, 1), /between 0 and/);
  assert.throws(
    () => optionalTimeoutMs({ timeout_seconds: MAX_TIMEOUT_SECONDS + 1 }, 1),
    /between 0 and/
  );
  assert.throws(() => optionalTimeoutMs({ timeout_seconds: '60' }, 1), /between 0 and/);
});

test('batch export and export_composite describe the new behaviour', () => {
  const tools = Object.fromEntries(createUtilityTools({}).map((t) => [t.tool.name, t.tool]));
  assert.ok(tools.photoshop_batch_export_layers.inputSchema.properties.timeout_seconds);
  assert.match(
    tools.photoshop_export_composite.inputSchema.properties.scale.description,
    /effects .* scaled/
  );
});

function psdTree(groups, perGroup) {
  const layers = [];
  for (let g = 0; g < groups; g++) {
    const gp = `/Group ${g}`;
    layers.push({
      path: gp,
      name: `Group ${g}`,
      type: 'LayerKind.GROUP',
      depth: 1,
      parent_path: '',
    });
    for (let c = 0; c < perGroup; c++) {
      layers.push({
        path: `${gp}/Layer ${c}`,
        name: `Layer ${c}`,
        type: 'LayerKind.NORMAL',
        depth: 2,
        parent_path: gp,
        padding: 'x'.repeat(200),
      });
    }
  }
  return JSON.stringify({ document: { width: 100, height: 100 }, layers }) + '\n';
}

test('a small PSD tree is returned unchanged', () => {
  const out = psdTree(2, 3);
  assert.equal(limitPsdLayerTree(out), out);
});

test('a PSD tree over budget is cut to the deepest level that fits', () => {
  const out = psdTree(20, 50);
  const cut = limitPsdLayerTree(out, 20_000);
  assert.ok(cut.length <= 20_000);
  const tree = JSON.parse(cut);
  assert.match(tree.note, /limited to 1 level/);
  assert.equal(tree.layers.length, 20);
  assert.deepEqual(tree.layers.map((l) => [l.child_count, l.truncated]).at(0), [50, true]);
  assert.deepEqual(tree.document, { width: 100, height: 100 });
});

test('a top level too large on its own is shortened, with a note', () => {
  const cut = limitPsdLayerTree(psdTree(400, 1), 5_000);
  assert.ok(cut.length <= 5_000);
  const t = JSON.parse(cut);
  assert.match(t.note, /showing the first \d+ of 400/);
  assert.ok(t.layers.every((l) => l.truncated && l.child_count === 1));
});
