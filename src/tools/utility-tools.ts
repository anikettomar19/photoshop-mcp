import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { PhotoshopConnection } from '../platform/connection.js';
import { PhotoshopAPIFactory } from '../api/photoshop-api.js';

export function createUtilityTools(connection: PhotoshopConnection): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'photoshop_get_session_info',
        description:
          'Get Photoshop session info: all open documents (names, sizes, paths), the active document, ' +
          'and user preferences (ruler units, type units). Useful to see what files are open before acting.',
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
        name: 'photoshop_export_layer_as_png',
        description:
          'Export the currently active layer as an isolated PNG file. ' +
          'Automatically detects clipping masks: if the layer is clipped to a layer below it, ' +
          'Photoshop composites just those two layers (respecting the clip boundary) and exports the result — ' +
          'so the output matches exactly what you see in Photoshop. ' +
          'Transparent pixels outside the clip boundary are preserved. ' +
          'Supports normal layers, Smart Objects, and layer groups.',
        inputSchema: {
          type: 'object',
          properties: {
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
              description: 'Position in pixels (distance from top for horizontal, from left for vertical)',
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
        result.documents.push({
          name:       doc.name,
          path:       docPath,
          width:      Math.round(doc.width.as('px')),
          height:     Math.round(doc.height.as('px')),
          resolution: doc.resolution,
          colorMode:  String(doc.mode),
          bitDepth:   doc.bitsPerChannel,
          isActive:   isActive
        });
        if (isActive) result.activeDocument = doc.name;
      }
      return result;
    `);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    return { content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
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
    return { content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

async function sampleColorAtPixel(
  connection: PhotoshopConnection,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const x = args.x as number;
  const y = args.y as number;
  try {
    const api = await new PhotoshopAPIFactory(connection).createAPI();
    const result = await api.executeScript(`
      if (app.documents.length === 0) throw new Error('No active document');
      var doc = app.activeDocument;
      var pt = [new UnitValue(${x}, 'px'), new UnitValue(${y}, 'px')];
      var sampler = doc.colorSamplers.add(pt);
      var color = sampler.color;
      var r = Math.round(color.rgb.red);
      var g = Math.round(color.rgb.green);
      var b = Math.round(color.rgb.blue);
      doc.colorSamplers.removeAll();
      var hex = '#' +
        ('0' + r.toString(16)).slice(-2) +
        ('0' + g.toString(16)).slice(-2) +
        ('0' + b.toString(16)).slice(-2);
      return { x: ${x}, y: ${y}, r: r, g: g, b: b, hex: hex };
    `);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    return { content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

async function exportLayerAsPng(
  connection: PhotoshopConnection,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const outputPath = (args.output_path as string).replace(/\\/g, '\\\\');
  const trim = args.trim_transparency !== false;
  const applyClip = args.apply_clipping_mask !== false;
  try {
    const api = await new PhotoshopAPIFactory(connection).createAPI();
    const result = await api.executeScript(`
      if (app.documents.length === 0) throw new Error('No active document');
      var origDoc = app.activeDocument;
      var srcLayer = origDoc.activeLayer;
      var layerName = srcLayer.name;

      // Detect clipping mask
      var isClipped = false;
      try { isClipped = srcLayer.grouped; } catch(e) {}

      var applyClip = ${applyClip};

      if (applyClip && isClipped) {
        // ── CLIPPING MASK PATH ─────────────────────────────────────────────
        // Duplicate entire document so we can non-destructively manipulate visibility
        var dupDoc = origDoc.duplicate('export_clip_tmp');
        app.activeDocument = dupDoc;

        // Recursively hide all layers
        function hideAll(layers) {
          for (var i = 0; i < layers.length; i++) {
            layers[i].visible = false;
            if (layers[i].typename === 'LayerSet') hideAll(layers[i].layers);
          }
        }
        hideAll(dupDoc.layers);

        // Find target layer by name, track ancestors (groups) and sibling collection
        function findInfo(layers, name, ancestors) {
          ancestors = ancestors || [];
          for (var i = 0; i < layers.length; i++) {
            if (layers[i].name === name) {
              return { layer: layers[i], parent: layers, index: i, ancestors: ancestors };
            }
            if (layers[i].typename === 'LayerSet') {
              var r = findInfo(layers[i].layers, name, ancestors.concat([layers[i]]));
              if (r) return r;
            }
          }
          return null;
        }

        var info = findInfo(dupDoc.layers, layerName);
        if (!info) throw new Error('Layer not found in duplicate: ' + layerName);

        // Show target layer
        info.layer.visible = true;

        // Find clip base: first layer below target in same parent that is NOT grouped
        var clipBase = null;
        for (var ci = info.index + 1; ci < info.parent.length; ci++) {
          var candidate = info.parent[ci];
          var candidateGrouped = false;
          try { candidateGrouped = candidate.grouped; } catch(e) {}
          if (!candidateGrouped) { clipBase = candidate; break; }
        }
        if (clipBase) clipBase.visible = true;

        // Make all ancestor groups visible so the layers render
        for (var ai = 0; ai < info.ancestors.length; ai++) {
          info.ancestors[ai].visible = true;
        }

        // selection.copy(true) = "Copy Merged" — composites visible layers
        // respecting the clipping mask, preserving the alpha channel
        dupDoc.selection.selectAll();
        dupDoc.selection.copy(true);
        dupDoc.close(SaveOptions.DONOTSAVECHANGES);

        // Paste into a new transparent document
        var newDoc = app.documents.add(
          origDoc.width, origDoc.height, origDoc.resolution,
          'clip_export', NewDocumentMode.RGB, DocumentFill.TRANSPARENT
        );
        newDoc.paste();
        try { newDoc.selection.deselect(); } catch(e) {}

        ${trim ? `try { newDoc.trim(TrimType.TRANSPARENT, true, true, true, true); } catch(e) {}` : ''}

        var saveFile = new File("${outputPath}");
        var pngOpts = new PNGSaveOptions();
        pngOpts.compression = 6;
        newDoc.saveAs(saveFile, pngOpts, true);

        var w = Math.round(newDoc.width.as('px'));
        var h = Math.round(newDoc.height.as('px'));
        newDoc.close(SaveOptions.DONOTSAVECHANGES);
        app.activeDocument = origDoc;

        return {
          exported: true,
          layerName: layerName,
          path: "${outputPath}",
          width: w,
          height: h,
          trimmed: ${trim},
          clippingApplied: true,
          clipBase: clipBase ? clipBase.name : null
        };

      } else {
        // ── SIMPLE PATH (no clipping mask) ────────────────────────────────
        var newDoc = app.documents.add(
          origDoc.width, origDoc.height, origDoc.resolution,
          'layer_export_tmp', NewDocumentMode.RGB, DocumentFill.TRANSPARENT
        );
        app.activeDocument = origDoc;
        srcLayer.duplicate(newDoc, ElementPlacement.PLACEATBEGINNING);
        app.activeDocument = newDoc;

        ${trim ? `try { newDoc.trim(TrimType.TRANSPARENT, true, true, true, true); } catch(e) {}` : ''}

        var saveFile = new File("${outputPath}");
        var pngOpts = new PNGSaveOptions();
        pngOpts.compression = 6;
        newDoc.saveAs(saveFile, pngOpts, true);

        var w = Math.round(newDoc.width.as('px'));
        var h = Math.round(newDoc.height.as('px'));
        newDoc.close(SaveOptions.DONOTSAVECHANGES);
        app.activeDocument = origDoc;

        return {
          exported: true,
          layerName: layerName,
          path: "${outputPath}",
          width: w,
          height: h,
          trimmed: ${trim},
          clippingApplied: false
        };
      }
    `);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    return { content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
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
      var dupName = ${name ? `"${name.replace(/"/g, '\\"')}"` : 'doc.name + " copy"'};
      var dup = doc.duplicate(dupName);
      return {
        duplicated: true,
        originalName: doc.name,
        newName: dup.name
      };
    `);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    return { content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

async function setActiveDocument(
  connection: PhotoshopConnection,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const name = args.name as string;
  try {
    const api = await new PhotoshopAPIFactory(connection).createAPI();
    const result = await api.executeScript(`
      var targetName = "${name.replace(/"/g, '\\"')}";
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
    return { content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

async function addGuide(
  connection: PhotoshopConnection,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const orientation = (args.orientation as string).toUpperCase();
  const position = args.position as number;
  try {
    const api = await new PhotoshopAPIFactory(connection).createAPI();
    const result = await api.executeScript(`
      if (app.documents.length === 0) throw new Error('No active document');
      var doc = app.activeDocument;
      var dir = "${orientation}" === 'HORIZONTAL' ? Direction.HORIZONTAL : Direction.VERTICAL;
      doc.guides.add(dir, new UnitValue(${position}, 'px'));
      return {
        added: true,
        orientation: "${orientation}",
        position: ${position}
      };
    `);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    return { content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
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
    return { content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}

async function applyLevels(
  connection: PhotoshopConnection,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const inputShadow    = (args.input_shadow    as number) ?? 0;
  const inputHighlight = (args.input_highlight as number) ?? 255;
  const midtoneGamma   = (args.midtone_gamma   as number) ?? 1.0;
  const outputShadow   = (args.output_shadow   as number) ?? 0;
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
    return { content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }], isError: true };
  }
}
