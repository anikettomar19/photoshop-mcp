// Generated script for open_smart_object. No Photoshop needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scriptOpenSmartObject } from '../dist/tools/smart-object-tools.js';
import { jsxString } from '../dist/utils/jsx.js';

const NASTY = 'Popup "a"/it\'s  b';

test('script parses for a path and for the active layer, and quotes the path', () => {
  const s = scriptOpenSmartObject(NASTY);
  assert.doesNotThrow(() => new Function(s));
  assert.ok(s.includes(jsxString(NASTY)));
  assert.doesNotThrow(() => new Function(scriptOpenSmartObject(undefined)));
});

test('uses Edit Contents, keeps visibility, and checks the layer kind first', () => {
  const s = scriptOpenSmartObject('A');
  assert.match(s, /placedLayerEditContents/);
  assert.match(s, /psActivate\(doc, layer\)/);
  assert.ok(s.indexOf('LayerKind.SMARTOBJECT') < s.indexOf('placedLayerEditContents'));
});
