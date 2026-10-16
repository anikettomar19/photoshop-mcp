// find_similar_sprites accuracy: trimming, alpha-aware pHash, pixel verdicts and
// sprite roots, run against throwaway fake Unity projects. No Photoshop needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Jimp } from 'jimp';
import {
  cacheDirFor,
  hammingSim,
  rebuildSpriteIndex,
  searchSimilarSprites,
} from '../dist/tools/sprite-tools.js';
import { compareArt, computePhash, HASH_VERSION } from '../dist/tools/sprite-hash.js';

// Draws by calling fn(x, y, w, h) -> [r, g, b, a] for every pixel.
function draw(w, h, fn) {
  const img = new Jimp({ width: w, height: h, color: 0x00000000 });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = fn(x, y, w, h);
      img.bitmap.data.set([r, g, b, a], (y * w + x) * 4);
    }
  }
  return img;
}

// A 4×4 grid of distinct colours: detailed enough that a wrong match shows.
const GRID = [
  [230, 40, 40],
  [40, 200, 60],
  [40, 80, 220],
  [240, 200, 30],
  [150, 40, 200],
  [30, 200, 200],
  [250, 130, 20],
  [90, 90, 90],
  [200, 200, 200],
  [120, 60, 20],
  [20, 120, 60],
  [220, 100, 160],
  [60, 20, 120],
  [180, 220, 90],
  [10, 10, 10],
  [250, 250, 250],
];
const badge = (scale) =>
  draw(16 * scale, 16 * scale, (x, y, w) => {
    const cell = w / 4;
    return [...GRID[Math.floor(y / cell) * 4 + Math.floor(x / cell)], 255];
  });

function pad(img, p) {
  const out = new Jimp({ width: img.width + 2 * p, height: img.height + 2 * p, color: 0x00000000 });
  out.composite(img, p, p);
  return out;
}

// White everywhere, shape only in alpha — how exported white UI shapes look.
const whiteShape = (size, inside) =>
  draw(size, size, (x, y, w, h) => [255, 255, 255, inside(x + 0.5, y + 0.5, w, h) ? 255 : 0]);
const circle = (x, y, w) => (x - w / 2) ** 2 + (y - w / 2) ** 2 <= (w / 2) ** 2;
const roundedSquare = (x, y, w) => {
  const r = w * 0.15;
  const cx = Math.min(Math.max(x, r), w - r);
  const cy = Math.min(Math.max(y, r), w - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};

// Gold disc with a dark glyph: same palette and silhouette, different art.
const goldDisc = (size, glyph) =>
  draw(size, size, (x, y, w) => {
    if (!circle(x + 0.5, y + 0.5, w)) return [0, 0, 0, 0];
    return glyph(x / w, y / w) ? [120, 60, 10, 255] : [245, 190, 40, 255];
  });
const crossGlyph = (u, v) => Math.abs(u - 0.5) < 0.08 || Math.abs(v - 0.5) < 0.08;
const ringGlyph = (u, v) => {
  const d = Math.hypot(u - 0.5, v - 0.5);
  return d > 0.22 && d < 0.3;
};

async function save(path, img) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, await img.getBuffer('image/png'));
}

async function withProject(fn) {
  const root = mkdtempSync(join(tmpdir(), 'psmcp-verify-'));
  try {
    await fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(cacheDirFor(root), { recursive: true, force: true });
  }
}

async function rebuild(root, extra = {}) {
  const res = await rebuildSpriteIndex({ project_root: root, ...extra });
  assert.ok(!res.isError, res.content[0].text);
  return JSON.parse(res.content[0].text);
}

test('a project with Assets/Sprite (not Sprites) is indexed and searchable', async () => {
  await withProject(async (root) => {
    await save(join(root, 'Assets/Sprite/UI/badge.png'), badge(4));
    const report = await rebuild(root);
    assert.deepEqual(report.sprite_roots, ['Assets/Sprite']);
    assert.equal(report.unique_sprites, 1);

    const q = join(root, 'q.png');
    await save(q, badge(4));
    const [top] = await searchSimilarSprites(q, root, 0.5, 3);
    assert.equal(top.path, 'Assets/Sprite/UI/badge.png');
    assert.equal(top.verdict, 'exact');
  });
});

test('explicit sprite_roots override auto-detection', async () => {
  await withProject(async (root) => {
    await save(join(root, 'Assets/Sprites/a.png'), badge(2));
    await save(join(root, 'Assets/Art/b.png'), badge(3));
    const report = await rebuild(root, { sprite_roots: ['Assets/Art'] });
    assert.deepEqual(report.sprite_roots, ['Assets/Art']);
    assert.equal(report.total_sprites, 1);
  });
});

test('the same art with transparent padding is found as same_art', async () => {
  await withProject(async (root) => {
    await save(join(root, 'Assets/Sprites/badge.png'), badge(4));
    await save(join(root, 'Assets/Sprites/other.png'), goldDisc(64, crossGlyph));
    await rebuild(root);

    const q = join(root, 'q.png');
    await save(q, pad(badge(4), 12));
    const [top] = await searchSimilarSprites(q, root, 0.5, 3);
    assert.equal(top.path, 'Assets/Sprites/badge.png');
    assert.equal(top.score, 1);
    assert.equal(top.verdict, 'same_art');
  });
});

test('the same art at another resolution is found as same_art', async () => {
  await withProject(async (root) => {
    await save(join(root, 'Assets/Sprites/badge.png'), badge(8));
    await rebuild(root);

    const q = join(root, 'q.png');
    await save(q, badge(3));
    const [top] = await searchSimilarSprites(q, root, 0.5, 3);
    assert.equal(top.path, 'Assets/Sprites/badge.png');
    assert.equal(top.verdict, 'same_art');
  });
});

test('pHash sees the shape of white-on-transparent sprites', async () => {
  // Before compositing over grey, every white shape hashed as a blank square.
  const sim = hammingSim(
    computePhash(whiteShape(64, circle)),
    computePhash(whiteShape(64, roundedSquare))
  );
  assert.ok(sim < 0.95, `circle vs rounded square pHash similarity ${sim}`);

  await withProject(async (root) => {
    await save(join(root, 'Assets/Sprites/circle.png'), whiteShape(64, circle));
    await save(join(root, 'Assets/Sprites/rounded.png'), whiteShape(64, roundedSquare));
    await rebuild(root);
    const q = join(root, 'q.png');
    await save(q, whiteShape(40, circle));
    const [top] = await searchSimilarSprites(q, root, 0.3, 3);
    assert.equal(top.path, 'Assets/Sprites/circle.png');
  });
});

test('same colours and silhouette but different art is not confirmed as the same', async () => {
  const cmp = compareArt(goldDisc(64, crossGlyph), goldDisc(64, ringGlyph));
  assert.notEqual(cmp.verdict, 'same_art');
  assert.notEqual(cmp.verdict, 'exact');

  await withProject(async (root) => {
    await save(join(root, 'Assets/Sprites/coin_ring.png'), goldDisc(64, ringGlyph));
    await save(join(root, 'Assets/Sprites/coin_cross.png'), goldDisc(64, crossGlyph));
    await rebuild(root);
    const q = join(root, 'q.png');
    // Resampled from the master, as a lower-res export is; redrawing at 32px
    // aliases the thin glyph differently and rightly lands in 'review'.
    await save(q, goldDisc(64, crossGlyph).resize({ w: 32, h: 32 }));
    const results = await searchSimilarSprites(q, root, 0.3, 3);
    assert.equal(results[0].path, 'Assets/Sprites/coin_cross.png');
    assert.equal(results[0].verdict, 'same_art');
    const ring = results.find((r) => r.path === 'Assets/Sprites/coin_ring.png');
    if (ring) assert.notEqual(ring.verdict, 'same_art');
  });
});

test('an index hashed by older math is rebuilt before searching', async () => {
  await withProject(async (root) => {
    await save(join(root, 'Assets/Sprites/badge.png'), badge(4));
    await rebuild(root);
    const indexPath = join(cacheDirFor(root), 'sprite_index.json');
    const index = JSON.parse(readFileSync(indexPath, 'utf8'));
    for (const e of Object.values(index.sprites)) delete e.hv;
    writeFileSync(indexPath, JSON.stringify(index));

    const q = join(root, 'q.png');
    await save(q, pad(badge(4), 5));
    const [top] = await searchSimilarSprites(q, root, 0.5, 3);
    assert.equal(top.verdict, 'same_art');
    const rebuilt = JSON.parse(readFileSync(indexPath, 'utf8'));
    assert.ok(Object.values(rebuilt.sprites).every((e) => e.hv === HASH_VERSION));
  });
});

// White rounded rect: radius in px, optional 1px soft rim (as exports often have).
const roundedRect = (w, h, radius, softRim = false) =>
  draw(w, h, (x, y) => {
    const px = x + 0.5;
    const py = y + 0.5;
    const cx = Math.min(Math.max(px, radius), w - radius);
    const cy = Math.min(Math.max(py, radius), h - radius);
    const inside = (px - cx) ** 2 + (py - cy) ** 2 <= radius * radius;
    const rim = softRim && (x === 0 || y === 0 || x === w - 1 || y === h - 1);
    return [255, 255, 255, inside ? (rim ? 128 : 255) : 0];
  });

test('a plain fill matches on colour and alpha, not pHash noise', async () => {
  await withProject(async (root) => {
    await save(join(root, 'Assets/Sprites/flat_rect.png'), roundedRect(110, 110, 0, true));
    await save(join(root, 'Assets/Sprites/badge.png'), badge(4));
    await rebuild(root);
    const q = join(root, 'q.png');
    await save(q, roundedRect(12, 12, 0));
    const [top] = await searchSimilarSprites(q, root, 0.5, 3);
    assert.equal(top.path, 'Assets/Sprites/flat_rect.png');
    assert.equal(top.breakdown.phash_ignored, 'plain fill');
    assert.ok(top.score >= 0.95, `score ${top.score}`);
  });
});

test('a 9-slice is judged as drawn at the query size, not uniformly scaled', async () => {
  await withProject(async (root) => {
    // 64px source with 16px corners, collapsed to minimum size as TAs export
    // 9-slices; the query is the same panel drawn larger and wide.
    const sliced = join(root, 'Assets/Sprites/panel_9slice.png');
    await save(sliced, roundedRect(64, 64, 14));
    writeFileSync(
      sliced + '.meta',
      'TextureImporter:\n  spriteBorder: {x: 16, y: 16, z: 16, w: 16}\n'
    );
    await save(join(root, 'Assets/Sprites/pill.png'), roundedRect(64, 64, 32));
    await rebuild(root);

    const q = join(root, 'q.png');
    await save(q, roundedRect(240, 100, 14));
    const results = await searchSimilarSprites(q, root, 0.3, 3);
    const panel = results.find((r) => r.path === 'Assets/Sprites/panel_9slice.png');
    assert.ok(panel, JSON.stringify(results));
    assert.equal(panel.verdict, 'same_art');
    assert.equal(panel.verify.mode, '9slice');
    assert.equal(results[0].path, 'Assets/Sprites/panel_9slice.png');
  });
});

test('a same-shape 9-slice drawn bigger keeps its corner size and is same_art', async () => {
  await withProject(async (root) => {
    // Uniformly scaling the 300px query down shrinks its 10px corners to ~3px,
    // so only the 9-slice reading sees that the source draws it exactly.
    const sliced = join(root, 'Assets/Sprites/card_9slice.png');
    await save(sliced, roundedRect(100, 100, 10));
    writeFileSync(
      sliced + '.meta',
      'TextureImporter:\n  spriteBorder: {x: 30, y: 30, z: 30, w: 30}\n'
    );
    await rebuild(root);

    const q = join(root, 'q.png');
    await save(q, roundedRect(300, 300, 10));
    const [top] = await searchSimilarSprites(q, root, 0.3, 3);
    assert.equal(top.path, 'Assets/Sprites/card_9slice.png');
    assert.equal(top.verify.mode, '9slice');
    assert.equal(top.verdict, 'same_art');
    assert.equal(top.verify.corner_scale, 1);
  });
});
