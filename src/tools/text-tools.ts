import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { PhotoshopConnection } from '../platform/connection.js';
import { PhotoshopAPIFactory } from '../api/photoshop-api.js';
import { ExtendScriptSnippets, TEXT_JUSTIFICATIONS } from '../api/extendscript.js';
import { optionalNumber, requireNumber, requireString } from '../utils/args.js';
import { jsxEnum, jsxString } from '../utils/jsx.js';
import { parseHexColor } from './layer-effects-tools.js';

export function createTextTools(connection: PhotoshopConnection): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'photoshop_set_text_font',
        description: 'Set font family and size for active text layer',
        inputSchema: {
          type: 'object',
          properties: {
            fontName: {
              type: 'string',
              description: 'Font family name (e.g., "Arial", "Helvetica")',
            },
            fontSize: {
              type: 'number',
              description: 'Font size in points (optional)',
              minimum: 1,
            },
          },
          required: ['fontName'],
        },
      },
      handler: async (args) => setTextFont(connection, args),
    },
    {
      tool: {
        name: 'photoshop_set_text_color',
        description: 'Set color for active text layer',
        inputSchema: {
          type: 'object',
          properties: {
            red: {
              type: 'number',
              description: 'Red component (0-255)',
              minimum: 0,
              maximum: 255,
            },
            green: {
              type: 'number',
              description: 'Green component (0-255)',
              minimum: 0,
              maximum: 255,
            },
            blue: {
              type: 'number',
              description: 'Blue component (0-255)',
              minimum: 0,
              maximum: 255,
            },
          },
          required: ['red', 'green', 'blue'],
        },
      },
      handler: async (args) => setTextColor(connection, args),
    },
    {
      tool: {
        name: 'photoshop_set_text_alignment',
        description: 'Set text alignment for active text layer',
        inputSchema: {
          type: 'object',
          properties: {
            alignment: {
              type: 'string',
              description: 'Text alignment',
              enum: [...TEXT_JUSTIFICATIONS],
            },
          },
          required: ['alignment'],
        },
      },
      handler: async (args) => setTextAlignment(connection, args),
    },
    {
      tool: {
        name: 'photoshop_update_text_content',
        description: 'Update the text content of active text layer',
        inputSchema: {
          type: 'object',
          properties: {
            text: {
              type: 'string',
              description: 'New text content',
            },
          },
          required: ['text'],
        },
      },
      handler: async (args) => updateTextContent(connection, args),
    },
    {
      tool: {
        name: 'photoshop_set_text_spacing',
        description:
          'Set letter spacing (tracking) and line spacing (leading) of the active text layer. ' +
          'tracking is in 1/1000 em (0 = normal, negative = tighter). leading is in px; pass ' +
          'auto_leading: true to go back to automatic line spacing. Give any of them.',
        inputSchema: {
          type: 'object',
          properties: {
            tracking: { type: 'number', minimum: -1000, maximum: 10000, description: '1/1000 em' },
            leading: { type: 'number', exclusiveMinimum: 0, description: 'Line spacing in px' },
            auto_leading: { type: 'boolean', description: 'Use automatic line spacing' },
          },
        },
      },
      handler: async (args) => runText(connection, () => scriptSetTextSpacing(spacingArgs(args))),
    },
    {
      tool: {
        name: 'photoshop_create_paragraph_text',
        description:
          'Create a paragraph (box) text layer: the text wraps inside a box of the given size, ' +
          'unlike photoshop_create_text_layer which makes a single unwrapped line. Sizes are px.',
        inputSchema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'Text; \\n starts a new paragraph' },
            left: { type: 'number', description: 'Box left edge in px' },
            top: { type: 'number', description: 'Box top edge in px' },
            width: { type: 'number', exclusiveMinimum: 0, description: 'Box width in px' },
            height: { type: 'number', exclusiveMinimum: 0, description: 'Box height in px' },
            font_size: {
              type: 'number',
              exclusiveMinimum: 0,
              description: 'Size in px (default 24)',
            },
            font: { type: 'string', description: 'PostScript font name, e.g. "Roboto-Bold"' },
            color: { type: 'string', description: 'Hex colour (default #000000)' },
            alignment: {
              type: 'string',
              enum: [...TEXT_JUSTIFICATIONS],
              description: 'Paragraph alignment (default LEFT)',
            },
            name: { type: 'string', description: 'Layer name (default: Photoshop uses the text)' },
          },
          required: ['text', 'left', 'top', 'width', 'height'],
        },
      },
      handler: async (args) =>
        runText(connection, () => scriptCreateParagraphText(paragraphArgs(args))),
    },
  ];
}

async function setTextFont(
  connection: PhotoshopConnection,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const fontName = requireString(args, 'fontName');
  const fontSize = args.fontSize as number | undefined;

  try {
    const apiFactory = new PhotoshopAPIFactory(connection);
    const api = await apiFactory.createAPI();

    const script = ExtendScriptSnippets.setTextFont(fontName, fontSize);
    const result = await api.executeScript(script);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Text font set to ${fontName}${fontSize ? `, size ${fontSize}pt` : ''}\nResult: ${JSON.stringify(result)}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error setting text font: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

async function setTextColor(
  connection: PhotoshopConnection,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const red = args.red as number;
  const green = args.green as number;
  const blue = args.blue as number;

  try {
    const apiFactory = new PhotoshopAPIFactory(connection);
    const api = await apiFactory.createAPI();

    const script = ExtendScriptSnippets.setTextColor(red, green, blue);
    await api.executeScript(script);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Text color set to RGB(${red}, ${green}, ${blue})`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error setting text color: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

async function setTextAlignment(
  connection: PhotoshopConnection,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const alignment = requireString(args, 'alignment');

  try {
    const apiFactory = new PhotoshopAPIFactory(connection);
    const api = await apiFactory.createAPI();

    const script = ExtendScriptSnippets.setTextAlignment(alignment);
    await api.executeScript(script);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Text alignment set to ${alignment}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error setting text alignment: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

async function updateTextContent(
  connection: PhotoshopConnection,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const text = requireString(args, 'text', { allowEmpty: true });

  try {
    const apiFactory = new PhotoshopAPIFactory(connection);
    const api = await apiFactory.createAPI();

    const script = ExtendScriptSnippets.updateTextContent(text);
    await api.executeScript(script);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Text content updated to: "${text}"`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error updating text content: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

// ─── spacing and paragraph text ──────────────────────────────────────────────

export interface SpacingArgs {
  tracking?: number;
  leading?: number;
  autoLeading?: boolean;
}

export function spacingArgs(args: Record<string, unknown>): SpacingArgs {
  const out: SpacingArgs = {};
  if (args.tracking !== undefined) {
    out.tracking = optionalNumber(args, 'tracking', 0);
    if (out.tracking < -1000 || out.tracking > 10000) {
      throw new Error(`tracking must be between -1000 and 10000, got ${out.tracking}`);
    }
  }
  if (args.leading !== undefined) {
    out.leading = optionalNumber(args, 'leading', 0);
    if (out.leading <= 0) throw new Error('leading must be greater than 0');
  }
  if (args.auto_leading !== undefined) out.autoLeading = args.auto_leading === true;
  if (out.leading !== undefined && out.autoLeading === true) {
    throw new Error('give leading or auto_leading: true, not both');
  }
  if (Object.keys(out).length === 0) {
    throw new Error('give at least one of tracking, leading or auto_leading');
  }
  return out;
}

export interface ParagraphArgs {
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
  fontSize: number;
  font?: string;
  color: { r: number; g: number; b: number };
  alignment: (typeof TEXT_JUSTIFICATIONS)[number];
  name?: string;
}

export function paragraphArgs(args: Record<string, unknown>): ParagraphArgs {
  const a: ParagraphArgs = {
    text: requireString(args, 'text', { allowEmpty: true }),
    left: requireNumber(args, 'left'),
    top: requireNumber(args, 'top'),
    width: requireNumber(args, 'width'),
    height: requireNumber(args, 'height'),
    fontSize: optionalNumber(args, 'font_size', 24),
    font: typeof args.font === 'string' && args.font !== '' ? args.font : undefined,
    color: parseHexColor(String(args.color ?? '#000000')),
    alignment: jsxEnum(
      String(args.alignment ?? 'LEFT').toUpperCase(),
      TEXT_JUSTIFICATIONS,
      'text alignment'
    ),
    name: typeof args.name === 'string' && args.name !== '' ? args.name : undefined,
  };
  if (a.width <= 0 || a.height <= 0) throw new Error('width and height must be greater than 0');
  if (a.fontSize <= 0) throw new Error('font_size must be greater than 0');
  return a;
}

// Text sizes are set in points and converted from px here. The DOM reads a text
// layer's size and box width/height as points at 72 ppi even when type units
// are pixels, so at 144 ppi a "24 px" font came out 48 px. PT converts px to
// those points; dividing by it converts back. Reading the box size back does
// not round-trip at non-72 ppi, so results report the box that was asked for. Ruler units are switched to px
// for positions, and both preferences are restored afterwards.
const withPixelUnits = (body: string) => `
  if (app.documents.length === 0) throw new Error('No active document');
  var savedRuler = app.preferences.rulerUnits, savedType = app.preferences.typeUnits;
  app.preferences.rulerUnits = Units.PIXELS;
  app.preferences.typeUnits = TypeUnits.POINTS;
  var PT = 72 / app.activeDocument.resolution;
  function px(v) { return Math.round((Number(v) / PT) * 100) / 100; }
  try {
    ${body}
  } finally {
    app.preferences.rulerUnits = savedRuler;
    app.preferences.typeUnits = savedType;
  }
`;

export function scriptSetTextSpacing(a: SpacingArgs): string {
  return withPixelUnits(`
    var layer = app.activeDocument.activeLayer;
    if (layer.kind !== LayerKind.TEXT) throw new Error('Layer "' + layer.name + '" is not a text layer.');
    var t = layer.textItem;
    ${a.tracking !== undefined ? `t.tracking = ${a.tracking};` : ''}
    ${a.autoLeading === true ? 't.useAutoLeading = true;' : ''}
    ${a.autoLeading === false && a.leading === undefined ? 't.useAutoLeading = false;' : ''}
    ${a.leading !== undefined ? `t.useAutoLeading = false; t.leading = ${a.leading} * PT;` : ''}
    var out = { applied: true, layerName: layer.name, tracking: t.tracking, autoLeading: t.useAutoLeading };
    if (!t.useAutoLeading) out.leading = px(t.leading);
    return out;
  `);
}

export function scriptCreateParagraphText(a: ParagraphArgs): string {
  const { r, g, b } = a.color;
  return withPixelUnits(`
    var doc = app.activeDocument;
    var layer = doc.artLayers.add();
    layer.kind = LayerKind.TEXT;
    var t = layer.textItem;
    t.kind = TextType.PARAGRAPHTEXT;
    t.size = ${a.fontSize} * PT;
    ${a.font !== undefined ? `t.font = ${jsxString(a.font)};` : ''}
    var c = new SolidColor();
    c.rgb.red = ${r}; c.rgb.green = ${g}; c.rgb.blue = ${b};
    t.color = c;
    t.justification = Justification.${a.alignment};
    t.position = [${a.left}, ${a.top}];
    t.width = ${a.width} * PT;
    t.height = ${a.height} * PT;
    t.contents = ${jsxString(a.text.replace(/\n/g, '\r'))};
    ${a.name !== undefined ? `layer.name = ${jsxString(a.name)};` : ''}
    ${
      a.font !== undefined
        ? `if (t.font !== ${jsxString(a.font)}) {
      var got = t.font;
      layer.remove();
      throw new Error('Font "' + ${jsxString(a.font)} + '" is not installed (Photoshop used "' + got + '"). Use its PostScript name.');
    }`
        : ''
    }
    var bnd = layer.bounds;
    return {
      created: true,
      layerName: layer.name,
      box: { left: ${a.left}, top: ${a.top}, width: ${a.width}, height: ${a.height} },
      inkBounds: { left: bnd[0].as('px'), top: bnd[1].as('px'), right: bnd[2].as('px'), bottom: bnd[3].as('px') },
      font: t.font,
      size: px(t.size)
    };
  `);
}

async function runText(connection: PhotoshopConnection, build: () => string): Promise<ToolResult> {
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
