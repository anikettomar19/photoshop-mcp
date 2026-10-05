// Argument normalization against the real tool schemas. Cases are taken from
// calls that failed in real Claude sessions. No Photoshop needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'fs';
import { normalizeArgs, assertRequiredArgs } from '../dist/utils/normalize-args.js';

const schemas = {};
for (const f of readdirSync(new URL('../dist/tools/', import.meta.url)).filter((f) => f.endsWith('-tools.js'))) {
  const mod = await import(`../dist/tools/${f}`);
  for (const [name, factory] of Object.entries(mod)) {
    if (!/^create\w+Tools$/.test(name)) continue;
    // Factories only store the connection; a stub keeps this runnable on Linux CI.
    for (const t of factory({})) schemas[t.tool.name] = t.tool.inputSchema;
  }
}

const norm = (tool, input) => {
  const { args } = normalizeArgs(tool, schemas[tool], input);
  assertRequiredArgs(tool, schemas[tool], args);
  return args;
};

test('spelling variants map to the schema name', () => {
  assert.deepEqual(norm('photoshop_get_layer_tree', { maxDepth: 2 }), { max_depth: 2 });
  assert.deepEqual(norm('photoshop_get_psd_layer_tree', { psdPath: '/a.psd', group_path: 'G' }), {
    psd_path: '/a.psd',
    group_path: 'G',
  });
});

test('synonyms map when the tool has exactly one matching argument', () => {
  assert.deepEqual(norm('photoshop_execute_script', { script: 'app.name;' }), { code: 'app.name;' });
  assert.deepEqual(norm('photoshop_open_image', { filepath: '/a.psd' }), { filePath: '/a.psd' });
  assert.deepEqual(norm('photoshop_open_image', { image_path: '/a.psd' }), { filePath: '/a.psd' });
  assert.deepEqual(norm('photoshop_open_image', { path: '/a.psd' }), { filePath: '/a.psd' });
  assert.deepEqual(norm('photoshop_select_layer_by_path', { layerPath: 'Header' }), { path: 'Header' });
  assert.deepEqual(norm('photoshop_set_active_document', { document_name: 'A.psd' }), { name: 'A.psd' });
});

test('an ambiguous synonym is left alone rather than guessed', () => {
  // extract_psd_layer has both psd_path and layer_path; "path" could be either.
  const { args } = normalizeArgs('photoshop_extract_psd_layer', schemas.photoshop_extract_psd_layer, {
    path: 'x',
    psd_path: '/a.psd',
    layer_path: 'L',
  });
  assert.deepEqual(args, { psd_path: '/a.psd', layer_path: 'L', path: 'x' });
});

test('a correctly named argument wins over an alias for it', () => {
  assert.deepEqual(norm('photoshop_execute_script', { code: 'a;', script: 'b;' }), { code: 'a;', script: 'b;' });
});

test('numbers and booleans sent as strings are coerced to the schema type', () => {
  assert.deepEqual(norm('photoshop_get_layer_tree', { max_depth: '2' }), { max_depth: 2 });
  assert.deepEqual(norm('photoshop_set_layer_visibility', { visible: 'false' }), { visible: false });
  // Not numeric: left as is for the handler to reject.
  assert.deepEqual(norm('photoshop_get_layer_tree', { max_depth: 'deep' }), { max_depth: 'deep' });
  // Strings stay strings even when they look numeric.
  assert.deepEqual(norm('photoshop_set_active_document', { name: '1' }), { name: '1' });
});

test('a missing required argument lists what the tool accepts', () => {
  assert.throws(() => norm('photoshop_open_image', {}), /missing required argument "filePath".*Accepted arguments.*filePath\*/);
});
