// Scripts and argument checks behind the group, flip, align, distribute,
// smart-object and trim tools. No Photoshop needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  alignArgs,
  distributeArgs,
  scriptAlignLayers,
  scriptConvertToSmartObject,
  scriptDistributeLayers,
  scriptFlipLayer,
  scriptMoveIntoGroup,
  scriptTrimDocument,
  scriptUngroup,
} from '../dist/tools/layer-organize-tools.js';
import { jsxString } from '../dist/utils/jsx.js';

const NASTY = 'HUD "main"/it\'s  end';
const parses = (name, script) =>
  assert.doesNotThrow(() => new Function(script), `${name} generated invalid ExtendScript`);

test('group scripts parse with awkward paths, for every placement', () => {
  for (const pos of ['TOP', 'BOTTOM']) {
    const s = scriptMoveIntoGroup(NASTY, NASTY, pos);
    parses(`into ${pos}`, s);
    assert.ok(s.includes(jsxString(NASTY)));
  }
  parses('move out', scriptMoveIntoGroup(undefined, '', 'TOP'));
  parses('ungroup', scriptUngroup(NASTY));
  parses('ungroup active', scriptUngroup(undefined));
});

test('flip, smart object and trim scripts parse', () => {
  parses('flip h', scriptFlipLayer('HORIZONTAL', NASTY));
  parses('flip v', scriptFlipLayer('VERTICAL', undefined));
  parses('smart object', scriptConvertToSmartObject(NASTY));
  for (const b of ['TRANSPARENT', 'TOP_LEFT_COLOR', 'BOTTOM_RIGHT_COLOR']) parses(b, scriptTrimDocument(b));
});

test('align parses for every edge and target', () => {
  for (const edge of ['LEFT', 'HCENTER', 'RIGHT', 'TOP', 'VCENTER', 'BOTTOM']) {
    for (const relative_to of ['LAYERS', 'CANVAS']) {
      parses(`${edge}/${relative_to}`, scriptAlignLayers(alignArgs({ layers: [NASTY, 'B'], edge, relative_to })));
    }
  }
});

test('align needs 2 layers for LAYERS, 1 for CANVAS, no duplicates', () => {
  assert.throws(() => alignArgs({ layers: ['A'], edge: 'LEFT' }), /at least 2/);
  assert.equal(alignArgs({ layers: ['A'], edge: 'left', relative_to: 'canvas' }).layers.length, 1);
  assert.throws(() => alignArgs({ layers: ['A', 'A'], edge: 'LEFT' }), /same path twice/);
  assert.throws(() => alignArgs({ layers: ['A', 'B'], edge: 'MIDDLE' }), /invalid edge/);
  assert.throws(() => alignArgs({ layers: 'A', edge: 'LEFT' }), /array/);
});

test('distribute needs 3 layers for even spacing, 2 with a fixed gap', () => {
  assert.throws(() => distributeArgs({ layers: ['A', 'B'], axis: 'HORIZONTAL' }), /at least 3/);
  assert.equal(distributeArgs({ layers: ['A', 'B'], axis: 'vertical', gap: 8 }).gap, 8);
  assert.throws(() => distributeArgs({ layers: ['A', 'B'], axis: 'VERTICAL', gap: '8; x' }), /expected a number/);
  for (const axis of ['HORIZONTAL', 'VERTICAL']) {
    parses(`${axis} even`, scriptDistributeLayers(distributeArgs({ layers: ['A', 'B', NASTY], axis })));
    parses(`${axis} gap`, scriptDistributeLayers(distributeArgs({ layers: ['A', 'B'], axis, gap: 12 })));
  }
});
