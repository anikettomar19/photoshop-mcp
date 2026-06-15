#!/usr/bin/env node
/**
 * CLI wrapper for sprite similarity search — same code path as the
 * find_similar_sprites MCP tool (searchSimilarSprites in sprite-tools.ts)
 * but callable via subprocess (no MCP protocol overhead).
 *
 * Usage: node find-similar-cli.js <image_path> <project_root> [threshold] [top_n]
 * Output: JSON array of matches [{path, score, breakdown, dimensions, ...}]
 */
import { searchSimilarSprites } from './sprite-tools.js';

const [,, imagePath, projectRoot, thresholdStr, topNStr] = process.argv;

if (!imagePath || !projectRoot) {
  process.stderr.write('Usage: find-similar-cli.js <image_path> <project_root> [threshold] [top_n]\n');
  process.exit(1);
}

const threshold = thresholdStr ? parseFloat(thresholdStr) : 0.5;
const topN = topNStr ? parseInt(topNStr, 10) : 5;

try {
  const results = await searchSimilarSprites(imagePath, projectRoot, threshold, topN);
  process.stdout.write(JSON.stringify(results) + '\n');
} catch (err) {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
