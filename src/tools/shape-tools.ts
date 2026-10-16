import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { PhotoshopConnection } from '../platform/connection.js';
import { PhotoshopAPIFactory } from '../api/photoshop-api.js';
import { jsxEnum, jsxString } from '../utils/jsx.js';
import { optionalNumber, requireNumber } from '../utils/args.js';
import { parseHexColor } from './layer-effects-tools.js';

const SHAPE_TYPES = ['RECTANGLE', 'ROUNDED_RECTANGLE', 'ELLIPSE'] as const;
const STROKE_ALIGNMENTS = ['INSIDE', 'CENTER', 'OUTSIDE'] as const;
const STROKE_ALIGNMENT_IDS: Record<(typeof STROKE_ALIGNMENTS)[number], string> = {
  INSIDE: 'strokeStyleAlignInside',
  CENTER: 'strokeStyleAlignCenter',
  OUTSIDE: 'strokeStyleAlignOutside',
};

const hexColorSchema = (description: string) => ({
  type: 'string',
  description: `${description} as hex, e.g. #2BA89E`,
});

export function createShapeTools(connection: PhotoshopConnection): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'photoshop_create_shape',
        description:
          'Create a vector shape layer (RECTANGLE, ROUNDED_RECTANGLE or ELLIPSE) with a solid fill. ' +
          'The fill stays editable, so layer effects such as photoshop_add_gradient_overlay can be ' +
          'applied without rasterizing. The new layer becomes the active layer.',
        inputSchema: {
          type: 'object',
          properties: {
            type: {
              type: 'string',
              enum: [...SHAPE_TYPES],
              description: 'Shape type (default RECTANGLE)',
              default: 'RECTANGLE',
            },
            left: { type: 'number', description: 'Left edge in pixels' },
            top: { type: 'number', description: 'Top edge in pixels' },
            width: { type: 'number', description: 'Width in pixels', exclusiveMinimum: 0 },
            height: { type: 'number', description: 'Height in pixels', exclusiveMinimum: 0 },
            corner_radius: {
              type: 'number',
              minimum: 0,
              description: 'Corner radius in pixels for ROUNDED_RECTANGLE (default 16)',
              default: 16,
            },
            color: { ...hexColorSchema('Fill colour'), default: '#808080' },
            name: { type: 'string', description: 'Layer name (default: Photoshop picks one)' },
          },
          required: ['left', 'top', 'width', 'height'],
        },
      },
      handler: async (args) => run(connection, () => scriptCreateShape(shapeArgs(args))),
    },
    {
      tool: {
        name: 'photoshop_set_shape_fill',
        description:
          'Change the solid fill colour of the active shape layer (or solid colour fill layer). ' +
          'Keeps the layer vector and its effects.',
        inputSchema: {
          type: 'object',
          properties: { color: hexColorSchema('Fill colour') },
          required: ['color'],
        },
      },
      handler: async (args) =>
        run(connection, () => scriptSetShapeFill(parseHexColor(String(args.color)))),
    },
    {
      tool: {
        name: 'photoshop_set_shape_stroke',
        description:
          "Set or remove the vector stroke of the active shape layer (the shape's own outline, " +
          'not the Stroke layer effect). Give width, colour and alignment, or enabled: false to remove it.',
        inputSchema: {
          type: 'object',
          properties: {
            enabled: {
              type: 'boolean',
              description: 'false removes the stroke (default true)',
              default: true,
            },
            width: { type: 'number', minimum: 0, description: 'Stroke width in px (default 2)' },
            color: { ...hexColorSchema('Stroke colour'), default: '#000000' },
            alignment: {
              type: 'string',
              enum: [...STROKE_ALIGNMENTS],
              description: 'Where the stroke sits on the path (default INSIDE)',
              default: 'INSIDE',
            },
          },
        },
      },
      handler: async (args) => run(connection, () => scriptSetShapeStroke(strokeArgs(args))),
    },
  ];
}

export interface ShapeArgs {
  type: (typeof SHAPE_TYPES)[number];
  left: number;
  top: number;
  width: number;
  height: number;
  radius: number;
  color: { r: number; g: number; b: number };
  name?: string;
}

/** Validates create_shape arguments; throws on anything that cannot be drawn. */
export function shapeArgs(args: Record<string, unknown>): ShapeArgs {
  const type = jsxEnum(String(args.type ?? 'RECTANGLE').toUpperCase(), SHAPE_TYPES, 'shape type');
  const width = requireNumber(args, 'width');
  const height = requireNumber(args, 'height');
  if (width <= 0 || height <= 0) throw new Error('width and height must be greater than 0');
  const radius = optionalNumber(args, 'corner_radius', 16);
  if (radius < 0) throw new Error('corner_radius must be 0 or more');
  return {
    type,
    left: requireNumber(args, 'left'),
    top: requireNumber(args, 'top'),
    width,
    height,
    // Photoshop clamps a radius larger than half the short side; do it here so
    // the result reports the radius actually drawn.
    radius: Math.min(radius, width / 2, height / 2),
    color: parseHexColor(String(args.color ?? '#808080')),
    name: typeof args.name === 'string' && args.name !== '' ? args.name : undefined,
  };
}

export interface StrokeArgs {
  enabled: boolean;
  width: number;
  color: { r: number; g: number; b: number };
  alignment: (typeof STROKE_ALIGNMENTS)[number];
}

export function strokeArgs(args: Record<string, unknown>): StrokeArgs {
  const width = optionalNumber(args, 'width', 2);
  if (width < 0) throw new Error('width must be 0 or more');
  return {
    enabled: args.enabled !== false,
    width,
    color: parseHexColor(String(args.color ?? '#000000')),
    alignment: jsxEnum(
      String(args.alignment ?? 'INSIDE').toUpperCase(),
      STROKE_ALIGNMENTS,
      'stroke alignment'
    ),
  };
}

const helpers = `
  function cTID(s) { return app.charIDToTypeID(s); }
  function sTID(s) { return app.stringIDToTypeID(s); }
  function rgbDesc(r, g, b) {
    var c = new ActionDescriptor();
    c.putDouble(cTID('Rd  '), r); c.putDouble(cTID('Grn '), g); c.putDouble(cTID('Bl  '), b);
    return c;
  }
  function solidFill(r, g, b) {
    var d = new ActionDescriptor();
    d.putObject(cTID('Clr '), cTID('RGBC'), rgbDesc(r, g, b));
    return d;
  }
  if (app.documents.length === 0) throw new Error('No active document');
`;

// Shape and fill edits only make sense on a layer that has a vector fill.
const requireShapeLayer = `
  var layer = app.activeDocument.activeLayer;
  if (layer.kind !== LayerKind.SOLIDFILL) {
    throw new Error('Layer "' + layer.name + '" is not a shape or solid colour fill layer (kind: ' +
      String(layer.kind) + '). Create one with photoshop_create_shape.');
  }
`;

export function scriptCreateShape(a: ShapeArgs): string {
  const { r, g, b } = a.color;
  const shapeClass = a.type === 'ELLIPSE' ? 'Elps' : 'Rctn';
  const radius = a.type === 'ROUNDED_RECTANGLE' ? a.radius : 0;
  return `
    ${helpers}
    var bounds = new ActionDescriptor();
    bounds.putUnitDouble(cTID('Top '), cTID('#Pxl'), ${a.top});
    bounds.putUnitDouble(cTID('Left'), cTID('#Pxl'), ${a.left});
    bounds.putUnitDouble(cTID('Btom'), cTID('#Pxl'), ${a.top + a.height});
    bounds.putUnitDouble(cTID('Rght'), cTID('#Pxl'), ${a.left + a.width});
    ${radius > 0 ? `bounds.putUnitDouble(cTID('Rds '), cTID('#Pxl'), ${radius});` : ''}

    var content = new ActionDescriptor();
    content.putObject(cTID('Type'), sTID('solidColorLayer'), solidFill(${r}, ${g}, ${b}));
    content.putObject(cTID('Shp '), cTID('${shapeClass}'), bounds);

    var ref = new ActionReference();
    ref.putClass(sTID('contentLayer'));
    var make = new ActionDescriptor();
    make.putReference(cTID('null'), ref);
    make.putObject(cTID('Usng'), sTID('contentLayer'), content);
    executeAction(cTID('Mk  '), make, DialogModes.NO);

    var layer = app.activeDocument.activeLayer;
    ${a.name !== undefined ? `layer.name = ${jsxString(a.name)};` : ''}
    var bnd = layer.bounds;
    return {
      created: true,
      layerName: layer.name,
      type: ${jsxString(a.type)},
      bounds: { left: bnd[0].as('px'), top: bnd[1].as('px'), right: bnd[2].as('px'), bottom: bnd[3].as('px') },
      cornerRadius: ${radius},
      color: { r: ${r}, g: ${g}, b: ${b} }
    };
  `;
}

export function scriptSetShapeFill(color: { r: number; g: number; b: number }): string {
  const { r, g, b } = color;
  return `
    ${helpers}
    ${requireShapeLayer}
    var ref = new ActionReference();
    ref.putEnumerated(sTID('contentLayer'), cTID('Ordn'), cTID('Trgt'));
    var set = new ActionDescriptor();
    set.putReference(cTID('null'), ref);
    set.putObject(cTID('T   '), sTID('solidColorLayer'), solidFill(${r}, ${g}, ${b}));
    executeAction(cTID('setd'), set, DialogModes.NO);
    return { applied: true, layerName: layer.name, color: { r: ${r}, g: ${g}, b: ${b} } };
  `;
}

export function scriptSetShapeStroke(s: StrokeArgs): string {
  const { r, g, b } = s.color;
  return `
    ${helpers}
    ${requireShapeLayer}
    var stroke = new ActionDescriptor();
    stroke.putInteger(sTID('strokeStyleVersion'), 2);
    stroke.putBoolean(sTID('strokeEnabled'), ${s.enabled});
    stroke.putBoolean(sTID('fillEnabled'), true);
    ${
      s.enabled
        ? `stroke.putUnitDouble(sTID('strokeStyleLineWidth'), cTID('#Pxl'), ${s.width});
    stroke.putEnumerated(sTID('strokeStyleLineAlignment'), sTID('strokeStyleLineAlignment'), sTID('${STROKE_ALIGNMENT_IDS[s.alignment]}'));
    stroke.putObject(sTID('strokeStyleContent'), sTID('solidColorLayer'), solidFill(${r}, ${g}, ${b}));`
        : ''
    }
    var style = new ActionDescriptor();
    style.putObject(sTID('strokeStyle'), sTID('strokeStyle'), stroke);

    var ref = new ActionReference();
    ref.putEnumerated(sTID('contentLayer'), cTID('Ordn'), cTID('Trgt'));
    var set = new ActionDescriptor();
    set.putReference(cTID('null'), ref);
    set.putObject(cTID('T   '), sTID('shapeStyle'), style);
    executeAction(cTID('setd'), set, DialogModes.NO);
    return ${
      s.enabled
        ? `{ applied: true, layerName: layer.name, width: ${s.width}, alignment: ${jsxString(s.alignment)}, color: { r: ${r}, g: ${g}, b: ${b} } }`
        : `{ applied: true, layerName: layer.name, stroke: 'removed' }`
    };
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
