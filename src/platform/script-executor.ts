export interface ScriptExecutor {
  /**
   * Execute a script in Photoshop
   * @param script - The script code to execute
   * @param timeout - Timeout in milliseconds, counted from when the script
   *   starts running (not while it waits behind earlier scripts). Defaults to
   *   DEFAULT_SCRIPT_TIMEOUT_MS.
   * @returns The result from the script execution
   */
  execute(script: string, timeout?: number): Promise<unknown>;

  /**
   * Check if Photoshop is running
   */
  isPhotoshopRunning(): Promise<boolean>;

  /**
   * Launch Photoshop if not running
   */
  launchPhotoshop(photoshopPath: string): Promise<void>;
}

export interface ScriptResult {
  success: boolean;
  result?: unknown;
  error?: string;
}

/**
 * Default per-script timeout. Override with PHOTOSHOP_MCP_TIMEOUT_MS; tools
 * that walk or export large documents pass a longer one explicitly.
 */
export const DEFAULT_SCRIPT_TIMEOUT_MS = (() => {
  const fromEnv = Number(process.env.PHOTOSHOP_MCP_TIMEOUT_MS);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : 30_000;
})();

/** Timeout for scripts that walk a whole document or export many layers. */
export const LONG_SCRIPT_TIMEOUT_MS = Math.max(DEFAULT_SCRIPT_TIMEOUT_MS, 300_000);

/**
 * Parses what Photoshop handed back for a script. The ExtendScript wrapper
 * catches script errors and returns them as an "ERROR: ..." string, so that
 * prefix is turned back into a thrown error here — otherwise every failed
 * script would reach the tool as a successful result.
 */
export function parseScriptOutput(output: string): unknown {
  const trimmed = output.trim();

  if (trimmed.startsWith('ERROR:')) {
    throw new Error(trimmed.substring(6).trim());
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

/**
 * Runs tasks one at a time. Photoshop executes scripts serially anyway, and
 * each task's timeout should only start once it is actually running.
 */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

/** Error for a child process killed because the script ran past its timeout. */
export function timeoutError(timeoutMs: number): Error {
  return new Error(
    `Script execution timed out after ${Math.round(timeoutMs / 1000)}s. ` +
      'Photoshop may still be finishing it; later calls wait until it is free.'
  );
}
