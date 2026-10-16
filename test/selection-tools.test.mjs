// Scripts and argument checks behind the ellipse, layer-pixel and colour-range
// selection tools. No Photoshop needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  colorRangeArgs,
  ellipseArgs,
  scriptSelectColorRange,
  scriptSelectEllipse,
  scriptSelectLayerPixels,
  selectionMode,
} from '../dist/tools/selection-tools.js';
import { jsxString } from '../dist/utils/jsx.js';

const NASTY = 'HUD "main"/it\'s  end';
const MODES = ['REPLACE', 'ADD', 'SUBTRACT', 'INTERSECT'];
const parses = (name, script) =>
  assert.doesNotThrow(() => new Function(script), `${name} generated invalid ExtendScript`);

test('ellipse and layer-pixel scripts parse in every mode', () => {
  for (const mode of MODES) {
    parses(`ellipse ${mode}`, scriptSelectEllipse(ellipseArgs({ left: 0, top: 0, right: 10, bottom: 20, mode })));
    const s = scriptSelectLayerPixels(NASTY, mode);
    parses(`layer pixels ${mode}`, s);
    assert.ok(s.includes(jsxString(NASTY)));
  }
  parses('active layer', scriptSelectLayerPixels(undefined, 'REPLACE'));
});

test('shape layers load their vector mask, not their full-canvas transparency', () => {
  assert.match(scriptSelectLayerPixels('A', 'REPLACE'), /vectorMask/);
});

test('colour range parses and matches a small Lab box, not a single point', () => {
  const s = scriptSelectColorRange(colorRangeArgs({ color: '#E84A5F', fuzziness: 10 }));
  parses('colour range', s);
  assert.match(s, /lab\(-1\)/);
  assert.match(s, /lab\(1\)/);
  assert.match(s, /deselect/, 'replaces the selection by default');
  assert.doesNotMatch(scriptSelectColorRange(colorRangeArgs({ color: '#000000', within_selection: true })), /deselect/);
});

test('arguments are validated', () => {
  assert.throws(() => ellipseArgs({ left: 10, top: 0, right: 5, bottom: 9 }), /right must be greater/);
  assert.throws(() => ellipseArgs({ left: 0, top: 0, right: 5 }), /bottom/);
  assert.throws(() => selectionMode('XOR'), /invalid selection mode/);
  assert.equal(selectionMode('add'), 'ADD');
  assert.throws(() => colorRangeArgs({ color: 'red' }), /Invalid hex colour/);
  assert.throws(() => colorRangeArgs({ color: '#FF0000', fuzziness: 500 }), /fuzziness/);
});
