// Arguments and generated script for export_composite. No Photoshop needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compositeArgs, scriptExportComposite } from '../dist/tools/utility-tools.js';

const parses = (s) => assert.doesNotThrow(() => new Function(s));

test('arguments are validated', () => {
  const a = compositeArgs({ output_path: '/tmp/x.png' });
  assert.deepEqual([a.onlyLayers, a.hideLayers, a.trim], [[], [], false]);
  assert.throws(() => compositeArgs({}), /output_path/);
  assert.throws(() => compositeArgs({ output_path: '/x.png', only_layers: 'A' }), /array/);
  assert.throws(
    () =>
      compositeArgs({ output_path: '/x.png', region: { left: 9, top: 0, right: 1, bottom: 5 } }),
    /region/
  );
  assert.throws(() => compositeArgs({ output_path: '/x.png', max_width: 0 }), /max_width/);
  assert.throws(() => compositeArgs({ output_path: '/x.png', canvas_width: 2.5 }), /canvas_width/);
  assert.throws(
    () => compositeArgs({ output_path: '/x.png', background: 'pink' }),
    /Invalid hex colour/
  );
});

test('script parses with every option and quotes paths', () => {
  const odd = 'HUD "a"/b c';
  const s = scriptExportComposite(
    compositeArgs({
      output_path: '/tmp/o "q".png',
      only_layers: [odd],
      hide_layers: ['X'],
      region: { left: 0, top: 0, right: 10, bottom: 10 },
      trim: true,
      max_width: 32,
      max_height: 40,
      scale: 50,
      canvas_width: 64,
      canvas_height: 64,
      padding: 2,
      background: '#FF00FF',
    }),
    'tmp'
  );
  parses(`var newDoc; ${s}`);
  assert.ok(!s.includes(' '));
  parses(scriptExportComposite(compositeArgs({ output_path: '/tmp/x.png' }), 'tmp'));
});

test('works on a duplicate, with batch hide/show, and finishes in order', () => {
  const s = scriptExportComposite(
    compositeArgs({
      output_path: '/x.png',
      only_layers: ['A'],
      trim: true,
      max_width: 10,
      canvas_width: 20,
      padding: 1,
      background: '#000000',
    }),
    'tmp'
  );
  assert.match(s, /origDoc\.duplicate\(/);
  assert.match(s, /cTID\('Hd  '\)|batch\(toHide, 'Hd  '\)/);
  const order = [
    'newDoc.trim(',
    "'scaleStyles'",
    'resizeCanvas(UnitValue(20',
    'resizeCanvas(UnitValue(newDoc.width',
    'bgLayer',
  ].map((k) => s.indexOf(k));
  assert.ok(
    order.every((v) => v >= 0),
    JSON.stringify(order)
  );
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order
  );
  assert.ok(
    s.indexOf('saveAs(') < s.indexOf('newDoc.close('),
    'saved before the duplicate is closed'
  );
});
