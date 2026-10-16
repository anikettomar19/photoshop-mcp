// Arguments and generated script for batch visibility and the new export
// options. No Photoshop needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibilityArgs } from '../dist/tools/layer-properties-tools.js';
import { exportOptions, exportFinishJs } from '../dist/tools/utility-tools.js';
import { ExtendScriptSnippets } from '../dist/api/extendscript.js';

const parses = (name, script) =>
  assert.doesNotThrow(() => new Function(script), `${name} generated invalid ExtendScript`);

test('visibility arguments', () => {
  assert.deepEqual(visibilityArgs({ visible: false, path: 'A' }).paths, []);
  assert.deepEqual(visibilityArgs({ visible: true, paths: ['A', 'B/C'] }).paths, ['A', 'B/C']);
  assert.throws(() => visibilityArgs({ path: 'A' }), /"visible"/);
  assert.throws(() => visibilityArgs({ visible: true, paths: 'A' }), /array/);
  assert.throws(() => visibilityArgs({ visible: true, name_pattern: '(' }), /not a valid regex/);
  assert.throws(
    () => visibilityArgs({ visible: true, under: 'G' }),
    /only applies together with name_pattern/
  );
  assert.equal(visibilityArgs({ visible: true, path: 'A', with_parents: true }).withParents, true);
});

test('batch visibility script parses, quotes paths and resolves before changing', () => {
  const odd = 'HUD "x"/Line Sep';
  const s = ExtendScriptSnippets.setLayersVisibility(true, [odd, 'B'], '^OLD ', 'UI', true);
  parses('batch', s);
  assert.ok(!s.includes(' '), 'U+2028 escaped');
  assert.ok(
    s.indexOf('Nothing was changed') < s.indexOf('__psVisApply = function'),
    'all paths resolved first'
  );
  parses(
    'paths only',
    ExtendScriptSnippets.setLayersVisibility(false, ['A'], undefined, undefined, false)
  );
});

test('export options are validated', () => {
  assert.deepEqual(exportOptions({}), {
    padding: 0,
    scale: 100,
    background: undefined,
    clipToCanvas: true,
  });
  const o = exportOptions({ padding: 8, scale: 200, background: '#00FF00', clip_to_canvas: false });
  assert.deepEqual(o, {
    padding: 8,
    scale: 200,
    background: { r: 0, g: 255, b: 0 },
    clipToCanvas: false,
  });
  assert.throws(() => exportOptions({ padding: -1 }), /padding/);
  assert.throws(() => exportOptions({ padding: 2.5 }), /whole number/);
  assert.throws(() => exportOptions({ scale: 0 }), /scale/);
  assert.throws(() => exportOptions({ background: 'red' }), /Invalid hex colour/);
});

test('finish steps run in order: trim, scale with styles, pad, background', () => {
  const js = exportFinishJs(true, exportOptions({ padding: 8, scale: 200, background: '#FFFFFF' }));
  parses('finish', `var newDoc; ${js}`);
  const order = ['trim(', "stringIDToTypeID('scaleStyles'), true", 'resizeCanvas(', 'bgLayer'].map(
    (k) => js.indexOf(k)
  );
  assert.ok(
    order.every((v) => v >= 0),
    'every step present'
  );
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
    'in order'
  );
  assert.equal(
    exportFinishJs(false, exportOptions({})),
    '',
    'nothing to do by default without trim'
  );
});
