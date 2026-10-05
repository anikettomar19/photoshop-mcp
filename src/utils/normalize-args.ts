/**
 * Makes tool arguments match the tool's input schema before the handler runs.
 *
 * Tool argument names in this server mix camelCase and snake_case (layerPath
 * vs layer_path, filePath vs psd_path), and callers routinely guess the other
 * spelling or a synonym ("script" for "code", "document_name" for "name").
 * Clients also send numbers as strings ("2"). Each of those used to reach the
 * handler as undefined and fail, or be silently ignored. Renaming the schema
 * properties would break existing callers, so instead an unknown key is mapped
 * onto the schema property it clearly means, and scalar strings are coerced to
 * the declared type.
 */

interface PropertySchema {
  type?: string;
}

interface InputSchema {
  properties?: Record<string, PropertySchema>;
  required?: string[];
}

/** Lowercase with separators removed: "layer_path", "layerPath" → "layerpath". */
function canonical(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Synonym groups, in canonical form. An unknown key in a group maps to a schema
 * property in the same group only when the schema has exactly one such
 * property and the caller did not already pass it, so an ambiguous key (e.g.
 * "path" on a tool with both psd_path and layer_path) is never guessed.
 */
const SYNONYM_GROUPS: string[][] = [
  // file to read
  [
    'filepath',
    'file',
    'path',
    'filename',
    'imagepath',
    'image',
    'imagefile',
    'psdpath',
    'psd',
    'psdfile',
    'inputpath',
    'inputfile',
  ],
  // layer inside the document
  ['layerpath', 'path', 'layer', 'layername'],
  // group to scope a walk to
  ['grouppath', 'group', 'groupname'],
  // document to act on
  ['documentname', 'document', 'docname', 'doc'],
  // ExtendScript source
  ['code', 'script', 'source', 'js', 'jsx', 'javascript'],
  // file to write
  [
    'outputpath',
    'output',
    'out',
    'outpath',
    'outputfile',
    'dest',
    'destination',
    'savepath',
    'exportpath',
  ],
  // walk depth
  ['maxdepth', 'depth', 'levels'],
];

/** Per-tool synonyms for names too generic to put in a shared group. */
const TOOL_ALIASES: Record<string, Record<string, string>> = {
  photoshop_set_active_document: {
    documentname: 'name',
    document: 'name',
    docname: 'name',
    doc: 'name',
  },
};

function coerce(value: unknown, schema: PropertySchema | undefined): unknown {
  if (typeof value !== 'string' || !schema?.type) return value;
  const v = value.trim();
  if (
    (schema.type === 'number' || schema.type === 'integer') &&
    v !== '' &&
    Number.isFinite(Number(v))
  ) {
    return Number(v);
  }
  if (schema.type === 'boolean' && (v === 'true' || v === 'false')) {
    return v === 'true';
  }
  return value;
}

export interface NormalizedArgs {
  args: Record<string, unknown>;
  /** Keys that were renamed, as "given → used", for logging. */
  renamed: string[];
}

export function normalizeArgs(
  toolName: string,
  schema: InputSchema | undefined,
  input: Record<string, unknown>
): NormalizedArgs {
  const properties = schema?.properties ?? {};
  const propNames = Object.keys(properties);
  const byCanonical = new Map(propNames.map((p) => [canonical(p), p]));
  const toolAliases = TOOL_ALIASES[toolName] ?? {};

  const args: Record<string, unknown> = {};
  const renamed: string[] = [];
  const unknown: string[] = [];

  // Exact names first, so a correctly named argument always wins over an alias.
  for (const [key, value] of Object.entries(input)) {
    if (key in properties) args[key] = value;
    else unknown.push(key);
  }

  for (const key of unknown) {
    const c = canonical(key);
    let target: string | undefined = byCanonical.get(c) ?? toolAliases[c];

    if (!target) {
      const candidates = new Set<string>();
      for (const group of SYNONYM_GROUPS) {
        if (!group.includes(c)) continue;
        for (const p of propNames)
          if (group.includes(canonical(p)) && !(p in args)) candidates.add(p);
      }
      if (candidates.size === 1) target = [...candidates][0];
    }

    if (target && !(target in args)) {
      args[target] = input[key];
      renamed.push(`${key} → ${target}`);
    } else {
      args[key] = input[key]; // leave it; the handler may read it, or ignore it
    }
  }

  for (const p of propNames) {
    if (p in args) args[p] = coerce(args[p], properties[p]);
  }

  return { args, renamed };
}

/**
 * Throws if a required argument is still missing after normalization, naming
 * every argument the tool accepts, so the caller can correct itself in one try
 * instead of guessing again.
 */
export function assertRequiredArgs(
  toolName: string,
  schema: InputSchema | undefined,
  args: Record<string, unknown>
): void {
  const missing = (schema?.required ?? []).filter((p) => args[p] === undefined || args[p] === null);
  if (missing.length === 0) return;
  const accepted = Object.entries(schema?.properties ?? {})
    .map(([p, s]) => `${p}${schema?.required?.includes(p) ? '*' : ''} (${s.type ?? 'any'})`)
    .join(', ');
  throw new Error(
    `${toolName}: missing required argument${missing.length > 1 ? 's' : ''} ${missing.map((m) => `"${m}"`).join(', ')}. ` +
      `Accepted arguments (* = required): ${accepted}. Got: ${Object.keys(args).join(', ') || 'none'}.`
  );
}
