// Arguments and generated script for find_layers. No Photoshop needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findLayersArgs } from '../dist/tools/layer-tools.js';
import { ExtendScriptSnippets } from '../dist/api/extendscript.js';

const parses = (s) => assert.doesNotThrow(() => new Function(s));

test('defaults and validation', () => {
  const d = findLayersArgs({});
  assert.equal(d.limit, 100);
  assert.equal(d.caseSensitive, false);
  assert.deepEqual(d.kinds, []);
  assert.deepEqual(findLayersArgs({ kinds: ['text', 'GROUP'] }).kinds, ['TEXT', 'GROUP']);
  assert.throws(() => findLayersArgs({ name_pattern: '(' }), /not a valid regex/);
  assert.throws(() => findLayersArgs({ kinds: ['SHAPE'] }), /invalid kind/);
  assert.throws(() => findLayersArgs({ limit: 0 }), /limit/);
  assert.throws(() => findLayersArgs({ limit: 5000 }), /limit/);
  assert.throws(
    () => findLayersArgs({ intersects: { left: 10, top: 0, right: 5, bottom: 9 } }),
    /intersects/
  );
});

test('script parses with every filter and quotes the pattern and group', () => {
  const odd = 'A "b" c';
  const s = ExtendScriptSnippets.findLayers(
    findLayersArgs({
      name_pattern: odd,
      under: odd,
      kinds: ['TEXT'],
      visible_only: true,
      intersects: { left: 0, top: 0, right: 9, bottom: 9 },
      limit: 3,
    })
  );
  parses(s);
  assert.ok(!s.includes(' '));
  assert.match(s, /new RegExp\(.*, 'i'\)/);
  parses(ExtendScriptSnippets.findLayers(findLayersArgs({})));
});

test('details are read only after the name filter', () => {
  const s = ExtendScriptSnippets.findLayers(findLayersArgs({ name_pattern: 'x' }));
  assert.ok(s.indexOf('re.test(n.name)') < s.indexOf("getProp(n.index, 'layerKind')"));
});
