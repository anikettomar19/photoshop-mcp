/**
 * Shapes get_layer_tree output so it fits in a tool result.
 *
 * A real 3,270-layer UI document produced ~700k characters (about 200k
 * tokens): far past what a client accepts from one tool call, so the result
 * was cut off or rejected. Two measures:
 *  - a compact layer format (default): defaults omitted, bounds as
 *    [left, top, width, height], short keys; about a third of the size;
 *  - a character budget: if the tree is still too big, it is cut to the
 *    deepest level that fits, and cut groups report their child count, so the
 *    caller gets a usable overview plus a hint to walk a subtree via `path`.
 */

export interface TreeLayer {
  name: string;
  type: string;
  visible: boolean;
  opacity: number;
  blendMode: string;
  depth: number;
  bounds: { left: number; top: number; width: number; height: number } | null;
  text?: unknown;
  isSmartObject?: boolean;
  children?: TreeLayer[];
  childCount?: number;
  truncated?: boolean;
}

export interface LayerTree {
  documentName: string;
  width: number;
  height: number;
  root: string | null;
  maxDepth: number | null;
  layers: TreeLayer[];
}

/** Default budget: roughly 25k tokens, well inside what MCP clients accept. */
export const LAYER_TREE_MAX_CHARS = 90_000;

export const COMPACT_LEGEND =
  'n=name, t=type (default NORMAL), b=[left,top,width,height] px, hidden=true when not visible, ' +
  'op=opacity % (default 100), blend=blend mode (default normal/pass-through), so=smart object, ' +
  'c=children, count=children not shown (cut by depth)';

function compactLayer(l: TreeLayer): Record<string, unknown> {
  const o: Record<string, unknown> = { n: l.name };
  const type = l.type.replace('LayerKind.', '');
  if (type !== 'NORMAL') o.t = type;
  if (!l.visible) o.hidden = true;
  if (l.opacity !== 100) o.op = l.opacity;
  const blend = l.blendMode.replace('BlendMode.', '');
  if (blend !== 'NORMAL' && blend !== 'PASSTHROUGH') o.blend = blend;
  if (l.bounds) o.b = [l.bounds.left, l.bounds.top, l.bounds.width, l.bounds.height];
  if (l.text) o.text = l.text;
  if (l.isSmartObject) o.so = true;
  if (l.children) o.c = l.children.map(compactLayer);
  if (l.truncated) o.count = l.childCount;
  return o;
}

/** Copy of `layers` with every group at `depth` (0-based) cut off. */
function cutAtDepth(layers: TreeLayer[], depth: number): TreeLayer[] {
  return layers.map((l) => {
    if (!l.children) return l;
    if (l.depth >= depth) {
      const { children, ...rest } = l;
      return { ...rest, childCount: children.length, truncated: true };
    }
    return { ...l, children: cutAtDepth(l.children, depth) };
  });
}

function deepest(layers: TreeLayer[]): number {
  let d = -1;
  for (const l of layers) d = Math.max(d, l.depth, l.children ? deepest(l.children) : -1);
  return d;
}

function render(tree: LayerTree, layers: TreeLayer[], compact: boolean, note?: string): string {
  const header = {
    documentName: tree.documentName,
    width: tree.width,
    height: tree.height,
    root: tree.root,
    maxDepth: tree.maxDepth,
    ...(note ? { note } : {}),
    ...(compact ? { legend: COMPACT_LEGEND } : {}),
  };
  return JSON.stringify({ ...header, layers: compact ? layers.map(compactLayer) : layers });
}

export function formatLayerTree(
  tree: LayerTree,
  options: { compact: boolean; maxChars?: number }
): string {
  const maxChars = options.maxChars ?? LAYER_TREE_MAX_CHARS;
  const whole = render(tree, tree.layers, options.compact);
  if (whole.length <= maxChars) return whole;

  // Too big: keep the deepest level that still fits.
  for (let depth = deepest(tree.layers) - 1; depth >= 0; depth--) {
    const cut = cutAtDepth(tree.layers, depth);
    const note =
      `Output limited to ${depth + 1} level(s) to stay under ${maxChars} characters ` +
      `(the full tree is ${whole.length}). Groups marked count/truncated have more inside: ` +
      `pass "path" to walk one of them, or "max_depth" to choose the depth.`;
    const text = render(tree, cut, options.compact, note);
    if (text.length <= maxChars) return text;
  }

  // Even the top level alone is too big (thousands of top-level layers).
  const note =
    `Even the top level is over ${maxChars} characters; showing the first layers only. ` +
    'Pass "path" to walk one group.';
  const top = cutAtDepth(tree.layers, 0);
  let n = top.length;
  let text = render(tree, top, options.compact, note);
  while (text.length > maxChars && n > 1) {
    n = Math.floor(n / 2);
    text = render(tree, top.slice(0, n), options.compact, note);
  }
  return text;
}
