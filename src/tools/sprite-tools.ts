import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { extname, join, relative } from 'path';
import { Jimp } from 'jimp';
import { ToolDefinition, ToolResult } from '../core/tool-registry.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SpriteEntry {
  mtime: number;
  width: number;
  height: number;
  aspectRatio: number;
  phash: number[];
  hsvHist: number[];
  alphaHash: number[];
}

interface IndexFile {
  version: number;
  indexedAt: string;
  sprites: Record<string, SpriteEntry>;
}

interface CatalogEntry {
  intent: string;
  theme: string;
  notes: string;
  usedIn: string[];
  taggedAt: string;
}

interface CatalogFile {
  version: number;
  sprites: Record<string, CatalogEntry>;
}

// ---------------------------------------------------------------------------
// Image hashing — pHash + HSV histogram + alpha mask
// ---------------------------------------------------------------------------

/**
 * 1-D Type-II Discrete Cosine Transform (O(n²), fine for n=32).
 */
function dct1d(data: number[]): number[] {
  const n = data.length;
  const out: number[] = [];
  for (let k = 0; k < n; k++) {
    let s = 0;
    for (let i = 0; i < n; i++) {
      s += data[i] * Math.cos((Math.PI * k * (2 * i + 1)) / (2 * n));
    }
    s *= k === 0 ? Math.sqrt(1 / n) : Math.sqrt(2 / n);
    out.push(s);
  }
  return out;
}

/**
 * Perceptual hash via 2-D DCT.
 * Returns (hashSize² - 1) bits with DC component removed.
 * Hamming distance between two hashes measures structural similarity.
 */
async function computePhash(imagePath: string, hashSize = 8): Promise<number[]> {
  const sample = hashSize * 4; // 32×32 for hashSize=8
  const img = await Jimp.read(imagePath);
  img.resize({ w: sample, h: sample });
  img.greyscale();
  const { data, width } = img.bitmap;

  const pixels: number[] = [];
  for (let i = 0; i < data.length; i += 4) {
    pixels.push(data[i]); // R = G = B after greyscale
  }

  // Row DCTs
  const rowDct: number[][] = [];
  for (let y = 0; y < sample; y++) {
    rowDct.push(dct1d(pixels.slice(y * width, (y + 1) * width)));
  }

  // Column DCTs — only first hashSize columns needed for the top-left block
  const block: number[] = [];
  for (let x = 0; x < hashSize; x++) {
    const col = rowDct.map((row) => row[x]);
    const colDct = dct1d(col);
    for (let y = 0; y < hashSize; y++) {
      block.push(colDct[y]);
    }
  }

  // Remove DC component (index 0) and threshold against mean
  const ac = block.slice(1);
  const avg = ac.reduce((s, v) => s + v, 0) / ac.length;
  return ac.map((v) => (v > avg ? 1 : 0));
}

/**
 * Normalized HSV histogram over non-transparent pixels.
 * HSV is far more discriminating than RGB for UI colours —
 * e.g. navy blue and purple are adjacent in RGB but diverge sharply in Hue.
 */
async function computeHsvHistogram(
  imagePath: string,
  hBins = 32,
  sBins = 8,
  vBins = 8
): Promise<number[]> {
  const img = await Jimp.read(imagePath);
  const { data } = img.bitmap;
  const hist = new Array<number>(hBins + sBins + vBins).fill(0);
  let count = 0;

  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 10) continue; // skip transparent pixels
    count++;

    const r = data[i] / 255;
    const g = data[i + 1] / 255;
    const b = data[i + 2] / 255;
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    const delta = mx - mn;
    const v = mx;
    const s = mx > 0 ? delta / mx : 0;

    let h = 0;
    if (delta > 0) {
      if (mx === r)      h = ((g - b) / delta) % 6;
      else if (mx === g) h = (b - r) / delta + 2;
      else               h = (r - g) / delta + 4;
      h = h / 6;
      if (h < 0) h += 1;
    }

    hist[Math.min(Math.floor(h * hBins), hBins - 1)]++;
    hist[hBins + Math.min(Math.floor(s * sBins), sBins - 1)]++;
    hist[hBins + sBins + Math.min(Math.floor(v * vBins), vBins - 1)]++;
  }

  return count > 0 ? hist.map((x) => x / count) : hist;
}

/**
 * Binary hash of the alpha mask (16×16 = 256 bits).
 * Ensures a transparent character sprite never matches a solid background panel.
 */
async function computeAlphaHash(imagePath: string, size = 16): Promise<number[]> {
  const img = await Jimp.read(imagePath);
  img.resize({ w: size, h: size });
  const { data } = img.bitmap;
  const result: number[] = [];
  for (let i = 3; i < data.length; i += 4) {
    result.push(data[i] > 128 ? 1 : 0);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Similarity metrics
// ---------------------------------------------------------------------------

function hammingSim(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  return a.reduce((s, v, i) => s + (v === b[i] ? 1 : 0), 0) / a.length;
}

function chiSquaredSim(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    const sum = a[i] + b[i];
    if (sum > 0) dist += ((a[i] - b[i]) ** 2) / sum;
  }
  return Math.max(0, 1 - dist / 2);
}

/**
 * Weighted combination of all three metrics with aspect ratio penalty.
 * pHash 40% (structure), HSV 35% (colour), alpha 25% (transparency pattern).
 * Penalty starts when aspect ratio differs by more than 15%.
 */
function combinedScore(
  phashS: number,
  hsvS: number,
  alphaS: number,
  aspectDiff: number
): number {
  const penalty = Math.max(0, 1 - Math.max(0, aspectDiff - 0.15) * 5);
  return (phashS * 0.4 + hsvS * 0.35 + alphaS * 0.25) * penalty;
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.bmp']);

function walkDir(dir: string, results: string[] = []): string[] {
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walkDir(full, results);
      } else if (IMAGE_EXTS.has(extname(entry.name).toLowerCase())) {
        results.push(full);
      }
    }
  } catch {
    // skip unreadable directories
  }
  return results;
}

function getProjectPaths(args: Record<string, unknown>) {
  const projectRoot =
    (args.project_root as string | undefined) || process.env.UNITY_PROJECT_ROOT;
  if (!projectRoot) {
    throw new Error(
      'Project root not set. Set UNITY_PROJECT_ROOT in .mcp.json env, or pass project_root arg.'
    );
  }
  return {
    projectRoot,
    spritesRoot: join(projectRoot, 'Assets', 'Sprites'),
    catalogPath: join(projectRoot, 'Assets', 'Sprites', '.sprite_catalog.json'),
    indexPath: join(projectRoot, 'Tools', '.sprite_index.json'),
  };
}

function loadIndex(indexPath: string): Record<string, SpriteEntry> {
  if (!existsSync(indexPath)) return {};
  try {
    return (JSON.parse(readFileSync(indexPath, 'utf8')) as IndexFile).sprites ?? {};
  } catch {
    return {};
  }
}

function saveIndex(indexPath: string, sprites: Record<string, SpriteEntry>): void {
  mkdirSync(join(indexPath, '..'), { recursive: true });
  const data: IndexFile = { version: 1, indexedAt: new Date().toISOString(), sprites };
  writeFileSync(indexPath, JSON.stringify(data));
}

function loadCatalog(catalogPath: string): Record<string, CatalogEntry> {
  if (!existsSync(catalogPath)) return {};
  try {
    return (JSON.parse(readFileSync(catalogPath, 'utf8')) as CatalogFile).sprites ?? {};
  } catch {
    return {};
  }
}

function saveCatalog(catalogPath: string, sprites: Record<string, CatalogEntry>): void {
  writeFileSync(catalogPath, JSON.stringify({ version: 1, sprites }, null, 2));
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

async function findSimilarSprites(args: Record<string, unknown>): Promise<ToolResult> {
  const topN     = (args.top_n     as number  | undefined) ?? 5;
  const threshold = (args.threshold as number  | undefined) ?? 0.5;
  const queryPath = args.image_path as string;

  try {
    const { projectRoot, indexPath, catalogPath } = getProjectPaths(args);
    const index = loadIndex(indexPath);

    if (Object.keys(index).length === 0) {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          error: 'Index is empty — call rebuild_sprite_index first.',
        }) }],
        isError: true,
      };
    }

    const qPhash = await computePhash(queryPath);
    const qHsv   = await computeHsvHistogram(queryPath);
    const qAlpha = await computeAlphaHash(queryPath);
    const qImg   = await Jimp.read(queryPath);
    const qAspect = qImg.bitmap.width / (qImg.bitmap.height || 1);

    const catalog = loadCatalog(catalogPath);
    const results: object[] = [];

    for (const [rel, entry] of Object.entries(index)) {
      const aspectDiff = Math.abs(entry.aspectRatio - qAspect) / Math.max(qAspect, 0.01);
      if (aspectDiff > 0.25) continue; // fast pre-filter

      const sc = combinedScore(
        hammingSim(qPhash, entry.phash),
        chiSquaredSim(qHsv, entry.hsvHist),
        hammingSim(qAlpha, entry.alphaHash),
        aspectDiff
      );

      if (sc >= threshold) {
        const result: Record<string, unknown> = {
          path: rel,
          score: Math.round(sc * 1000) / 1000,
          breakdown: {
            phash: Math.round(hammingSim(qPhash, entry.phash) * 1000) / 1000,
            hsv:   Math.round(chiSquaredSim(qHsv, entry.hsvHist) * 1000) / 1000,
            alpha: Math.round(hammingSim(qAlpha, entry.alphaHash) * 1000) / 1000,
          },
          dimensions: `${entry.width}×${entry.height}`,
        };
        const cat = catalog[rel] || catalog[relative(projectRoot, join(projectRoot, rel))];
        if (cat) result.catalog = cat;
        results.push(result);
      }
    }

    results.sort((a, b) => (b as Record<string, number>).score - (a as Record<string, number>).score);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(results.slice(0, topN), null, 2) }],
    };
  } catch (error) {
    return {
      content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

async function rebuildSpriteIndex(args: Record<string, unknown>): Promise<ToolResult> {
  try {
    const { projectRoot, spritesRoot, indexPath } = getProjectPaths(args);
    const existing = loadIndex(indexPath);
    const allPaths = walkDir(spritesRoot);

    let indexed = 0, updated = 0, skipped = 0;
    const errors: object[] = [];
    const sprites: Record<string, SpriteEntry> = {};

    for (const absPath of allPaths) {
      const rel = relative(projectRoot, absPath);
      let mtime: number;
      try {
        mtime = statSync(absPath).mtimeMs;
      } catch {
        continue;
      }

      const prev = existing[rel];
      if (prev && Math.abs(prev.mtime - mtime) < 500) {
        sprites[rel] = prev; // copy unchanged entry
        skipped++;
        continue;
      }

      try {
        const img = await Jimp.read(absPath);
        const { width, height } = img.bitmap;
        sprites[rel] = {
          mtime,
          width,
          height,
          aspectRatio: width / (height || 1),
          phash:    await computePhash(absPath),
          hsvHist:  await computeHsvHistogram(absPath),
          alphaHash: await computeAlphaHash(absPath),
        };
        const isNew = !prev;
        if (isNew) indexed++; else updated++;
      } catch (e) {
        errors.push({ path: rel, error: e instanceof Error ? e.message : String(e) });
      }
    }

    saveIndex(indexPath, sprites);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({
        total_sprites: allPaths.length,
        newly_indexed: indexed,
        updated,
        skipped_unchanged: skipped,
        errors,
        index_path: indexPath,
      }, null, 2) }],
    };
  } catch (error) {
    return {
      content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

async function catalogSearch(args: Record<string, unknown>): Promise<ToolResult> {
  const intent        = (args.intent         as string | undefined) ?? '';
  const theme         = (args.theme          as string | undefined) ?? '';
  const notesContains = (args.notes_contains as string | undefined) ?? '';

  try {
    const { catalogPath } = getProjectPaths(args);
    const catalog = loadCatalog(catalogPath);
    const results: object[] = [];

    for (const [p, entry] of Object.entries(catalog)) {
      if (intent && entry.intent !== intent) continue;
      if (theme  && entry.theme  !== theme)  continue;
      if (notesContains && !entry.notes.toLowerCase().includes(notesContains.toLowerCase())) continue;
      results.push({ path: p, ...entry });
    }

    return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
  } catch (error) {
    return {
      content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

async function catalogTag(args: Record<string, unknown>): Promise<ToolResult> {
  const spritePath = args.sprite_path as string;
  const intent     = args.intent      as string;
  const theme      = (args.theme    as string | undefined) ?? '';
  const notes      = (args.notes    as string | undefined) ?? '';
  const usedInRaw  = (args.used_in  as string | undefined) ?? '';
  const usedIn     = usedInRaw ? usedInRaw.split(',').map((s) => s.trim()).filter(Boolean) : [];

  try {
    const { catalogPath } = getProjectPaths(args);
    const catalog = loadCatalog(catalogPath);
    catalog[spritePath] = {
      intent,
      theme,
      notes,
      usedIn,
      taggedAt: new Date().toISOString().slice(0, 10),
    };
    saveCatalog(catalogPath, catalog);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ status: 'tagged', sprite_path: spritePath, intent, theme }) }],
    };
  } catch (error) {
    return {
      content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

async function catalogList(args: Record<string, unknown>): Promise<ToolResult> {
  const intentFilter = (args.intent_filter as string | undefined) ?? '';

  try {
    const { catalogPath } = getProjectPaths(args);
    const catalog = loadCatalog(catalogPath);
    const result = intentFilter
      ? Object.fromEntries(Object.entries(catalog).filter(([, v]) => v.intent === intentFilter))
      : catalog;
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  } catch (error) {
    return {
      content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Factory — no PhotoshopConnection needed (pure file I/O)
// ---------------------------------------------------------------------------

export function createSpriteTools(): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'find_similar_sprites',
        description:
          'Find sprites in Assets/Sprites/ that visually resemble a given image.\n\n' +
          'Call this AFTER catalog_search returns nothing. Reliability:\n' +
          '  ~85% for character art and distinct icons\n' +
          '  ~55% for UI panels/backgrounds (similar-looking assets may score close)\n\n' +
          'Read the breakdown in each result: low hsv = colours differ, ' +
          'low alpha = transparency pattern differs. Both low = false positive.\n\n' +
          'Requires UNITY_PROJECT_ROOT env var (set in .mcp.json) or project_root arg. ' +
          'Run rebuild_sprite_index first if the index is empty.',
        inputSchema: {
          type: 'object',
          properties: {
            image_path: {
              type: 'string',
              description: 'Absolute path to the query PNG (e.g. /tmp/exported_layer.png)',
            },
            top_n: {
              type: 'number',
              description: 'Maximum results to return (default 5)',
              default: 5,
            },
            threshold: {
              type: 'number',
              description: 'Minimum combined score 0.0–1.0 (default 0.5)',
              minimum: 0,
              maximum: 1,
              default: 0.5,
            },
            project_root: {
              type: 'string',
              description: 'Absolute path to Unity project root (overrides UNITY_PROJECT_ROOT env)',
            },
          },
          required: ['image_path'],
        },
      },
      handler: async (args) => findSimilarSprites(args),
    },
    {
      tool: {
        name: 'rebuild_sprite_index',
        description:
          'Scan Assets/Sprites/ and build (or update) the visual search index.\n\n' +
          'Run this:\n' +
          '  - Before the first find_similar_sprites call\n' +
          '  - After importing new sprites into Assets/Sprites/\n\n' +
          'Only re-hashes files whose modification time changed. ' +
          'First-time build over ~500 sprites takes 1–3 minutes (single-threaded DCT). ' +
          'Subsequent incremental runs are fast.\n\n' +
          'Index is stored at {project_root}/Tools/.sprite_index.json (gitignored).',
        inputSchema: {
          type: 'object',
          properties: {
            project_root: {
              type: 'string',
              description: 'Absolute path to Unity project root (overrides UNITY_PROJECT_ROOT env)',
            },
          },
        },
      },
      handler: async (args) => rebuildSpriteIndex(args),
    },
    {
      tool: {
        name: 'catalog_search',
        description:
          'Search the sprite catalog by intent, theme, or notes.\n\n' +
          'Use this BEFORE find_similar_sprites — catalog hits are 100% reliable.\n\n' +
          'Standard intents:\n' +
          '  modal-background  modal-card       button-cta      button-secondary\n' +
          '  button-close      icon             character-art   decoration\n' +
          '  timer-bg          header-bg        tab-bg          progress-bar\n' +
          '  badge             divider          9slice-panel\n\n' +
          'Examples:\n' +
          '  catalog_search(intent="modal-background", theme="white-card")\n' +
          '  catalog_search(notes_contains="9-slice")',
        inputSchema: {
          type: 'object',
          properties: {
            intent: {
              type: 'string',
              description: 'Exact intent tag to match (e.g. "modal-background")',
            },
            theme: {
              type: 'string',
              description: 'Exact theme tag to match (e.g. "white-card", "blue-popup")',
            },
            notes_contains: {
              type: 'string',
              description: 'Case-insensitive substring match against notes field',
            },
            project_root: {
              type: 'string',
              description: 'Absolute path to Unity project root (overrides UNITY_PROJECT_ROOT env)',
            },
          },
        },
      },
      handler: async (args) => catalogSearch(args),
    },
    {
      tool: {
        name: 'catalog_tag',
        description:
          'Tag a sprite with its purpose and visual theme.\n\n' +
          'Run this every time a new sprite is imported so future lookups are deterministic.\n' +
          'sprite_path must be relative to the project root.\n\n' +
          'Standard intents:\n' +
          '  modal-background, modal-card, button-cta, button-secondary, button-close,\n' +
          '  icon, character-art, decoration, timer-bg, header-bg, tab-bg,\n' +
          '  progress-bar, badge, divider, 9slice-panel',
        inputSchema: {
          type: 'object',
          properties: {
            sprite_path: {
              type: 'string',
              description: 'Project-relative path, e.g. "Assets/Sprites/IntroModal/intro_bg.png"',
            },
            intent: {
              type: 'string',
              description: 'Primary purpose from the standard intent list',
            },
            theme: {
              type: 'string',
              description: 'Visual theme, e.g. "white-card", "blue-popup", "purple-daily-task"',
            },
            notes: {
              type: 'string',
              description: 'Free text: PPM value, 9-slice borders, special behaviour, etc.',
            },
            used_in: {
              type: 'string',
              description: 'Comma-separated prefab/modal names, e.g. "DailyTaskModal,LeagueModal"',
            },
            project_root: {
              type: 'string',
              description: 'Absolute path to Unity project root (overrides UNITY_PROJECT_ROOT env)',
            },
          },
          required: ['sprite_path', 'intent'],
        },
      },
      handler: async (args) => catalogTag(args),
    },
    {
      tool: {
        name: 'catalog_list',
        description:
          'List all tagged sprites in the catalog, optionally filtered by intent.\n' +
          'Useful to see what is already catalogued before tagging or searching.',
        inputSchema: {
          type: 'object',
          properties: {
            intent_filter: {
              type: 'string',
              description: 'Only return sprites with this intent (empty = return all)',
            },
            project_root: {
              type: 'string',
              description: 'Absolute path to Unity project root (overrides UNITY_PROJECT_ROOT env)',
            },
          },
        },
      },
      handler: async (args) => catalogList(args),
    },
  ];
}
