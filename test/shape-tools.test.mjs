// Scripts and argument checks behind the shape tools. No Photoshop needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shapeArgs,
  strokeArgs,
  scriptCreateShape,
  scriptSetShapeFill,
  scriptSetShapeStroke,
} from '../dist/tools/shape-tools.js';
import { jsxString } from '../dist/utils/jsx.js';

const NASTY = 'Btn "Play"\nit\'s C:\\ui \u2028end';
const parses = (name, script) =>
  assert.doesNotThrow(() => new Function(script), `${name} generated invalid ExtendScript`);

test('create_shape scripts parse for every shape type and quote the name', () => {
  for (const type of ['RECTANGLE', 'ROUNDED_RECTANGLE', 'ELLIPSE']) {
    const script = scriptCreateShape(
      shapeArgs({ type, left: 1, top: 2, width: 30, height: 40, name: NASTY })
    );
    parses(type, script);
    assert.ok(script.includes(jsxString(NASTY)));
  }
});

test('only a rounded rectangle gets a corner radius, clamped to half the short side', () => {
  const pill = shapeArgs({ type: 'rounded_rectangle', left: 0, top: 0, width: 280, height: 140, corner_radius: 500 });
  assert.equal(pill.radius, 70);
  assert.match(scriptCreateShape(pill), /Rds /);
  assert.doesNotMatch(scriptCreateShape(shapeArgs({ left: 0, top: 0, width: 9, height: 9 })), /Rds /);
});

test('create_shape rejects what cannot be drawn', () => {
  const base = { left: 0, top: 0, width: 10, height: 10 };
  assert.throws(() => shapeArgs({ ...base, width: 0 }), /greater than 0/);
  assert.throws(() => shapeArgs({ ...base, type: 'STAR' }), /invalid shape type/);
  assert.throws(() => shapeArgs({ ...base, color: 'red' }), /Invalid hex colour/);
  assert.throws(() => shapeArgs({ ...base, corner_radius: -1 }), /corner_radius/);
  assert.throws(() => shapeArgs({ top: 0, width: 10, height: 10 }), /left/);
});

test('fill and stroke scripts parse, including stroke removal', () => {
  parses('fill', scriptSetShapeFill({ r: 1, g: 2, b: 3 }));
  for (const alignment of ['INSIDE', 'CENTER', 'OUTSIDE']) {
    parses(alignment, scriptSetShapeStroke(strokeArgs({ alignment, width: 3, color: '#FFFFFF' })));
  }
  const off = scriptSetShapeStroke(strokeArgs({ enabled: false }));
  parses('stroke off', off);
  assert.match(off, /strokeEnabled'\), false/);
  assert.throws(() => strokeArgs({ alignment: 'MIDDLE' }), /invalid stroke alignment/);
});
