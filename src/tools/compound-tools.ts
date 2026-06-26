import { mkdirSync, statSync, writeFileSync } from 'fs';
import { dirname, join, relative } from 'path';
import { Jimp } from 'jimp';
import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { PhotoshopConnection } from '../platform/connection.js';
import { PhotoshopAPIFactory } from '../api/photoshop-api.js';
import { computePhash, computeHsvHistogram, computeAlphaHash } from './sprite-hash.js';
import {
  SpriteEntry,
  loadIndex,
  saveIndex,
  loadCatalog,
  saveCatalog,
  getProjectPaths,
} from './sprite-tools.js';
import { batchExportLayers } from './utility-tools.js';

// ── ExtendScript helpers ──────────────────────────────────────────────────────

function scriptGetLayerBounds(layerPath: string): string {
  const escapedPath = layerPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `
    if (!app.documents.length) throw new Error('No active document');
    var doc = app.activeDocument;
    var parts = "${escapedPath}".split('/');
    var collection = doc.layers;
    var layer = null;
    for (var p = 0; p < parts.length; p++) {
      var found = false;
      for (var i = 0; i < collection.length; i++) {
        if (collection[i].name === parts[p]) {
          layer = collection[i]; found = true;
          if (p < parts.length - 1) {
            if (layer.typename !== 'LayerSet') throw new Error('Not a group: "' + parts[p] + '"');
            collection = layer.layers;
          }
          break;
        }
      }
      if (!found) throw new Error('Layer not found: "' + parts[p] + '"');
    }
    doc.activeLayer = layer;
    var b = layer.bounds;
    return {
      layerName: layer.name,
      layerKind: String(layer.kind),
      bounds: {
        left: Math.round(b[0].as('px')), top: Math.round(b[1].as('px')),
        width: Math.round(b[2].as('px') - b[0].as('px')),
        height: Math.round(b[3].as('px') - b[1].as('px'))
      }
    };
  `;
}

function scriptGetLayerTreeWithRT(scaleFactor: number, groupFilter: string): string {
  const escapedFilter = groupFilter.replace(/"/g, '\\"');

  return `
    if (!app.documents.length) throw new Error('No active document');
    var doc = app.activeDocument;
    var docW = doc.width.as('px');
    var docH = doc.height.as('px');
    var sf = ${scaleFactor};

    function rtOf(layer, pb) {
      var b = layer.bounds;
      var lL = b[0].as('px'), lT = b[1].as('px'), lR = b[2].as('px'), lB = b[3].as('px');
      var lW = lR - lL, lH = lB - lT;
      var lCX = (lL + lR) / 2, lCY = (lT + lB) / 2;
      var pCX = (pb[0] + pb[2]) / 2, pCY = (pb[1] + pb[3]) / 2;
      return {
        bounds: {
          left: Math.round(lL), top: Math.round(lT),
          width: Math.round(lW), height: Math.round(lH)
        },
        unityRT: {
          anchoredPosition: [
            Math.round((lCX - pCX) * sf * 100) / 100,
            Math.round(-(lCY - pCY) * sf * 100) / 100
          ],
          sizeDelta: [Math.round(lW * sf * 100) / 100, Math.round(lH * sf * 100) / 100]
        }
      };
    }

    function walkLayers(layerCollection, pathPrefix, parentBounds, depth) {
      var result = [];
      for (var i = 0; i < layerCollection.length; i++) {
        var layer = layerCollection[i];
        if (!layer.visible) continue;
        var fullPath = pathPrefix ? (pathPrefix + '/' + layer.name) : layer.name;
        var isGroup = layer.typename === 'LayerSet';

        var bCheck;
        try { bCheck = layer.bounds; } catch(e) { continue; }
        var lW = bCheck[2].as('px') - bCheck[0].as('px');
        var lH = bCheck[3].as('px') - bCheck[1].as('px');
        if (lW < 1 || lH < 1) continue;

        var rt = rtOf(layer, parentBounds);
        var entry = {
          name: layer.name,
          path: fullPath,
          type: isGroup ? 'GROUP' : String(layer.kind),
          depth: depth,
          bounds: rt.bounds,
          unityRT: rt.unityRT
        };

        if (isGroup) {
          var childPB = [bCheck[0].as('px'), bCheck[1].as('px'), bCheck[2].as('px'), bCheck[3].as('px')];
          entry.children = walkLayers(layer.layers, fullPath, childPB, depth + 1);
        }
        result.push(entry);
      }
      return result;
    }

    var rootCollection = doc.layers;
    var rootBounds = [0, 0, docW, docH];

    // If groupFilter is set, scope to that group
    if ("${escapedFilter}") {
      var found = null;
      for (var i = 0; i < doc.layers.length; i++) {
        if (doc.layers[i].name === "${escapedFilter}") { found = doc.layers[i]; break; }
      }
      if (!found) throw new Error('Group not found: "${escapedFilter}"');
      if (found.typename !== 'LayerSet') throw new Error('"${escapedFilter}" is not a group');
      var fb = found.bounds;
      rootCollection = found.layers;
      rootBounds = [fb[0].as('px'), fb[1].as('px'), fb[2].as('px'), fb[3].as('px')];
    }

    return {
      documentName: doc.name,
      documentSize: { width: Math.round(docW), height: Math.round(docH) },
      scaleFactor: sf,
      groupFilter: "${escapedFilter}",
      layers: walkLayers(rootCollection, "${escapedFilter}", rootBounds, 0)
    };
  `;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function flattenToLeaves(
  layers: any[],
  includeGroups: boolean
): Array<{ name: string; path: string; bounds: any; unityRT: any }> {
  const out: Array<{ name: string; path: string; bounds: any; unityRT: any }> = [];
  for (const layer of layers) {
    if (layer.type === 'GROUP') {
      if (includeGroups) {
        out.push({ name: layer.name, path: layer.path, bounds: layer.bounds, unityRT: layer.unityRT });
      }
      if (layer.children?.length) {
        out.push(...flattenToLeaves(layer.children, includeGroups));
      }
    } else {
      out.push({ name: layer.name, path: layer.path, bounds: layer.bounds, unityRT: layer.unityRT });
    }
  }
  return out;
}

async function hashAndAddToIndex(
  pngPath: string,
  projectRoot: string,
  indexPath: string
): Promise<void> {
  const img = await Jimp.read(pngPath);
  const mtime = statSync(pngPath).mtimeMs;
  const entry: SpriteEntry = {
    mtime,
    width: img.bitmap.width,
    height: img.bitmap.height,
    aspectRatio: img.bitmap.width / (img.bitmap.height || 1),
    phash: computePhash(img),
    hsvHist: computeHsvHistogram(img),
    alphaHash: computeAlphaHash(img),
  };
  const sprites = loadIndex(indexPath);
  const rel = relative(projectRoot, pngPath);
  sprites[rel] = entry;
  saveIndex(indexPath, sprites);
}

// ── Tool: extract_sprite_to_catalog ──────────────────────────────────────────

async function extractSpriteToCatalog(
  connection: PhotoshopConnection,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const layerPath = args.layerPath as string;
  const outputPath = args.outputPath as string;
  const intent = args.intent as string;
  const theme = (args.theme as string | undefined) ?? '';
  const notes = (args.notes as string | undefined) ?? '';
  const usedIn = ((args.usedIn as string | undefined) ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const trimTransparency = (args.trimTransparency as boolean | undefined) ?? true;
  const addToIndex = (args.addToIndex as boolean | undefined) ?? true;

  try {
    mkdirSync(dirname(outputPath), { recursive: true });

    const api = await new PhotoshopAPIFactory(connection).createAPI();

    // ── 1. Resolve layer bounds (also validates the path exists) ─────────────
    const layerInfo = (await api.executeScript(scriptGetLayerBounds(layerPath))) as {
      layerName: string;
      layerKind: string;
      bounds: { left: number; top: number; width: number; height: number };
    };

    // ── 2. Export via batchExportLayers (battle-tested, no PS dialog issues) ─
    const exportResult = await batchExportLayers(connection, {
      layers: [{ path: layerPath, output_path: outputPath, scale_percent: 100, trim: trimTransparency, apply_clipping_mask: false }],
    });
    if (exportResult.isError) {
      throw new Error((exportResult.content[0] as any).text);
    }

    // ── 2. Tag in catalog ────────────────────────────────────────────────────
    const { catalogPath, indexPath, projectRoot } = getProjectPaths(args);
    const catalog = loadCatalog(catalogPath);
    const relPath = relative(projectRoot, outputPath);
    catalog[relPath] = {
      intent,
      theme,
      notes,
      usedIn,
      taggedAt: new Date().toISOString().slice(0, 10),
    };
    saveCatalog(catalogPath, catalog);

    // ── 3. Incrementally update sprite index ─────────────────────────────────
    if (addToIndex) {
      await hashAndAddToIndex(outputPath, projectRoot, indexPath);
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: true,
              layerName: layerInfo.layerName,
              layerKind: layerInfo.layerKind,
              layerPath,
              exportedPng: outputPath,
              bounds: layerInfo.bounds,
              catalog: { relPath, intent, theme, notes, usedIn },
              indexUpdated: addToIndex,
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
          text: `Error in extract_sprite_to_catalog: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

// ── Tool: prep_ui_for_unity ───────────────────────────────────────────────────

async function prepUiForUnity(
  connection: PhotoshopConnection,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const exportDir = args.exportDir as string;
  const scaleFactor = (args.scaleFactor as number | undefined) ?? 1.0;
  const groupFilter = (args.groupFilter as string | undefined) ?? '';
  const documentName = (args.documentName as string | undefined) ?? '';
  const includeGroups = (args.includeGroups as boolean | undefined) ?? false;
  const manifestPath =
    (args.manifestPath as string | undefined) ?? join(exportDir, 'unity_manifest.json');

  try {
    mkdirSync(exportDir, { recursive: true });

    const api = await new PhotoshopAPIFactory(connection).createAPI();

    // ── 1. Switch to target document if specified ─────────────────────────────
    if (documentName) {
      await api.executeScript(`
        var n = "${documentName.replace(/"/g, '\\"')}";
        for (var i = 0; i < app.documents.length; i++) {
          if (app.documents[i].name === n) { app.activeDocument = app.documents[i]; break; }
        }
      `);
    }

    // ── 2. Get full layer tree with RT values in one ExtendScript call ────────
    const treeScript = scriptGetLayerTreeWithRT(scaleFactor, groupFilter);
    const tree = (await api.executeScript(treeScript)) as {
      documentName: string;
      documentSize: { width: number; height: number };
      scaleFactor: number;
      groupFilter: string;
      layers: any[];
    };

    // ── 3. Flatten to exportable layers ──────────────────────────────────────
    const leaves = flattenToLeaves(tree.layers, includeGroups);

    if (leaves.length === 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(
              { success: false, reason: 'No visible layers found', groupFilter },
              null,
              2
            ),
          },
        ],
      };
    }

    // ── 4. Build batch export config ─────────────────────────────────────────
    // Sanitise layer names for file system (replace / : * ? " < > | with _)
    const sanitise = (name: string) => name.replace(/[/\\:*?"<>|]/g, '_');

    const batchConfig = leaves.map((layer) => ({
      path: layer.path,
      output_path: join(exportDir, `${sanitise(layer.name)}.png`),
      scale_percent: scaleFactor * 100,
      trim: true,
      apply_clipping_mask: false,
    }));

    // ── 5. Batch export all layers ────────────────────────────────────────────
    const batchResult = await batchExportLayers(connection, {
      layers: batchConfig,
      document_name: documentName || undefined,
    });

    // Parse batch result to find successes/failures
    let batchSummary: any = {};
    try {
      const batchText = (batchResult.content[0] as any).text as string;
      batchSummary = JSON.parse(batchText);
    } catch {
      // non-fatal — continue with manifest
    }

    // ── 6. Build and write manifest ───────────────────────────────────────────
    const manifest = leaves.map((layer) => {
      const pngPath = join(exportDir, `${sanitise(layer.name)}.png`);
      const layerResult = batchSummary?.results?.find?.(
        (r: any) => r.path === layer.path
      );
      return {
        name: layer.name,
        path: layer.path,
        png: pngPath,
        exported: layerResult?.status === 'success',
        error: layerResult?.error ?? null,
        bounds: layer.bounds,
        unityRT: layer.unityRT,
      };
    });

    const manifestData = {
      document: tree.documentName,
      documentSize: tree.documentSize,
      scaleFactor: tree.scaleFactor,
      groupFilter: tree.groupFilter,
      exportDir,
      exportedAt: new Date().toISOString().slice(0, 10),
      layerCount: manifest.length,
      layers: manifest,
    };

    writeFileSync(manifestPath, JSON.stringify(manifestData, null, 2));

    const successCount = manifest.filter((l) => l.exported).length;
    const errors = manifest.filter((l) => l.error).map((l) => ({ path: l.path, error: l.error }));

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            {
              success: true,
              document: tree.documentName,
              totalLayers: leaves.length,
              exported: successCount,
              errors,
              manifestPath,
              exportDir,
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
          text: `Error in prep_ui_for_unity: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

export function createCompoundTools(connection: PhotoshopConnection): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'photoshop_extract_sprite_to_catalog',
        description:
          'Compound tool: select a layer by path, export it as PNG, tag it in the sprite catalog, ' +
          'and add it to the visual search index — all in one call. ' +
          'Replaces the 4-step sequence of select_layer → export_layer → catalog_tag → rebuild_index. ' +
          'The index update is incremental (only hashes the new file, not the whole project).',
        inputSchema: {
          type: 'object',
          properties: {
            layerPath: {
              type: 'string',
              description: 'Slash-separated layer path, e.g. "Characters/Hero/Idle"',
            },
            outputPath: {
              type: 'string',
              description:
                'Absolute path for the exported PNG, e.g. "/Assets/Sprites/Heroes/hero_idle.png". ' +
                'Parent directories are created automatically.',
            },
            intent: {
              type: 'string',
              description:
                'Catalog intent tag, e.g. "icon", "character-art", "modal-background". ' +
                'Standard intents: icon, character-art, modal-background, modal-card, button-cta, ' +
                'button-secondary, button-close, decoration, timer-bg, header-bg, progress-bar, badge, 9slice-panel.',
            },
            theme: {
              type: 'string',
              description: 'Visual theme, e.g. "hero", "blue-popup", "white-card".',
            },
            notes: {
              type: 'string',
              description: 'Free-text notes: PPM value, slice borders, animation frame info, etc.',
            },
            usedIn: {
              type: 'string',
              description: 'Comma-separated prefab/modal names, e.g. "HeroPanel,CharacterSelect"',
            },
            trimTransparency: {
              type: 'boolean',
              description: 'Trim transparent edges from the exported PNG (default: true).',
              default: true,
            },
            addToIndex: {
              type: 'boolean',
              description:
                'Hash the new PNG and add it to the visual search index (default: true). ' +
                'Skipping saves ~50ms but find_similar_sprites will miss this sprite until rebuild_sprite_index is called.',
              default: true,
            },
            project_root: {
              type: 'string',
              description: 'Absolute path to Unity project root (overrides UNITY_PROJECT_ROOT env).',
            },
          },
          required: ['layerPath', 'outputPath', 'intent'],
        },
      },
      handler: async (args) => extractSpriteToCatalog(connection, args),
    },
    {
      tool: {
        name: 'photoshop_prep_ui_for_unity',
        description:
          'Compound tool: reads the full layer tree of the active PSD, exports every visible ' +
          'layer as an isolated PNG, computes Unity RectTransform values for each layer, and ' +
          'writes a JSON manifest a Unity script can consume to auto-build the UI hierarchy. ' +
          'Replaces the N×(get_layer_rt + export_layer) call sequence with a single call. ' +
          'Use groupFilter to scope to one screen panel (e.g. "HUD").',
        inputSchema: {
          type: 'object',
          properties: {
            exportDir: {
              type: 'string',
              description:
                'Absolute directory path where PNGs and the manifest are written. ' +
                'Created automatically if it does not exist.',
            },
            scaleFactor: {
              type: 'number',
              description:
                'Scale multiplier applied to all Unity RectTransform values and PNG export size. ' +
                'Use 0.5 for half-res exports, 1.0 for native resolution. Default: 1.0.',
              default: 1.0,
            },
            groupFilter: {
              type: 'string',
              description:
                'If set, only layers inside this top-level group are exported, e.g. "HUD". ' +
                'Leave empty to export all visible layers in the document.',
            },
            documentName: {
              type: 'string',
              description:
                'Target document by name, e.g. "Info Screen.psd". ' +
                'Recommended in multi-document sessions.',
            },
            includeGroups: {
              type: 'boolean',
              description:
                'If true, layer groups are also exported as flattened PNGs in addition to leaf layers. ' +
                'Default: false (leaf layers only).',
              default: false,
            },
            manifestPath: {
              type: 'string',
              description:
                'Output path for the JSON manifest. ' +
                'Default: {exportDir}/unity_manifest.json.',
            },
          },
          required: ['exportDir'],
        },
      },
      handler: async (args) => prepUiForUnity(connection, args),
    },
  ];
}
