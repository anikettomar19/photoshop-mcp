// Scripts and argument checks behind the adjustment-layer, fill-layer, curves
// and clipping tools. No Photoshop needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  adjustmentArgs,
  fillArgs,
  normalizeCurvePoints,
  scriptAddAdjustmentLayer,
  scriptAddFillLayer,
  scriptApplyCurves,
  scriptSetClippingMask,
} from '../dist/tools/nondestructive-tools.js';
import { jsxString } from '../dist/utils/jsx.js';

const NASTY = 'Grade "warm"\nit\'s  end';
const parses = (name, script) =>
  assert.doesNotThrow(() => new Function(script), `${name} generated invalid ExtendScript`);

test('every adjustment type parses, clipped and named', () => {
  for (const type of ['BRIGHTNESS_CONTRAST', 'LEVELS', 'CURVES', 'HUE_SATURATION', 'VIBRANCE', 'BLACK_AND_WHITE', 'INVERT']) {
    const script = scriptAddAdjustmentLayer(adjustmentArgs({ type, clip: true, name: NASTY }));
    parses(type, script);
    assert.ok(script.includes(jsxString(NASTY)));
    assert.match(script, /Grup'\), true/);
  }
});

test('hue/saturation edits the master range, never a single colour', () => {
  const script = scriptAddAdjustmentLayer(adjustmentArgs({ type: 'HUE_SATURATION', hue: 40 }));
  assert.doesNotMatch(script, /LclR/);
});

test('colorize takes an absolute hue 0-360 and saturation 0-100', () => {
  assert.equal(adjustmentArgs({ type: 'HUE_SATURATION', colorize: true, hue: 300 }).values.hue, 300);
  assert.throws(() => adjustmentArgs({ type: 'HUE_SATURATION', hue: 300 }), /hue must be between -180 and 180/);
  assert.throws(() => adjustmentArgs({ type: 'HUE_SATURATION', colorize: true, saturation: -10 }), /saturation/);
});

test('adjustment arguments are range-checked', () => {
  assert.throws(() => adjustmentArgs({ type: 'POSTERIZE' }), /invalid adjustment type/);
  assert.throws(() => adjustmentArgs({ type: 'BRIGHTNESS_CONTRAST', brightness: 500 }), /brightness/);
  assert.throws(() => adjustmentArgs({ type: 'LEVELS', input_black: 200, input_white: 201 }), /input_white/);
  assert.throws(() => adjustmentArgs({ type: 'LEVELS', gamma: '1; alert(1)' }), /expected a number/);
});

test('curve points are validated and sorted', () => {
  assert.deepEqual(normalizeCurvePoints([[255, 0], [0, 255], [128, 100.4]]), [[0, 255], [128, 100], [255, 0]]);
  assert.throws(() => normalizeCurvePoints([[0, 0]]), /at least 2/);
  assert.throws(() => normalizeCurvePoints([[0, 0], [0, 9]]), /share input 0/);
  assert.throws(() => normalizeCurvePoints([[0, 0], [300, 9]]), /0-255/);
  assert.throws(() => normalizeCurvePoints([[0, 0], [1]]), /\[input, output\]/);
  parses('apply curves', scriptApplyCurves(normalizeCurvePoints([[0, 0], [255, 255]])));
});

test('fill layers parse for solid and every gradient style', () => {
  parses('solid', scriptAddFillLayer(fillArgs({ color: '#FFB400', clip: true, name: NASTY })));
  const stops = [{ color: '#FFFFFF', location: 0 }, { color: '#000000', location: 100 }];
  for (const gradient_type of ['LINEAR', 'RADIAL', 'ANGLE', 'REFLECTED', 'DIAMOND']) {
    parses(gradient_type, scriptAddFillLayer(fillArgs({ type: 'GRADIENT', stops, gradient_type })));
  }
  assert.throws(() => fillArgs({ type: 'GRADIENT' }), /stops/);
  assert.throws(() => fillArgs({ type: 'PATTERN' }), /invalid fill type/);
});

test('clipping mask scripts parse both ways', () => {
  parses('clip', scriptSetClippingMask(true));
  parses('release', scriptSetClippingMask(false));
});
