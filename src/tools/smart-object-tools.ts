import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { PhotoshopConnection } from '../platform/connection.js';
import { PhotoshopAPIFactory } from '../api/photoshop-api.js';

export function createSmartObjectTools(connection: PhotoshopConnection): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'photoshop_list_smart_objects',
        description:
          'List all smart object layers in the active document, with their full paths ' +
          'through the group hierarchy (e.g. "UI/Card/Artwork"). ' +
          'Use this before replace_smart_object to find the correct layer path.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      handler: async () => listSmartObjects(connection),
    },
    {
      tool: {
        name: 'photoshop_replace_smart_object',
        description:
          'Replace the content of a smart object layer with a new image file. ' +
          'The layer transform (position, rotation, scale) is preserved by default. ' +
          'Use layerPath with slash separators to target nested layers, e.g. "UI/Card/Artwork". ' +
          'Use fitToLayer to scale the new content to exactly match the original bounds.',
        inputSchema: {
          type: 'object',
          properties: {
            layerPath: {
              type: 'string',
              description:
                'Slash-separated path to the smart object layer, e.g. "UI/Card/Artwork" or "Background".',
            },
            newFilePath: {
              type: 'string',
              description: 'Absolute path to the replacement image file (PNG, JPG, PSD, etc.).',
            },
            fitToLayer: {
              type: 'boolean',
              description:
                'If true, scales and re-centers the new content to approximately match the original ' +
                'layer bounds (fit-within, aspect ratio preserved). Due to Photoshop smart object ' +
                'transform stacking the result is within ~10-15px of the original bounds — suitable ' +
                'for mockup workflows but not pixel-perfect. ' +
                'Default: false (Photoshop inherits the previous content\'s transform as-is).',
              default: false,
            },
            saveAfter: {
              type: 'boolean',
              description: 'If true, saves the document as PSD after replacement. Default: false.',
              default: false,
            },
          },
          required: ['layerPath', 'newFilePath'],
        },
      },
      handler: async (args) => replaceSmartObject(connection, args),
    },
  ];
}

// ── ExtendScript helpers ──────────────────────────────────────────────────────

function scriptListSmartObjects(): string {
  return `
    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;

    var results = [];

    function walk(layerCollection, pathPrefix) {
      for (var i = 0; i < layerCollection.length; i++) {
        var layer = layerCollection[i];
        var fullPath = pathPrefix ? (pathPrefix + '/' + layer.name) : layer.name;

        if (layer.typename === 'LayerSet') {
          walk(layer.layers, fullPath);
        } else if (layer.kind === LayerKind.SMARTOBJECT) {
          var bounds = null;
          try {
            var b = layer.bounds;
            bounds = {
              left:   Math.round(b[0].as('px')),
              top:    Math.round(b[1].as('px')),
              right:  Math.round(b[2].as('px')),
              bottom: Math.round(b[3].as('px')),
              width:  Math.round(b[2].as('px') - b[0].as('px')),
              height: Math.round(b[3].as('px') - b[1].as('px'))
            };
          } catch (e) {}
          results.push({
            name: layer.name,
            path: fullPath,
            visible: layer.visible,
            opacity: layer.opacity,
            bounds: bounds
          });
        }
      }
    }

    walk(doc.layers, '');
    return {
      documentName: doc.name,
      smartObjectCount: results.length,
      smartObjects: results
    };
  `;
}

export function scriptReplaceSmartObject(
  layerPath: string,
  newFilePath: string,
  fitToLayer: boolean,
  saveAfter: boolean
): string {
  const escapedPath = layerPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const escapedFile = newFilePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  return `
    function cTID(s) { return app.charIDToTypeID(s); }
    function sTID(s) { return app.stringIDToTypeID(s); }

    if (app.documents.length === 0) {
      throw new Error('No active document');
    }
    var doc = app.activeDocument;

    // ── Navigate to layer by path ──────────────────────────────────────────
    var parts = "${escapedPath}".split('/');
    var collection = doc.layers;
    var layer = null;

    for (var p = 0; p < parts.length; p++) {
      var found = false;
      for (var i = 0; i < collection.length; i++) {
        if (collection[i].name === parts[p]) {
          layer = collection[i];
          found = true;
          if (p < parts.length - 1) {
            if (layer.typename !== 'LayerSet') {
              throw new Error('Layer "' + parts[p] + '" is not a group');
            }
            collection = layer.layers;
          }
          break;
        }
      }
      if (!found) {
        throw new Error('Layer not found at path segment: "' + parts[p] + '"');
      }
    }

    // ── Validate smart object ──────────────────────────────────────────────
    if (layer.kind !== LayerKind.SMARTOBJECT) {
      throw new Error(
        'Layer "' + layer.name + '" is not a smart object (kind: ' + String(layer.kind) + '). ' +
        'Use photoshop_list_smart_objects to find valid targets.'
      );
    }

    doc.activeLayer = layer;

    // ── Record original bounds ─────────────────────────────────────────────
    var origBounds = layer.bounds;
    var origLeft   = origBounds[0].as('px');
    var origTop    = origBounds[1].as('px');
    var origRight  = origBounds[2].as('px');
    var origBottom = origBounds[3].as('px');
    var origWidth  = origRight  - origLeft;
    var origHeight = origBottom - origTop;
    var origCX = (origLeft + origRight) / 2;
    var origCY = (origTop  + origBottom) / 2;

    // ── Verify replacement file ────────────────────────────────────────────
    var newFile = new File("${escapedFile}");
    if (!newFile.exists) {
      throw new Error('Replacement file not found: "${escapedFile}"');
    }

    // ── Replace smart object content ───────────────────────────────────────
    // placedLayerReplaceContents swaps the embedded/linked asset while keeping
    // the layer's current transform descriptor intact.
    var replaceDesc = new ActionDescriptor();
    replaceDesc.putPath(cTID('null'), newFile);
    executeAction(sTID('placedLayerReplaceContents'), replaceDesc, DialogModes.NO);

    // ── Fit new content to original bounds (optional) ──────────────────────
    var fitApplied = false;
    if (${fitToLayer}) {
      var nb = layer.bounds;
      var newW = nb[2].as('px') - nb[0].as('px');
      var newH = nb[3].as('px') - nb[1].as('px');

      if (newW > 0 && newH > 0) {
        // Scale to cover original bounds (fill, maintain aspect ratio)
        var scaleW = (origWidth  / newW) * 100;
        var scaleH = (origHeight / newH) * 100;
        var scalePct = Math.min(scaleW, scaleH); // fit within bounds, preserve aspect ratio
        layer.resize(scalePct, scalePct, AnchorPosition.MIDDLECENTER);

        // Re-read bounds after scale, then translate to original center
        var sb = layer.bounds;
        var sCX = (sb[0].as('px') + sb[2].as('px')) / 2;
        var sCY = (sb[1].as('px') + sb[3].as('px')) / 2;
        layer.translate(origCX - sCX, origCY - sCY);
        fitApplied = true;
      }
    }

    // ── Read final bounds ──────────────────────────────────────────────────
    var fb = layer.bounds;
    var finalBounds = {
      left:   Math.round(fb[0].as('px')),
      top:    Math.round(fb[1].as('px')),
      right:  Math.round(fb[2].as('px')),
      bottom: Math.round(fb[3].as('px')),
      width:  Math.round(fb[2].as('px') - fb[0].as('px')),
      height: Math.round(fb[3].as('px') - fb[1].as('px'))
    };

    // ── Save document ──────────────────────────────────────────────────────
    if (${saveAfter}) {
      var psdOptions = new PhotoshopSaveOptions();
      psdOptions.embedColorProfile = true;
      doc.save();
    }

    return {
      replaced: true,
      layerName: layer.name,
      layerPath: "${escapedPath}",
      newFile: "${escapedFile}",
      fitApplied: fitApplied,
      saved: ${saveAfter},
      originalBounds: {
        left: Math.round(origLeft), top: Math.round(origTop),
        right: Math.round(origRight), bottom: Math.round(origBottom),
        width: Math.round(origWidth), height: Math.round(origHeight)
      },
      finalBounds: finalBounds
    };
  `;
}

// ── Handlers ──────────────────────────────────────────────────────────────────

async function listSmartObjects(connection: PhotoshopConnection): Promise<ToolResult> {
  try {
    const apiFactory = new PhotoshopAPIFactory(connection);
    const api = await apiFactory.createAPI();
    const result = await api.executeScript(scriptListSmartObjects());

    return {
      content: [
        {
          type: 'text' as const,
          text: `Smart Objects:\n${JSON.stringify(result, null, 2)}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error listing smart objects: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

async function replaceSmartObject(
  connection: PhotoshopConnection,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const layerPath = args.layerPath as string;
  const newFilePath = args.newFilePath as string;
  const fitToLayer = (args.fitToLayer as boolean) ?? false;
  const saveAfter = (args.saveAfter as boolean) ?? false;

  try {
    const apiFactory = new PhotoshopAPIFactory(connection);
    const api = await apiFactory.createAPI();
    const script = scriptReplaceSmartObject(layerPath, newFilePath, fitToLayer, saveAfter);
    const result = await api.executeScript(script);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Smart object replaced successfully.\n${JSON.stringify(result, null, 2)}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error replacing smart object: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}
