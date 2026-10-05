import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activateDocumentScript, withDocumentTarget } from '../dist/core/document-target.js';

const def = (name, properties = {}) => ({
  tool: { name, description: '', inputSchema: { type: 'object', properties } },
  handler: async (args) => ({ content: [{ type: 'text', text: JSON.stringify(args) }] }),
});

test('live tools get an optional document argument', () => {
  const wrapped = withDocumentTarget(
    def('photoshop_get_layer_tree', { path: { type: 'string' } }),
    {}
  );
  assert.equal(wrapped.tool.inputSchema.properties.document.type, 'string');
  assert.ok(wrapped.tool.inputSchema.properties.path, 'existing arguments are kept');
  assert.equal(wrapped.tool.inputSchema.required, undefined, 'document is optional');
});

test('tools that create or pick documents themselves are left alone', () => {
  for (const name of [
    'photoshop_open_image',
    'photoshop_set_active_document',
    'photoshop_batch_export_layers',
  ]) {
    const d = def(name);
    assert.equal(withDocumentTarget(d, {}), d, name);
  }
});

test('without document, the handler gets the same arguments and nothing is activated', async () => {
  const wrapped = withDocumentTarget(def('photoshop_get_layer_tree'), {});
  const r = await wrapped.handler({ path: 'A' });
  assert.deepEqual(JSON.parse(r.content[0].text), { path: 'A' });
});

test('the activation script parses with awkward document names', () => {
  assert.doesNotThrow(() => new Function(activateDocumentScript('Clan "League"\nMain\\Page.psd')));
});
