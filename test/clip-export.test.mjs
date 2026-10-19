// The clipping-mask export's layer isolation, run against a stand-in layer
// tree. No Photoshop needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clipExportJs } from '../dist/tools/utility-tools.js';

const { psLayerIndexPath, psIsolateForClipExport } = new Function(
  `${clipExportJs}; return { psLayerIndexPath, psIsolateForClipExport };`
)();

function art(name, opts = {}) {
  return { name, typename: 'ArtLayer', visible: opts.visible ?? true, grouped: !!opts.grouped };
}
function group(name, layers, opts = {}) {
  // A group's "grouped" reads as undefined in Photoshop's DOM.
  const g = { name, typename: 'LayerSet', visible: opts.visible ?? true, layers };
  for (const l of layers) l.parent = g;
  return g;
}
function doc(layers) {
  const d = { typename: 'Document', layers };
  for (const l of layers) l.parent = d;
  return d;
}
const vis = (layers) =>
  Object.fromEntries(
    layers.flatMap((l) => [[l.name, l.visible], ...(l.layers ? Object.entries(vis(l.layers)) : [])])
  );

test('a layer clipped onto a group keeps the group contents as the document shows them', () => {
  const d = doc([
    art('Top', { grouped: true }),
    group('Base', [art('Fill'), art('Guide', { visible: false })]),
    art('Background'),
  ]);
  const r = psIsolateForClipExport(d, psLayerIndexPath(d.layers[0]));
  assert.equal(r.layer.name, 'Top');
  assert.equal(r.clipBase.name, 'Base');
  assert.deepEqual(vis(d.layers), {
    Top: true,
    Base: true,
    Fill: true,
    Guide: false,
    Background: false,
  });
});

test('nested target: siblings on the path are hidden, other clipped layers in the stack too', () => {
  const target = art('Shine', { grouped: true });
  const d = doc([
    art('Overlay'),
    group(
      'Card',
      [
        art('Other', { grouped: true }),
        target,
        art('Tint', { grouped: true }),
        art('Shape'),
        art('Shadow'),
      ],
      { visible: false }
    ),
    art('Background'),
  ]);
  assert.equal(psLayerIndexPath(target), '1,1');
  const r = psIsolateForClipExport(d, '1,1');
  assert.equal(r.layer, target);
  assert.equal(r.clipBase.name, 'Shape');
  assert.deepEqual(vis(d.layers), {
    Overlay: false,
    Card: true,
    Other: false,
    Shine: true,
    Tint: false,
    Shape: true,
    Shadow: false,
    Background: false,
  });
});

test('same-named layers are told apart by position', () => {
  const second = art('Icon', { grouped: true });
  const d = doc([
    group('A', [art('Icon', { grouped: true }), art('Base1')]),
    group('B', [second, art('Base2')]),
  ]);
  assert.equal(psLayerIndexPath(second), '1,0');
  assert.equal(psIsolateForClipExport(d, '1,0').layer, second);
});
