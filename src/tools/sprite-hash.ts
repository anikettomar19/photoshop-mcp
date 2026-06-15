import { existsSync, readFileSync } from 'fs';
import { Jimp } from 'jimp';

// ---------------------------------------------------------------------------
// Pure image-hashing primitives — pHash + HSV histogram + alpha mask.
//
// These operate on an already-decoded Jimp image so a sprite is decoded ONCE
// and all three hashes are derived from that single decode (the rebuild loop
// and find_similar previously decoded the same file 3–4×). The math is
// byte-identical to the original path so existing indexes stay valid.
//
// This module has no MCP/SDK dependencies so it can be imported by a
// worker_threads worker for parallel cold-index builds.
// ---------------------------------------------------------------------------

// Jimp v1's published types conflict across import resolution modes (tsc emits
// spurious "two different types with this name exist" errors when a decoded
// image is passed between functions). The runtime value is always a Jimp
// instance — use a loose type for the param to sidestep the broken typings.
type JimpImage = any;

export interface SpriteHashes {
  width: number;
  height: number;
  aspectRatio: number;
  phash: number[];
  hsvHist: number[];
  alphaHash: number[];
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
export function computeHsvHistogram(
  img: JimpImage,
  hBins = 32,
  sBins = 8,
  vBins = 8
): number[] {
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
    for (let x = 0; x < width; x++) { if (alphaAt(x, 0) > 128) { left = x; break; } }
    let top = 0;
    for (let y = 0; y < height; y++) { if (alphaAt(0, y) > 128) { top = y; break; } }
    corner_radius = (left + top) / 2.0;
  }

  // dominant_color: mean RGB of opaque pixels in the centre crop [h/4..h-h/4, w/4..w-w/4].
  const cy = Math.max(1, Math.floor(height / 4));
  const cx = Math.max(1, Math.floor(width / 4));
  let sr = 0, sg = 0, sb = 0, count = 0;
  for (let y = cy; y < height - cy; y++) {
    for (let x = cx; x < width - cx; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] > 128) { sr += data[i]; sg += data[i + 1]; sb += data[i + 2]; count++; }
    }
  }
  const dominant_color = count < 10
    ? null
    : [Math.trunc(sr / count), Math.trunc(sg / count), Math.trunc(sb / count)];

  return { corner_radius, dominant_color };
}

/**
 * Decode a file once and compute all three hashes + dimensions.
 */
export async function hashImageFile(absPath: string): Promise<SpriteHashes> {
  const img = await Jimp.read(absPath);
  const { width, height } = img.bitmap;
  return {
    width,
    height,
    aspectRatio: width / (height || 1),
    phash: computePhash(img),
    hsvHist: computeHsvHistogram(img),
    alphaHash: computeAlphaHash(img),
  };
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
    const m = content.match(/spriteBorder:\s*\{x:\s*([\d.]+),\s*y:\s*([\d.]+),\s*z:\s*([\d.]+),\s*w:\s*([\d.]+)\}/);
    if (!m) return undefined;
    const border: [number, number, number, number] = [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), parseFloat(m[4])];
    if (border.every(v => v === 0)) return undefined;
    return border;
  } catch {
    return undefined;
  }
}
