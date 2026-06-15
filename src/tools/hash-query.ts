#!/usr/bin/env node
/**
 * Tiny CLI: hash a query image using the same Jimp pipeline as the sprite index.
 * Called by sprite_matcher.py to ensure cross-library pHash compatibility.
 *
 * Usage: node hash-query.js <image_path>
 * Output: JSON { phash, hsvHist, alphaHash, width, height, aspectRatio }
 */
import { hashImageFile } from './sprite-hash.js';

const path = process.argv[2];
if (!path) { process.stderr.write('Usage: hash-query.js <image_path>\n'); process.exit(1); }

const h = await hashImageFile(path);
process.stdout.write(JSON.stringify(h) + '\n');
