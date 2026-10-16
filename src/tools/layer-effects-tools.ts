import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { PhotoshopConnection } from '../platform/connection.js';
import { PhotoshopAPIFactory } from '../api/photoshop-api.js';
import { jsxEnum, jsxString } from '../utils/jsx.js';
import { optionalNumber } from '../utils/args.js';

export function createLayerEffectsTools(connection: PhotoshopConnection): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'photoshop_get_layer_effects',
        description:
          'Read all layer effects (drop shadow, stroke, inner glow, outer glow, color overlay) ' +
          "from the currently active layer using the Action Manager API. Returns each effect's " +
          'enabled state, color (RGB), opacity, size, and other parameters. Works on any layer type.',
        inputSchema: { type: 'object', properties: {} },
      },
      handler: async () => getLayerEffects(connection),
    },
    {
      tool: {
        name: 'photoshop_add_drop_shadow',
        description:
          'Add or replace the drop shadow effect on the active layer. ' +
          'Set angle (0-360°), distance (px), size (px / softness), opacity (0-100), ' +
          'spread (0-100), and color (RGB). Does not rasterize the layer.',
        inputSchema: {
          type: 'object',
          properties: {
            color_r: {
              type: 'number',
              description: 'Shadow color R (0-255)',
              minimum: 0,
              maximum: 255,
              default: 0,
            },
            color_g: {
              type: 'number',
              description: 'Shadow color G (0-255)',
              minimum: 0,
              maximum: 255,
              default: 0,
            },
            color_b: {
              type: 'number',
              description: 'Shadow color B (0-255)',
              minimum: 0,
              maximum: 255,
              default: 0,
            },
            opacity: {
              type: 'number',
              description: 'Opacity % (0-100, default 75)',
              minimum: 0,
              maximum: 100,
              default: 75,
            },
            angle: {
              type: 'number',
              description: 'Light angle in degrees (default 120)',
              default: 120,
            },
            distance: {
              type: 'number',
              description: 'Shadow distance in pixels (default 5)',
              default: 5,
            },
            size: {
              type: 'number',
              description: 'Shadow size/softness in pixels (default 5)',
              default: 5,
            },
            spread: {
              type: 'number',
              description: 'Shadow spread % (0-100, default 0)',
              minimum: 0,
              maximum: 100,
              default: 0,
            },
          },
        },
      },
      handler: async (args) => addDropShadow(connection, args),
    },
    {
      tool: {
        name: 'photoshop_add_stroke_effect',
        description:
          'Add or replace the stroke (outline) effect on the active layer. ' +
          'Specify size (px), position (INSIDE/OUTSIDE/CENTER), opacity (0-100), and color (RGB).',
        inputSchema: {
          type: 'object',
          properties: {
            size: { type: 'number', description: 'Stroke width in pixels (default 3)', default: 3 },
            position: {
              type: 'string',
              enum: ['OUTSIDE', 'INSIDE', 'CENTER'],
              description: 'Stroke position relative to layer edge (default OUTSIDE)',
              default: 'OUTSIDE',
            },
            color_r: {
              type: 'number',
              description: 'Stroke color R (0-255)',
              minimum: 0,
              maximum: 255,
              default: 0,
            },
            color_g: {
              type: 'number',
              description: 'Stroke color G (0-255)',
              minimum: 0,
              maximum: 255,
              default: 0,
            },
            color_b: {
              type: 'number',
              description: 'Stroke color B (0-255)',
              minimum: 0,
              maximum: 255,
              default: 0,
            },
            opacity: {
              type: 'number',
              description: 'Opacity % (0-100, default 100)',
              minimum: 0,
              maximum: 100,
              default: 100,
            },
          },
        },
      },
      handler: async (args) => addStrokeEffect(connection, args),
    },
    {
      tool: {
        name: 'photoshop_add_gradient_overlay',
        description:
          'Add or replace the gradient overlay effect on the active layer (works on shape layers, ' +
          'so the fill stays editable). Give 2+ colour stops as hex with a location 0-100, an angle ' +
          '(90 = bottom-to-top), a type (LINEAR/RADIAL/ANGLE/REFLECTED/DIAMOND), opacity and scale. ' +
          'Does not rasterize the layer.',
        inputSchema: {
          type: 'object',
          properties: {
            stops: {
              type: 'array',
              description:
                'Colour stops, e.g. [{"color":"#2BA89E","location":0},{"color":"#7FE3D8","location":100}]',
              minItems: 2,
              items: {
                type: 'object',
                properties: {
                  color: { type: 'string', description: 'Hex colour, e.g. #2BA89E' },
                  location: { type: 'number', minimum: 0, maximum: 100, description: 'Position %' },
                },
                required: ['color', 'location'],
              },
            },
            angle: { type: 'number', description: 'Angle in degrees (default 90)', default: 90 },
            type: {
              type: 'string',
              enum: ['LINEAR', 'RADIAL', 'ANGLE', 'REFLECTED', 'DIAMOND'],
              description: 'Gradient style (default LINEAR)',
              default: 'LINEAR',
            },
            opacity: {
              type: 'number',
              minimum: 0,
              maximum: 100,
              default: 100,
              description: 'Opacity %',
            },
            scale: {
              type: 'number',
              minimum: 10,
              maximum: 150,
              default: 100,
              description: 'Scale %',
            },
            reverse: { type: 'boolean', default: false, description: 'Reverse the gradient' },
          },
          required: ['stops'],
        },
      },
      handler: async (args) => addGradientOverlay(connection, args),
    },
    {
      tool: {
        name: 'photoshop_remove_layer_effects',
        description:
          'Remove ALL layer effects (styles) from the active layer, leaving the pixel content unchanged.',
        inputSchema: { type: 'object', properties: {} },
      },
      handler: async () => removeLayerEffects(connection),
    },
  ];
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * ExtendScript that sets one effect on the active layer and keeps the rest.
 *
 * Effects are written by setting the layer's Lefx property with `setd`
 * (there is no "setLayerEffects" event, which is what these tools called
 * before, so they failed on every layer). Setting Lefx replaces the whole set,
 * so the layer's current effects are read first and only `key` is replaced.
 * Photoshop stores several shadows/strokes under a "...Multi" list; that list is
 * dropped so the single effect written here is the one that shows.
 * The script must define `effect` (an ActionDescriptor) before this runs.
 */
function setLayerEffectScript(key: string, multiKey: string): string {
  return `
      var layer = app.activeDocument.activeLayer;
      if (layer.isBackgroundLayer) {
        throw new Error('The Background layer cannot have layer effects; convert it to a normal layer or select another layer.');
      }
      var getRef = new ActionReference();
      getRef.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      var layerDesc = executeActionGet(getRef);
      var fx = layerDesc.hasKey(sTID('layerEffects'))
        ? layerDesc.getObjectValue(sTID('layerEffects'))
        : new ActionDescriptor();
      if (!fx.hasKey(cTID('Scl '))) fx.putUnitDouble(cTID('Scl '), cTID('#Prc'), 100);
      if (fx.hasKey(sTID('${multiKey}'))) fx.erase(sTID('${multiKey}'));
      fx.putObject(sTID('${key}'), sTID('${key}'), effect);

      var setRef = new ActionReference();
      setRef.putProperty(cTID('Prpr'), cTID('Lefx'));
      setRef.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      var setDesc = new ActionDescriptor();
      setDesc.putReference(cTID('null'), setRef);
      setDesc.putObject(cTID('T   '), cTID('Lefx'), fx);
      executeAction(cTID('setd'), setDesc, DialogModes.NO);
  `;
}

const STROKE_POSITIONS = ['OUTSIDE', 'INSIDE', 'CENTER'] as const;

const GRADIENT_TYPES = ['LINEAR', 'RADIAL', 'ANGLE', 'REFLECTED', 'DIAMOND'] as const;
const GRADIENT_TYPE_IDS: Record<(typeof GRADIENT_TYPES)[number], string> = {
  LINEAR: 'Lnr ',
  RADIAL: 'Rdl ',
  ANGLE: 'Angl',
  REFLECTED: 'Rflc',
  DIAMOND: 'Dmnd',
};

/** Parses "#RRGGBB" / "RRGGBB" into 0-255 channels; throws on anything else. */
export function parseHexColor(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex).trim());
  if (!m) throw new Error(`Invalid hex colour: ${hex} (expected #RRGGBB)`);
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

/** Validates gradient stops and converts locations from 0-100 % to Photoshop's 0-4096. */
export function normalizeGradientStops(
  raw: unknown
): Array<{ r: number; g: number; b: number; location: number }> {
  if (!Array.isArray(raw) || raw.length < 2)
    throw new Error('stops must be an array of at least 2 stops');
  return raw
    .map((st) => {
      const o = st as { color?: unknown; location?: unknown };
      const loc = Number(o.location);
      if (!Number.isFinite(loc) || loc < 0 || loc > 100)
        throw new Error(`Stop location must be 0-100, got ${o.location}`);
      return { ...parseHexColor(String(o.color)), location: Math.round((loc / 100) * 4096) };
    })
    .sort((a, b) => a.location - b.location);
}

const amHelpers = `
function cTID(s) { return app.charIDToTypeID(s); }
function sTID(s) { return app.stringIDToTypeID(s); }
function tSID(id) { return app.typeIDToStringID(id); }
function safeGet(fn) { try { return fn(); } catch(e) { return null; } }
function colorFromDesc(d) {
  return {
    r: Math.round(d.getDouble(cTID('Rd  '))),
    g: Math.round(d.getDouble(cTID('Grn '))),
    b: Math.round(d.getDouble(cTID('Bl  ')))
  };
}
`;

// ─── handlers ────────────────────────────────────────────────────────────────

async function getLayerEffects(connection: PhotoshopConnection): Promise<ToolResult> {
  try {
    const api = await new PhotoshopAPIFactory(connection).createAPI();
    const result = await api.executeScript(`
      ${amHelpers}
      if (app.documents.length === 0) throw new Error('No active document');

      var ref = new ActionReference();
      ref.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      var desc = executeActionGet(ref);

      var out = { layerName: app.activeDocument.activeLayer.name, effects: {} };

      if (!desc.hasKey(sTID('layerEffects'))) {
        out.effects = null;
        return out;
      }

      var fx = desc.getObjectValue(sTID('layerEffects'));

      // Friendly names for the raw Photoshop keys. Anything not listed is reported
      // under its raw key, so a new/unknown effect type can never be silently dropped.
      var ALIAS = {
        dropShadow: 'dropShadow', frameFX: 'stroke', innerGlow: 'innerGlow',
        outerGlow: 'outerGlow', solidFill: 'colorOverlay', gradientFill: 'gradientOverlay',
        innerShadow: 'innerShadow', bevelEmboss: 'bevelEmboss', chromeFX: 'satin',
        patternFill: 'patternOverlay'
      };

      function readEffect(o) {
        var e = {
          enabled:   safeGet(function(){ return o.getBoolean(sTID('enabled')); }),
          present:   safeGet(function(){ return o.getBoolean(sTID('present')); }),
          opacity:   safeGet(function(){ return o.getDouble(cTID('Opct')); }),
          blendMode: safeGet(function(){ return tSID(o.getEnumerationValue(sTID('mode'))); }),
          color:     safeGet(function(){ return colorFromDesc(o.getObjectValue(sTID('color'))); }),
          angle:     safeGet(function(){ return o.getDouble(cTID('lagl')); }),
          distance:  safeGet(function(){ return o.getDouble(cTID('Dstn')); }),
          // Shadows and glows store their size as 'blur'; a stroke stores its width as 'Sz  '.
          size:      safeGet(function(){ return o.hasKey(cTID('blur')) ? o.getDouble(cTID('blur')) : o.getDouble(cTID('Sz  ')); }),
          choke:     safeGet(function(){ return o.getDouble(cTID('Ckmt')); }),
          spread:    safeGet(function(){ return o.getDouble(cTID('uglC')); }),
          // Stroke position (outsetFrame / insetFrame / centeredFrame) lives under 'Styl'.
          position:  safeGet(function(){ return tSID(o.getEnumerationValue(cTID('Styl'))); }),
          gradientAngle: safeGet(function(){ return o.getDouble(cTID('Angl')); }),
          gradientType:  safeGet(function(){ return tSID(o.getEnumerationValue(sTID('type'))); }),
          gradientScale: safeGet(function(){ return o.getDouble(cTID('Scl ')); }),
          reverse:       safeGet(function(){ return o.getBoolean(sTID('reverse')); })
        };
        e.stops = safeGet(function(){
          var g = o.getObjectValue(sTID('gradient'));
          var cl = g.getList(sTID('colors'));
          var arr = [];
          for (var s = 0; s < cl.count; s++) {
            var stp = cl.getObjectValue(s);
            arr.push({
              location: safeGet(function(){ return stp.getInteger(sTID('location')); }),
              color:    safeGet(function(){ return colorFromDesc(stp.getObjectValue(sTID('color'))); })
            });
          }
          return arr;
        });
        var clean = {};
        for (var k in e) { if (e[k] !== null && e[k] !== undefined) clean[k] = e[k]; }
        return clean;
      }

      function readKey(key) {
        var asList = safeGet(function(){ return fx.getList(key); });
        if (asList) {
          var arr = [];
          for (var j = 0; j < asList.count; j++) arr.push(readEffect(asList.getObjectValue(j)));
          return arr.length === 1 ? arr[0] : arr;
        }
        var single = safeGet(function(){ return fx.getObjectValue(key); });
        return single ? readEffect(single) : null;
      }

      // rawKeys records exactly what Photoshop reported, so a caller can tell the
      // difference between "no such effect" and "this reader did not look for it".
      out.rawKeys = [];
      var multiKeys = [], singleKeys = [];
      for (var i = 0; i < fx.count; i++) {
        var k = fx.getKey(i);
        var id = typeIDToStringID(k);
        out.rawKeys.push(id);
        if (id === 'scale') continue;   // document FX scale, not an effect
        if (id.length > 5 && id.substring(id.length - 5) === 'Multi') multiKeys.push([k, id]);
        else singleKeys.push([k, id]);
      }
      // singular first, then Multi overwrites — Photoshop treats the Multi list as authoritative
      for (var a = 0; a < singleKeys.length; a++) {
        var nm = ALIAS[singleKeys[a][1]] || singleKeys[a][1];
        var v1 = readKey(singleKeys[a][0]);
        if (v1) out.effects[nm] = v1;
      }
      for (var b = 0; b < multiKeys.length; b++) {
        var base = multiKeys[b][1].substring(0, multiKeys[b][1].length - 5);
        var nm2 = ALIAS[base] || base;
        var v2 = readKey(multiKeys[b][0]);
        if (v2) out.effects[nm2] = v2;
      }

      // Explicit summary of what is actually switched ON — the question callers really ask.
      out.enabledEffects = [];
      for (var n in out.effects) {
        var v = out.effects[n];
        if (v && typeof v.length === 'number') {
          for (var q = 0; q < v.length; q++) if (v[q] && v[q].enabled) out.enabledEffects.push(n + '[' + q + ']');
        } else if (v && v.enabled) {
          out.enabledEffects.push(n);
        }
      }

      return out;
    `);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

async function addDropShadow(
  connection: PhotoshopConnection,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const r = optionalNumber(args, 'color_r', 0);
  const g = optionalNumber(args, 'color_g', 0);
  const b = optionalNumber(args, 'color_b', 0);
  const opacity = optionalNumber(args, 'opacity', 75);
  const angle = optionalNumber(args, 'angle', 120);
  const distance = optionalNumber(args, 'distance', 5);
  const size = optionalNumber(args, 'size', 5);
  const spread = optionalNumber(args, 'spread', 0);
  try {
    const api = await new PhotoshopAPIFactory(connection).createAPI();
    const result = await api.executeScript(`
      ${amHelpers}
      if (app.documents.length === 0) throw new Error('No active document');

      var effect = new ActionDescriptor();
      effect.putBoolean(sTID('enabled'), true);
      effect.putBoolean(sTID('present'), true);
      effect.putBoolean(sTID('showInDialog'), true);
      effect.putEnumerated(cTID('Md  '), cTID('BlnM'), cTID('Mltp'));
      var colorDesc = new ActionDescriptor();
      colorDesc.putDouble(cTID('Rd  '), ${r});
      colorDesc.putDouble(cTID('Grn '), ${g});
      colorDesc.putDouble(cTID('Bl  '), ${b});
      effect.putObject(cTID('Clr '), cTID('RGBC'), colorDesc);
      effect.putUnitDouble(cTID('Opct'), cTID('#Prc'), ${opacity});
      effect.putBoolean(cTID('uglg'), false);
      effect.putUnitDouble(cTID('lagl'), cTID('#Ang'), ${angle});
      effect.putUnitDouble(cTID('Dstn'), cTID('#Pxl'), ${distance});
      effect.putUnitDouble(cTID('Ckmt'), cTID('#Pxl'), ${spread});
      effect.putUnitDouble(cTID('blur'), cTID('#Pxl'), ${size});
      ${setLayerEffectScript('dropShadow', 'dropShadowMulti')}

      return {
        applied: true,
        effect: 'dropShadow',
        color: { r: ${r}, g: ${g}, b: ${b} },
        opacity: ${opacity},
        angle: ${angle},
        distance: ${distance},
        size: ${size},
        spread: ${spread}
      };
    `);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

async function addStrokeEffect(
  connection: PhotoshopConnection,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const size = optionalNumber(args, 'size', 3);
  const position = (args.position as string) ?? 'OUTSIDE';
  const r = optionalNumber(args, 'color_r', 0);
  const g = optionalNumber(args, 'color_g', 0);
  const b = optionalNumber(args, 'color_b', 0);
  const opacity = optionalNumber(args, 'opacity', 100);

  // Map position string → Photoshop frameFXType enum string
  const posMap: Record<string, string> = {
    OUTSIDE: 'OutF',
    INSIDE: 'InsF',
    CENTER: 'CtrF',
  };
  const posEnum = posMap[jsxEnum(position.toUpperCase(), STROKE_POSITIONS, 'stroke position')];

  try {
    const api = await new PhotoshopAPIFactory(connection).createAPI();
    const result = await api.executeScript(`
      ${amHelpers}
      if (app.documents.length === 0) throw new Error('No active document');

      var effect = new ActionDescriptor();
      effect.putBoolean(sTID('enabled'), true);
      effect.putBoolean(sTID('present'), true);
      effect.putBoolean(sTID('showInDialog'), true);
      effect.putEnumerated(cTID('Styl'), cTID('FStl'), cTID('${posEnum}'));
      effect.putEnumerated(cTID('PntT'), cTID('FrFl'), cTID('SClr'));
      effect.putEnumerated(cTID('Md  '), cTID('BlnM'), cTID('Nrml'));
      effect.putUnitDouble(cTID('Opct'), cTID('#Prc'), ${opacity});
      effect.putUnitDouble(cTID('Sz  '), cTID('#Pxl'), ${size});
      var colorDesc = new ActionDescriptor();
      colorDesc.putDouble(cTID('Rd  '), ${r});
      colorDesc.putDouble(cTID('Grn '), ${g});
      colorDesc.putDouble(cTID('Bl  '), ${b});
      effect.putObject(cTID('Clr '), cTID('RGBC'), colorDesc);
      ${setLayerEffectScript('frameFX', 'frameFXMulti')}

      return {
        applied: true,
        effect: 'stroke',
        size: ${size},
        position: ${jsxString(position)},
        color: { r: ${r}, g: ${g}, b: ${b} },
        opacity: ${opacity}
      };
    `);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

async function addGradientOverlay(
  connection: PhotoshopConnection,
  args: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const stops = normalizeGradientStops(args.stops);
    const angle = optionalNumber(args, 'angle', 90);
    const opacity = optionalNumber(args, 'opacity', 100);
    const scale = optionalNumber(args, 'scale', 100);
    const reverse = args.reverse === true;
    const typeName = jsxEnum(
      String(args.type ?? 'LINEAR').toUpperCase(),
      GRADIENT_TYPES,
      'gradient type'
    );
    const stopJsx = stops
      .map(
        (st) => `cl.putObject(cTID('Clrt'), colorStop(${st.r}, ${st.g}, ${st.b}, ${st.location}));`
      )
      .join('\n      ');
    const api = await new PhotoshopAPIFactory(connection).createAPI();
    const result = await api.executeScript(`
      ${amHelpers}
      if (app.documents.length === 0) throw new Error('No active document');

      function colorStop(r, g, b, loc) {
        var c = new ActionDescriptor();
        c.putDouble(cTID('Rd  '), r); c.putDouble(cTID('Grn '), g); c.putDouble(cTID('Bl  '), b);
        var d = new ActionDescriptor();
        d.putObject(cTID('Clr '), cTID('RGBC'), c);
        d.putEnumerated(cTID('Type'), cTID('Clry'), cTID('UsrS'));
        d.putInteger(cTID('Lctn'), loc);
        d.putInteger(cTID('Mdpn'), 50);
        return d;
      }
      function opacityStop(loc) {
        var d = new ActionDescriptor();
        d.putUnitDouble(cTID('Opct'), cTID('#Prc'), 100);
        d.putInteger(cTID('Lctn'), loc);
        d.putInteger(cTID('Mdpn'), 50);
        return d;
      }

      var grad = new ActionDescriptor();
      grad.putString(cTID('Nm  '), 'Custom');
      grad.putEnumerated(cTID('GrdF'), cTID('GrdF'), cTID('CstS'));
      grad.putDouble(cTID('Intr'), 4096);
      var cl = new ActionList();
      ${stopJsx}
      grad.putList(cTID('Clrs'), cl);
      var tl = new ActionList();
      tl.putObject(cTID('TrnS'), opacityStop(0));
      tl.putObject(cTID('TrnS'), opacityStop(4096));
      grad.putList(cTID('Trns'), tl);

      var effect = new ActionDescriptor();
      effect.putBoolean(sTID('enabled'), true);
      effect.putBoolean(sTID('present'), true);
      effect.putBoolean(sTID('showInDialog'), true);
      effect.putEnumerated(cTID('Md  '), cTID('BlnM'), cTID('Nrml'));
      effect.putUnitDouble(cTID('Opct'), cTID('#Prc'), ${opacity});
      effect.putObject(cTID('Grad'), cTID('Grdn'), grad);
      effect.putUnitDouble(cTID('Angl'), cTID('#Ang'), ${angle});
      effect.putEnumerated(cTID('Type'), cTID('GrdT'), cTID('${GRADIENT_TYPE_IDS[typeName]}'));
      effect.putBoolean(cTID('Rvrs'), ${reverse});
      effect.putBoolean(cTID('Algn'), true);
      effect.putUnitDouble(cTID('Scl '), cTID('#Prc'), ${scale});
      var ofs = new ActionDescriptor();
      ofs.putUnitDouble(cTID('Hrzn'), cTID('#Prc'), 0);
      ofs.putUnitDouble(cTID('Vrtc'), cTID('#Prc'), 0);
      effect.putObject(cTID('Ofst'), cTID('Pnt '), ofs);
      ${setLayerEffectScript('gradientFill', 'gradientFillMulti')}

      return {
        applied: true,
        effect: 'gradientOverlay',
        layerName: app.activeDocument.activeLayer.name,
        type: ${jsxString(typeName)},
        angle: ${angle},
        stops: ${stops.length}
      };
    `);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

async function removeLayerEffects(connection: PhotoshopConnection): Promise<ToolResult> {
  try {
    const api = await new PhotoshopAPIFactory(connection).createAPI();
    const result = await api.executeScript(`
      ${amHelpers}
      if (app.documents.length === 0) throw new Error('No active document');
      var layerName = app.activeDocument.activeLayer.name;
      var desc = new ActionDescriptor();
      var ref = new ActionReference();
      ref.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      desc.putReference(cTID('null'), ref);
      executeAction(sTID('disableLayerFX'), desc, DialogModes.NO);
      return { removed: true, layerName: layerName };
    `);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}
