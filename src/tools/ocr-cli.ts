#!/usr/bin/env node
/**
 * CLI wrapper for OCR — same tesseract.js pipeline as photoshop_ocr_text
 * but callable via subprocess, with batch mode (one worker, N images).
 *
 * Usage: node ocr-cli.js <image1.png> [image2.png ...] [--mode auto|bright|dark|raw]
 * Output: JSON map { "<image_path>": { text, confidence } }
 */
import { ocrFile, terminateOcrWorker } from './ocr-tools.js';

const args = process.argv.slice(2);
const modeIdx = args.indexOf('--mode');
const mode = modeIdx >= 0 ? args[modeIdx + 1] : 'auto';
const images = args.filter((a, i) => a !== '--mode' && (modeIdx < 0 || i !== modeIdx + 1));

if (images.length === 0) {
  process.stderr.write('Usage: ocr-cli.js <image1.png> [image2.png ...] [--mode auto]\n');
  process.exit(1);
}

const results: Record<string, { text: string; confidence: number }> = {};

for (const img of images) {
  try {
    const r = await ocrFile(img, mode);
    results[img] = { text: r.text, confidence: Math.round(r.confidence) };
  } catch (err) {
    results[img] = { text: '', confidence: 0 };
    process.stderr.write(`OCR failed for ${img}: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

await terminateOcrWorker();
process.stdout.write(JSON.stringify(results) + '\n');
