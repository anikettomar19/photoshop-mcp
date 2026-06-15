import { readFileSync } from 'fs';
import { Jimp } from 'jimp';
import Tesseract from 'tesseract.js';
import { ToolDefinition, ToolResult } from '../core/tool-registry.js';

// ---------------------------------------------------------------------------
// Preprocessing helpers
// ---------------------------------------------------------------------------

/**
 * Extract bright/white pixels from an RGBA image to isolate text.
 * Game UI text is typically white/light on colored backgrounds.
 * Returns a binary image buffer (white text on black bg) as PNG.
 */
async function extractBrightPixels(
  imagePath: string,
  brightnessThreshold: number = 200,
): Promise<Buffer> {
  const img = await Jimp.read(imagePath);
  const w = img.width;
  const h = img.height;

  // Create a new image: white where bright pixels exist, black elsewhere
  const result = new Jimp({ width: w, height: h, color: 0x000000ff });

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const pixel = img.getPixelColor(x, y);
      const r = (pixel >> 24) & 0xff;
      const g = (pixel >> 16) & 0xff;
      const b = (pixel >> 8) & 0xff;
      const a = pixel & 0xff;

      if (a > 128 && r > brightnessThreshold && g > brightnessThreshold && b > brightnessThreshold) {
        result.setPixelColor(0xffffffff, x, y);
      }
    }
  }

  // Scale up 2x for better OCR accuracy
  result.resize({ w: w * 2, h: h * 2 });

  return await result.getBuffer('image/png');
}

/**
 * Extract dark pixels — for dark text on light backgrounds.
 */
async function extractDarkPixels(
  imagePath: string,
  darknessThreshold: number = 80,
): Promise<Buffer> {
  const img = await Jimp.read(imagePath);
  const w = img.width;
  const h = img.height;

  const result = new Jimp({ width: w, height: h, color: 0xffffffff });

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const pixel = img.getPixelColor(x, y);
      const r = (pixel >> 24) & 0xff;
      const g = (pixel >> 16) & 0xff;
      const b = (pixel >> 8) & 0xff;
      const a = pixel & 0xff;

      if (a > 128 && r < darknessThreshold && g < darknessThreshold && b < darknessThreshold) {
        result.setPixelColor(0x000000ff, x, y);
      }
    }
  }

  result.resize({ w: w * 2, h: h * 2 });

  return await result.getBuffer('image/png');
}

// ---------------------------------------------------------------------------
// OCR engine
// ---------------------------------------------------------------------------

let _worker: Tesseract.Worker | null = null;

async function getWorker(): Promise<Tesseract.Worker> {
  if (!_worker) {
    _worker = await Tesseract.createWorker('eng');
  }
  return _worker;
}

export interface OcrResult {
  text: string;
  confidence: number;
  words: Array<{ text: string; confidence: number }>;
}

async function runOcr(imageBuffer: Buffer): Promise<OcrResult> {
  const worker = await getWorker();
  const { data } = await worker.recognize(imageBuffer);

  const rawWords = (data as any).words || [];
  const words = rawWords
    .filter((w: any) => w.text.trim().length > 0)
    .map((w: any) => ({ text: w.text.trim(), confidence: w.confidence }));

  return {
    text: data.text.trim(),
    confidence: data.confidence,
    words,
  };
}

/**
 * OCR a file with preprocessing mode selection. Shared by the MCP tool
 * handler and ocr-cli.js (subprocess access without MCP overhead).
 */
export async function ocrFile(
  imagePath: string,
  mode: string = 'auto',
  brightnessThreshold: number = 200,
  darknessThreshold: number = 80,
): Promise<OcrResult> {
  let bestResult: OcrResult = { text: '', confidence: 0, words: [] };

  if (mode === 'bright' || mode === 'auto') {
    const brightResult = await runOcr(await extractBrightPixels(imagePath, brightnessThreshold));
    if (brightResult.confidence > bestResult.confidence) bestResult = brightResult;
  }

  if (mode === 'dark' || mode === 'auto') {
    const darkResult = await runOcr(await extractDarkPixels(imagePath, darknessThreshold));
    if (darkResult.confidence > bestResult.confidence) bestResult = darkResult;
  }

  if (mode === 'raw' || (mode === 'auto' && bestResult.confidence < 50)) {
    const rawResult = await runOcr(readFileSync(imagePath));
    if (rawResult.confidence > bestResult.confidence) bestResult = rawResult;
  }

  return bestResult;
}

/** Terminate the shared tesseract worker (CLI must call this or the process hangs). */
export async function terminateOcrWorker(): Promise<void> {
  if (_worker) {
    await _worker.terminate();
    _worker = null;
  }
}

// ---------------------------------------------------------------------------
// Tool handler
// ---------------------------------------------------------------------------

async function ocrImage(args: Record<string, unknown>): Promise<ToolResult> {
  const imagePath = args.image_path as string;
  if (!imagePath) {
    return { content: [{ type: 'text', text: 'Error: image_path is required' }], isError: true };
  }

  // Verify file exists
  try {
    readFileSync(imagePath);
  } catch {
    return { content: [{ type: 'text', text: `Error: File not found: ${imagePath}` }], isError: true };
  }

  const mode = (args.mode as string) || 'auto';
  const brightnessThreshold = (args.brightness_threshold as number) || 200;
  const darknessThreshold = (args.darkness_threshold as number) || 80;

  try {
    const bestResult = await ocrFile(imagePath, mode, brightnessThreshold, darknessThreshold);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              text: bestResult.text,
              confidence: Math.round(bestResult.confidence),
              words: bestResult.words.map((w) => ({
                text: w.text,
                confidence: Math.round(w.confidence),
              })),
            },
            null,
            2,
          ),
        },
      ],
    };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `OCR error: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function createOcrTools(): ToolDefinition[] {
  return [
    {
      tool: {
        name: 'photoshop_ocr_text',
        description:
          'Read text from a rasterized image layer using OCR (no tokens consumed).\n\n' +
          'Use this on exported PSD layers that contain rasterized/flattened text\n' +
          '(pixel or smartobject layers with baked-in text like button labels, headers).\n\n' +
          'Preprocessing modes:\n' +
          '  "auto" (default) — tries bright extraction, dark extraction, and raw; returns best\n' +
          '  "bright" — extracts white/light text on colored backgrounds (game UI buttons)\n' +
          '  "dark"  — extracts dark text on light backgrounds\n' +
          '  "raw"   — no preprocessing, feeds image directly to OCR\n\n' +
          'Returns detected text and per-word confidence scores.\n' +
          'Confidence > 80 = reliable. Confidence < 50 = likely wrong, ask the user.',
        inputSchema: {
          type: 'object',
          properties: {
            image_path: {
              type: 'string',
              description: 'Absolute path to the exported layer PNG',
            },
            mode: {
              type: 'string',
              enum: ['auto', 'bright', 'dark', 'raw'],
              description: 'Preprocessing mode (default: "auto")',
              default: 'auto',
            },
            brightness_threshold: {
              type: 'number',
              description: 'Pixel brightness threshold for bright text extraction (0-255, default 200)',
              default: 200,
            },
            darkness_threshold: {
              type: 'number',
              description: 'Pixel darkness threshold for dark text extraction (0-255, default 80)',
              default: 80,
            },
          },
          required: ['image_path'],
        },
      },
      handler: async (args) => ocrImage(args),
    },
  ];
}
