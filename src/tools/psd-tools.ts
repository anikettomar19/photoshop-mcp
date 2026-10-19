import { ToolDefinition } from '../core/tool-registry.js';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import { existsSync } from 'fs';
import { requireString } from '../utils/args.js';
import { LAYER_TREE_MAX_CHARS } from './layer-tree-format.js';

/** Checks the PSD exists before spawning Python, which otherwise fails with a traceback. */
function requirePsd(args: Record<string, unknown>): string {
  const psdPath = requireString(args, 'psd_path');
  if (!existsSync(psdPath)) throw new Error(`PSD file not found: ${psdPath}`);
  return psdPath;
}

// Pick the Python interpreter that has psd-tools + Pillow installed
function detectPython(): string {
  for (const candidate of ['python3.12', 'python3.11', 'python3.10', 'python3']) {
    const result = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (result.status === 0) {
      // Quick check: does it have psd_tools?
      const check = spawnSync(candidate, ['-c', 'import psd_tools, PIL'], { encoding: 'utf8' });
      if (check.status === 0) return candidate;
    }
  }
  return 'python3'; // fallback
}
const PYTHON_BIN = detectPython();

// Resolve Python script path relative to this compiled file (dist/tools/psd-tools.js → ../../scripts/)
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PSD_EXTRACT_SCRIPT = path.resolve(__dirname, '../../scripts/psd_extract.py');

function runPython(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const python = spawn(PYTHON_BIN, [PSD_EXTRACT_SCRIPT, ...args]);
    let stdout = '';
    let stderr = '';
    python.stdout.on('data', (d) => (stdout += d.toString()));
    python.stderr.on('data', (d) => (stderr += d.toString()));
    python.on('close', (code) => {
      if (code !== 0) {
        // psd_extract.py reports errors meant for the caller as one "ERROR:"
        // line; only unexpected failures keep their full traceback.
        const line = stderr.split('\n').find((l) => l.startsWith('ERROR: '));
        reject(
          new Error(line ? line.slice(7) : `psd_extract.py exited ${code}:\n${stderr || stdout}`)
        );
      } else {
        resolve(stdout + (stderr ? `\nSTDERR:\n${stderr}` : ''));
      }
    });
    python.on('error', (err) => reject(new Error(`Failed to spawn python3: ${err.message}`)));
  });
}

interface PsdTreeEntry {
  path: string;
  type: string;
  depth: number;
  parent_path: string;
  child_count?: number;
  truncated?: boolean;
}

/**
 * Keeps get_psd_layer_tree output within what a client accepts from one tool
 * call. A whole UI document came back at up to 220k characters and was
 * rejected. If the tree is over `maxChars`, it is cut to the deepest level
 * that fits; groups cut off report child_count and truncated:true, as with
 * max_depth, and a note says how to walk further.
 */
export function limitPsdLayerTree(output: string, maxChars = LAYER_TREE_MAX_CHARS): string {
  if (output.length <= maxChars) return output;
  const nl = output.indexOf('\n');
  const json = nl < 0 ? output : output.slice(0, nl);
  const rest = nl < 0 ? '' : output.slice(nl);
  let tree: { layers: PsdTreeEntry[]; note?: string };
  try {
    tree = JSON.parse(json);
  } catch {
    return output;
  }
  const all = tree.layers;
  const childCount = new Map<string, number>();
  for (const l of all) childCount.set(l.parent_path, (childCount.get(l.parent_path) ?? 0) + 1);
  const render = (layers: PsdTreeEntry[], note: string) =>
    JSON.stringify({ ...tree, note, layers }) + rest;

  const cutAt = (depth: number) =>
    all
      .filter((l) => l.depth <= depth)
      .map((l) =>
        l.depth === depth && childCount.has(l.path)
          ? { ...l, child_count: childCount.get(l.path), truncated: true }
          : l
      );

  const deepest = all.reduce((d, l) => Math.max(d, l.depth), 0);
  const whole = output.length;
  for (let depth = deepest - 1; depth >= 1; depth--) {
    const kept = cutAt(depth);
    const text = render(
      kept,
      `Output limited to ${depth} level(s) to stay under ${maxChars} characters (the full tree is ` +
        `${whole}). Groups marked truncated have more inside: pass group_path to walk one of them, ` +
        'or max_depth to choose the depth.'
    );
    if (text.length <= maxChars) return text;
  }

  // Even the top level alone is too big: show the first layers only.
  const top = cutAt(1);
  let n = top.length;
  let text = '';
  do {
    text = render(
      top.slice(0, n),
      `Even the top level is over ${maxChars} characters; showing the first ${n} of ${top.length} ` +
        'top-level layers. Pass group_path to walk one group.'
    );
    n = Math.floor(n / 2);
  } while (text.length > maxChars && n >= 1);
  return text;
}

function ok(text: string): { content: Array<{ type: 'text'; text: string }>; isError: false } {
  return { content: [{ type: 'text', text }], isError: false };
}

function fail(text: string): { content: Array<{ type: 'text'; text: string }>; isError: true } {
  return { content: [{ type: 'text', text }], isError: true };
}

export function createPsdTools(): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'photoshop_extract_psd_layer',
        description:
          'Extract a named layer from a PSD file to a PNG — without needing Photoshop open. ' +
          'Handles Smart Objects (extracts embedded content), clipping masks (crops to clip-base bounds), ' +
          'and group layers. Layer path uses slash notation: "intro screen/fg box/Sorry_Feb...".',
        inputSchema: {
          type: 'object',
          properties: {
            psd_path: {
              type: 'string',
              description: 'Absolute path to the .psd file',
            },
            layer_path: {
              type: 'string',
              description:
                'Slash-separated path to the layer: e.g. "intro screen/fg box/Sorry_Feb_2026_00515_ copy 2"',
            },
            output_path: {
              type: 'string',
              description: 'Absolute path for the output PNG (default: /tmp/extracted_layer.png)',
            },
          },
          required: ['psd_path', 'layer_path'],
        },
      },
      handler: async (args) => {
        const psdPath = requirePsd(args);
        const layerPath = requireString(args, 'layer_path');
        const outputPath =
          (args['output_path'] as string | undefined) ?? '/tmp/extracted_layer.png';

        try {
          const output = await runPython([psdPath, layerPath, outputPath]);
          return ok(`Layer extracted to: ${outputPath}\n\n${output}`);
        } catch (err) {
          return fail(String(err));
        }
      },
    },

    {
      tool: {
        name: 'photoshop_extract_layer_fx',
        description:
          "Read a layer's stroke and drop-shadow effects from a PSD file and return the " +
          'equivalent Unity TMPInstancingUtil property values (m_OutlineColor, m_OutlineThickness, ' +
          'm_UnderlayColor, m_OffsetX/Y, m_UnderlayDilate, m_UnderlaySoftness). ' +
          'Does not require Photoshop to be open.',
        inputSchema: {
          type: 'object',
          properties: {
            psd_path: {
              type: 'string',
              description: 'Absolute path to the .psd file',
            },
            layer_path: {
              type: 'string',
              description:
                'Slash-separated path to the text layer: e.g. "intro screen/timer area/Time left text"',
            },
          },
          required: ['psd_path', 'layer_path'],
        },
      },
      handler: async (args) => {
        const psdPath = requirePsd(args);
        const layerPath = requireString(args, 'layer_path');

        try {
          const output = await runPython([psdPath, '--fx', layerPath]);
          return ok(output);
        } catch (err) {
          return fail(String(err));
        }
      },
    },
    {
      tool: {
        name: 'photoshop_get_psd_layer_tree',
        description:
          'Extract the layer tree of a PSD (or of one group in it) as structured JSON — without needing Photoshop open. ' +
          'Omit group_path to walk the whole document; pass max_depth to limit how deep it goes. ' +
          'Hidden layers are skipped. ' +
          'Returns every layer with: bounds, type, text content (font/size/color/alignment), ' +
          'FX (stroke/drop_shadow/gradient_overlay), solidfill colors, clip mask flags, and document PPI. ' +
          'This is the primary data source for the Picasso pipeline (PixelPeep). ' +
          'Uses psd-tools Python library — all data extracted in one pass.',
        inputSchema: {
          type: 'object',
          properties: {
            psd_path: {
              type: 'string',
              description: 'Absolute path to the .psd file',
            },
            group_path: {
              type: 'string',
              description:
                'Optional slash-separated path to a group, e.g. "Beach" or "Daily Task main pop up". ' +
                'Omit to walk the whole document. Append [n] to pick between identically named siblings.',
            },
            max_depth: {
              type: 'number',
              description:
                'Optional cap on levels returned (1 = only the direct children). Groups cut off report child_count and truncated:true. ' +
                'A tree too large for one result is cut to the deepest level that fits, with a note saying so.',
            },
          },
          required: ['psd_path'],
        },
      },
      handler: async (args) => {
        const psdPath = requirePsd(args);
        const groupPath = typeof args.group_path === 'string' ? args.group_path : '';
        const maxDepth =
          typeof args.max_depth === 'number' && args.max_depth > 0
            ? String(Math.floor(args.max_depth))
            : '';

        try {
          const output = await runPython([psdPath, '--layer-tree', groupPath, maxDepth]);
          return ok(limitPsdLayerTree(output));
        } catch (err) {
          return fail(String(err));
        }
      },
    },
  ];
}
