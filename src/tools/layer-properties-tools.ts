import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { PhotoshopConnection } from '../platform/connection.js';
import { PhotoshopAPIFactory } from '../api/photoshop-api.js';
import { requireString } from '../utils/args.js';
import { BLEND_MODES, ExtendScriptSnippets } from '../api/extendscript.js';

export function createLayerPropertiesTools(connection: PhotoshopConnection): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'photoshop_rasterize_layer',
        description: 'Rasterize the active layer (convert text/smart object to normal layer)',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      handler: async () => rasterizeLayer(connection),
    },
    {
      tool: {
        name: 'photoshop_set_layer_opacity',
        description: 'Set the opacity of the active layer',
        inputSchema: {
          type: 'object',
          properties: {
            opacity: {
              type: 'number',
              description: 'Opacity value (0-100)',
              minimum: 0,
              maximum: 100,
            },
          },
          required: ['opacity'],
        },
      },
      handler: async (args) => setLayerOpacity(connection, args),
    },
    {
      tool: {
        name: 'photoshop_set_layer_blend_mode',
        description: 'Set the blend mode of the active layer',
        inputSchema: {
          type: 'object',
          properties: {
            blendMode: {
              type: 'string',
              description: 'Blend mode name',
              enum: [...BLEND_MODES],
            },
          },
          required: ['blendMode'],
        },
      },
      handler: async (args) => setLayerBlendMode(connection, args),
    },
    {
      tool: {
        name: 'photoshop_set_layer_visibility',
        description:
          'Show or hide layers. One layer: "path" (otherwise the active layer; prefer passing a ' +
          'path, since the active layer is whatever the user last clicked). Many layers in one ' +
          'call: "paths", and/or "name_pattern" (a regex on layer names, ' +
          'searched in all nested groups, or only under the group "under"). If any path is ' +
          'missing nothing changes. with_parents: true also shows hidden groups above a layer ' +
          'being shown, so it actually appears.',
        inputSchema: {
          type: 'object',
          properties: {
            visible: {
              type: 'boolean',
              description: 'Whether the layer should be visible',
            },
            path: {
              type: 'string',
              description:
                'Optional layer path, e.g. "Tier/Group 1050". Append [n] to a segment to pick between ' +
                'identically named siblings. Omit to act on the active layer.',
            },
            paths: {
              type: 'array',
              items: { type: 'string' },
              description: 'Several layer or group paths, changed together',
            },
            name_pattern: {
              type: 'string',
              description: 'Regex matched against layer names, e.g. "^OLD " or "pointer|arrow"',
            },
            under: {
              type: 'string',
              description: 'Group path that limits name_pattern to its contents',
            },
            with_parents: {
              type: 'boolean',
              description: 'When showing, also show hidden groups above each layer (default false)',
            },
          },
          required: ['visible'],
        },
      },
      handler: async (args) => setLayerVisibility(connection, args),
    },
    {
      tool: {
        name: 'photoshop_set_layer_locked',
        description: 'Lock or unlock the active layer',
        inputSchema: {
          type: 'object',
          properties: {
            locked: {
              type: 'boolean',
              description: 'Whether the layer should be locked',
            },
          },
          required: ['locked'],
        },
      },
      handler: async (args) => setLayerLocked(connection, args),
    },
    {
      tool: {
        name: 'photoshop_rename_layer',
        description:
          'Rename a layer: the one at layer_path if given, otherwise the active layer. ' +
          'Its visibility is kept (a hidden layer stays hidden).',
        inputSchema: {
          type: 'object',
          properties: {
            layer_path: {
              type: 'string',
              description: 'Layer path, e.g. "HUD/PlayButton" (default: the active layer)',
            },
            name: {
              type: 'string',
              description: 'New name for the layer',
            },
          },
          required: ['name'],
        },
      },
      handler: async (args) => renameLayer(connection, args),
    },
    {
      tool: {
        name: 'photoshop_duplicate_layer',
        description: 'Duplicate the active layer',
        inputSchema: {
          type: 'object',
          properties: {
            newName: {
              type: 'string',
              description: 'Name for the duplicated layer (optional)',
            },
          },
        },
      },
      handler: async (args) => duplicateLayer(connection, args),
    },
    {
      tool: {
        name: 'photoshop_merge_visible_layers',
        description: 'Merge all visible layers into one',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      handler: async () => mergeVisibleLayers(connection),
    },
    {
      tool: {
        name: 'photoshop_flatten_image',
        description: 'Flatten all layers into a single background layer',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      handler: async () => flattenImage(connection),
    },
  ];
}

async function setLayerOpacity(
  connection: PhotoshopConnection,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const opacity = args.opacity as number;

  try {
    const apiFactory = new PhotoshopAPIFactory(connection);
    const api = await apiFactory.createAPI();

    const script = ExtendScriptSnippets.setLayerOpacity(opacity);
    await api.executeScript(script);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Layer opacity set to ${opacity}%`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error setting layer opacity: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

async function setLayerBlendMode(
  connection: PhotoshopConnection,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const blendMode = requireString(args, 'blendMode');

  try {
    const apiFactory = new PhotoshopAPIFactory(connection);
    const api = await apiFactory.createAPI();

    const script = ExtendScriptSnippets.setLayerBlendMode(blendMode);
    await api.executeScript(script);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Layer blend mode set to ${blendMode}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error setting blend mode: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

export interface VisibilityArgs {
  visible: boolean;
  path?: string;
  paths: string[];
  namePattern?: string;
  under?: string;
  withParents: boolean;
}

/** Validates set_layer_visibility arguments; throws on anything that can't run. */
export function visibilityArgs(args: Record<string, unknown>): VisibilityArgs {
  if (typeof args.visible !== 'boolean') {
    throw new Error(
      `missing or invalid required argument "visible" (got ${JSON.stringify(args.visible)})`
    );
  }
  const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
  const paths = args.paths === undefined ? [] : args.paths;
  if (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string' && p !== '')) {
    throw new Error('paths must be an array of layer paths');
  }
  const namePattern = str(args.name_pattern);
  if (namePattern !== undefined) {
    try {
      new RegExp(namePattern);
    } catch (e) {
      throw new Error(`name_pattern is not a valid regex: ${e instanceof Error ? e.message : e}`);
    }
  }
  const under = str(args.under);
  if (under !== undefined && namePattern === undefined) {
    throw new Error('"under" only applies together with name_pattern');
  }
  return {
    visible: args.visible,
    path: str(args.path),
    paths: paths as string[],
    namePattern,
    under,
    withParents: args.with_parents === true,
  };
}

async function setLayerVisibility(
  connection: PhotoshopConnection,
  args: Record<string, unknown>
): Promise<ToolResult> {
  try {
    const a = visibilityArgs(args);
    const api = await new PhotoshopAPIFactory(connection).createAPI();
    const batch = a.paths.length > 0 || a.namePattern !== undefined || a.withParents;
    if (!batch) {
      await api.executeScript(ExtendScriptSnippets.setLayerVisibility(a.visible, a.path));
      return {
        content: [{ type: 'text' as const, text: `Layer ${a.visible ? 'shown' : 'hidden'}` }],
      };
    }
    const paths = a.path !== undefined ? [a.path, ...a.paths] : a.paths;
    if (paths.length === 0 && a.namePattern === undefined) {
      throw new Error('with_parents needs a path, paths or name_pattern');
    }
    const result = await api.executeScript(
      ExtendScriptSnippets.setLayersVisibility(
        a.visible,
        paths,
        a.namePattern,
        a.under,
        a.withParents
      )
    );
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error setting layer visibility: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

async function setLayerLocked(
  connection: PhotoshopConnection,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const locked = args.locked as boolean;

  try {
    const apiFactory = new PhotoshopAPIFactory(connection);
    const api = await apiFactory.createAPI();

    const script = ExtendScriptSnippets.setLayerLocked(locked);
    await api.executeScript(script);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Layer ${locked ? 'locked' : 'unlocked'}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error locking/unlocking layer: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

async function renameLayer(
  connection: PhotoshopConnection,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const name = requireString(args, 'name');
  const layerPath =
    typeof args.layer_path === 'string' && args.layer_path !== '' ? args.layer_path : undefined;

  try {
    const apiFactory = new PhotoshopAPIFactory(connection);
    const api = await apiFactory.createAPI();

    const script = ExtendScriptSnippets.renameLayer(name, layerPath);
    const result = await api.executeScript(script);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Layer renamed to: ${name}\nResult: ${JSON.stringify(result)}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error renaming layer: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

async function duplicateLayer(
  connection: PhotoshopConnection,
  args: Record<string, unknown>
): Promise<ToolResult> {
  const newName = args.newName as string | undefined;

  try {
    const apiFactory = new PhotoshopAPIFactory(connection);
    const api = await apiFactory.createAPI();

    const script = ExtendScriptSnippets.duplicateLayer(newName);
    const result = await api.executeScript(script);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Layer duplicated\nResult: ${JSON.stringify(result)}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error duplicating layer: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

async function mergeVisibleLayers(connection: PhotoshopConnection): Promise<ToolResult> {
  try {
    const apiFactory = new PhotoshopAPIFactory(connection);
    const api = await apiFactory.createAPI();

    const script = ExtendScriptSnippets.mergeVisibleLayers();
    await api.executeScript(script);

    return {
      content: [
        {
          type: 'text' as const,
          text: 'All visible layers merged',
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error merging visible layers: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

async function flattenImage(connection: PhotoshopConnection): Promise<ToolResult> {
  try {
    const apiFactory = new PhotoshopAPIFactory(connection);
    const api = await apiFactory.createAPI();

    const script = ExtendScriptSnippets.flattenImage();
    await api.executeScript(script);

    return {
      content: [
        {
          type: 'text' as const,
          text: 'Image flattened (all layers merged to background)',
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error flattening image: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}

async function rasterizeLayer(connection: PhotoshopConnection): Promise<ToolResult> {
  try {
    const apiFactory = new PhotoshopAPIFactory(connection);
    const api = await apiFactory.createAPI();

    const script = ExtendScriptSnippets.rasterizeLayer();
    const result = await api.executeScript(script);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Layer rasterized\nResult: ${JSON.stringify(result)}`,
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error rasterizing layer: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}
