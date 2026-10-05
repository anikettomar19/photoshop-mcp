// rebuild_sprite_index content dedup, run against a throwaway fake Unity
// project. No Photoshop needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Jimp } from 'jimp';
import { cacheDirFor, rebuildSpriteIndex } from '../dist/tools/sprite-tools.js';

async function writeSprite(path, color) {
  mkdirSync(join(path, '..'), { recursive: true });
  const img = new Jimp({ width: 16, height: 16, color });
  writeFileSync(path, await img.getBuffer('image/png'));
}

async function rebuild(projectRoot) {
  const res = await rebuildSpriteIndex({ project_root: projectRoot });
  assert.ok(!res.isError, res.content[0].text);
  return JSON.parse(res.content[0].text);
}

test('identical art across folders collapses to one entry, and stays cheap to rebuild', async () => {
  const root = mkdtempSync(join(tmpdir(), 'psmcp-dedup-'));
  try {
    await writeSprite(join(root, 'Assets/Sprites/UI/tab.png'), 0xff0000ff);
    await writeSprite(join(root, 'Assets/Resources_moved/old/tab_copy.png'), 0xff0000ff);
    await writeSprite(join(root, 'Assets/Resources/blue.png'), 0x0000ffff);

    const first = await rebuild(root);
    assert.equal(first.total_sprites, 3);
    assert.equal(first.unique_sprites, 2);
    assert.equal(first.duplicate_files_collapsed, 1);
    assert.deepEqual(first.duplicates_sample, [
      { canonical: 'Assets/Sprites/UI/tab.png', duplicates: ['Assets/Resources_moved/old/tab_copy.png'] },
    ]);

    // Second run: nothing changed, so nothing is re-decoded — including the
    // copy that dedup folded away.
    const second = await rebuild(root);
    assert.equal(second.newly_indexed, 0);
    assert.equal(second.updated, 0);
    assert.equal(second.skipped_unchanged, 3);
    assert.equal(second.unique_sprites, 2);
    assert.equal(second.duplicate_files_collapsed, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(cacheDirFor(root), { recursive: true, force: true });
  }
});

test('an index built before content hashes is rehashed once so dedup applies', async () => {
  const root = mkdtempSync(join(tmpdir(), 'psmcp-dedup-'));
  try {
    await writeSprite(join(root, 'Assets/Sprites/a.png'), 0x00ff00ff);
    await writeSprite(join(root, 'Assets/Resources/a_copy.png'), 0x00ff00ff);
    await rebuild(root);

    // Simulate a pre-dedup index: every entry kept, no contentHash anywhere.
    const indexPath = join(cacheDirFor(root), 'sprite_index.json');
    const index = JSON.parse(readFileSync(indexPath, 'utf8'));
    const flat = { ...index.sprites, ...index.duplicates };
    for (const e of Object.values(flat)) {
      delete e.contentHash;
      delete e.duplicatePaths;
    }
    writeFileSync(indexPath, JSON.stringify({ ...index, sprites: flat, duplicates: undefined }));

    const res = await rebuild(root);
    assert.equal(res.updated, 2, 'old entries were reused without a content hash');
    assert.equal(res.unique_sprites, 1);
    assert.equal(res.duplicate_files_collapsed, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(cacheDirFor(root), { recursive: true, force: true });
  }
});
