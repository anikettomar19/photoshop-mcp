import { existsSync, readFileSync } from 'fs';
import { createHash } from 'crypto';
import { Jimp } from 'jimp';

// ---------------------------------------------------------------------------
// Pure image-hashing primitives — pHash + HSV histogram + alpha mask.
//
// These operate on an already-decoded Jimp image so a sprite is decoded ONCE
// and all three hashes are derived from that single decode (the rebuild loop
// and find_similar previously decoded the same file 3–4×). Indexes record
// HASH_VERSION so entries hashed by older math get rebuilt, not compared.
//
// This module has no MCP/SDK dependencies so it can be imported by a
// worker_threads worker for parallel cold-index builds.
// ---------------------------------------------------------------------------

// Jimp v1's published types conflict across import resolution modes (tsc emits
// spurious "two different types with this name exist" errors when a decoded
// image is passed between functions). The runtime value is always a Jimp
// instance — use a loose type for the param to sidestep the broken typings.
type JimpImage = any;

// Bump when the perceptual hashes change shape; index entries from another
// version are re-hashed, since mixing versions makes every score meaningless.
// v2: hashes are taken on the trimmed image, and pHash composites over grey.
export const HASH_VERSION = 2;

export interface SpriteHashes {
  width: number;
  height: number;
  aspectRatio: number;
  phash: number[];
  hsvHist: number[];
  alphaHash: number[];
  contentHash: string;
  hv: number;
}

/**
 * Crop away fully transparent borders. The same art exported with padding must
 * hash like the unpadded copy. A fully transparent image is returned as is.
 */
export function trimTransparent(img: JimpImage): JimpImage {
  const { data, width, height } = img.bitmap;
  let x0 = width,
    y0 = height,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0 || (x0 === 0 && y0 === 0 && x1 === width - 1 && y1 === height - 1)) return img;
  return img.clone().crop({ x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 });
}

/**
 * Composite RGB over mid-grey by alpha, in place. Without this, greyscale reads
 * the RGB of transparent pixels, so white-on-transparent shapes all hash blank.
 */
export function flattenOverGrey(img: JimpImage): void {
  const { data } = img.bitmap;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] / 255;
    data[i] = Math.round(data[i] * a + 128 * (1 - a));
    data[i + 1] = Math.round(data[i + 1] * a + 128 * (1 - a));
    data[i + 2] = Math.round(data[i + 2] * a + 128 * (1 - a));
    data[i + 3] = 255;
  }
}

/**
 * Exact-identity hash: SHA-1 over the raw decoded RGBA bytes. Two sprites share
 * this ONLY if every pixel matches — the correct key for dedup. (pHash is
 * perceptual and false-merges same-shape / different-detail art, e.g. a blue tab
 * vs a red tab, or "GG" vs "KW" tags.)
 */
export function computeContentHash(img: JimpImage): string {
  return createHash('sha1').update(Buffer.from(img.bitmap.data)).digest('hex');
}

/**
 * 1-D Type-II Discrete Cosine Transform (O(n²), fine for n=32).
 */
export function dct1d(data: number[]): number[] {
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
 * Perceptual hash via 2-D DCT. Returns (hashSize² - 1) bits with DC removed.
 * Clones the input so the shared decoded image is never mutated.
 */
export function computePhash(img: JimpImage, hashSize = 8): number[] {
  const sample = hashSize * 4; // 32×32 for hashSize=8
  const work = img.clone();
  flattenOverGrey(work);
  work.resize({ w: sample, h: sample });
  work.greyscale();
  const { data, width } = work.bitmap;

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
 * Normalized HSV histogram over non-transparent pixels (read-only on `img`).
 */
export function computeHsvHistogram(img: JimpImage, hBins = 32, sBins = 8, vBins = 8): number[] {
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
      if (mx === r) h = ((g - b) / delta) % 6;
      else if (mx === g) h = (b - r) / delta + 2;
      else h = (r - g) / delta + 4;
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
 * Binary hash of the alpha mask (16×16 = 256 bits). Clones the input.
 */
export function computeAlphaHash(img: JimpImage, size = 16): number[] {
  const work = img.clone();
  work.resize({ w: size, h: size });
  const { data } = work.bitmap;
  const result: number[] = [];
  for (let i = 3; i < data.length; i += 4) {
    result.push(data[i] > 128 ? 1 : 0);
  }
  return result;
}

export interface NineSliceGeom {
  corner_radius: number;
  dominant_color: number[] | null;
}

/**
 * Corner radius (alpha edge inset) + dominant centre colour for a 9-slice sprite.
 * Mirrors nine_slice_matcher.py's _measure_corner_radius / _get_dominant_color so
 * the MCP-built nine-slice index is interchangeable with the Python-built one.
 */
export function computeNineSliceGeom(img: JimpImage): NineSliceGeom {
  const { data, width, height } = img.bitmap;
  const alphaAt = (x: number, y: number) => data[(y * width + x) * 4 + 3];

  // corner_radius: first opaque pixel along the top row and the left column, averaged.
  let corner_radius = 0;
  if (width >= 4 && height >= 4) {
    let left = 0;
    for (let x = 0; x < width; x++) {
      if (alphaAt(x, 0) > 128) {
        left = x;
        break;
      }
    }
    let top = 0;
    for (let y = 0; y < height; y++) {
      if (alphaAt(0, y) > 128) {
        top = y;
        break;
      }
    }
    corner_radius = (left + top) / 2.0;
  }

  // dominant_color: mean RGB of opaque pixels in the centre crop [h/4..h-h/4, w/4..w-w/4].
  const cy = Math.max(1, Math.floor(height / 4));
  const cx = Math.max(1, Math.floor(width / 4));
  let sr = 0,
    sg = 0,
    sb = 0,
    count = 0;
  for (let y = cy; y < height - cy; y++) {
    for (let x = cx; x < width - cx; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] > 128) {
        sr += data[i];
        sg += data[i + 1];
        sb += data[i + 2];
        count++;
      }
    }
  }
  const dominant_color =
    count < 10 ? null : [Math.trunc(sr / count), Math.trunc(sg / count), Math.trunc(sb / count)];

  return { corner_radius, dominant_color };
}

/**
 * All hashes for one decoded image. Width/height and contentHash describe the
 * file as stored; the perceptual hashes and aspect ratio use the trimmed art.
 */
export function computeSpriteHashes(img: JimpImage): SpriteHashes {
  const { width, height } = img.bitmap;
  const art = trimTransparent(img);
  return {
    width,
    height,
    aspectRatio: art.bitmap.width / (art.bitmap.height || 1),
    phash: computePhash(art),
    hsvHist: computeHsvHistogram(art),
    alphaHash: computeAlphaHash(art),
    contentHash: computeContentHash(img),
    hv: HASH_VERSION,
  };
}

/**
 * Decode a file once and compute all hashes + dimensions.
 */
export async function hashImageFile(absPath: string): Promise<SpriteHashes> {
  return computeSpriteHashes(await Jimp.read(absPath));
}

// ---------------------------------------------------------------------------
// Pixel verification — the hashes only shortlist. Similar colour + silhouette
// scores high for different art (two coins at different angles), so a match is
// labelled by comparing the trimmed pixels at a common size.
// ---------------------------------------------------------------------------

// 'review' is the honest middle: resize artefacts on tiny sprites and real shape
// changes on soft glows land at the same distances, so no threshold splits them.
export type Verdict = 'exact' | 'same_art' | 'review' | 'different';

export interface ArtComparison {
  verdict: Verdict;
  mad: number | null; // mean abs difference per channel, 0–255
  p95: number | null; // 95th-percentile per-pixel max channel difference
}

// Trimmed aspect ratios further apart than this are different shapes, not a resize.
const VERIFY_MAX_ASPECT_DIFF = 0.06;
// Compared at this longest side, so resolution differences mostly wash out.
const VERIFY_SIDE = 32;
// Calibrated on hand-labelled pairs (same art at 2–4× resolution vs different
// art with the same colours and silhouette); see test/sprite-verify.test.mjs.
const SAME_ART_MAX_MAD = 2.5;
const SAME_ART_MAX_P95 = 25;
const REVIEW_MAX_MAD = 8;

/**
 * Area-average shrink to w×h (alpha-weighted). Resampling filters skip source
 * pixels when shrinking a lot, which makes two copies of the same art differ.
 */
function boxShrink(img: JimpImage, w: number, h: number): Float64Array {
  const { data, width: W, height: H } = img.bitmap;
  const out = new Float64Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy0 = Math.floor((y * H) / h);
    const sy1 = Math.max(sy0 + 1, Math.floor(((y + 1) * H) / h));
    for (let x = 0; x < w; x++) {
      const sx0 = Math.floor((x * W) / w);
      const sx1 = Math.max(sx0 + 1, Math.floor(((x + 1) * W) / w));
      let r = 0,
        g = 0,
        b = 0,
        a = 0,
        n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const i = (sy * W + sx) * 4;
          const al = data[i + 3];
          r += data[i] * al;
          g += data[i + 1] * al;
          b += data[i + 2] * al;
          a += al;
          n++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = a ? r / a : 0;
      out[o + 1] = a ? g / a : 0;
      out[o + 2] = a ? b / a : 0;
      out[o + 3] = a / n;
    }
  }
  return out;
}

export function compareArt(a: JimpImage, b: JimpImage): ArtComparison {
  if (
    a.bitmap.width === b.bitmap.width &&
    a.bitmap.height === b.bitmap.height &&
    computeContentHash(a) === computeContentHash(b)
  ) {
    return { verdict: 'exact', mad: 0, p95: 0 };
  }
  const A = trimTransparent(a);
  const B = trimTransparent(b);
  const arA = A.bitmap.width / (A.bitmap.height || 1);
  const arB = B.bitmap.width / (B.bitmap.height || 1);
  if (Math.abs(arA - arB) / Math.max(arA, arB) > VERIFY_MAX_ASPECT_DIFF) {
    return { verdict: 'different', mad: null, p95: null };
  }

  const cw = Math.min(A.bitmap.width, B.bitmap.width);
  const ch = Math.min(A.bitmap.height, B.bitmap.height);
  const s = Math.min(1, VERIFY_SIDE / Math.max(cw, ch));
  const w = Math.max(1, Math.round(cw * s));
  const h = Math.max(1, Math.round(ch * s));
  const pa = boxShrink(A, w, h);
  const pb = boxShrink(B, w, h);
  const perPixel = new Float64Array(w * h);
  let sum = 0;
  for (let p = 0; p < w * h; p++) {
    const o = p * 4;
    // Compare as composited over grey so the RGB of transparent pixels is ignored.
    const fa = pa[o + 3] / 255;
    const fb = pb[o + 3] / 255;
    let worst = 0;
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(pa[o + c] * fa + 128 * (1 - fa) - (pb[o + c] * fb + 128 * (1 - fb)));
      sum += d;
      if (d > worst) worst = d;
    }
    const da = Math.abs(pa[o + 3] - pb[o + 3]);
    sum += da;
    perPixel[p] = Math.max(worst, da);
  }
  const mad = sum / (w * h * 4);
  const sorted = Array.from(perPixel).sort((x, y) => x - y);
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  const verdict: Verdict =
    mad < SAME_ART_MAX_MAD && p95 < SAME_ART_MAX_P95
      ? 'same_art'
      : mad < REVIEW_MAX_MAD
        ? 'review'
        : 'different';
  return { verdict, mad: Math.round(mad * 100) / 100, p95: Math.round(p95) };
}

/**
 * Read Unity 9-slice spriteBorder from the sibling .meta file.
 * Returns [left, bottom, right, top] or undefined when absent / all-zero.
 */
export function readSpriteBorder(absPath: string): [number, number, number, number] | undefined {
  const metaPath = absPath + '.meta';
  if (!existsSync(metaPath)) return undefined;
  try {
    const content = readFileSync(metaPath, 'utf8');
    const m = content.match(
      /spriteBorder:\s*\{x:\s*([\d.]+),\s*y:\s*([\d.]+),\s*z:\s*([\d.]+),\s*w:\s*([\d.]+)\}/
    );
    if (!m) return undefined;
    const border: [number, number, number, number] = [
      parseFloat(m[1]),
      parseFloat(m[2]),
      parseFloat(m[3]),
      parseFloat(m[4]),
    ];
    if (border.every((v) => v === 0)) return undefined;
    return border;
  } catch {
    return undefined;
  }
}
