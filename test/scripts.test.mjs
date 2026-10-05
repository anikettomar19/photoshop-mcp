// Every generated ExtendScript must at least parse. These run against the
// compiled output in dist/, so `npm test` builds first; no Photoshop needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExtendScriptSnippets } from '../dist/api/extendscript.js';
import { scriptReplaceSmartObject } from '../dist/tools/smart-object-tools.js';
import { jsxString, jsxEnum } from '../dist/utils/jsx.js';

// Quotes of both kinds, a backslash, a newline, a Windows path separator and
// U+2028 (a line terminator in ES3 but not in JSON).
const NASTY = 'Line 1\nLine "2" it\'s C:\\new\\file \u2028end';

// One argument list per snippet. A snippet missing from this table fails the
// coverage test below, so new snippets can't skip the syntax check.
const ARGS = {
  getAppInfo: [],
  newDocument: [100, 200, 72, 'NewDocumentMode.RGB'],
  getDocumentInfo: [],
  createTextLayer: [NASTY, 10, 20, 24],
  placeImage: [NASTY, 0, 0],
  openImage: [NASTY],
  saveAsPSD: [NASTY],
  saveAsJPEG: [NASTY, 8],
  saveAsPNG: [NASTY],
  closeDocument: [true],
  newLayer: [NASTY],
  deleteLayer: [],
  fillLayer: [255, 0, 0],
  resizeImage: [100, undefined, 'BICUBICSHARPER'],
  resizeCanvas: [undefined, 300, 'TOPLEFT'],
  getLayerNames: [],
  selectLayer: [NASTY],
  fitLayerToDocument: [true],
  scaleLayer: [50, true],
  moveLayer: [1, 2],
  rotateLayer: [45],
  setLayerOpacity: [50],
  setLayerBlendMode: ['MULTIPLY'],
  setLayerVisibility: [false, NASTY],
  setLayerLocked: [true],
  renameLayer: [NASTY],
  duplicateLayer: [NASTY],
  mergeVisibleLayers: [],
  flattenImage: [],
  applyGaussianBlur: [2],
  applyUnsharpMask: [50, 1, 0],
  applyAddNoise: [10, 'GAUSSIAN', true],
  applyMotionBlur: [0, 10],
  adjustBrightnessContrast: [10, 10],
  adjustHueSaturation: [10, -20, 5],
  autoLevels: [],
  autoContrast: [],
  desaturate: [],
  invert: [],
  cropDocument: [0, 0, 10, 10],
  setTextFont: [NASTY, 12],
  setTextColor: [1, 2, 3],
  setTextAlignment: ['CENTER'],
  updateTextContent: [NASTY],
  selectRectangle: [0, 0, 10, 10],
  selectAll: [],
  deselect: [],
  invertSelection: [],
  createLayerMask: [],
  deleteLayerMask: [],
  applyLayerMask: [],
  playAction: [NASTY, NASTY],
  executeCustomScript: ['var a = 1;\na'],
  rasterizeLayer: [],
  undo: [2],
  redo: [2],
  getHistoryStates: [],
  moveLayerToPosition: [NASTY, 'ABOVE'],
  moveLayerToTop: [],
  moveLayerToBottom: [],
  moveLayerUp: [],
  getLayerTree: [NASTY, 2],
  selectLayerByPath: [NASTY],
  createLayerGroup: [NASTY],
  getLayerRT: [NASTY, 1],
  moveLayerDown: [],
};

function assertParses(name, script) {
  assert.doesNotThrow(() => new Function(script), `${name} generated invalid ExtendScript`);
}

test('every snippet has test arguments', () => {
  assert.deepEqual(Object.keys(ExtendScriptSnippets).sort(), Object.keys(ARGS).sort());
});

for (const [name, args] of Object.entries(ARGS)) {
  test(`${name} generates parseable script`, () => {
    const script = ExtendScriptSnippets[name](...args);
    assertParses(name, script);
    if (args.includes(NASTY)) {
      assert.ok(script.includes(jsxString(NASTY)), `${name} did not quote its string argument`);
    }
  });
}

test('getLayerTree and setLayerVisibility parse without a path', () => {
  assertParses('getLayerTree', ExtendScriptSnippets.getLayerTree());
  assertParses('setLayerVisibility', ExtendScriptSnippets.setLayerVisibility(true));
});

test('scriptReplaceSmartObject parses with awkward paths', () => {
  assertParses('scriptReplaceSmartObject', scriptReplaceSmartObject(NASTY, NASTY, true, false));
});

test('jsxString round-trips through the JS parser', () => {
  assert.equal(new Function(`return ${jsxString(NASTY)};`)(), NASTY);
  assert.ok(!jsxString(NASTY).includes('\u2028'));
});

test('identifier arguments are validated, not spliced', () => {
  assert.throws(() => ExtendScriptSnippets.setLayerBlendMode('NORMAL; alert(1)'), /invalid blend mode/);
  assert.throws(() => ExtendScriptSnippets.setTextAlignment('MIDDLE'), /invalid text alignment/);
  assert.throws(() => ExtendScriptSnippets.applyAddNoise(1, 'PERLIN', false), /invalid noise distribution/);
  assert.throws(() => ExtendScriptSnippets.resizeImage(10, 10, 'LANCZOS'), /invalid resample method/);
  assert.throws(() => ExtendScriptSnippets.resizeCanvas(10, 10, 'CENTER'), /invalid anchor/);
  assert.equal(jsxEnum('A', ['A', 'B'], 'x'), 'A');
});
