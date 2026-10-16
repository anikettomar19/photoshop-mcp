// Scripts and argument checks behind set_text_spacing and create_paragraph_text.
// No Photoshop needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  paragraphArgs,
  scriptCreateParagraphText,
  scriptSetTextSpacing,
  spacingArgs,
} from '../dist/tools/text-tools.js';
import { jsxString } from '../dist/utils/jsx.js';

const NASTY = 'Tap "Claim"\nit\'s C:\\x \u2028end';
const parses = (name, script) =>
  assert.doesNotThrow(() => new Function(script), `${name} generated invalid ExtendScript`);
const box = { left: 0, top: 0, width: 100, height: 50 };

test('paragraph text parses, quotes text, font and name, and turns \\n into paragraphs', () => {
  const s = scriptCreateParagraphText(paragraphArgs({ ...box, text: NASTY, font: NASTY, name: NASTY, alignment: 'center' }));
  parses('paragraph', s);
  assert.ok(s.includes(jsxString(NASTY.replace(/\n/g, '\r'))));
  assert.ok(s.includes(jsxString(NASTY)), 'font and name are quoted');
});

test('sizes are converted from px to points, and units are restored', () => {
  const s = scriptCreateParagraphText(paragraphArgs({ ...box, text: 'x', font_size: 24 }));
  assert.match(s, /PT = 72 \/ app\.activeDocument\.resolution/);
  assert.match(s, /t\.size = 24 \* PT/);
  assert.match(s, /finally[\s\S]*savedType/);
});

test('spacing scripts parse for each combination', () => {
  parses('tracking', scriptSetTextSpacing(spacingArgs({ tracking: -20 })));
  parses('leading', scriptSetTextSpacing(spacingArgs({ leading: 30 })));
  parses('auto', scriptSetTextSpacing(spacingArgs({ auto_leading: true, tracking: 5 })));
  parses('manual off', scriptSetTextSpacing(spacingArgs({ auto_leading: false })));
});

test('arguments are validated', () => {
  assert.throws(() => spacingArgs({}), /at least one/);
  assert.throws(() => spacingArgs({ leading: 30, auto_leading: true }), /not both/);
  assert.throws(() => spacingArgs({ tracking: 99999 }), /tracking/);
  assert.throws(() => spacingArgs({ leading: 0 }), /leading/);
  assert.throws(() => spacingArgs({ tracking: '5; alert(1)' }), /expected a number/);
  assert.throws(() => paragraphArgs({ ...box, text: 'x', width: 0 }), /greater than 0/);
  assert.throws(() => paragraphArgs({ ...box, text: 'x', alignment: 'MIDDLE' }), /invalid text alignment/);
  assert.throws(() => paragraphArgs({ ...box, text: 'x', color: 'teal' }), /Invalid hex colour/);
  assert.throws(() => paragraphArgs({ left: 0, top: 0, width: 9, height: 9 }), /text/);
});
