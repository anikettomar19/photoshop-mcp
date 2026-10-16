import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { PhotoshopConnection } from '../platform/connection.js';
import { PhotoshopAPIFactory } from '../api/photoshop-api.js';
import { layerPathResolver } from '../api/extendscript.js';
import { jsxEnum, jsxString } from '../utils/jsx.js';
import { optionalNumber } from '../utils/args.js';

const ALIGN_EDGES = ['LEFT', 'HCENTER', 'RIGHT', 'TOP', 'VCENTER', 'BOTTOM'] as const;
const ALIGN_TARGETS = ['LAYERS', 'CANVAS'] as const;
const AXES = ['HORIZONTAL', 'VERTICAL'] as const;
const GROUP_POSITIONS = ['TOP', 'BOTTOM'] as const;
const TRIM_BASES = ['TRANSPARENT', 'TOP_LEFT_COLOR', 'BOTTOM_RIGHT_COLOR'] as const;

const pathSchema = {
  type: 'string',
  description: 'Layer path, e.g. "HUD/PlayButton" (default: the active layer)',
};
const pathsSchema = (min: number) => ({
  type: 'array',
  items: { type: 'string' },
  minItems: min,
  description: 'Layer or group paths, e.g. ["HUD/Btn1", "HUD/Btn2"]',
});

export function createLayerOrganizeTools(connection: PhotoshopConnection): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'photoshop_move_layer_into_group',
        description:
          'Move a layer (or group) into a group, at its TOP or BOTTOM. Leave group empty to move ' +
          'the layer out of its current group, just above it.',
        inputSchema: {
          type: 'object',
          properties: {
            layer_path: pathSchema,
            group: { type: 'string', description: 'Target group path; empty moves the layer out' },
            position: {
              type: 'string',
              enum: [...GROUP_POSITIONS],
              description: 'Where in the group (default TOP)',
            },
          },
        },
      },
      handler: async (args) =>
        run(connection, () =>
          scriptMoveIntoGroup(
            optionalPath(args.layer_path),
            typeof args.group === 'string' ? args.group : '',
            jsxEnum(String(args.position ?? 'TOP').toUpperCase(), GROUP_POSITIONS, 'position')
          )
        ),
    },
    {
      tool: {
        name: 'photoshop_ungroup_layer',
        description:
          'Ungroup a group: its layers move up to where the group was, in the same order, and the ' +
          'group is removed.',
        inputSchema: {
          type: 'object',
          properties: { group: { type: 'string', description: 'Group path (default: active)' } },
        },
      },
      handler: async (args) => run(connection, () => scriptUngroup(optionalPath(args.group))),
    },
    {
      tool: {
        name: 'photoshop_flip_layer',
        description:
          'Flip the active layer HORIZONTAL or VERTICAL around its centre. Shapes, text and smart ' +
          'objects stay editable.',
        inputSchema: {
          type: 'object',
          properties: {
            direction: { type: 'string', enum: [...AXES], description: 'Flip direction' },
            layer_path: pathSchema,
          },
          required: ['direction'],
        },
      },
      handler: async (args) =>
        run(connection, () =>
          scriptFlipLayer(
            jsxEnum(String(args.direction ?? '').toUpperCase(), AXES, 'direction'),
            optionalPath(args.layer_path)
          )
        ),
    },
    {
      tool: {
        name: 'photoshop_align_layers',
        description:
          'Align layers by an edge or centre: LEFT, HCENTER, RIGHT, TOP, VCENTER, BOTTOM. ' +
          'relative_to LAYERS (default) aligns to the bounding box of the given layers (2+ ' +
          'needed); CANVAS aligns each to the document. Positions are rounded to whole pixels.',
        inputSchema: {
          type: 'object',
          properties: {
            layers: pathsSchema(1),
            edge: { type: 'string', enum: [...ALIGN_EDGES], description: 'Edge or centre' },
            relative_to: {
              type: 'string',
              enum: [...ALIGN_TARGETS],
              description: 'Align to the layers together or to the canvas (default LAYERS)',
            },
          },
          required: ['layers', 'edge'],
        },
      },
      handler: async (args) => run(connection, () => scriptAlignLayers(alignArgs(args))),
    },
    {
      tool: {
        name: 'photoshop_distribute_layers',
        description:
          'Space 3+ layers evenly along HORIZONTAL or VERTICAL: the outermost two stay put and ' +
          'the gaps between all of them become equal. Give gap (px) instead to lay them out one ' +
          'after another from the first, with that exact gap.',
        inputSchema: {
          type: 'object',
          properties: {
            layers: pathsSchema(2),
            axis: { type: 'string', enum: [...AXES], description: 'Direction' },
            gap: { type: 'number', description: 'Fixed gap in px (optional)' },
          },
          required: ['layers', 'axis'],
        },
      },
      handler: async (args) => run(connection, () => scriptDistributeLayers(distributeArgs(args))),
    },
    {
      tool: {
        name: 'photoshop_convert_to_smart_object',
        description:
          'Convert the active layer (or group) into a smart object, so it can be scaled without ' +
          'losing quality and replaced later with photoshop_replace_smart_object.',
        inputSchema: { type: 'object', properties: { layer_path: pathSchema } },
      },
      handler: async (args) =>
        run(connection, () => scriptConvertToSmartObject(optionalPath(args.layer_path))),
    },
    {
      tool: {
        name: 'photoshop_trim_document',
        description:
          'Trim the canvas: remove TRANSPARENT borders (default), or borders matching the ' +
          'TOP_LEFT_COLOR or BOTTOM_RIGHT_COLOR pixel. Useful before exporting a sprite.',
        inputSchema: {
          type: 'object',
          properties: {
            based_on: {
              type: 'string',
              enum: [...TRIM_BASES],
              description: 'What counts as border (default TRANSPARENT)',
            },
          },
        },
      },
      handler: async (args) =>
        run(connection, () =>
          scriptTrimDocument(
            jsxEnum(String(args.based_on ?? 'TRANSPARENT').toUpperCase(), TRIM_BASES, 'based_on')
          )
        ),
    },
  ];
}

// ─── argument checks ─────────────────────────────────────────────────────────

const optionalPath = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);

function layerPaths(raw: unknown, min: number): string[] {
  if (!Array.isArray(raw) || raw.length < min || !raw.every((p) => typeof p === 'string' && p)) {
    throw new Error(`layers must be an array of at least ${min} layer path(s)`);
  }
  if (new Set(raw).size !== raw.length) throw new Error('layers lists the same path twice');
  return raw as string[];
}

export interface AlignArgs {
  layers: string[];
  edge: (typeof ALIGN_EDGES)[number];
  relativeTo: (typeof ALIGN_TARGETS)[number];
}

export function alignArgs(args: Record<string, unknown>): AlignArgs {
  const relativeTo = jsxEnum(
    String(args.relative_to ?? 'LAYERS').toUpperCase(),
    ALIGN_TARGETS,
    'relative_to'
  );
  return {
    layers: layerPaths(args.layers, relativeTo === 'LAYERS' ? 2 : 1),
    edge: jsxEnum(String(args.edge ?? '').toUpperCase(), ALIGN_EDGES, 'edge'),
    relativeTo,
  };
}

export interface DistributeArgs {
  layers: string[];
  axis: (typeof AXES)[number];
  gap?: number;
}

export function distributeArgs(args: Record<string, unknown>): DistributeArgs {
  const gap =
    args.gap === undefined || args.gap === null ? undefined : optionalNumber(args, 'gap', 0);
  return {
    layers: layerPaths(args.layers, gap === undefined ? 3 : 2),
    axis: jsxEnum(String(args.axis ?? '').toUpperCase(), AXES, 'axis'),
    gap,
  };
}

// ─── scripts ─────────────────────────────────────────────────────────────────

const helpers = `
  function cTID(s) { return app.charIDToTypeID(s); }
  function sTID(s) { return app.stringIDToTypeID(s); }
  ${layerPathResolver}
  if (app.documents.length === 0) throw new Error('No active document');
  var doc = app.activeDocument;
  function pick(path) { return path === null ? doc.activeLayer : psResolveLayerPath(doc, path); }
  function box(l) {
    var b = l.bounds;
    return { l: b[0].as('px'), t: b[1].as('px'), r: b[2].as('px'), b: b[3].as('px') };
  }
  function fullPath(l) {
    var parts = [];
    for (var n = l; n && n.typename !== 'Document'; n = n.parent) parts.unshift(n.name);
    return parts.join('/');
  }
`;

const pathLiteral = (p: string | undefined) => (p === undefined ? 'null' : jsxString(p));

export function scriptMoveIntoGroup(
  layerPath: string | undefined,
  group: string,
  position: (typeof GROUP_POSITIONS)[number]
): string {
  return `
    ${helpers}
    var layer = pick(${pathLiteral(layerPath)});
    if (layer.isBackgroundLayer) throw new Error('The Background layer cannot be moved into a group.');
    ${
      group === ''
        ? `if (layer.parent.typename === 'Document') {
      throw new Error('Layer "' + layer.name + '" is not in a group.');
    }
    layer.move(layer.parent, ElementPlacement.PLACEBEFORE);`
        : `var target = psResolveLayerPath(doc, ${jsxString(group)});
    if (target.typename !== 'LayerSet') throw new Error('"' + target.name + '" is not a group.');
    for (var n = target; n && n.typename !== 'Document'; n = n.parent) {
      if (n === layer) throw new Error('A group cannot be moved into itself.');
    }
    // move(group, INSIDE) throws "Illegal Argument" when the layer is itself a
    // group, and PLACEAFTER a child group lands outside the target. So the layer
    // is placed before a child: the first one for TOP, or a placeholder art
    // layer sent to the end of the group for BOTTOM (and for an empty group).
    var placeholder = null;
    if (${position === 'BOTTOM'} || target.layers.length === 0) {
      placeholder = target.artLayers.add();
      placeholder.move(target, ElementPlacement.PLACEATEND);
      psActivate(doc, layer);
    }
    layer.move(placeholder || target.layers[0], ElementPlacement.PLACEBEFORE);
    if (placeholder) placeholder.remove();`
    }
    return { moved: true, layerName: layer.name, path: fullPath(layer) };
  `;
}

export function scriptUngroup(group: string | undefined): string {
  return `
    ${helpers}
    var g = pick(${pathLiteral(group)});
    if (g.typename !== 'LayerSet') throw new Error('"' + g.name + '" is not a group.');
    var names = [];
    for (var i = 0; i < g.layers.length; i++) names.push(g.layers[i].name);
    var name = g.name;
    psActivate(doc, g);
    var ref = new ActionReference();
    ref.putEnumerated(cTID('Lyr '), cTID('Ordn'), cTID('Trgt'));
    var d = new ActionDescriptor();
    d.putReference(cTID('null'), ref);
    executeAction(sTID('ungroupLayersEvent'), d, DialogModes.NO);
    return { ungrouped: true, group: name, layers: names };
  `;
}

export function scriptFlipLayer(
  direction: (typeof AXES)[number],
  layerPath: string | undefined
): string {
  const [sx, sy] = direction === 'HORIZONTAL' ? [-100, 100] : [100, -100];
  return `
    ${helpers}
    var layer = pick(${pathLiteral(layerPath)});
    if (layer.isBackgroundLayer) throw new Error('The Background layer cannot be flipped; flip the canvas or convert it to a normal layer.');
    psActivate(doc, layer);
    // Photoshop refuses to transform a hidden layer, so it is shown for the
    // flip and hidden again afterwards.
    var wasVisible = layer.visible;
    if (!wasVisible) layer.visible = true;
    try {
      layer.resize(${sx}, ${sy}, AnchorPosition.MIDDLECENTER);
    } finally {
      if (!wasVisible) layer.visible = false;
    }
    return { flipped: ${jsxString(direction)}, layerName: layer.name, visible: layer.visible };
  `;
}

export function scriptAlignLayers(a: AlignArgs): string {
  return `
    ${helpers}
    var paths = [${a.layers.map((p) => jsxString(p)).join(', ')}];
    var layers = [], boxes = [];
    for (var i = 0; i < paths.length; i++) {
      var l = psResolveLayerPath(doc, paths[i]);
      if (l.isBackgroundLayer) throw new Error('The Background layer cannot be moved.');
      var b = box(l);
      if (b.r <= b.l || b.b <= b.t) throw new Error('Layer "' + paths[i] + '" is empty, so it has no edges to align.');
      layers.push(l); boxes.push(b);
    }
    var ref;
    if (${jsxString(a.relativeTo)} === 'CANVAS') {
      ref = { l: 0, t: 0, r: doc.width.as('px'), b: doc.height.as('px') };
    } else {
      ref = { l: boxes[0].l, t: boxes[0].t, r: boxes[0].r, b: boxes[0].b };
      for (var j = 1; j < boxes.length; j++) {
        ref.l = Math.min(ref.l, boxes[j].l); ref.t = Math.min(ref.t, boxes[j].t);
        ref.r = Math.max(ref.r, boxes[j].r); ref.b = Math.max(ref.b, boxes[j].b);
      }
    }
    var edge = ${jsxString(a.edge)}, moved = [];
    for (var k = 0; k < layers.length; k++) {
      var bx = boxes[k], dx = 0, dy = 0;
      if (edge === 'LEFT') dx = ref.l - bx.l;
      else if (edge === 'RIGHT') dx = ref.r - bx.r;
      else if (edge === 'HCENTER') dx = (ref.l + ref.r) / 2 - (bx.l + bx.r) / 2;
      else if (edge === 'TOP') dy = ref.t - bx.t;
      else if (edge === 'BOTTOM') dy = ref.b - bx.b;
      else dy = (ref.t + ref.b) / 2 - (bx.t + bx.b) / 2;
      dx = Math.round(dx); dy = Math.round(dy);
      if (dx !== 0 || dy !== 0) layers[k].translate(UnitValue(dx, 'px'), UnitValue(dy, 'px'));
      var nb = box(layers[k]);
      moved.push({ path: paths[k], dx: dx, dy: dy, left: nb.l, top: nb.t });
    }
    return { aligned: edge, relativeTo: ${jsxString(a.relativeTo)}, layers: moved };
  `;
}

export function scriptDistributeLayers(a: DistributeArgs): string {
  const h = a.axis === 'HORIZONTAL';
  const [start, end] = h ? ['l', 'r'] : ['t', 'b'];
  return `
    ${helpers}
    var paths = [${a.layers.map((p) => jsxString(p)).join(', ')}];
    var items = [];
    for (var i = 0; i < paths.length; i++) {
      var l = psResolveLayerPath(doc, paths[i]);
      if (l.isBackgroundLayer) throw new Error('The Background layer cannot be moved.');
      items.push({ path: paths[i], layer: l, b: box(l) });
    }
    items.sort(function (x, y) { return x.b.${start} - y.b.${start}; });
    var sizes = 0;
    for (var s = 0; s < items.length; s++) sizes += items[s].b.${end} - items[s].b.${start};
    var gap = ${
      a.gap === undefined
        ? `(items[items.length - 1].b.${end} - items[0].b.${start} - sizes) / (items.length - 1)`
        : a.gap
    };
    var cursor = items[0].b.${start}, out = [];
    for (var k = 0; k < items.length; k++) {
      var it = items[k];
      var d = Math.round(cursor - it.b.${start});
      if (d !== 0) it.layer.translate(UnitValue(${h ? 'd' : '0'}, 'px'), UnitValue(${h ? '0' : 'd'}, 'px'));
      cursor += it.b.${end} - it.b.${start} + gap;
      out.push({ path: it.path, moved: d, ${start === 'l' ? 'left' : 'top'}: box(it.layer).${start} });
    }
    return { distributed: ${jsxString(a.axis)}, gap: Math.round(gap * 100) / 100, layers: out };
  `;
}

export function scriptConvertToSmartObject(layerPath: string | undefined): string {
  return `
    ${helpers}
    var layer = pick(${pathLiteral(layerPath)});
    if (layer.isBackgroundLayer) throw new Error('The Background layer cannot become a smart object; convert it to a normal layer first.');
    if (layer.typename !== 'LayerSet' && layer.kind === LayerKind.SMARTOBJECT) {
      throw new Error('Layer "' + layer.name + '" is already a smart object.');
    }
    var wasVisible = layer.visible;
    psActivate(doc, layer);
    executeAction(sTID('newPlacedLayer'), undefined, DialogModes.NO);
    var so = doc.activeLayer;
    if (so.visible !== wasVisible) so.visible = wasVisible;
    return { converted: true, layerName: so.name, kind: String(so.kind), path: fullPath(so), visible: so.visible };
  `;
}

export function scriptTrimDocument(basedOn: (typeof TRIM_BASES)[number]): string {
  const type = {
    TRANSPARENT: 'TrimType.TRANSPARENT',
    TOP_LEFT_COLOR: 'TrimType.TOPLEFT',
    BOTTOM_RIGHT_COLOR: 'TrimType.BOTTOMRIGHT',
  }[basedOn];
  return `
    ${helpers}
    var w0 = doc.width.as('px'), h0 = doc.height.as('px');
    ${
      basedOn === 'TRANSPARENT'
        ? `if (doc.layers.length === 1 && doc.layers[0].isBackgroundLayer) {
      throw new Error('The document is a single Background layer, which has no transparency to trim.');
    }`
        : ''
    }
    doc.trim(${type}, true, true, true, true);
    return { trimmed: true, basedOn: ${jsxString(basedOn)}, before: { width: w0, height: h0 },
      after: { width: doc.width.as('px'), height: doc.height.as('px') } };
  `;
}

async function run(connection: PhotoshopConnection, build: () => string): Promise<ToolResult> {
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
