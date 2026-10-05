import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { PhotoshopConnection } from '../platform/connection.js';
import { PhotoshopAPIFactory } from '../api/photoshop-api.js';
import { ANCHOR_POSITIONS, ExtendScriptSnippets, RESAMPLE_METHODS } from '../api/extendscript.js';
import { LONG_SCRIPT_TIMEOUT_MS } from '../platform/script-executor.js';

export function createImageTools(connection: PhotoshopConnection): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'photoshop_resize_image',
        description:
          'Resize (resample) the active image. Give width, height, or both; with one, the other ' +
          'follows the aspect ratio. To change the canvas without scaling content, use photoshop_resize_canvas.',
        inputSchema: {
          type: 'object',
          properties: {
            width: {
              type: 'number',
              description: 'New width in pixels (omit to keep the aspect ratio from height)',
              minimum: 1,
            },
            height: {
              type: 'number',
              description: 'New height in pixels (omit to keep the aspect ratio from width)',
              minimum: 1,
            },
            resample: {
              type: 'string',
              enum: [...RESAMPLE_METHODS],
              description:
                'Resampling method (default BICUBIC). BICUBICSHARPER suits downscaling, ' +
                'BICUBICSMOOTHER upscaling, NEARESTNEIGHBOR pixel art.',
            },
          },
        },
      },
      handler: async (args) => resizeImage(connection, args),
    },
    {
      tool: {
        name: 'photoshop_resize_canvas',
        description:
          'Change the canvas size of the active document without scaling its content. ' +
          'Give width, height, or both (an omitted one stays as is). Content is placed by anchor.',
        inputSchema: {
          type: 'object',
          properties: {
            width: { type: 'number', description: 'New canvas width in pixels', minimum: 1 },
            height: { type: 'number', description: 'New canvas height in pixels', minimum: 1 },
            anchor: {
              type: 'string',
              enum: [...ANCHOR_POSITIONS],
              description: 'Where existing content sits in the new canvas (default MIDDLECENTER)',
            },
          },
        },
      },
      handler: async (args) => resizeCanvas(connection, args),
    },
    {
      tool: {
        name: 'photoshop_crop_document',
        description: 'Crop the document to specified bounds',
        inputSchema: {
          type: 'object',
          properties: {
            left: {
              type: 'number',
              description: 'Left edge position in pixels',
              minimum: 0,
            },
            top: {
              type: 'number',
              description: 'Top edge position in pixels',
              minimum: 0,
            },
            right: {
              type: 'number',
              description: 'Right edge position in pixels',
              minimum: 1,
            },
            bottom: {
              type: 'number',
              description: 'Bottom edge position in pixels',
              minimum: 1,
            },
          },
          required: ['left', 'top', 'right', 'bottom'],
        },
      },
      handler: async (args) => cropDocument(connection, args),
    },
  ];
}

function optionalSize(args: Record<string, unknown>, name: string): number | undefined {
  const v = args[name];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 1) {
    throw new Error(
      `invalid argument "${name}": expected a size in pixels >= 1 (got ${JSON.stringify(v)})`
    );
  }
  return Math.round(v);
}

async function resizeImage(
  connection: PhotoshopConnection,
  args: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const width = optionalSize(args, 'width');
    const height = optionalSize(args, 'height');
    if (width === undefined && height === undefined) throw new Error('Pass width, height, or both');
    const resample = typeof args.resample === 'string' ? args.resample.toUpperCase() : 'BICUBIC';

    const api = await new PhotoshopAPIFactory(connection).createAPI();
    const script = ExtendScriptSnippets.resizeImage(width, height, resample);
    // Resampling a large PSD can take well over 30s.
    const result = await api.executeScript(script, LONG_SCRIPT_TIMEOUT_MS);

    return {
      content: [{ type: 'text' as const, text: `Image resized: ${JSON.stringify(result)}` }],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error resizing image: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

async function resizeCanvas(
  connection: PhotoshopConnection,
  args: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const width = optionalSize(args, 'width');
    const height = optionalSize(args, 'height');
    if (width === undefined && height === undefined) throw new Error('Pass width, height, or both');
    const anchor = typeof args.anchor === 'string' ? args.anchor.toUpperCase() : 'MIDDLECENTER';

    const api = await new PhotoshopAPIFactory(connection).createAPI();
    const result = await api.executeScript(
      ExtendScriptSnippets.resizeCanvas(width, height, anchor)
    );

    return {
      content: [{ type: 'text' as const, text: `Canvas resized: ${JSON.stringify(result)}` }],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error resizing canvas: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

async function cropDocument(
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

    const script = ExtendScriptSnippets.cropDocument(left, top, right, bottom);
    const result = await api.executeScript(script);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Document cropped\nResult: ${JSON.stringify(result)}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error cropping document: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}
