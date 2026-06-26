import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { basename, extname, join, relative } from 'path';
import { cpus, homedir } from 'os';
import { createHash } from 'crypto';
import { Worker } from 'worker_threads';
import { Jimp } from 'jimp';
import { ToolDefinition, ToolResult } from '../core/tool-registry.js';
import { computePhash, computeHsvHistogram, computeAlphaHash, computeNineSliceGeom, readSpriteBorder } from './sprite-hash.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SpriteEntry {
  mtime: number;
  width: number;
  height: number;
  aspectRatio: number;
  phash: number[];
  hsvHist: number[];
  alphaHash: number[];
  spriteBorder?: [number, number, number, number]; // [x,y,z,w] from .meta (9-slice only)
  corner_radius?: number;        // 9-slice geometry (only present when spriteBorder is set)
  dominant_color?: number[] | null;
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
// Image hashing (pHash + HSV histogram + alpha mask) and readSpriteBorder now
// live in ./sprite-hash.ts — shared with the worker_threads pool used for
// parallel cold-index builds. The hash fns take an already-decoded Jimp image
// (decode once, hash three times) and are imported at the top of this file.
// ---------------------------------------------------------------------------

/**
 * 9-slice stretch a Jimp image to target width/height.
 * Border = [left, bottom, right, top] (Unity spriteBorder convention).
 */
export async function nineSliceStretch(
  img: InstanceType<typeof Jimp>,
  border: [number, number, number, number],
  tw: number,
  th: number,
): Promise<any> {
  let [bl, bb, br, bt] = border.map(Math.round);
  const iw = img.width;
  const ih = img.height;

  bl = Math.min(bl, Math.floor(iw / 2));
  br = Math.min(br, Math.floor(iw / 2));
  bt = Math.min(bt, Math.floor(ih / 2));
  bb = Math.min(bb, Math.floor(ih / 2));
  if (bl + br >= iw) { bl = Math.floor(iw / 3); br = Math.floor(iw / 3); }
  if (bt + bb >= ih) { bt = Math.floor(ih / 3); bb = Math.floor(ih / 3); }

  const cw = iw - bl - br;
  const ch = ih - bt - bb;
  const ncw = Math.max(1, tw - bl - br);
  const nch = Math.max(1, th - bt - bb);

  const result = new Jimp({ width: tw, height: th, color: 0x00000000 });

  const regions: Array<{ sx: number; sy: number; sw: number; sh: number; dx: number; dy: number; dw: number; dh: number }> = [
    { sx: 0, sy: 0, sw: bl, sh: bt, dx: 0, dy: 0, dw: bl, dh: bt },
    { sx: bl, sy: 0, sw: cw, sh: bt, dx: bl, dy: 0, dw: ncw, dh: bt },
    { sx: iw - br, sy: 0, sw: br, sh: bt, dx: tw - br, dy: 0, dw: br, dh: bt },
    { sx: 0, sy: bt, sw: bl, sh: ch, dx: 0, dy: bt, dw: bl, dh: nch },
    { sx: bl, sy: bt, sw: cw, sh: ch, dx: bl, dy: bt, dw: ncw, dh: nch },
    { sx: iw - br, sy: bt, sw: br, sh: ch, dx: tw - br, dy: bt, dw: br, dh: nch },
    { sx: 0, sy: ih - bb, sw: bl, sh: bb, dx: 0, dy: th - bb, dw: bl, dh: bb },
    { sx: bl, sy: ih - bb, sw: cw, sh: bb, dx: bl, dy: th - bb, dw: ncw, dh: bb },
    { sx: iw - br, sy: ih - bb, sw: br, sh: bb, dx: tw - br, dy: th - bb, dw: br, dh: bb },
  ];

  for (const r of regions) {
    if (r.sw <= 0 || r.sh <= 0 || r.dw <= 0 || r.dh <= 0) continue;
    const piece = img.clone().crop({ x: r.sx, y: r.sy, w: r.sw, h: r.sh });
    if (piece.width !== r.dw || piece.height !== r.dh) {
      piece.resize({ w: r.dw, h: r.dh });
    }
    (result as any).composite(piece, r.dx, r.dy);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Similarity metrics
// ---------------------------------------------------------------------------

export function hammingSim(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  return a.reduce((s, v, i) => s + (v === b[i] ? 1 : 0), 0) / a.length;
}

export function chiSquaredSim(a: number[], b: number[]): number {
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
export function combinedScore(
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

// 9-slice stretch is expensive (decode + 9 crop/resize + 3 hashes per sprite).
// Only the top candidates by HSV similarity are stretch-tested.
export const NINE_SLICE_RECHECK_LIMIT = 10;

// Monotonic counter for stretch temp files — combined with pid this is
// collision-free across concurrent searches in the same process.
let tmpCounter = 0;

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

/**
 * Per-project cache dir, owned by the photoshop-mcp namespace and OUTSIDE any
 * git repo (so it never pollutes the Unity project / needs a .gitignore there).
 * Keyed by a hash of the project root so multiple projects don't collide, and
 * computed identically in nine_slice_matcher.py so both tools find the same files.
 *   ~/.cache/photoshop-mcp/<sha1(projectRoot)[:12]>/{sprite_index,nine_slice_index}.json
 */
export function cacheDirFor(projectRoot: string): string {
  const norm = projectRoot.replace(/\/+$/, '');
  const key = createHash('sha1').update(norm).digest('hex').slice(0, 12);
  return join(homedir(), '.cache', 'photoshop-mcp', key);
}

export function getProjectPaths(args: Record<string, unknown>) {
  const projectRoot =
    (args.project_root as string | undefined) || process.env.UNITY_PROJECT_ROOT;
  if (!projectRoot) {
    throw new Error(
      'Project root not set. Set UNITY_PROJECT_ROOT in .mcp.json env, or pass project_root arg.'
    );
  }
  const cacheDir = cacheDirFor(projectRoot);
  return {
    projectRoot,
    spritesRoot: join(projectRoot, 'Assets', 'Sprites'),
    catalogPath: join(projectRoot, 'Assets', 'Sprites', '.sprite_catalog.json'),
    indexPath: join(cacheDir, 'sprite_index.json'),
    nineSliceIndexPath: join(cacheDir, 'nine_slice_index.json'),
  };
}

export function loadIndex(indexPath: string): Record<string, SpriteEntry> {
  if (!existsSync(indexPath)) return {};
  try {
    return (JSON.parse(readFileSync(indexPath, 'utf8')) as IndexFile).sprites ?? {};
  } catch {
    return {};
  }
}

export function saveIndex(indexPath: string, sprites: Record<string, SpriteEntry>): void {
  mkdirSync(join(indexPath, '..'), { recursive: true });
  const data: IndexFile = { version: 1, indexedAt: new Date().toISOString(), sprites };
  writeFileSync(indexPath, JSON.stringify(data));
}

interface NineSliceEntry {
  path: string;
  name: string;
  border: [number, number, number, number];
  corner_radius: number;
  dominant_color: number[] | null;
}

// nine_slice_matcher.py scans these roots (not just Assets/Sprites) for bordered
// sprites. The sprite index stays scoped to Assets/Sprites (find_similar's domain),
// but the nine-slice index must match the Python scope or the matcher loses candidates.
const NINE_SLICE_EXTRA_ROOTS = ['Assets/Resources', 'Assets/Textures', 'Assets/Art'];

/**
 * Build the nine-slice list (version-2 schema nine_slice_matcher.py reads): every
 * bordered sprite + its 9-slice geometry. Assets/Sprites entries reuse the geometry
 * already computed during the index build; the extra roots are decoded here (few,
 * bordered-only). A single rebuild_sprite_index therefore produces both indexes.
 */
async function collectNineSliceSprites(
  projectRoot: string,
  sprites: Record<string, SpriteEntry>
): Promise<NineSliceEntry[]> {
  const list: NineSliceEntry[] = [];
  const seen = new Set<string>();

  for (const [rel, e] of Object.entries(sprites)) {
    if (!e.spriteBorder) continue;
    list.push({
      path: rel,
      name: basename(rel, extname(rel)),
      border: e.spriteBorder,
      corner_radius: e.corner_radius ?? 0,
      dominant_color: e.dominant_color ?? null,
    });
    seen.add(rel);
  }

  for (const sub of NINE_SLICE_EXTRA_ROOTS) {
    const root = join(projectRoot, sub);
    if (!existsSync(root)) continue;
    for (const absPath of walkDir(root)) {
      const rel = relative(projectRoot, absPath);
      if (seen.has(rel)) continue;
      const border = readSpriteBorder(absPath);
      if (!border) continue;
      try {
        const geom = computeNineSliceGeom(await Jimp.read(absPath));
        list.push({ path: rel, name: basename(rel, extname(rel)), border, ...geom });
        seen.add(rel);
      } catch {
        // unreadable sprite — skip (matches Python's try/except)
      }
    }
  }
  return list;
}

function writeNineSliceIndex(indexPath: string, sprites: NineSliceEntry[]): void {
  mkdirSync(join(indexPath, '..'), { recursive: true });
  writeFileSync(indexPath, JSON.stringify({ version: 2, sprites }, null, 2));
}

export function loadCatalog(catalogPath: string): Record<string, CatalogEntry> {
  if (!existsSync(catalogPath)) return {};
  try {
    return (JSON.parse(readFileSync(catalogPath, 'utf8')) as CatalogFile).sprites ?? {};
  } catch {
    return {};
  }
}

export function saveCatalog(catalogPath: string, sprites: Record<string, CatalogEntry>): void {
  mkdirSync(join(catalogPath, '..'), { recursive: true });
  writeFileSync(catalogPath, JSON.stringify({ version: 1, sprites }, null, 2));
}

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

/**
 * Core similarity search — shared by the MCP tool handler and
 * find-similar-cli.js (subprocess access without MCP overhead).
 * Throws when the index is empty.
 */
export async function searchSimilarSprites(
  queryPath: string,
  projectRoot: string,
  threshold: number = 0.5,
  topN: number = 5,
): Promise<Array<Record<string, unknown>>> {
  const indexPath = join(cacheDirFor(projectRoot), 'sprite_index.json');
  const catalogPath = join(projectRoot, 'Assets', 'Sprites', '.sprite_catalog.json');
  const index = loadIndex(indexPath);

  if (Object.keys(index).length === 0) {
    throw new Error('Index is empty — call rebuild_sprite_index first.');
  }

  const qImg   = await Jimp.read(queryPath);
  const qPhash = computePhash(qImg);
  const qHsv   = computeHsvHistogram(qImg);
  const qAlpha = computeAlphaHash(qImg);
  const qAspect = qImg.bitmap.width / (qImg.bitmap.height || 1);
  const qWidth  = qImg.bitmap.width;
  const qHeight = qImg.bitmap.height;

  const catalog = loadCatalog(catalogPath);
  const results: Array<Record<string, unknown>> = [];
  const nineSliceCandidates: Array<{ rel: string; entry: SpriteEntry; hsvScore: number }> = [];

    // Pass 1: native comparison (pure arithmetic). Bordered sprites that fail
    // the aspect gate but could 9-slice-stretch to the query size are queued
    // for pass 2 instead of being stretched inline — stretching every bordered
    // candidate cost 5-15s per query.
    for (const [rel, entry] of Object.entries(index)) {
      const aspectDiff = Math.abs(entry.aspectRatio - qAspect) / Math.max(qAspect, 0.01);

      if (aspectDiff > 0.25) {
        if (entry.spriteBorder && qWidth > entry.width * 1.5 && qHeight > entry.height * 1.2) {
          const hsvS = chiSquaredSim(qHsv, entry.hsvHist);
          if (hsvS > 0.3) nineSliceCandidates.push({ rel, entry, hsvScore: hsvS });
        }
        continue;
      }

      const nativePhash = hammingSim(qPhash, entry.phash);
      const nativeHsv = chiSquaredSim(qHsv, entry.hsvHist);
      const nativeAlpha = hammingSim(qAlpha, entry.alphaHash);
      const sc = combinedScore(nativePhash, nativeHsv, nativeAlpha, aspectDiff);

      if (sc >= threshold) {
        results.push({
          path: rel,
          score: Math.round(sc * 1000) / 1000,
          breakdown: {
            phash: Math.round(nativePhash * 1000) / 1000,
            hsv:   Math.round(nativeHsv * 1000) / 1000,
            alpha: Math.round(nativeAlpha * 1000) / 1000,
          },
          dimensions: `${entry.width}×${entry.height}`,
          _spriteBorder: entry.spriteBorder,
        });
      }
    }

    // Pass 2: 9-slice stretch only the top HSV-prefiltered candidates.
    nineSliceCandidates.sort((a, b) => b.hsvScore - a.hsvScore);
    for (const { rel, entry } of nineSliceCandidates.slice(0, NINE_SLICE_RECHECK_LIMIT)) {
      try {
        const absPath = join(projectRoot, rel);
        const spriteImg = await Jimp.read(absPath);
        const stretched = await nineSliceStretch(spriteImg as any, entry.spriteBorder!, qWidth, qHeight);

        // Round-trip through a lossless PNG (preserves exact pixels), then
        // decode once and compute all three hashes from that single decode.
        // pid + counter avoids collisions between concurrent searches.
        const tmpPath = `/tmp/_9slice_stretch_${process.pid}_${++tmpCounter}.png`;
        const buf = await stretched.getBuffer('image/png');
        writeFileSync(tmpPath, buf);
        const sImg = await Jimp.read(tmpPath);
        const sPhash = hammingSim(qPhash, computePhash(sImg));
        const sHsv = chiSquaredSim(qHsv, computeHsvHistogram(sImg));
        const sAlpha = hammingSim(qAlpha, computeAlphaHash(sImg));
        try {
          const { unlinkSync } = await import('fs');
          unlinkSync(tmpPath);
        } catch (err) {
          console.warn(`temp cleanup failed for ${tmpPath}: ${err instanceof Error ? err.message : String(err)}`);
        }

        const sc = combinedScore(sPhash, sHsv, sAlpha, 0);
        if (sc >= threshold) {
          results.push({
            path: rel,
            score: Math.round(sc * 1000) / 1000,
            breakdown: {
              phash: Math.round(sPhash * 1000) / 1000,
              hsv:   Math.round(sHsv * 1000) / 1000,
              alpha: Math.round(sAlpha * 1000) / 1000,
            },
            dimensions: `${entry.width}×${entry.height}`,
            match_type: '9slice_stretched',
            _spriteBorder: entry.spriteBorder,
          });
        }
      } catch (err) {
        console.warn(`9-slice stretch failed for ${rel}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Deduplicate by path (keep highest score), attach catalog + spriteBorder.
    const best = new Map<string, Record<string, unknown>>();
    for (const r of results) {
      const p = r.path as string;
      const prev = best.get(p);
      if (!prev || (r.score as number) > (prev.score as number)) best.set(p, r);
    }
    const finalResults = [...best.values()]
      .sort((a, b) => (b.score as number) - (a.score as number))
      .slice(0, topN);
    for (const r of finalResults) {
      const border = r._spriteBorder;
      delete r._spriteBorder;
      if (border) r.spriteBorder = border;
      const cat = catalog[r.path as string];
      if (cat) r.catalog = cat;
    }

  return finalResults;
}

async function findSimilarSprites(args: Record<string, unknown>): Promise<ToolResult> {
  const topN      = (args.top_n     as number | undefined) ?? 5;
  const threshold = (args.threshold as number | undefined) ?? 0.5;
  const queryPath = args.image_path as string;

  try {
    const { projectRoot } = getProjectPaths(args);
    const results = await searchSimilarSprites(queryPath, projectRoot, threshold, topN);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }],
    };
  } catch (error) {
    return {
      content: [{ type: 'text' as const, text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

interface HashJob {
  absPath: string;
  rel: string;
  mtime: number;
  isNew: boolean;
}

interface WorkerResult {
  entries: Array<{ rel: string; isNew: boolean; entry: SpriteEntry }>;
  errors: Array<{ path: string; error: string }>;
}

/**
 * Decode + hash a list of sprites in parallel across CPU cores using a
 * worker_threads pool. Each sprite is decoded once (the worker derives all
 * three hashes from that single decode). Jobs are round-robin partitioned so
 * large/small sprites spread evenly. Hash math is identical to the serial path.
 */
async function runHashWorkers(jobs: HashJob[]): Promise<WorkerResult> {
  const merged: WorkerResult = { entries: [], errors: [] };
  if (jobs.length === 0) return merged;

  const workerUrl = new URL('./sprite-hash-worker.js', import.meta.url);
  const poolSize = Math.max(1, Math.min(jobs.length, cpus().length - 1));

  const chunks: HashJob[][] = Array.from({ length: poolSize }, () => []);
  jobs.forEach((job, i) => chunks[i % poolSize].push(job));

  await Promise.all(chunks.map((chunk) => new Promise<void>((resolve, reject) => {
    const worker = new Worker(workerUrl, { workerData: { jobs: chunk } });
    worker.once('message', (msg: WorkerResult) => {
      merged.entries.push(...msg.entries);
      merged.errors.push(...msg.errors);
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`hash worker exited with code ${code}`));
    });
  })));

  return merged;
}

export async function rebuildSpriteIndex(args: Record<string, unknown>): Promise<ToolResult> {
  try {
    const { projectRoot, spritesRoot, indexPath, nineSliceIndexPath } = getProjectPaths(args);
    const existing = loadIndex(indexPath);
    const allPaths = walkDir(spritesRoot);

    let indexed = 0, updated = 0, skipped = 0;
    const errors: object[] = [];
    const sprites: Record<string, SpriteEntry> = {};
    const jobs: HashJob[] = [];

    // Serial pass (statSync only): reuse unchanged entries, queue the rest for hashing.
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
      jobs.push({ absPath, rel, mtime, isNew: !prev });
    }

    // Parallel decode + hash across CPU cores.
    const { entries, errors: workerErrors } = await runHashWorkers(jobs);
    for (const { rel, isNew, entry } of entries) {
      sprites[rel] = entry;
      if (isNew) indexed++; else updated++;
    }
    errors.push(...workerErrors);

    saveIndex(indexPath, sprites);
    // Build the nine-slice index in the same pass (covers Assets/Sprites + the
    // extra roots nine_slice_matcher.py scans).
    const nineSliceList = await collectNineSliceSprites(projectRoot, sprites);
    writeNineSliceIndex(nineSliceIndexPath, nineSliceList);
    const nineSliceCount = nineSliceList.length;
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({
        total_sprites: allPaths.length,
        newly_indexed: indexed,
        updated,
        skipped_unchanged: skipped,
        nine_slice_sprites: nineSliceCount,
        errors,
        index_path: indexPath,
        nine_slice_index_path: nineSliceIndexPath,
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
          'Cold build over ~5,000 sprites takes ~90s (parallel worker threads); ' +
          'incremental runs take seconds.\n\n' +
          'Index is stored at ~/.cache/photoshop-mcp/<project_hash>/sprite_index.json ' +
          '(outside the repo — no gitignore needed). The nine-slice index is built in the same pass.',
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
