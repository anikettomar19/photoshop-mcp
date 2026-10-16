import { parentPort, workerData } from 'worker_threads';
import { Jimp } from 'jimp';
import { computeSpriteHashes, computeNineSliceGeom, readSpriteBorder } from './sprite-hash.js';

// ---------------------------------------------------------------------------
// worker_threads entry for parallel sprite-index builds.
//
// Receives a slice of hash jobs via workerData, decodes each sprite ONCE, and
// derives all three perceptual hashes from that single decode. For sprites that
// carry a Unity spriteBorder it also computes the 9-slice geometry (corner
// radius + dominant colour) so the sprite index and the nine-slice index are
// produced in the same pass. One worker is spawned per CPU core.
// ---------------------------------------------------------------------------

interface HashJob {
  absPath: string;
  rel: string;
  mtime: number;
  isNew: boolean;
}

const { jobs } = workerData as { jobs: HashJob[] };

const entries: Array<{ rel: string; isNew: boolean; entry: Record<string, unknown> }> = [];
const errors: Array<{ path: string; error: string }> = [];

for (const job of jobs) {
  try {
    const img = await Jimp.read(job.absPath);
    const entry: Record<string, unknown> = { mtime: job.mtime, ...computeSpriteHashes(img) };
    const border = readSpriteBorder(job.absPath);
    if (border) {
      entry.spriteBorder = border;
      // Geometry reads the untrimmed file: corner radius is measured from its edge.
      const geom = computeNineSliceGeom(img);
      entry.corner_radius = geom.corner_radius;
      entry.dominant_color = geom.dominant_color;
    }
    entries.push({ rel: job.rel, isNew: job.isNew, entry });
  } catch (e) {
    errors.push({ path: job.rel, error: e instanceof Error ? e.message : String(e) });
  }
}

parentPort?.postMessage({ entries, errors });
