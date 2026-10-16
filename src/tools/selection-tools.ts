import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { PhotoshopConnection } from '../platform/connection.js';
import { PhotoshopAPIFactory } from '../api/photoshop-api.js';
import { ExtendScriptSnippets, layerPathResolver } from '../api/extendscript.js';
import { jsxEnum, jsxString } from '../utils/jsx.js';
import { optionalNumber, requireNumber } from '../utils/args.js';
import { parseHexColor } from './layer-effects-tools.js';

export function createSelectionTools(connection: PhotoshopConnection): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'photoshop_select_rectangle',
        description: 'Create a rectangular selection',
        inputSchema: {
          type: 'object',
          properties: {
            left: {
              type: 'number',
              description: 'Left edge in pixels',
            },
            top: {
              type: 'number',
              description: 'Top edge in pixels',
            },
            right: {
              type: 'number',
              description: 'Right edge in pixels',
            },
            bottom: {
              type: 'number',
              description: 'Bottom edge in pixels',
            },
          },
          required: ['left', 'top', 'right', 'bottom'],
        },
      },
      handler: async (args) => selectRectangle(connection, args),
    },
    {
      tool: {
        name: 'photoshop_select_all',
        description: 'Select the entire document',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      handler: async () => selectAll(connection),
    },
    {
      tool: {
        name: 'photoshop_deselect',
        description: 'Deselect all selections',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      handler: async () => deselect(connection),
    },
    {
      tool: {
        name: 'photoshop_invert_selection',
        description: 'Invert the current selection',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      handler: async () => invertSelection(connection),
    },
    {
      tool: {
        name: 'photoshop_create_layer_mask',
        description: 'Create a layer mask from the current selection',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      handler: async () => createLayerMask(connection),
    },
    {
      tool: {
        name: 'photoshop_delete_layer_mask',
        description: 'Delete the layer mask from active layer',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      handler: async () => deleteLayerMask(connection),
    },
    {
      tool: {
        name: 'photoshop_apply_layer_mask',
        description: 'Apply (merge) the layer mask to the layer',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      handler: async () => applyLayerMask(connection),
    },
    {
      tool: {
        name: 'photoshop_select_ellipse',
        description:
          'Make an elliptical (or circular) selection inside the given box, anti-aliased. ' +
          'mode REPLACE (default), ADD, SUBTRACT or INTERSECT combines it with the current selection.',
        inputSchema: {
          type: 'object',
          properties: {
            left: { type: 'number', description: 'Left edge in pixels' },
            top: { type: 'number', description: 'Top edge in pixels' },
            right: { type: 'number', description: 'Right edge in pixels' },
            bottom: { type: 'number', description: 'Bottom edge in pixels' },
            mode: modeSchema,
          },
          required: ['left', 'top', 'right', 'bottom'],
        },
      },
      handler: async (args) =>
        runSelection(connection, () => scriptSelectEllipse(ellipseArgs(args))),
    },
    {
      tool: {
        name: 'photoshop_select_layer_pixels',
        description:
          "Select a layer's pixels (or shape), like Cmd/Ctrl-clicking its thumbnail. The active " +
          'layer stays active. mode combines it with the current selection.',
        inputSchema: {
          type: 'object',
          properties: {
            layer_path: {
              type: 'string',
              description: 'Layer path, e.g. "HUD/PlayButton" (default: the active layer)',
            },
            mode: modeSchema,
          },
        },
      },
      handler: async (args) =>
        runSelection(connection, () =>
          scriptSelectLayerPixels(
            typeof args.layer_path === 'string' && args.layer_path !== ''
              ? args.layer_path
              : undefined,
            selectionMode(args.mode)
          )
        ),
    },
    {
      tool: {
        name: 'photoshop_select_color_range',
        description:
          'Select every pixel of the active layer close to a colour (Select > Color Range). ' +
          'fuzziness 0-200 widens the match (default 40). Replaces the current selection unless ' +
          'within_selection is true.',
        inputSchema: {
          type: 'object',
          properties: {
            color: { type: 'string', description: 'Hex colour to match, e.g. #2BA89E' },
            fuzziness: {
              type: 'number',
              minimum: 0,
              maximum: 200,
              description: '0-200 (default 40)',
            },
            within_selection: {
              type: 'boolean',
              description: 'Only search inside the current selection (default false)',
            },
          },
          required: ['color'],
        },
      },
      handler: async (args) =>
        runSelection(connection, () => scriptSelectColorRange(colorRangeArgs(args))),
    },
  ];
}

// ─── ellipse, layer pixels, colour range ─────────────────────────────────────

const SELECTION_MODES = ['REPLACE', 'ADD', 'SUBTRACT', 'INTERSECT'] as const;
type SelectionMode = (typeof SELECTION_MODES)[number];

const modeSchema = {
  type: 'string',
  enum: [...SELECTION_MODES],
  description: 'How to combine with the current selection (default REPLACE)',
};

export function selectionMode(raw: unknown): SelectionMode {
  return jsxEnum(String(raw ?? 'REPLACE').toUpperCase(), SELECTION_MODES, 'selection mode');
}

export interface EllipseArgs {
  left: number;
  top: number;
  right: number;
  bottom: number;
  mode: SelectionMode;
}

export function ellipseArgs(args: Record<string, unknown>): EllipseArgs {
  const a = {
    left: requireNumber(args, 'left'),
    top: requireNumber(args, 'top'),
    right: requireNumber(args, 'right'),
    bottom: requireNumber(args, 'bottom'),
    mode: selectionMode(args.mode),
  };
  if (a.right <= a.left || a.bottom <= a.top) {
    throw new Error('right must be greater than left and bottom greater than top');
  }
  return a;
}

export interface ColorRangeArgs {
  color: { r: number; g: number; b: number };
  fuzziness: number;
  withinSelection: boolean;
}

export function colorRangeArgs(args: Record<string, unknown>): ColorRangeArgs {
  const fuzziness = optionalNumber(args, 'fuzziness', 40);
  if (fuzziness < 0 || fuzziness > 200) {
    throw new Error(`fuzziness must be between 0 and 200, got ${fuzziness}`);
  }
  return {
    color: parseHexColor(String(args.color ?? '')),
    fuzziness: Math.round(fuzziness),
    withinSelection: args.within_selection === true,
  };
}

// Action Manager event and target key for each way of combining selections.
const MODE_EVENTS: Record<SelectionMode, [string, string]> = {
  REPLACE: ['setd', 'T   '],
  ADD: ['AddT', 'T   '],
  SUBTRACT: ['SbtF', 'T   '],
  INTERSECT: ['IntW', 'T   '],
};

const selectionHelpers = `
  function cTID(s) { return app.charIDToTypeID(s); }
  function sTID(s) { return app.stringIDToTypeID(s); }
  ${layerPathResolver}
  if (app.documents.length === 0) throw new Error('No active document');
  var doc = app.activeDocument;
  function fselRef() {
    var r = new ActionReference();
    r.putProperty(cTID('Chnl'), cTID('fsel'));
    return r;
  }
  function selectionSummary(extra) {
    var out = extra || {};
    try {
      var b = doc.selection.bounds;
      out.hasSelection = true;
      out.bounds = { left: b[0].as('px'), top: b[1].as('px'), right: b[2].as('px'), bottom: b[3].as('px') };
    } catch (e) {
      out.hasSelection = false;
    }
    return out;
  }
`;

export function scriptSelectEllipse(a: EllipseArgs): string {
  const [event, key] = MODE_EVENTS[a.mode];
  return `
    ${selectionHelpers}
    var box = new ActionDescriptor();
    box.putUnitDouble(cTID('Top '), cTID('#Pxl'), ${a.top});
    box.putUnitDouble(cTID('Left'), cTID('#Pxl'), ${a.left});
    box.putUnitDouble(cTID('Btom'), cTID('#Pxl'), ${a.bottom});
    box.putUnitDouble(cTID('Rght'), cTID('#Pxl'), ${a.right});
    var d = new ActionDescriptor();
    d.putReference(cTID('null'), fselRef());
    d.putObject(cTID('${key}'), cTID('Elps'), box);
    d.putBoolean(cTID('AntA'), true);
    executeAction(cTID('${event}'), d, DialogModes.NO);
    return selectionSummary({ shape: 'ellipse', mode: ${jsxString(a.mode)} });
  `;
}

const DOM_SELECTION_TYPES: Record<SelectionMode, string> = {
  REPLACE: 'SelectionType.REPLACE',
  ADD: 'SelectionType.EXTEND',
  SUBTRACT: 'SelectionType.DIMINISH',
  INTERSECT: 'SelectionType.INTERSECT',
};

/**
 * Selects a layer's visible content. A shape or fill layer covers the whole
 * canvas and is cut out by its vector mask, so its transparency would select
 * everything; those load the vector mask instead. Other modes combine through
 * two temporary channels, which works the same for pixels and vector masks.
 */
export function scriptSelectLayerPixels(
  layerPath: string | undefined,
  mode: SelectionMode
): string {
  return `
    ${selectionHelpers}
    var previous = doc.activeLayer;
    var layer = ${layerPath === undefined ? 'previous' : `psResolveLayerPath(doc, ${jsxString(layerPath)})`};
    if (layer.typename === 'LayerSet') throw new Error('"' + layer.name + '" is a group; select a layer inside it.');
    if (layer.isBackgroundLayer) throw new Error('The Background layer has no transparency; use photoshop_select_all.');

    function loadContent() {
      psActivate(doc, layer);
      var lr = new ActionReference();
      lr.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      var ld = executeActionGet(lr);
      var vector = ld.hasKey(sTID('hasVectorMask')) && ld.getBoolean(sTID('hasVectorMask'));
      var to = new ActionReference();
      if (vector) {
        to.putEnumerated(cTID('Path'), cTID('Path'), sTID('vectorMask'));
        to.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
      } else {
        to.putEnumerated(cTID('Chnl'), cTID('Chnl'), cTID('Trsp'));
      }
      var d = new ActionDescriptor();
      d.putReference(cTID('null'), fselRef());
      d.putReference(cTID('T   '), to);
      if (vector) { d.putInteger(cTID('Vrsn'), 1); d.putBoolean(sTID('vectorMaskParams'), true); }
      executeAction(cTID('setd'), d, DialogModes.NO);
      return vector;
    }

    var had = selectionSummary().hasSelection, vector = false;
    var mode = ${jsxString(mode)};
    if (mode === 'REPLACE' || (mode === 'ADD' && !had)) {
      vector = loadContent();
    } else if (!had) {
      doc.selection.deselect();
    } else {
      var oldCh = doc.channels.add();
      doc.selection.store(oldCh);
      vector = loadContent();
      var newCh = doc.channels.add();
      doc.selection.store(newCh);
      doc.selection.load(oldCh, SelectionType.REPLACE);
      doc.selection.load(newCh, ${DOM_SELECTION_TYPES[mode]});
      oldCh.remove();
      newCh.remove();
      doc.activeChannels = doc.componentChannels;
    }
    psActivate(doc, previous);
    return selectionSummary({ layerName: layer.name, mode: mode, source: vector ? 'vector mask' : 'pixels' });
  `;
}

export function scriptSelectColorRange(a: ColorRangeArgs): string {
  const { r, g, b } = a.color;
  return `
    ${selectionHelpers}
    var layer = doc.activeLayer;
    if (layer.typename === 'LayerSet') throw new Error('"' + layer.name + '" is a group; select a layer inside it.');
    ${a.withinSelection ? '' : 'doc.selection.deselect();'}
    var c = new SolidColor();
    c.rgb.red = ${r}; c.rgb.green = ${g}; c.rgb.blue = ${b};
    // A +/-1 Lab box rather than one point: the hex colour's Lab value can differ
    // from Photoshop's own conversion of the pixel by a rounding step, and then an
    // exact match came out only partly selected at low fuzziness.
    function lab(delta) {
      var d = new ActionDescriptor();
      d.putDouble(cTID('Lmnc'), Math.max(0, Math.min(100, c.lab.l + delta)));
      d.putDouble(cTID('A   '), c.lab.a + delta);
      d.putDouble(cTID('B   '), c.lab.b + delta);
      return d;
    }
    var d = new ActionDescriptor();
    d.putInteger(cTID('Fzns'), ${a.fuzziness});
    d.putObject(cTID('Mnm '), cTID('LbCl'), lab(-1));
    d.putObject(cTID('Mxm '), cTID('LbCl'), lab(1));
    d.putInteger(sTID('colorModel'), 0);
    executeAction(cTID('ClrR'), d, DialogModes.NO);
    return selectionSummary({ layerName: layer.name, color: { r: ${r}, g: ${g}, b: ${b} }, fuzziness: ${a.fuzziness} });
  `;
}

async function runSelection(
  connection: PhotoshopConnection,
  build: () => string
): Promise<ToolResult> {
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

async function selectRectangle(
  connection: PhotoshopConnection,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const left = args.left as number;
  const top = args.top as number;
  const right = args.right as number;
  const bottom = args.bottom as number;

  try {
    const apiFactory = new PhotoshopAPIFactory(connection);
    const api = await apiFactory.createAPI();

    const script = ExtendScriptSnippets.selectRectangle(left, top, right, bottom);
    await api.executeScript(script);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Rectangular selection created: (${left}, ${top}) to (${right}, ${bottom})`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error creating selection: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

async function selectAll(connection: PhotoshopConnection): Promise<ToolResult> {
  try {
    const apiFactory = new PhotoshopAPIFactory(connection);
    const api = await apiFactory.createAPI();

    const script = ExtendScriptSnippets.selectAll();
    await api.executeScript(script);

    return {
      content: [
        {
          type: 'text' as const,
          text: 'All selected',
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error selecting all: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

async function deselect(connection: PhotoshopConnection): Promise<ToolResult> {
  try {
    const apiFactory = new PhotoshopAPIFactory(connection);
    const api = await apiFactory.createAPI();

    const script = ExtendScriptSnippets.deselect();
    await api.executeScript(script);

    return {
      content: [
        {
          type: 'text' as const,
          text: 'Selection cleared',
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error deselecting: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

async function invertSelection(connection: PhotoshopConnection): Promise<ToolResult> {
  try {
    const apiFactory = new PhotoshopAPIFactory(connection);
    const api = await apiFactory.createAPI();

    const script = ExtendScriptSnippets.invertSelection();
    await api.executeScript(script);

    return {
      content: [
        {
          type: 'text' as const,
          text: 'Selection inverted',
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error inverting selection: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

async function createLayerMask(connection: PhotoshopConnection): Promise<ToolResult> {
  try {
    const apiFactory = new PhotoshopAPIFactory(connection);
    const api = await apiFactory.createAPI();

    const script = ExtendScriptSnippets.createLayerMask();
    await api.executeScript(script);

    return {
      content: [
        {
          type: 'text' as const,
          text: 'Layer mask created from selection',
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error creating layer mask: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

async function deleteLayerMask(connection: PhotoshopConnection): Promise<ToolResult> {
  try {
    const apiFactory = new PhotoshopAPIFactory(connection);
    const api = await apiFactory.createAPI();

    const script = ExtendScriptSnippets.deleteLayerMask();
    await api.executeScript(script);

    return {
      content: [
        {
          type: 'text' as const,
          text: 'Layer mask deleted',
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error deleting layer mask: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

async function applyLayerMask(connection: PhotoshopConnection): Promise<ToolResult> {
  try {
    const apiFactory = new PhotoshopAPIFactory(connection);
    const api = await apiFactory.createAPI();

    const script = ExtendScriptSnippets.applyLayerMask();
    await api.executeScript(script);

    return {
      content: [
        {
          type: 'text' as const,
          text: 'Layer mask applied (merged to layer)',
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error applying layer mask: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}
