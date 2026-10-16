// Scripts and argument checks behind the layer-effect tools. No Photoshop needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EFFECT_SPECS, effectValues, effectScript } from '../dist/tools/layer-effects-tools.js';
import { scriptSetFillOpacity } from '../dist/tools/layer-properties-tools.js';

const parses = (name, script) =>
  assert.doesNotThrow(() => new Function(script), `${name} generated invalid ExtendScript`);
const spec = (tool) => EFFECT_SPECS.find((s) => s.tool === tool);

test('every effect parses with its defaults and with every enum value', () => {
  for (const s of EFFECT_SPECS) {
    parses(s.tool, effectScript(s, effectValues(s, {})));
    for (const [name, p] of Object.entries(s.params)) {
      if (p.kind !== 'enum') continue;
      for (const value of p.values) {
        parses(`${s.tool} ${name}=${value}`, effectScript(s, effectValues(s, { [name]: value })));
      }
    }
  }
});

test('each effect writes its own key and replaces only that effect', () => {
  const keys = EFFECT_SPECS.map((s) => s.key);
  assert.deepEqual(keys, ['solidFill', 'innerShadow', 'outerGlow', 'innerGlow', 'bevelEmboss', 'chromeFX']);
  const script = effectScript(spec('photoshop_add_color_overlay'), effectValues(spec('photoshop_add_color_overlay'), {}));
  assert.match(script, /fx\.putObject\(sTID\('solidFill'\)/);
  assert.match(script, /executeActionGet/, 'reads current effects first so the others are kept');
});

test('arguments are validated before anything reaches Photoshop', () => {
  const glow = spec('photoshop_add_outer_glow');
  assert.throws(() => effectValues(glow, { size: 999 }), /size must be between 0 and 250/);
  assert.throws(() => effectValues(glow, { size: '5; alert(1)' }), /expected a number/);
  assert.throws(() => effectValues(glow, { technique: 'FUZZY' }), /invalid technique/);
  assert.throws(() => effectValues(glow, { blend_mode: 'GLOW' }), /invalid blend mode/);
  assert.throws(() => effectValues(glow, { color: 'pink' }), /Invalid hex colour/);
  assert.throws(() => effectValues(spec('photoshop_add_bevel_emboss'), { depth: 0 }), /depth/);
  assert.equal(effectValues(spec('photoshop_add_satin'), { invert: false }).invert, false);
  assert.equal(effectValues(glow, { technique: 'precise' }).technique, 'PRECISE', 'enums are case-insensitive');
});

test('fill opacity script parses', () => {
  parses('fill opacity', scriptSetFillOpacity(35));
});
