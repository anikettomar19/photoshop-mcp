import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { parseHexColor } from './layer-effects-tools.js';
import { PhotoshopConnection } from '../platform/connection.js';
import { PhotoshopAPIFactory } from '../api/photoshop-api.js';
import { LONG_SCRIPT_TIMEOUT_MS } from '../platform/script-executor.js';
import {
  optionalNumber,
  optionalTimeoutMs,
  requireString,
  requireNumber,
  MAX_TIMEOUT_SECONDS,
} from '../utils/args.js';
import { jsxString } from '../utils/jsx.js';
import { layerPathResolver } from '../api/extendscript.js';

export function createUtilityTools(connection: PhotoshopConnection): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'photoshop_get_session_info',
        description:
          'Get Photoshop session info: all open documents (names, sizes, paths, whether each has ' +
          'unsaved changes), the active document and its active layer, and user preferences (ruler ' +
          'units, type units). Useful to see what files are open before acting.',
        inputSchema: { type: 'object', properties: {} },
      },
      handler: async () => getSessionInfo(connection),
    },
    {
      tool: {
        name: 'photoshop_get_selection_info',
        description:
          'Read the current selection state: whether a selection exists, its pixel bounds ' +
          '(left/top/right/bottom), width, height, and approximate area. Returns hasSelection=false if nothing is selected.',
        inputSchema: { type: 'object', properties: {} },
      },
      handler: async () => getSelectionInfo(connection),
    },
    {
      tool: {
        name: 'photoshop_sample_color_at_pixel',
        description:
          'Sample the exact RGB color at a specific pixel coordinate in the active document. ' +
          'Returns r, g, b (0-255) and the hex color string. Reads from the flattened composite (all visible layers).',
        inputSchema: {
          type: 'object',
          properties: {
            x: { type: 'number', description: 'X coordinate in pixels (from left)' },
            y: { type: 'number', description: 'Y coordinate in pixels (from top)' },
          },
          required: ['x', 'y'],
        },
      },
      handler: async (args) => sampleColorAtPixel(connection, args),
    },
    {
      tool: {
        name: 'photoshop_export_composite',
        description:
          'Export what the document shows (or a chosen part of it) as one PNG, keeping ' +
          'transparency, without changing the document: the work happens on a temporary ' +
          'duplicate. only_layers keeps just those layers or groups (and the groups they are in); ' +
          'hide_layers hides some; region crops to an area. Then optional trim, max_width / ' +
          'max_height (fit inside, keeping proportions), scale, canvas_width / canvas_height ' +
          '(centre on an exact canvas), padding and background. Use instead of duplicating, ' +
          'flattening and saving by hand: flatten() puts transparent art on white.',
        inputSchema: {
          type: 'object',
          properties: {
            output_path: { type: 'string', description: 'Absolute output path for the PNG' },
            only_layers: {
              type: 'array',
              items: { type: 'string' },
              description:
                'Layer or group paths to keep; everything else is hidden (a kept group shows ' +
                'its contents as they are). The Background layer is hidden unless listed.',
            },
            hide_layers: {
              type: 'array',
              items: { type: 'string' },
              description: 'Layer or group paths to hide',
            },
            region: {
              type: 'object',
              description: 'Crop to this area, in px',
              properties: {
                left: { type: 'number' },
                top: { type: 'number' },
                right: { type: 'number' },
                bottom: { type: 'number' },
              },
              required: ['left', 'top', 'right', 'bottom'],
            },
            trim: { type: 'boolean', description: 'Trim transparent edges (default false)' },
            max_width: {
              type: 'number',
              description: 'Shrink to fit this width, keeping proportions',
            },
            max_height: {
              type: 'number',
              description: 'Shrink to fit this height, keeping proportions',
            },
            scale: {
              type: 'number',
              description:
                'Resize by this percent (default 100), e.g. 50 for a half-size export. Layer ' +
                'effects (strokes, shadows, glows) are scaled with it, like Image Size with Scale Styles on.',
            },
            canvas_width: {
              type: 'number',
              description: 'Final canvas width in px, content centred',
            },
            canvas_height: {
              type: 'number',
              description: 'Final canvas height in px, content centred',
            },
            padding: { type: 'number', description: 'Transparent margin in px on every side' },
            background: {
              type: 'string',
              description: 'Hex colour behind everything instead of transparency, e.g. "#FF00FF"',
            },
          },
          required: ['output_path'],
        },
      },
      handler: async (args) => exportComposite(connection, args),
    },
    {
      tool: {
        name: 'photoshop_export_layer_as_png',
        description:
          'Export a layer as an isolated PNG file: the layer at "path" if given, otherwise the active layer. ' +
          'Automatically detects clipping masks: if the layer is clipped to a layer below it, ' +
          'Photoshop composites just those two layers (respecting the clip boundary) and exports the result — ' +
          'so the output matches exactly what you see in Photoshop. ' +
          'Transparent pixels outside the clip boundary are preserved. ' +
          'Supports normal layers, Smart Objects, and layer groups.',
        inputSchema: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description:
                'Optional layer or group path, e.g. "Header/Title". Selected before exporting. ' +
                'Append [n] to a segment to pick between identically named siblings. Omit to export the active layer.',
            },
            output_path: {
              type: 'string',
              description: 'Absolute output path for the PNG, e.g. /tmp/my_layer.png',
            },
            trim_transparency: {
              type: 'boolean',
              description: 'Trim transparent pixels from edges (default: true)',
              default: true,
            },
            apply_clipping_mask: {
              type: 'boolean',
              description:
                'When true (default), detect and apply clipping masks so the export matches ' +
                'the Photoshop rendering. Set false to export the raw full layer without any clip.',
              default: true,
            },
            clip_to_canvas: {
              type: 'boolean',
              description:
                'When true (default), anything outside the document canvas is cut off. Set false ' +
                'to keep content and effects (shadows, glows) that extend past the canvas edge.',
              default: true,
            },
            padding: {
              type: 'number',
              description: 'Transparent margin in px added on every side of the result (default 0)',
            },
            scale: {
              type: 'number',
              description:
                'Resize the result by this percent, e.g. 200 for @2x (default 100). Layer ' +
                'effects are scaled with it.',
            },
            background: {
              type: 'string',
              description:
                'Hex colour to put behind the layer instead of transparency, e.g. "#FFFFFF" ' +
                '(default: transparent)',
            },
          },
          required: ['output_path'],
        },
      },
      handler: async (args) => exportLayerAsPng(connection, args),
    },
    {
      tool: {
        name: 'photoshop_duplicate_document',
        description:
          'Duplicate the active document. The duplicate opens as a new untitled document. ' +
          'Useful before destructive operations (resize, flatten, merge) so the original is preserved.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Name for the duplicate document (optional)',
            },
          },
        },
      },
      handler: async (args) => duplicateDocument(connection, args),
    },
    {
      tool: {
        name: 'photoshop_set_active_document',
        description:
          'Switch the active document by name. Use photoshop_get_session_info to list all open document names first.',
        inputSchema: {
          type: 'object',
          properties: {
            name: {
              type: 'string',
              description: 'Exact document name (as shown in the window title)',
            },
          },
          required: ['name'],
        },
      },
      handler: async (args) => setActiveDocument(connection, args),
    },
    {
      tool: {
        name: 'photoshop_add_guide',
        description: 'Add a horizontal or vertical ruler guide at the specified pixel position.',
        inputSchema: {
          type: 'object',
          properties: {
            orientation: {
              type: 'string',
              enum: ['HORIZONTAL', 'VERTICAL'],
              description: 'Guide orientation',
            },
            position: {
              type: 'number',
              description:
                'Position in pixels (distance from top for horizontal, from left for vertical)',
            },
          },
          required: ['orientation', 'position'],
        },
      },
      handler: async (args) => addGuide(connection, args),
    },
    {
      tool: {
        name: 'photoshop_clear_guides',
        description: 'Remove all ruler guides from the active document.',
        inputSchema: { type: 'object', properties: {} },
      },
      handler: async () => clearGuides(connection),
    },
    {
      tool: {
        name: 'photoshop_apply_levels',
        description:
          'Apply a Levels adjustment to the active layer. Lets you set the black/white input points ' +
          '(clipping), midtone gamma, and output range. Rasterizes text/smart object layers automatically.',
        inputSchema: {
          type: 'object',
          properties: {
            input_shadow: {
              type: 'number',
              description: 'Input black point (0-253, default 0)',
              minimum: 0,
              maximum: 253,
              default: 0,
            },
            input_highlight: {
              type: 'number',
              description: 'Input white point (2-255, default 255)',
              minimum: 2,
              maximum: 255,
              default: 255,
            },
            midtone_gamma: {
              type: 'number',
              description: 'Midtone gamma (0.10-9.99, default 1.0 = neutral)',
              minimum: 0.1,
              maximum: 9.99,
              default: 1.0,
            },
            output_shadow: {
              type: 'number',
              description: 'Output black point (0-255, default 0)',
              minimum: 0,
              maximum: 255,
              default: 0,
            },
            output_highlight: {
              type: 'number',
              description: 'Output white point (0-255, default 255)',
              minimum: 0,
              maximum: 255,
              default: 255,
            },
          },
        },
      },
      handler: async (args) => applyLevels(connection, args),
    },
    {
      tool: {
        name: 'photoshop_batch_export_layers',
        description:
          'Export multiple layers or groups as isolated PNGs in a single call. ' +
          "A group path exports the group's composite. To export a particular state of a group " +
          '(e.g. a button with only its "Pressed" child visible), pass show/hide with paths relative to it. ' +
          'Each layer is scaled, isolated (siblings hidden), cropped to bounds, merged, trimmed, and saved. ' +
          'The document is restored to its original state after each export via history state undo. ' +
          'Supports clipping masks: when apply_clipping_mask is true, the clip base layer is composited with the target. ' +
          'Results are returned as structured JSON with per-layer status, dimensions, and errors. ' +
          'Use this instead of multiple photoshop_export_layer_as_png + photoshop_scale_layer + photoshop_undo calls — ' +
          'replaces 4N MCP calls with 1.',
        inputSchema: {
          type: 'object',
          properties: {
            layers: {
              type: 'array',
              description: 'Array of layer export configs',
              items: {
                type: 'object',
                properties: {
                  path: {
                    type: 'string',
                    description:
                      'Slash-separated layer path, e.g. "Group Name/Layer Name". ' +
                      'Trailing/leading spaces in group names are matched flexibly.',
                  },
                  output_path: {
                    type: 'string',
                    description: 'Absolute output path for the PNG, e.g. /tmp/my_sprite.png',
                  },
                  scale_percent: {
                    type: 'number',
                    description:
                      'Scale percentage to resize the layer before export (e.g. 29.6 for ~30%). ' +
                      '100 = no scaling.',
                    default: 100,
                  },
                  apply_clipping_mask: {
                    type: 'boolean',
                    description:
                      'When true, find the clipping base layer (layer below) and composite both during export.',
                    default: false,
                  },
                  trim: {
                    type: 'boolean',
                    description: 'Trim transparent pixels from edges (default: true)',
                    default: true,
                  },
                  show: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                      'Paths relative to "path" to make visible before exporting, e.g. ["State Claim"]. ' +
                      'Applied after "hide".',
                  },
                  hide: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                      'Paths relative to "path" to hide before exporting, e.g. ["State Locked", "Badge"]. ' +
                      'Use "*" to hide every direct child, then list the ones you want in "show".',
                  },
                },
                required: ['path', 'output_path'],
              },
            },
            document_name: {
              type: 'string',
              description:
                'Target document by name (e.g. "Beach buddies Popup.psd"). ' +
                'Recommended in multi-document sessions — without it the export runs ' +
                'against whatever document currently has focus.',
            },
            timeout_seconds: {
              type: 'number',
              description:
                `Optional time limit in seconds for the whole batch (default 300, max ${MAX_TIMEOUT_SECONDS}). ` +
                'Raise it for many layers or a large document instead of splitting the batch.',
            },
          },
          required: ['layers'],
        },
      },
      handler: async (args) => batchExportLayers(connection, args),
    },
  ];
}

// ─── handlers ────────────────────────────────────────────────────────────────

async function getSessionInfo(connection: PhotoshopConnection): Promise<ToolResult> {
  try {
    const api = await new PhotoshopAPIFactory(connection).createAPI();
    const result = await api.executeScript(`
      var result = {
        version: app.version,
        build: app.build,
        isRunning: true,
        documentCount: app.documents.length,
        activeDocument: null,
        documents: [],
        preferences: {}
      };

      try {
        result.preferences.rulerUnits = String(app.preferences.rulerUnits);
        result.preferences.typeUnits  = String(app.preferences.typeUnits);
      } catch(e) {}

      for (var i = 0; i < app.documents.length; i++) {
        var doc = app.documents[i];
        var isActive = (doc === app.activeDocument);
        var docPath = '';
        try { docPath = doc.path.fsName; } catch(e) {}
        // saved: no unsaved changes. hasFile: the document exists on disk at all
        // (a new or duplicated document has no file until it is saved).
        var saved = null;
        try { saved = doc.saved; } catch(e) {}
        var entry = {
          name:       doc.name,
          path:       docPath,
          hasFile:    docPath !== '',
          saved:      saved,
          width:      Math.round(doc.width.as('px')),
          height:     Math.round(doc.height.as('px')),
          resolution: doc.resolution,
          colorMode:  String(doc.mode),
          bitDepth:   String(doc.bitsPerChannel),
          isActive:   isActive
        };
        if (isActive) {
          result.activeDocument = doc.name;
          try {
            var al = doc.activeLayer, parts = [];
            for (var n = al; n && n.typename !== 'Document'; n = n.parent) parts.unshift(n.name);
            result.activeLayer = { name: al.name, path: parts.join('/'), visible: al.visible };
          } catch(e) {}
        }
        result.documents.push(entry);
      }
      return result;
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

async function getSelectionInfo(connection: PhotoshopConnection): Promise<ToolResult> {
  try {
    const api = await new PhotoshopAPIFactory(connection).createAPI();
    const result = await api.executeScript(`
      if (app.documents.length === 0) throw new Error('No active document');
      var doc = app.activeDocument;
      try {
        var bounds = doc.selection.bounds;
        var l = bounds[0].as('px'), t = bounds[1].as('px'),
            r = bounds[2].as('px'), b = bounds[3].as('px');
        return {
          hasSelection: true,
          bounds: { left: l, top: t, right: r, bottom: b },
          width:  r - l,
          height: b - t,
          area:   (r - l) * (b - t)
        };
      } catch(e) {
        return { hasSelection: false };
      }
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

async function sampleColorAtPixel(
  connection: PhotoshopConnection,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const x = requireNumber(args, 'x');
  const y = requireNumber(args, 'y');
  try {
    const api = await new PhotoshopAPIFactory(connection).createAPI();
    const result = await api.executeScript(`
      if (app.documents.length === 0) throw new Error('No active document');
      var doc = app.activeDocument;
      var w = doc.width.as('px'), h = doc.height.as('px');
      if (${x} < 0 || ${y} < 0 || ${x} >= w || ${y} >= h) {
        throw new Error('Point (${x}, ${y}) is outside the ' + w + 'x' + h + ' canvas of "' + doc.name + '"');
      }
      var pt = [new UnitValue(${x}, 'px'), new UnitValue(${y}, 'px')];
      // Remove only our sampler, and always: removeAll() deleted the user's own
      // samplers, and a sampler left behind by a failed read used up the
      // document's few sampler slots, so later calls failed with a
      // "General Photoshop error".
      var sampler = doc.colorSamplers.add(pt);
      try {
        var color = sampler.color;
        var r = Math.round(color.rgb.red);
        var g = Math.round(color.rgb.green);
        var b = Math.round(color.rgb.blue);
      } finally {
        sampler.remove();
      }
      var hex = '#' +
        ('0' + r.toString(16)).slice(-2) +
        ('0' + g.toString(16)).slice(-2) +
        ('0' + b.toString(16)).slice(-2);
      return { x: ${x}, y: ${y}, r: r, g: g, b: b, hex: hex };
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

export interface ExportOptions {
  padding: number;
  scale: number;
  background?: { r: number; g: number; b: number };
  clipToCanvas: boolean;
  /** export_composite only: shrink to fit inside these, keeping proportions. */
  maxWidth?: number;
  maxHeight?: number;
  /** export_composite only: final canvas size, content centred. */
  canvasWidth?: number;
  canvasHeight?: number;
}

/** Validates the optional export arguments. */
export function exportOptions(args: Record<string, unknown>): ExportOptions {
  const padding = optionalNumber(args, 'padding', 0);
  if (!Number.isInteger(padding) || padding < 0 || padding > 4096) {
    throw new Error(`padding must be a whole number of pixels from 0 to 4096, got ${padding}`);
  }
  const scale = optionalNumber(args, 'scale', 100);
  if (scale <= 0 || scale > 1000)
    throw new Error(`scale must be above 0 and at most 1000 (%), got ${scale}`);
  const bg =
    typeof args.background === 'string' && args.background !== '' ? args.background : undefined;
  return {
    padding,
    scale,
    background: bg === undefined ? undefined : parseHexColor(bg),
    clipToCanvas: args.clip_to_canvas !== false,
  };
}

/**
 * ExtendScript run on the temp export document before it is saved: trim, then
 * scale (effects scale with it), then pad, then put a solid background
 * behind everything.
 */
export function exportFinishJs(trim: boolean, o: ExportOptions): string {
  const lines: string[] = [];
  if (trim)
    lines.push('try { newDoc.trim(TrimType.TRANSPARENT, true, true, true, true); } catch(e) {}');
  if (o.scale !== 100) {
    // Image Size with "Scale Styles" on, so strokes, shadows and glows scale with
    // the art; the DOM's resizeImage leaves them at their original size.
    lines.push(
      `var isz = new ActionDescriptor();`,
      `isz.putUnitDouble(app.charIDToTypeID('Wdth'), app.charIDToTypeID('#Pxl'), Math.max(1, Math.round(newDoc.width.as('px') * ${o.scale} / 100)));`,
      `isz.putBoolean(app.stringIDToTypeID('scaleStyles'), true);`,
      `isz.putBoolean(app.charIDToTypeID('CnsP'), true);`,
      `isz.putEnumerated(app.charIDToTypeID('Intr'), app.charIDToTypeID('Intp'), app.charIDToTypeID('Bcbc'));`,
      `executeAction(app.charIDToTypeID('ImgS'), isz, DialogModes.NO);`
    );
  }
  if (o.maxWidth !== undefined || o.maxHeight !== undefined) {
    lines.push(
      `var fitK = Math.min(1, ${o.maxWidth ?? 'Infinity'} / newDoc.width.as('px'), ${o.maxHeight ?? 'Infinity'} / newDoc.height.as('px'));`,
      `if (fitK < 1) {`,
      `  var fsz = new ActionDescriptor();`,
      `  fsz.putUnitDouble(app.charIDToTypeID('Wdth'), app.charIDToTypeID('#Pxl'), Math.max(1, Math.round(newDoc.width.as('px') * fitK)));`,
      `  fsz.putBoolean(app.stringIDToTypeID('scaleStyles'), true);`,
      `  fsz.putBoolean(app.charIDToTypeID('CnsP'), true);`,
      `  fsz.putEnumerated(app.charIDToTypeID('Intr'), app.charIDToTypeID('Intp'), app.charIDToTypeID('Bcbc'));`,
      `  executeAction(app.charIDToTypeID('ImgS'), fsz, DialogModes.NO);`,
      `}`
    );
  }
  if (o.canvasWidth !== undefined || o.canvasHeight !== undefined) {
    lines.push(
      `newDoc.resizeCanvas(UnitValue(${o.canvasWidth ?? "newDoc.width.as('px')"}, 'px'), ` +
        `UnitValue(${o.canvasHeight ?? "newDoc.height.as('px')"}, 'px'), AnchorPosition.MIDDLECENTER);`
    );
  }
  if (o.padding > 0) {
    lines.push(
      `newDoc.resizeCanvas(UnitValue(newDoc.width.as('px') + ${2 * o.padding}, 'px'), ` +
        `UnitValue(newDoc.height.as('px') + ${2 * o.padding}, 'px'), AnchorPosition.MIDDLECENTER);`
    );
  }
  if (o.background) {
    const { r, g, b } = o.background;
    lines.push(
      `var bgLayer = newDoc.artLayers.add(); bgLayer.name = 'background';`,
      `bgLayer.move(newDoc, ElementPlacement.PLACEATEND);`,
      `newDoc.selection.selectAll(); var bgColor = new SolidColor();`,
      `bgColor.rgb.red = ${r}; bgColor.rgb.green = ${g}; bgColor.rgb.blue = ${b};`,
      `newDoc.selection.fill(bgColor); newDoc.selection.deselect();`
    );
  }
  return lines.join('\n        ');
}

/**
 * ExtendScript helpers for the clipping-mask export. psLayerIndexPath gives the
 * active layer's position in the tree (a duplicate document has the same
 * tree), so the duplicate is searched by position rather than by name, which
 * picked the first of two same-named layers.
 *
 * psIsolateForClipExport hides everything except the target, its clip base
 * and the groups above them. Only siblings along that path are hidden, never
 * the contents of the target or the base: hiding every layer recursively left
 * a group used as a clip base with all its children off, so the export came
 * out empty, and turning them all back on would show children that are hidden
 * in the document.
 */
export const clipExportJs = `
function psLayerIndexPath(layer) {
  var path = [];
  for (var n = layer; n.typename !== 'Document'; n = n.parent) {
    var sibs = n.parent.layers;
    for (var i = 0; i < sibs.length; i++) {
      if (sibs[i] == n) { path.unshift(i); break; }
    }
  }
  return path.join(',');
}

function psIsolateForClipExport(doc, indexPath) {
  var idx = indexPath.split(',');
  var collection = doc.layers;
  var layer = null;
  for (var p = 0; p < idx.length; p++) {
    var at = parseInt(idx[p], 10);
    var keep = [at];
    if (p === idx.length - 1) {
      // The clip base is the first layer below the target that is not
      // itself clipped; the clipped layers in between are hidden.
      for (var ci = at + 1; ci < collection.length; ci++) {
        var cg = false;
        try { cg = collection[ci].grouped === true; } catch (e) {}
        if (!cg) { keep.push(ci); break; }
      }
    }
    for (var i = 0; i < collection.length; i++) {
      var kept = false;
      for (var k = 0; k < keep.length; k++) if (keep[k] === i) kept = true;
      collection[i].visible = kept;
    }
    layer = collection[at];
    if (p < idx.length - 1) collection = layer.layers;
  }
  return { layer: layer, clipBase: keep.length > 1 ? collection[keep[1]] : null };
}
`;

export interface CompositeArgs {
  outputPath: string;
  onlyLayers: string[];
  hideLayers: string[];
  region?: { left: number; top: number; right: number; bottom: number };
  trim: boolean;
  opts: ExportOptions;
}

/** Validates export_composite arguments. */
export function compositeArgs(args: Record<string, unknown>): CompositeArgs {
  const outputPath = requireString(args, 'output_path');
  const list = (name: string) => {
    const v = args[name] === undefined ? [] : args[name];
    if (!Array.isArray(v) || !v.every((p) => typeof p === 'string' && p !== '')) {
      throw new Error(`${name} must be an array of layer paths`);
    }
    return v as string[];
  };
  let region: CompositeArgs['region'];
  if (args.region !== undefined) {
    const r = args.region as Record<string, unknown>;
    const n = ['left', 'top', 'right', 'bottom'].map((k) => Number(r?.[k]));
    if (!n.every(Number.isFinite) || n[2] <= n[0] || n[3] <= n[1]) {
      throw new Error('region needs numeric left < right and top < bottom');
    }
    region = { left: n[0], top: n[1], right: n[2], bottom: n[3] };
  }
  const size = (name: string) => {
    if (args[name] === undefined) return undefined;
    const v = optionalNumber(args, name, 0);
    if (!Number.isInteger(v) || v < 1 || v > 30000) {
      throw new Error(`${name} must be a whole number of pixels from 1 to 30000, got ${v}`);
    }
    return v;
  };
  const opts: ExportOptions = {
    ...exportOptions(args),
    clipToCanvas: true,
    maxWidth: size('max_width'),
    maxHeight: size('max_height'),
    canvasWidth: size('canvas_width'),
    canvasHeight: size('canvas_height'),
  };
  return {
    outputPath,
    onlyLayers: list('only_layers'),
    hideLayers: list('hide_layers'),
    region,
    trim: args.trim === true,
    opts,
  };
}

/**
 * One script: duplicate the document, set visibility on the duplicate with
 * batch Hide/Show commands (by layer ID; per-layer DOM walks timed out on
 * large documents), crop, finish (trim, fit, scale, canvas, padding,
 * background), save the layered duplicate as PNG (keeps transparency), close
 * it, and return to the original.
 */
export function scriptExportComposite(a: CompositeArgs, tempName: string): string {
  const q = (paths: string[]) => `[${paths.map((p) => jsxString(p)).join(', ')}]`;
  return `
    if (app.documents.length === 0) throw new Error('No active document');
    function cTID(s) { return app.charIDToTypeID(s); }
    function sTID(s) { return app.stringIDToTypeID(s); }
    function tSID(t) { return app.typeIDToStringID(t); }
    var origDoc = app.activeDocument;
    var newDoc = origDoc.duplicate(${jsxString(tempName)});
    app.activeDocument = newDoc;

    function layerRef(index, prop) {
      var r = new ActionReference();
      if (prop) r.putProperty(cTID('Prpr'), sTID(prop));
      r.putIndex(cTID('Lyr '), index);
      return r;
    }
    function getProp(index, prop) {
      try { return executeActionGet(layerRef(index, prop)); } catch (e) { return null; }
    }
    var docRef = new ActionReference();
    docRef.putEnumerated(cTID('Dcmn'), cTID('Ordn'), cTID('Trgt'));
    var layerCount = executeActionGet(docRef).getInteger(sTID('numberOfLayers'));
    var firstIndex = getProp(0, 'layerID') ? 0 : 1;

    // Layer index of the duplicate: names, ids and nesting, top to bottom.
    var root = { children: [] }, stack = [root], all = [];
    for (var i = layerCount; i >= firstIndex; i--) {
      var sec = getProp(i, 'layerSection');
      if (!sec) continue;
      var section = tSID(sec.getEnumerationValue(sTID('layerSection')));
      if (section === 'layerSectionEnd') { if (stack.length > 1) stack.pop(); continue; }
      var parent = stack[stack.length - 1];
      var node = {
        id: getProp(i, 'layerID').getInteger(sTID('layerID')),
        name: getProp(i, 'name').getString(cTID('Nm  ')),
        visible: getProp(i, 'visible').getBoolean(cTID('Vsbl')),
        isGroup: section === 'layerSectionStart',
        parent: parent,
        children: []
      };
      parent.children.push(node);
      all.push(node);
      if (node.isGroup) stack.push(node);
    }
    function segment(n) {
      var sib = n.parent.children, count = 0, pos = 0;
      for (var k = 0; k < sib.length; k++) if (sib[k].name === n.name) { if (sib[k] === n) pos = count; count++; }
      return count > 1 ? n.name + '[' + pos + ']' : n.name;
    }
    function pathOf(n) {
      var parts = [];
      for (var x = n; x && x !== root; x = x.parent) parts.unshift(segment(x));
      return parts.join('/');
    }
    var byPath = {};
    for (var a2 = 0; a2 < all.length; a2++) byPath[pathOf(all[a2])] = all[a2];
    function resolve(paths, what) {
      var out = [], missing = [];
      for (var p = 0; p < paths.length; p++) {
        if (byPath.hasOwnProperty(paths[p])) out.push(byPath[paths[p]]); else missing.push(paths[p]);
      }
      if (missing.length) throw new Error(what + ' not found: ' + missing.join(', ') +
        '. Paths need [n] where siblings share a name; photoshop_find_layers returns exact paths.');
      return out;
    }
    var keep = resolve(${q(a.onlyLayers)}, 'only_layers');
    var hide = resolve(${q(a.hideLayers)}, 'hide_layers');

    var toHide = [], toShow = [];
    function want(n, v) { if (n.visible !== v) (v ? toShow : toHide).push(n.id); n.visible = v; }
    if (keep.length) {
      var keepIds = {}, pathIds = {};
      for (var k1 = 0; k1 < keep.length; k1++) {
        keepIds[keep[k1].id] = true;
        for (var up = keep[k1].parent; up && up !== root; up = up.parent) pathIds[up.id] = true;
      }
      (function apply(list) {
        for (var c = 0; c < list.length; c++) {
          var n = list[c];
          if (keepIds[n.id]) { want(n, true); continue; }
          if (pathIds[n.id]) { want(n, true); apply(n.children); continue; }
          want(n, false);
        }
      })(root.children);
    }
    for (var h = 0; h < hide.length; h++) want(hide[h], false);

    function batch(ids, eventId) {
      if (!ids.length) return;
      var list = new ActionList();
      for (var b = 0; b < ids.length; b++) {
        var r = new ActionReference();
        r.putIdentifier(cTID('Lyr '), ids[b]);
        list.putReference(r);
      }
      var d = new ActionDescriptor();
      d.putList(cTID('null'), list);
      executeAction(cTID(eventId), d, DialogModes.NO);
    }
    batch(toHide, 'Hd  ');
    batch(toShow, 'Shw ');

    ${
      a.region === undefined
        ? ''
        : `newDoc.crop([UnitValue(${a.region.left}, 'px'), UnitValue(${a.region.top}, 'px'), UnitValue(${a.region.right}, 'px'), UnitValue(${a.region.bottom}, 'px')]);`
    }
    ${exportFinishJs(a.trim, a.opts)}

    var pngOpts = new PNGSaveOptions();
    pngOpts.compression = 6;
    newDoc.saveAs(new File(${jsxString(a.outputPath)}), pngOpts, true);
    var w = Math.round(newDoc.width.as('px')), hgt = Math.round(newDoc.height.as('px'));
    newDoc.close(SaveOptions.DONOTSAVECHANGES);
    app.activeDocument = origDoc;
    return {
      exported: true,
      path: ${jsxString(a.outputPath)},
      width: w,
      height: hgt,
      hidden: toHide.length,
      shown: toShow.length,
      document: origDoc.name
    };
  `;
}

async function exportComposite(
  connection: PhotoshopConnection,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const tempName = `export_composite_tmp_${process.pid}`;
  const api = await new PhotoshopAPIFactory(connection).createAPI();
  let origDocName: string | undefined;
  try {
    const a = compositeArgs(args);
    origDocName = String(
      await api.executeScript(
        `if (app.documents.length === 0) throw new Error('No active document'); return app.activeDocument.name;`
      )
    );
    const result = await api.executeScript(
      scriptExportComposite(a, tempName),
      LONG_SCRIPT_TIMEOUT_MS
    );
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    await cleanUpExportDocs(api, [tempName], origDocName);
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

/**
 * After a failed export, closes the temp documents it may have left open (only
 * unsaved documents with exactly these names) and returns to the original
 * document. Leftovers used to stay open, and the clipped path left its temp
 * document active, so the next call worked on the wrong document. Best effort:
 * a cleanup failure must not hide the export error.
 */
async function cleanUpExportDocs(
  api: { executeScript(script: string, timeout?: number): Promise<unknown> },
  tempNames: string[],
  origDocName: string | undefined
): Promise<void> {
  try {
    await api.executeScript(`
      var names = ${JSON.stringify(tempNames)};
      for (var i = app.documents.length - 1; i >= 0; i--) {
        var d = app.documents[i];
        var saved = true;
        try { d.fullName; } catch (e) { saved = false; }
        for (var n = 0; n < names.length; n++) {
          if (d.name === names[n] && !saved) { d.close(SaveOptions.DONOTSAVECHANGES); break; }
        }
      }
      ${
        origDocName === undefined
          ? ''
          : `for (var j = 0; j < app.documents.length; j++) {
        if (app.documents[j].name === ${jsxString(origDocName)}) { app.activeDocument = app.documents[j]; break; }
      }`
      }
      return 1;
    `);
  } catch {
    // ignore: the export error is what the caller needs to see
  }
}

async function exportLayerAsPng(
  connection: PhotoshopConnection,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const outputPath = requireString(args, 'output_path');
  const trim = args.trim_transparency !== false;
  const applyClip = args.apply_clipping_mask !== false;
  const layerPath = typeof args.path === 'string' && args.path !== '' ? args.path : undefined;
  // Temp document names, and the document to return to, for cleanup on failure.
  const dupDocName = `export_clip_tmp_${process.pid}`;
  const pasteDocName = `clip_export_${process.pid}`;
  const simpleDocName = 'layer_export_tmp';
  let origDocName: string | undefined;
  const api = await new PhotoshopAPIFactory(connection).createAPI();
  try {
    const opts = exportOptions(args);
    const finishJs = exportFinishJs(trim, opts);
    // Callers passed a layer path expecting it to be exported; without this the
    // tool silently exported whichever layer happened to be active.
    if (layerPath) {
      await api.executeScript(`
        ${layerPathResolver}
        if (app.documents.length === 0) throw new Error('No active document');
        psActivate(app.activeDocument, psResolveLayerPath(app.activeDocument, ${jsxString(layerPath)}));
        return 1;
      `);
    }

    // Step 0: Detect if layer is clipped
    // Return as pipe-delimited string since ExtendScript toSource() isn't valid JSON
    const detection = await api.executeScript(`
      ${clipExportJs}
      if (app.documents.length === 0) throw new Error('No active document');
      var srcLayer = app.activeDocument.activeLayer;
      var isClipped = false;
      try { isClipped = srcLayer.grouped; } catch(e) {}
      return (isClipped ? '1' : '0') + '|' + psLayerIndexPath(srcLayer) + '|' +
        srcLayer.name.length + '|' + srcLayer.name + app.activeDocument.name;
    `);

    // clipped | index path | layer name length | layer name + doc name. Both
    // names may contain '|', so the layer name is cut by its length.
    const detStr = String(detection);
    const m = /^([01])\|([\d,]+)\|(\d+)\|([\s\S]*)$/.exec(detStr);
    if (!m) throw new Error(`Unexpected layer detection result: ${detStr}`);
    const isClipped = m[1] === '1';
    const indexPath = m[2];
    const layerName = m[4].substring(0, Number(m[3]));
    origDocName = m[4].substring(Number(m[3]));

    // Unique temp doc names — lets every step resolve its document BY NAME
    // instead of trusting app.activeDocument, which a user click between the
    // sequential osascript invocations can silently change (the wrong-focus
    // bug: step 4 would then trim/save/CLOSE whatever document had focus).
    const docByNameJs = `
      function docByName(n) {
        for (var di = 0; di < app.documents.length; di++)
          if (app.documents[di].name === n) return app.documents[di];
        return null;
      }
    `;

    if (applyClip && isClipped) {
      // ── CLIPPING MASK PATH (multi-step to avoid PS scripting engine crashes) ──
      // Large documents crash when duplicate → copy merged → close → add → paste
      // runs in a single script. Breaking into sequential steps fixes this.

      // Step 1: Duplicate doc, hide all, show target + clip base + ancestors
      await api.executeScript(
        `
        ${docByNameJs}
        var origDoc = docByName(${jsxString(origDocName)});
        if (!origDoc) throw new Error('Original document no longer open: ' + ${jsxString(origDocName)});
        var dupDoc = origDoc.duplicate(${jsxString(dupDocName)});
        app.activeDocument = dupDoc;

        ${clipExportJs}
        var info = psIsolateForClipExport(dupDoc, ${jsxString(indexPath)});
        if (info.layer.name !== ${jsxString(layerName)})
          throw new Error('Layer at the same position in the duplicate is "' + info.layer.name + '", expected ' + ${jsxString(layerName)});
        var clipBase = info.clipBase;
        ${
          opts.clipToCanvas
            ? ''
            : `// Copy Merged only takes what is on the canvas, so the canvas is grown
        // to cover the layer and its effects first.
        var lb = info.layer.bounds, W = dupDoc.width.as('px'), H = dupDoc.height.as('px');
        var m = Math.max(0, -lb[0].as('px'), -lb[1].as('px'), lb[2].as('px') - W, lb[3].as('px') - H);
        if (m > 0) dupDoc.resizeCanvas(UnitValue(W + 2 * m + 16, 'px'), UnitValue(H + 2 * m + 16, 'px'), AnchorPosition.MIDDLECENTER);`
        }

        return { ready: true, clipBase: clipBase ? clipBase.name : null };
      `,
        LONG_SCRIPT_TIMEOUT_MS
      );

      // Step 2: Copy Merged (composites visible layers respecting clip mask + shape)
      await api.executeScript(
        `
        ${docByNameJs}
        var dupDoc = docByName(${jsxString(dupDocName)});
        if (!dupDoc) throw new Error('Temp document vanished: ' + ${jsxString(dupDocName)});
        app.activeDocument = dupDoc;
        dupDoc.selection.selectAll();
        dupDoc.selection.copy(true);
        return { copied: true };
      `,
        LONG_SCRIPT_TIMEOUT_MS
      );

      // Step 3: Close dup doc, create new transparent doc, paste
      await api.executeScript(
        `
        ${docByNameJs}
        var dupDoc = docByName(${jsxString(dupDocName)});
        if (!dupDoc) throw new Error('Temp document vanished: ' + ${jsxString(dupDocName)});
        var ow = dupDoc.width;
        var oh = dupDoc.height;
        var ores = dupDoc.resolution;
        dupDoc.close(SaveOptions.DONOTSAVECHANGES);

        var newDoc = app.documents.add(ow, oh, ores, ${jsxString(pasteDocName)}, NewDocumentMode.RGB, DocumentFill.TRANSPARENT);
        app.activeDocument = newDoc;
        newDoc.paste();
        try { newDoc.selection.deselect(); } catch(e) {}
        return { pasted: true };
      `,
        LONG_SCRIPT_TIMEOUT_MS
      );

      // Step 4: Trim, save, close, return to original doc — all by name,
      // never via app.activeDocument (user focus changes between scripts).
      const result = await api.executeScript(
        `
        ${docByNameJs}
        var newDoc = docByName(${jsxString(pasteDocName)});
        if (!newDoc) throw new Error('Paste document vanished: ' + ${jsxString(pasteDocName)});
        app.activeDocument = newDoc;
        ${finishJs}

        var saveFile = new File(${jsxString(outputPath)});
        var pngOpts = new PNGSaveOptions();
        pngOpts.compression = 6;
        newDoc.saveAs(saveFile, pngOpts, true);

        var w = Math.round(newDoc.width.as('px'));
        var h = Math.round(newDoc.height.as('px'));
        newDoc.close(SaveOptions.DONOTSAVECHANGES);

        var origDoc = docByName(${jsxString(origDocName)});
        if (origDoc) app.activeDocument = origDoc;

        return {
          exported: true,
          layerName: ${jsxString(layerName)},
          path: ${jsxString(outputPath)},
          width: w,
          height: h,
          trimmed: ${trim},
          scale: ${opts.scale},
          padding: ${opts.padding},
          clipToCanvas: ${opts.clipToCanvas},
          clippingApplied: true
        };
      `,
        LONG_SCRIPT_TIMEOUT_MS
      );

      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    } else {
      // ── SIMPLE PATH (no clipping mask) ────────────────────────────────
      const result = await api.executeScript(
        `
        var origDoc = app.activeDocument;
        var srcLayer = origDoc.activeLayer;

        ${
          opts.clipToCanvas
            ? 'var docW = origDoc.width, docH = origDoc.height, M = 0;'
            : `// Sized to the layer's own bounds (effects included) plus a margin, so
        // content and effects beyond the original canvas are kept.
        var ob = srcLayer.bounds, M = 16;
        var docW = UnitValue(Math.max(1, ob[2].as('px') - ob[0].as('px') + 2 * M), 'px');
        var docH = UnitValue(Math.max(1, ob[3].as('px') - ob[1].as('px') + 2 * M), 'px');`
        }
        var newDoc = app.documents.add(
          docW, docH, origDoc.resolution,
          ${jsxString(simpleDocName)}, NewDocumentMode.RGB, DocumentFill.TRANSPARENT
        );
        app.activeDocument = origDoc;
        srcLayer.duplicate(newDoc, ElementPlacement.PLACEATBEGINNING);
        app.activeDocument = newDoc;
        // A hidden layer is exported as it looks when shown; only the copy is
        // made visible, so the original document is left as it was.
        newDoc.activeLayer.visible = true;
        if (M > 0) {
          // A layer copied into a document of another size lands centred, not at
          // its old coordinates, so it is placed from where it actually is.
          var nb = newDoc.activeLayer.bounds;
          var dx = M - nb[0].as('px'), dy = M - nb[1].as('px');
          if (dx !== 0 || dy !== 0) newDoc.activeLayer.translate(UnitValue(dx, 'px'), UnitValue(dy, 'px'));
        }

        // Smart Objects may export blank after duplicate — rasterize to materialize pixels
        try {
          if (newDoc.activeLayer.kind === LayerKind.SMARTOBJECT) {
            newDoc.activeLayer.rasterize(RasterizeType.ENTIRELAYER);
          }
        } catch(e) {}

        ${finishJs}

        var saveFile = new File(${jsxString(outputPath)});
        var pngOpts = new PNGSaveOptions();
        pngOpts.compression = 6;
        newDoc.saveAs(saveFile, pngOpts, true);

        var w = Math.round(newDoc.width.as('px'));
        var h = Math.round(newDoc.height.as('px'));
        newDoc.close(SaveOptions.DONOTSAVECHANGES);
        app.activeDocument = origDoc;

        return {
          exported: true,
          layerName: ${jsxString(layerName)},
          path: ${jsxString(outputPath)},
          width: w,
          height: h,
          trimmed: ${trim},
          scale: ${opts.scale},
          padding: ${opts.padding},
          clipToCanvas: ${opts.clipToCanvas},
          clippingApplied: false
        };
      `,
        LONG_SCRIPT_TIMEOUT_MS
      );
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    }
  } catch (error) {
    await cleanUpExportDocs(api, [dupDocName, pasteDocName, simpleDocName], origDocName);
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

async function duplicateDocument(
  connection: PhotoshopConnection,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const name = args.name as string | undefined;
  try {
    const api = await new PhotoshopAPIFactory(connection).createAPI();
    const result = await api.executeScript(`
      if (app.documents.length === 0) throw new Error('No active document');
      var doc = app.activeDocument;
      var dupName = ${name ? jsxString(name) : 'doc.name + " copy"'};
      var dup = doc.duplicate(dupName);
      return {
        duplicated: true,
        originalName: doc.name,
        newName: dup.name
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

async function setActiveDocument(
  connection: PhotoshopConnection,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const name = requireString(args, 'name');
  try {
    const api = await new PhotoshopAPIFactory(connection).createAPI();
    const result = await api.executeScript(`
      var targetName = ${jsxString(name)};
      for (var i = 0; i < app.documents.length; i++) {
        if (app.documents[i].name === targetName) {
          app.activeDocument = app.documents[i];
          return { activated: true, name: targetName };
        }
      }
      throw new Error('Document not found: ' + targetName);
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

async function addGuide(
  connection: PhotoshopConnection,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const orientation = requireString(args, 'orientation').toUpperCase();
  const position = requireNumber(args, 'position');
  try {
    const api = await new PhotoshopAPIFactory(connection).createAPI();
    const result = await api.executeScript(`
      if (app.documents.length === 0) throw new Error('No active document');
      var doc = app.activeDocument;
      var dir = ${jsxString(orientation)} === 'HORIZONTAL' ? Direction.HORIZONTAL : Direction.VERTICAL;
      doc.guides.add(dir, new UnitValue(${position}, 'px'));
      return {
        added: true,
        orientation: ${jsxString(orientation)},
        position: ${position}
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

async function clearGuides(connection: PhotoshopConnection): Promise<ToolResult> {
  try {
    const api = await new PhotoshopAPIFactory(connection).createAPI();
    const result = await api.executeScript(`
      if (app.documents.length === 0) throw new Error('No active document');
      var doc = app.activeDocument;
      var count = doc.guides.length;
      doc.guides.removeAll();
      return { cleared: true, removedCount: count };
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

export async function batchExportLayers(
  connection: PhotoshopConnection,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const layers = args.layers as Array<{
    path: string;
    output_path: string;
    scale_percent?: number;
    apply_clipping_mask?: boolean;
    trim?: boolean;
    show?: string[];
    hide?: string[];
  }>;

  if (!layers || layers.length === 0) {
    return {
      content: [{ type: 'text' as const, text: 'Error: layers array is empty or missing' }],
      isError: true,
    };
  }
  const timeoutMs = optionalTimeoutMs(args, LONG_SCRIPT_TIMEOUT_MS);

  try {
    const api = await new PhotoshopAPIFactory(connection).createAPI();

    // Build the layer configs as a JS literal for injection into ExtendScript
    const stringList = (v: unknown, field: string, i: number): string[] => {
      if (v === undefined) return [];
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
        throw new Error(`layers[${i}].${field} must be an array of layer paths`);
      }
      return v as string[];
    };
    const configEntries = layers.map((l, i) => {
      const scale = Number(l.scale_percent ?? 100);
      if (!Number.isFinite(scale) || scale <= 0) {
        throw new Error(`layers[${i}].scale_percent must be a positive number`);
      }
      const clip = l.apply_clipping_mask === true;
      const trim = l.trim !== false;
      const show = stringList(l.show, 'show', i).map(jsxString).join(',');
      const hide = stringList(l.hide, 'hide', i).map(jsxString).join(',');
      return `{path:${jsxString(l.path)},output_path:${jsxString(l.output_path)},scale_percent:${scale},apply_clipping_mask:${clip},trim:${trim},show:[${show}],hide:[${hide}]}`;
    });
    const configArrayStr = '[' + configEntries.join(',') + ']';

    const targetDocName = (args.document_name as string) || '';
    const result = await api.executeScript(
      `
      var doc = app.activeDocument;
      if (${jsxString(targetDocName)}) {
        doc = null;
        for (var di = 0; di < app.documents.length; di++) {
          if (app.documents[di].name === ${jsxString(targetDocName)}) { doc = app.documents[di]; break; }
        }
        if (!doc) throw new Error('Document not open: ' + ${jsxString(targetDocName)});
        app.activeDocument = doc;
      }
      var CONFIGS = ${configArrayStr};
      var results = [];

      function findLayer(parent, name) {
        name = name.replace(/^\\s+|\\s+$/g, '');
        try {
          for (var j = 0; j < parent.layerSets.length; j++) {
            if (parent.layerSets[j].name.replace(/^\\s+|\\s+$/g, '') === name)
              return parent.layerSets[j];
          }
        } catch(e) {}
        try {
          for (var j = 0; j < parent.artLayers.length; j++) {
            if (parent.artLayers[j].name.replace(/^\\s+|\\s+$/g, '') === name)
              return parent.artLayers[j];
          }
        } catch(e) {}
        return null;
      }

      function findLayerByPath(path) {
        var parts = path.split('/');
        var current = doc;
        for (var i = 0; i < parts.length; i++) {
          current = findLayer(current, parts[i]);
          if (!current) return null;
        }
        return current;
      }

      function hideAllChildren(parent) {
        try { for (var i = 0; i < parent.layerSets.length; i++) parent.layerSets[i].visible = false; } catch(e) {}
        try { for (var i = 0; i < parent.artLayers.length; i++) parent.artLayers[i].visible = false; } catch(e) {}
      }

      function isolateLayerPath(path) {
        var parts = path.split('/');
        var current = doc;
        hideAllChildren(doc);
        for (var i = 0; i < parts.length; i++) {
          var found = findLayer(current, parts[i]);
          if (found) {
            found.visible = true;
            if (i < parts.length - 1) hideAllChildren(found);
            current = found;
          }
        }
        return current;
      }

      // Visibility changes are not part of the history (unless the user turned
      // on "Make Layer Visibility Changes Undoable"), so resetting the history
      // state after an export left every layer isolateLayerPath hid still hidden
      // in the user's document. Record and restore visibility explicitly.
      function snapshotVisibility(parent, out) {
        for (var i = 0; i < parent.layers.length; i++) {
          var l = parent.layers[i];
          out.push([l, l.visible]);
          if (l.typename === 'LayerSet') snapshotVisibility(l, out);
        }
        return out;
      }
      function restoreVisibility(snap) {
        for (var i = 0; i < snap.length; i++) {
          try { if (snap[i][0].visible !== snap[i][1]) snap[i][0].visible = snap[i][1]; } catch (e) {}
        }
      }

      function findRelative(base, relPath) {
        var parts = relPath.split('/');
        var current = base;
        for (var i = 0; i < parts.length; i++) {
          current = findLayer(current, parts[i]);
          if (!current) return null;
        }
        return current;
      }

      // Sets the visibility of children of the exported group, so one group
      // can be exported in several states (e.g. a button's Normal / Pressed).
      function applyStates(target, cfg) {
        if (!cfg.hide.length && !cfg.show.length) return;
        if (target.typename !== 'LayerSet') {
          throw new Error('show/hide need "path" to be a group, but it is a layer');
        }
        for (var h = 0; h < cfg.hide.length; h++) {
          if (cfg.hide[h] === '*') { hideAllChildren(target); continue; }
          var hl = findRelative(target, cfg.hide[h]);
          if (!hl) throw new Error('hide: "' + cfg.hide[h] + '" not found under "' + cfg.path + '"');
          hl.visible = false;
        }
        for (var s = 0; s < cfg.show.length; s++) {
          var sl = findRelative(target, cfg.show[s]);
          if (!sl) throw new Error('show: "' + cfg.show[s] + '" not found under "' + cfg.path + '"');
          // A child only renders if every group between it and the target is visible.
          for (var p = sl; p && p !== target; p = p.parent) p.visible = true;
        }
      }

      function findClipBase(targetLayer) {
        var parent = targetLayer.parent;
        try {
          var layers = parent.layers;
          var foundTarget = false;
          for (var i = 0; i < layers.length; i++) {
            if (foundTarget) return layers[i];
            if (layers[i] === targetLayer) foundTarget = true;
          }
        } catch(e) {}
        return null;
      }

      for (var ci = 0; ci < CONFIGS.length; ci++) {
        var cfg = CONFIGS[ci];
        try {
          var layer = findLayerByPath(cfg.path);
          if (!layer) {
            results.push(cfg.output_path + '|NOT_FOUND|0|0');
            continue;
          }

          doc.activeLayer = layer;
          var preState = doc.activeHistoryState;
          var preVisibility = snapshotVisibility(doc, []);

          // Isolate visibility BEFORE any resize — DOM transforms throw
          // "User cancelled the operation" on hidden layers
          isolateLayerPath(cfg.path);
          applyStates(layer, cfg);

          // Scale if needed
          if (cfg.scale_percent !== 100) {
            layer.visible = true;
            layer.resize(cfg.scale_percent, cfg.scale_percent, AnchorPosition.MIDDLECENTER);
          }

          // Clipping mask handling
          if (cfg.apply_clipping_mask) {
            var clipBase = findClipBase(layer);
            if (clipBase) {
              clipBase.visible = true;
              if (cfg.scale_percent !== 100) {
                clipBase.resize(cfg.scale_percent, cfg.scale_percent, AnchorPosition.MIDDLECENTER);
              }
            }
          }

          // Crop to layer bounds
          var b = layer.bounds;
          doc.crop([b[0], b[1], b[2], b[3]]);

          // Merge visible
          doc.mergeVisibleLayers();

          // Trim transparent pixels
          if (cfg.trim) {
            try { doc.trim(TrimType.TRANSPARENT, true, true, true, true); } catch(e) {}
          }

          var w = Math.round(doc.width.as('px'));
          var h = Math.round(doc.height.as('px'));

          // Save as PNG
          var pngOpts = new PNGSaveOptions();
          pngOpts.compression = 6;
          pngOpts.interlaced = false;
          doc.saveAs(new File(cfg.output_path), pngOpts, true, Extension.LOWERCASE);

          results.push(cfg.output_path + '|OK|' + w + '|' + h);

          // Undo all changes back to pre-state
          doc.activeHistoryState = preState;
          restoreVisibility(preVisibility);

        } catch(e) {
          try { doc.activeHistoryState = preState; } catch(e2) {}
          try { restoreVisibility(preVisibility); } catch(e3) {}
          results.push(cfg.output_path + '|ERROR|' + e.message + '|0');
        }
      }

      return results.join('\\n');
    `,
      timeoutMs
    );

    // Parse pipe-delimited results into structured JSON
    const resultStr = String(result);
    const lines = resultStr.split('\n').filter((l: string) => l.length > 0);
    const exportResults: object[] = [];
    let successCount = 0;
    let errorCount = 0;

    for (const line of lines) {
      const parts = line.split('|');
      const status = parts[1];
      if (status === 'OK') {
        successCount++;
        exportResults.push({
          output_path: parts[0],
          status: 'OK',
          width: parseInt(parts[2], 10),
          height: parseInt(parts[3], 10),
        });
      } else {
        errorCount++;
        exportResults.push({
          output_path: parts[0],
          status,
          error: status === 'ERROR' ? parts[2] : undefined,
        });
      }
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              batch_export: true,
              total: layers.length,
              success: successCount,
              errors: errorCount,
              results: exportResults,
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Batch export error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

async function applyLevels(
  connection: PhotoshopConnection,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const inputShadow = (args.input_shadow as number) ?? 0;
  const inputHighlight = (args.input_highlight as number) ?? 255;
  const midtoneGamma = (args.midtone_gamma as number) ?? 1.0;
  const outputShadow = (args.output_shadow as number) ?? 0;
  const outputHighlight = (args.output_highlight as number) ?? 255;
  try {
    const api = await new PhotoshopAPIFactory(connection).createAPI();
    const result = await api.executeScript(`
      if (app.documents.length === 0) throw new Error('No active document');
      var layer = app.activeDocument.activeLayer;
      if (layer.kind === LayerKind.TEXT || layer.kind === LayerKind.SMARTOBJECT) {
        layer.rasterize(RasterizeType.ENTIRELAYER);
      }
      layer.adjustLevels(${inputShadow}, ${inputHighlight}, ${midtoneGamma}, ${outputShadow}, ${outputHighlight});
      return {
        applied: true,
        adjustment: 'Levels',
        inputShadow: ${inputShadow},
        inputHighlight: ${inputHighlight},
        midtoneGamma: ${midtoneGamma},
        outputShadow: ${outputShadow},
        outputHighlight: ${outputHighlight}
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
