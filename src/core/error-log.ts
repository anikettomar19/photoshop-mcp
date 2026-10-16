/**
 * A local log of failed tool calls, so a bug report can say what actually
 * failed instead of what someone remembers. It never leaves the machine on its
 * own: photoshop_draft_issue reads it into a draft the user reviews before
 * anything is submitted.
 *
 * One JSON object per line in ~/.photoshop-mcp/errors.jsonl (override the
 * folder with PHOTOSHOP_MCP_HOME). Set PHOTOSHOP_MCP_ERROR_LOG=off to disable.
 * The file is cut back to the newest KEEP entries once it grows past MAX.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const MAX_ENTRIES = 500;
const KEEP_ENTRIES = 200;
const MAX_VALUE_CHARS = 300;
const MAX_CODE_CHARS = 1500;
const MAX_ERROR_CHARS = 800;

export interface ErrorLogEntry {
  time: string;
  tool: string;
  args: Record<string, unknown>;
  error: string;
  serverVersion: string;
}

export function errorLogEnabled(): boolean {
  return !/^(off|0|false|no)$/i.test(process.env.PHOTOSHOP_MCP_ERROR_LOG ?? '');
}

export function errorLogPath(): string {
  return join(process.env.PHOTOSHOP_MCP_HOME || join(homedir(), '.photoshop-mcp'), 'errors.jsonl');
}

/**
 * Replaces the user's home folder (and any other /Users/<name> or
 * C:\Users\<name> prefix) with "~", so paths in a report don't carry a
 * username.
 */
export function redactPaths(text: string): string {
  const home = homedir();
  let out = home ? text.split(home).join('~') : text;
  out = out.replace(/\/Users\/[^/\s"'\\]+/g, '~').replace(/[A-Za-z]:\\Users\\[^\\\s"']+/g, '~');
  return out;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}… (${text.length - max} more chars)` : text;
}

/** Copy of tool arguments that is safe and small enough to log. */
export function sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args ?? {})) {
    const limit = key === 'code' ? MAX_CODE_CHARS : MAX_VALUE_CHARS;
    if (typeof value === 'string') out[key] = truncate(redactPaths(value), limit);
    else if (value === null || typeof value !== 'object') out[key] = value;
    else out[key] = truncate(redactPaths(JSON.stringify(value)), limit);
  }
  return out;
}

export function recordToolError(
  tool: string,
  args: Record<string, unknown>,
  error: string,
  serverVersion: string
): void {
  if (!errorLogEnabled()) return;
  try {
    const path = errorLogPath();
    const dir = join(path, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const entry: ErrorLogEntry = {
      time: new Date().toISOString(),
      tool,
      args: sanitizeArgs(args),
      error: truncate(redactPaths(error), MAX_ERROR_CHARS),
      serverVersion,
    };
    appendFileSync(path, JSON.stringify(entry) + '\n');
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    if (lines.length > MAX_ENTRIES) {
      writeFileSync(path, lines.slice(-KEEP_ENTRIES).join('\n') + '\n');
    }
  } catch {
    // Logging must never break a tool call.
  }
}

/** Newest-last entries, optionally only for one tool. */
export function readRecentErrors(limit: number, tool?: string): ErrorLogEntry[] {
  try {
    const path = errorLogPath();
    if (!existsSync(path)) return [];
    const entries: ErrorLogEntry[] = [];
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line) as ErrorLogEntry;
        if (!tool || e.tool === tool || e.tool === `photoshop_${tool}`) entries.push(e);
      } catch {
        // skip a damaged line
      }
    }
    return entries.slice(-Math.max(0, limit));
  } catch {
    return [];
  }
}
