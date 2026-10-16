import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { PhotoshopConnection } from '../platform/connection.js';
import { PhotoshopAPIFactory } from '../api/photoshop-api.js';
import { jsxEnum, jsxString } from '../utils/jsx.js';
import { optionalNumber } from '../utils/args.js';
import { normalizeGradientStops, parseHexColor } from './layer-effects-tools.js';

const ADJUSTMENT_TYPES = [
  'BRIGHTNESS_CONTRAST',
  'LEVELS',
  'CURVES',
  'HUE_SATURATION',
  'VIBRANCE',
  'BLACK_AND_WHITE',
  'INVERT',
] as const;
type AdjustmentType = (typeof ADJUSTMENT_TYPES)[number];

const FILL_TYPES = ['SOLID', 'GRADIENT'] as const;
const GRADIENT_TYPES = ['LINEAR', 'RADIAL', 'ANGLE', 'REFLECTED', 'DIAMOND'] as const;
const GRADIENT_TYPE_IDS: Record<(typeof GRADIENT_TYPES)[number], string> = {
  LINEAR: 'Lnr ',
  RADIAL: 'Rdl ',
  ANGLE: 'Angl',
  REFLECTED: 'Rflc',
  DIAMOND: 'Dmnd',
};

const curvePointsSchema = {
  type: 'array',
  description:
    'Curve points as [input, output] pairs, 0-255, e.g. [[0,0],[64,40],[192,220],[255,255]]. ' +
    'At least 2 points, inputs all different.',
  minItems: 2,
  items: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
};

const stopsSchema = {
  type: 'array',
  description:
    'Gradient colour stops, e.g. [{"color":"#2BA89E","location":0},{"color":"#7FE3D8","location":100}]',
  minItems: 2,
  items: {
    type: 'object',
    properties: {
      color: { type: 'string', description: 'Hex colour, e.g. #2BA89E' },
      location: { type: 'number', minimum: 0, maximum: 100, description: 'Position %' },
    },
    required: ['color', 'location'],
  },
};

const clipSchema = {
  type: 'boolean',
  description: 'Clip to the layer below, so it only affects that layer (default false)',
  default: false,
};

export function createNonDestructiveTools(connection: PhotoshopConnection): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'photoshop_add_adjustment_layer',
        description:
          'Add an adjustment layer above the active layer: the edit stays editable and can be ' +
          'hidden or deleted, unlike photoshop_adjust_* which change pixels. Arguments by type: ' +
          'BRIGHTNESS_CONTRAST (brightness, contrast); LEVELS (input_black, input_white, gamma, ' +
          'output_black, output_white); CURVES (points); HUE_SATURATION (hue, saturation, ' +
          'lightness, colorize); VIBRANCE (vibrance, saturation); BLACK_AND_WHITE; INVERT. ' +
          'Set clip: true to affect only the layer below.',
        inputSchema: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: [...ADJUSTMENT_TYPES], description: 'Adjustment type' },
            name: { type: 'string', description: 'Layer name (default: Photoshop picks one)' },
            clip: clipSchema,
            brightness: { type: 'number', minimum: -150, maximum: 150, description: '-150..150' },
            contrast: { type: 'number', minimum: -50, maximum: 100, description: '-50..100' },
            input_black: { type: 'number', minimum: 0, maximum: 253, description: '0-253' },
            input_white: { type: 'number', minimum: 2, maximum: 255, description: '2-255' },
            gamma: { type: 'number', minimum: 0.1, maximum: 9.99, description: '0.1-9.99' },
            output_black: { type: 'number', minimum: 0, maximum: 255, description: '0-255' },
            output_white: { type: 'number', minimum: 0, maximum: 255, description: '0-255' },
            points: curvePointsSchema,
            hue: {
              type: 'number',
              minimum: -180,
              maximum: 360,
              description: '-180..180 shift, or 0-360 with colorize',
            },
            saturation: { type: 'number', minimum: -100, maximum: 100, description: '-100..100' },
            lightness: { type: 'number', minimum: -100, maximum: 100, description: '-100..100' },
            colorize: { type: 'boolean', description: 'HUE_SATURATION: colorize mode' },
            vibrance: { type: 'number', minimum: -100, maximum: 100, description: '-100..100' },
          },
          required: ['type'],
        },
      },
      handler: async (args) =>
        run(connection, () => scriptAddAdjustmentLayer(adjustmentArgs(args))),
    },
    {
      tool: {
        name: 'photoshop_add_fill_layer',
        description:
          'Add a solid colour or gradient fill layer above the active layer. It fills the canvas ' +
          '(or the current selection, as a mask) and stays editable. Set clip: true to fill only ' +
          'inside the layer below, e.g. a gradient clipped to a button shape.',
        inputSchema: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: [...FILL_TYPES],
              description: 'Fill type (default SOLID)',
            },
            color: { type: 'string', description: 'SOLID: hex colour, e.g. #2BA89E' },
            stops: stopsSchema,
            angle: { type: 'number', description: 'GRADIENT: angle in degrees (default 90)' },
            gradient_type: {
              type: 'string',
              enum: [...GRADIENT_TYPES],
              description: 'GRADIENT: style (default LINEAR)',
            },
            name: { type: 'string', description: 'Layer name (default: Photoshop picks one)' },
            clip: clipSchema,
          },
        },
      },
      handler: async (args) => run(connection, () => scriptAddFillLayer(fillArgs(args))),
    },
    {
      tool: {
        name: 'photoshop_apply_curves',
        description:
          "Apply a Curves adjustment directly to the active layer's pixels (destructive; use " +
          'photoshop_add_adjustment_layer with type CURVES to keep it editable).',
        inputSchema: {
          type: 'object',
          properties: { points: curvePointsSchema },
          required: ['points'],
        },
      },
      handler: async (args) =>
        run(connection, () => scriptApplyCurves(normalizeCurvePoints(args.points))),
    },
    {
      tool: {
        name: 'photoshop_set_clipping_mask',
        description:
          "Clip the active layer to the layer below it (it shows only inside that layer's pixels " +
          'or shape), or release it with enabled: false.',
        inputSchema: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean', description: 'true clips, false releases (default true)' },
          },
        },
      },
      handler: async (args) => run(connection, () => scriptSetClippingMask(args.enabled !== false)),
    },
  ];
}

// ─── argument checks ─────────────────────────────────────────────────────────

/** Validates curve points: 2+ [input, output] pairs in 0-255, distinct inputs; sorted by input. */
export function normalizeCurvePoints(raw: unknown): Array<[number, number]> {
  if (!Array.isArray(raw) || raw.length < 2) {
    throw new Error('points must be an array of at least 2 [input, output] pairs');
  }
  const points = raw.map((p) => {
    if (!Array.isArray(p) || p.length !== 2) {
      throw new Error(`each point must be [input, output], got ${JSON.stringify(p)}`);
    }
    const [x, y] = p.map(Number);
    if (![x, y].every((v) => Number.isFinite(v) && v >= 0 && v <= 255)) {
      throw new Error(`curve values must be 0-255, got ${JSON.stringify(p)}`);
    }
    return [Math.round(x), Math.round(y)] as [number, number];
  });
  points.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < points.length; i++) {
    if (points[i][0] === points[i - 1][0]) {
      throw new Error(`two curve points share input ${points[i][0]}`);
    }
  }
  return points;
}

function ranged(args: Record<string, unknown>, name: string, d: number, min: number, max: number) {
  const v = optionalNumber(args, name, d);
  if (v < min || v > max) throw new Error(`${name} must be between ${min} and ${max}, got ${v}`);
  return v;
}

const optionalName = (args: Record<string, unknown>) =>
  typeof args.name === 'string' && args.name !== '' ? args.name : undefined;

export interface AdjustmentArgs {
  type: AdjustmentType;
  name?: string;
  clip: boolean;
  values: Record<string, number | boolean>;
  points?: Array<[number, number]>;
}

export function adjustmentArgs(args: Record<string, unknown>): AdjustmentArgs {
  const type = jsxEnum(String(args.type ?? '').toUpperCase(), ADJUSTMENT_TYPES, 'adjustment type');
  const out: AdjustmentArgs = {
    type,
    name: optionalName(args),
    clip: args.clip === true,
    values: {},
  };
  const v = out.values;
  if (type === 'BRIGHTNESS_CONTRAST') {
    v.brightness = ranged(args, 'brightness', 0, -150, 150);
    v.contrast = ranged(args, 'contrast', 0, -50, 100);
  } else if (type === 'LEVELS') {
    v.input_black = ranged(args, 'input_black', 0, 0, 253);
    v.input_white = ranged(args, 'input_white', 255, 2, 255);
    v.gamma = ranged(args, 'gamma', 1, 0.1, 9.99);
    v.output_black = ranged(args, 'output_black', 0, 0, 255);
    v.output_white = ranged(args, 'output_white', 255, 0, 255);
    if (v.input_white <= (v.input_black as number) + 1) {
      throw new Error('input_white must be at least 2 above input_black');
    }
  } else if (type === 'CURVES') {
    out.points = normalizeCurvePoints(
      args.points ?? [
        [0, 0],
        [255, 255],
      ]
    );
  } else if (type === 'HUE_SATURATION') {
    // Colorize sets an absolute hue (0-360) and saturation (0-100); otherwise
    // both shift the existing colours.
    v.colorize = args.colorize === true;
    v.hue = v.colorize ? ranged(args, 'hue', 0, 0, 360) : ranged(args, 'hue', 0, -180, 180);
    v.saturation = v.colorize
      ? ranged(args, 'saturation', 25, 0, 100)
      : ranged(args, 'saturation', 0, -100, 100);
    v.lightness = ranged(args, 'lightness', 0, -100, 100);
  } else if (type === 'VIBRANCE') {
    v.vibrance = ranged(args, 'vibrance', 0, -100, 100);
    v.saturation = ranged(args, 'saturation', 0, -100, 100);
  }
  return out;
}

export interface FillArgs {
  type: (typeof FILL_TYPES)[number];
  color?: { r: number; g: number; b: number };
  stops?: Array<{ r: number; g: number; b: number; location: number }>;
  angle: number;
  gradientType: (typeof GRADIENT_TYPES)[number];
  name?: string;
  clip: boolean;
}

export function fillArgs(args: Record<string, unknown>): FillArgs {
  const type = jsxEnum(String(args.type ?? 'SOLID').toUpperCase(), FILL_TYPES, 'fill type');
  return {
    type,
    color: type === 'SOLID' ? parseHexColor(String(args.color ?? '#808080')) : undefined,
    stops: type === 'GRADIENT' ? normalizeGradientStops(args.stops) : undefined,
    angle: optionalNumber(args, 'angle', 90),
    gradientType: jsxEnum(
      String(args.gradient_type ?? 'LINEAR').toUpperCase(),
      GRADIENT_TYPES,
      'gradient type'
    ),
    name: optionalName(args),
    clip: args.clip === true,
  };
}

// ─── scripts ─────────────────────────────────────────────────────────────────

const helpers = `
  function cTID(s) { return app.charIDToTypeID(s); }
  function sTID(s) { return app.stringIDToTypeID(s); }
  function rgbDesc(r, g, b) {
    var c = new ActionDescriptor();
    c.putDouble(cTID('Rd  '), r); c.putDouble(cTID('Grn '), g); c.putDouble(cTID('Bl  '), b);
    return c;
  }
  function compositeChannel() {
    var ref = new ActionReference();
    ref.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Cmps'));
    return ref;
  }
  function curveList(points) {
    var crv = new ActionList();
    for (var i = 0; i < points.length; i++) {
      var p = new ActionDescriptor();
      p.putDouble(cTID('Hrzn'), points[i][0]);
      p.putDouble(cTID('Vrtc'), points[i][1]);
      crv.putObject(cTID('Pnt '), p);
    }
    var a = new ActionDescriptor();
    a.putReference(cTID('Chnl'), compositeChannel());
    a.putList(cTID('Crv '), crv);
    var adjs = new ActionList();
    adjs.putObject(cTID('CrvA'), a);
    return adjs;
  }
  if (app.documents.length === 0) throw new Error('No active document');
`;

/** Creates a layer of `layerClass` above the active one; `typeJsx` builds `typeDesc`. */
function makeLayerScript(
  layerClass: 'adjustmentLayer' | 'contentLayer',
  typeClassJsx: string,
  typeJsx: string,
  name: string | undefined,
  clip: boolean
): string {
  return `
    ${helpers}
    var typeDesc = new ActionDescriptor();
    ${typeJsx}
    var using = new ActionDescriptor();
    ${clip ? "using.putBoolean(cTID('Grup'), true);" : ''}
    using.putObject(cTID('Type'), ${typeClassJsx}, typeDesc);
    var ref = new ActionReference();
    ref.putClass(sTID('${layerClass}'));
    var make = new ActionDescriptor();
    make.putReference(cTID('null'), ref);
    make.putObject(cTID('Usng'), sTID('${layerClass}'), using);
    executeAction(cTID('Mk  '), make, DialogModes.NO);
    var layer = app.activeDocument.activeLayer;
    ${name !== undefined ? `layer.name = ${jsxString(name)};` : ''}
  `;
}

export function scriptAddAdjustmentLayer(a: AdjustmentArgs): string {
  const v = a.values;
  let cls: string;
  let body: string;
  switch (a.type) {
    case 'BRIGHTNESS_CONTRAST':
      cls = "cTID('BrgC')";
      body = `typeDesc.putInteger(cTID('Brgh'), ${Math.round(v.brightness as number)});
        typeDesc.putInteger(cTID('Cntr'), ${Math.round(v.contrast as number)});
        typeDesc.putBoolean(sTID('useLegacy'), false);`;
      break;
    case 'LEVELS':
      cls = "cTID('Lvls')";
      body = `var lv = new ActionDescriptor();
        lv.putReference(cTID('Chnl'), compositeChannel());
        var inp = new ActionList(); inp.putInteger(${v.input_black}); inp.putInteger(${v.input_white});
        lv.putList(cTID('Inpt'), inp);
        lv.putDouble(cTID('Gmm '), ${v.gamma});
        var outp = new ActionList(); outp.putInteger(${v.output_black}); outp.putInteger(${v.output_white});
        lv.putList(cTID('Otpt'), outp);
        var lvs = new ActionList(); lvs.putObject(cTID('LvlA'), lv);
        typeDesc.putList(cTID('Adjs'), lvs);`;
      break;
    case 'CURVES':
      cls = "cTID('Crvs')";
      body = `typeDesc.putList(cTID('Adjs'), curveList(${JSON.stringify(a.points)}));`;
      break;
    case 'HUE_SATURATION':
      cls = "cTID('HStr')";
      body = `typeDesc.putBoolean(cTID('Clrz'), ${v.colorize});
        var hs = new ActionDescriptor();
        hs.putInteger(cTID('H   '), ${Math.round(v.hue as number)});
        hs.putInteger(cTID('Strt'), ${Math.round(v.saturation as number)});
        hs.putInteger(cTID('Lght'), ${Math.round(v.lightness as number)});
        var hsl = new ActionList(); hsl.putObject(cTID('Hst2'), hs);
        typeDesc.putList(cTID('Adjs'), hsl);`;
      break;
    case 'VIBRANCE':
      cls = "sTID('vibrance')";
      body = `typeDesc.putInteger(sTID('vibrance'), ${Math.round(v.vibrance as number)});
        typeDesc.putInteger(cTID('Strt'), ${Math.round(v.saturation as number)});`;
      break;
    case 'BLACK_AND_WHITE':
      cls = "cTID('BanW')";
      body = `typeDesc.putInteger(cTID('Rd  '), 40); typeDesc.putInteger(cTID('Yllw'), 60);
        typeDesc.putInteger(cTID('Grn '), 40); typeDesc.putInteger(cTID('Cyn '), 60);
        typeDesc.putInteger(cTID('Bl  '), 20); typeDesc.putInteger(cTID('Mgnt'), 80);`;
      break;
    case 'INVERT':
      cls = "cTID('Invr')";
      body = '';
      break;
  }
  return `
    ${makeLayerScript('adjustmentLayer', cls, body, a.name, a.clip)}
    return { created: true, layerName: layer.name, type: ${jsxString(a.type)}, clipped: layer.grouped,
      values: ${JSON.stringify(a.points ? { points: a.points } : v)} };
  `;
}

export function scriptAddFillLayer(f: FillArgs): string {
  let cls: string;
  let body: string;
  if (f.type === 'SOLID') {
    const { r, g, b } = f.color!;
    cls = "sTID('solidColorLayer')";
    body = `typeDesc.putObject(cTID('Clr '), cTID('RGBC'), rgbDesc(${r}, ${g}, ${b}));`;
  } else {
    cls = "sTID('gradientLayer')";
    const stops = f
      .stops!.map(
        (s) => `cl.putObject(cTID('Clrt'), colorStop(${s.r}, ${s.g}, ${s.b}, ${s.location}));`
      )
      .join('\n        ');
    body = `
        function colorStop(r, g, b, loc) {
          var d = new ActionDescriptor();
          d.putObject(cTID('Clr '), cTID('RGBC'), rgbDesc(r, g, b));
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
        ${stops}
        grad.putList(cTID('Clrs'), cl);
        var tl = new ActionList();
        tl.putObject(cTID('TrnS'), opacityStop(0));
        tl.putObject(cTID('TrnS'), opacityStop(4096));
        grad.putList(cTID('Trns'), tl);
        typeDesc.putUnitDouble(cTID('Angl'), cTID('#Ang'), ${f.angle});
        typeDesc.putEnumerated(cTID('Type'), cTID('GrdT'), cTID('${GRADIENT_TYPE_IDS[f.gradientType]}'));
        typeDesc.putObject(cTID('Grad'), cTID('Grdn'), grad);`;
  }
  return `
    ${makeLayerScript('contentLayer', cls, body, f.name, f.clip)}
    return { created: true, layerName: layer.name, type: ${jsxString(f.type)}, clipped: layer.grouped };
  `;
}

export function scriptApplyCurves(points: Array<[number, number]>): string {
  return `
    ${helpers}
    var layer = app.activeDocument.activeLayer;
    if (layer.typename === 'LayerSet') throw new Error('Select a pixel layer, not the group "' + layer.name + '".');
    if (layer.kind !== LayerKind.NORMAL) {
      throw new Error('Layer "' + layer.name + '" is ' + String(layer.kind) +
        '; curves change pixels, so rasterize it first or use photoshop_add_adjustment_layer.');
    }
    var d = new ActionDescriptor();
    d.putEnumerated(sTID('presetKind'), sTID('presetKindType'), sTID('presetKindCustom'));
    d.putList(cTID('Adjs'), curveList(${JSON.stringify(points)}));
    executeAction(cTID('Crvs'), d, DialogModes.NO);
    return { applied: true, layerName: layer.name, points: ${JSON.stringify(points)} };
  `;
}

export function scriptSetClippingMask(enabled: boolean): string {
  return `
    ${helpers}
    var doc = app.activeDocument;
    var layer = doc.activeLayer;
    if (layer.isBackgroundLayer) throw new Error('The Background layer cannot be clipped.');
    if (layer.typename === 'LayerSet') throw new Error('Groups cannot be clipped; clip the layers inside "' + layer.name + '".');
    var siblings = layer.parent.layers;
    if (${enabled} && siblings[siblings.length - 1] === layer) {
      throw new Error('Layer "' + layer.name + '" is the bottom layer of its group, so there is nothing below to clip to.');
    }
    if (layer.grouped !== ${enabled}) layer.grouped = ${enabled};
    return { applied: true, layerName: layer.name, clipped: layer.grouped };
  `;
}

async function run(connection: PhotoshopConnection, build: () => string): Promise<ToolResult> {
  try {
    const script = build();
    const api = await new PhotoshopAPIFactory(connection).createAPI();
    const result = await api.executeScript(script);
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
