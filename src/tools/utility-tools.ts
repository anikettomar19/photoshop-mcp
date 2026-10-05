import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { PhotoshopConnection } from '../platform/connection.js';
import { PhotoshopAPIFactory } from '../api/photoshop-api.js';
import { LONG_SCRIPT_TIMEOUT_MS } from '../platform/script-executor.js';
import { requireString, requireNumber } from '../utils/args.js';
import { jsxString } from '../utils/jsx.js';
import { layerPathResolver } from '../api/extendscript.js';

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

async function exportLayerAsPng(
  connection: PhotoshopConnection,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const outputPath = requireString(args, 'output_path');
  const trim = args.trim_transparency !== false;
  const applyClip = args.apply_clipping_mask !== false;
  const layerPath = typeof args.path === 'string' && args.path !== '' ? args.path : undefined;
  try {
    const api = await new PhotoshopAPIFactory(connection).createAPI();

    // Callers passed a layer path expecting it to be exported; without this the
    // tool silently exported whichever layer happened to be active.
    if (layerPath) {
      await api.executeScript(`
        ${layerPathResolver}
        if (app.documents.length === 0) throw new Error('No active document');
        app.activeDocument.activeLayer = psResolveLayerPath(app.activeDocument, ${jsxString(layerPath)});
        return 1;
      `);
    }

    // Step 0: Detect if layer is clipped
    // Return as pipe-delimited string since ExtendScript toSource() isn't valid JSON
    const detection = await api.executeScript(`
      if (app.documents.length === 0) throw new Error('No active document');
      var srcLayer = app.activeDocument.activeLayer;
      var isClipped = false;
      try { isClipped = srcLayer.grouped; } catch(e) {}
      return srcLayer.name + '|' + (isClipped ? '1' : '0') + '|' + app.activeDocument.name;
    `);

    // Parse from the right — layer names may contain '|', doc name is last.
    const detStr = String(detection);
    const docSep = detStr.lastIndexOf('|');
    const origDocName = detStr.substring(docSep + 1);
    const rest = detStr.substring(0, docSep);
    const sepIdx = rest.lastIndexOf('|');
    const layerName = rest.substring(0, sepIdx);
    const isClipped = rest.substring(sepIdx + 1) === '1';

    // Unique temp doc names — lets every step resolve its document BY NAME
    // instead of trusting app.activeDocument, which a user click between the
    // sequential osascript invocations can silently change (the wrong-focus
    // bug: step 4 would then trim/save/CLOSE whatever document had focus).
    const dupDocName = `export_clip_tmp_${process.pid}`;
    const pasteDocName = `clip_export_${process.pid}`;
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

        function hideAll(layers) {
          for (var i = 0; i < layers.length; i++) {
            layers[i].visible = false;
            if (layers[i].typename === 'LayerSet') hideAll(layers[i].layers);
          }
        }
        hideAll(dupDoc.layers);

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

        var info = findInfo(dupDoc.layers, ${jsxString(layerName)});
        if (!info) throw new Error('Layer not found in duplicate: ' + ${jsxString(layerName)});

        info.layer.visible = true;

        var clipBase = null;
        for (var ci = info.index + 1; ci < info.parent.length; ci++) {
          var candidate = info.parent[ci];
          var cg = false;
          try { cg = candidate.grouped; } catch(e) {}
          if (!cg) { clipBase = candidate; break; }
        }
        if (clipBase) clipBase.visible = true;

        for (var ai = 0; ai < info.ancestors.length; ai++) {
          info.ancestors[ai].visible = true;
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
        ${trim ? `try { newDoc.trim(TrimType.TRANSPARENT, true, true, true, true); } catch(e) {}` : ''}

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

        var newDoc = app.documents.add(
          origDoc.width, origDoc.height, origDoc.resolution,
          'layer_export_tmp', NewDocumentMode.RGB, DocumentFill.TRANSPARENT
        );
        app.activeDocument = origDoc;
        srcLayer.duplicate(newDoc, ElementPlacement.PLACEATBEGINNING);
        app.activeDocument = newDoc;

        // Smart Objects may export blank after duplicate — rasterize to materialize pixels
        try {
          if (newDoc.activeLayer.kind === LayerKind.SMARTOBJECT) {
            newDoc.activeLayer.rasterize(RasterizeType.ENTIRELAYER);
          }
        } catch(e) {}

        ${trim ? `try { newDoc.trim(TrimType.TRANSPARENT, true, true, true, true); } catch(e) {}` : ''}

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
          clippingApplied: false
        };
      `,
        LONG_SCRIPT_TIMEOUT_MS
      );
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
    }
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
      LONG_SCRIPT_TIMEOUT_MS
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
