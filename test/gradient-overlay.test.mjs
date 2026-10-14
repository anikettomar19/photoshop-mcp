// Pure helpers behind photoshop_add_gradient_overlay. No Photoshop needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseHexColor, normalizeGradientStops } from '../dist/tools/layer-effects-tools.js';

test('parseHexColor accepts #RRGGBB and RRGGBB', () => {
  assert.deepEqual(parseHexColor('#2BA89E'), { r: 43, g: 168, b: 158 });
  assert.deepEqual(parseHexColor('ffffff'), { r: 255, g: 255, b: 255 });
});

test('parseHexColor rejects malformed colours', () => {
  assert.throws(() => parseHexColor('#FFF'));
  assert.throws(() => parseHexColor('teal'));
});

test('normalizeGradientStops maps 0-100 to 0-4096 and sorts by location', () => {
  const out = normalizeGradientStops([
    { color: '#7FE3D8', location: 100 },
    { color: '#2BA89E', location: 0 },
    { color: '#4FC4BA', location: 50 },
  ]);
  assert.deepEqual(out.map((s) => s.location), [0, 2048, 4096]);
  assert.equal(out[0].r, 43);
});

test('normalizeGradientStops needs 2+ stops with 0-100 locations', () => {
  assert.throws(() => normalizeGradientStops([{ color: '#000000', location: 0 }]));
  assert.throws(() => normalizeGradientStops([{ color: '#000000', location: 0 }, { color: '#FFFFFF', location: 140 }]));
});
