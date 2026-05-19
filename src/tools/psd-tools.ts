import { ToolDefinition } from '../core/tool-registry.js';
import { spawn, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

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
        reject(new Error(`psd_extract.py exited ${code}:\n${stderr || stdout}`));
      } else {
        resolve(stdout + (stderr ? `\nSTDERR:\n${stderr}` : ''));
      }
    });
    python.on('error', (err) => reject(new Error(`Failed to spawn python3: ${err.message}`)));
  });
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
        const psdPath = args['psd_path'] as string;
        const layerPath = args['layer_path'] as string;
        const outputPath = (args['output_path'] as string | undefined) ?? '/tmp/extracted_layer.png';

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
          'Read a layer\'s stroke and drop-shadow effects from a PSD file and return the ' +
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
        const psdPath = args['psd_path'] as string;
        const layerPath = args['layer_path'] as string;

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
          'Extract the full layer tree of a PSD group as structured JSON — without needing Photoshop open. ' +
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
                'Slash-separated path to the target group: e.g. "Beach" or "Daily Task main pop up"',
            },
          },
          required: ['psd_path', 'group_path'],
        },
      },
      handler: async (args) => {
        const psdPath = args['psd_path'] as string;
        const groupPath = args['group_path'] as string;

        try {
          const output = await runPython([psdPath, '--layer-tree', groupPath]);
          return ok(output);
        } catch (err) {
          return fail(String(err));
        }
      },
    },
  ];
}
