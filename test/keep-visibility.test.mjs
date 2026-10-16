// Selecting or renaming a layer must not change what the document shows.
// Making a hidden layer active through the DOM makes it (and hidden groups
// above it) visible, so every path-based selection goes through psActivate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExtendScriptSnippets, layerPathResolver } from '../dist/api/extendscript.js';

const NASTY = 'HUD "main"/it\'s  end';
const parses = (name, script) =>
  assert.doesNotThrow(() => new Function(script), `${name} generated invalid ExtendScript`);

test('the path resolver carries the visibility-keeping helpers', () => {
  assert.match(layerPathResolver, /function psActivate\(doc, layer\)/);
  assert.match(layerPathResolver, /function psRename\(layer, name\)/);
});

test('psActivate restores the visibility of the layer and every ancestor', () => {
  // Run the helper against a fake DOM where activating reveals the chain.
  const fn = new Function(`${layerPathResolver}; return psActivate;`)();
  const doc = { typename: 'Document' };
  const group = { typename: 'LayerSet', visible: false, parent: doc };
  const layer = { typename: 'ArtLayer', visible: false, parent: group };
  Object.defineProperty(doc, 'activeLayer', {
    set(l) {
      for (let n = l; n.typename !== 'Document'; n = n.parent) n.visible = true;
      this._a = l;
    },
    get() {
      return this._a;
    },
  });
  fn(doc, layer);
  assert.equal(doc.activeLayer, layer);
  assert.equal(layer.visible, false);
  assert.equal(group.visible, false);
});

test('select_layer_by_path and rename_layer go through the helpers', () => {
  assert.match(ExtendScriptSnippets.selectLayerByPath('A/B'), /psActivate\(doc, layer\)/);
  const byPath = ExtendScriptSnippets.renameLayer(NASTY, NASTY);
  parses('rename by path', byPath);
  assert.match(byPath, /psResolveLayerPath/);
  assert.match(byPath, /psRename\(layer,/);
  const active = ExtendScriptSnippets.renameLayer(NASTY);
  parses('rename active', active);
  assert.match(active, /doc\.activeLayer;/);
});
