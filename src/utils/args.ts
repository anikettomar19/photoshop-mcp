/**
 * Throws if `args[name]` is not a string (empty string rejected too, unless
 * `allowEmpty` is set — some args, like text content, treat "" as a
 * meaningful value rather than a missing one). Any tool handler this is
 * called from is invoked via the MCP server's CallToolRequestSchema handler
 * (src/core/server.ts), which catches thrown errors and turns them into a
 * `{ isError: true }` ToolResult — so callers don't need a local try/catch
 * just to use this.
 */
export function requireString(
  args: Record<string, unknown>,
  name: string,
  options: { allowEmpty?: boolean } = {}
): string {
  const value = args[name];
  if (typeof value !== 'string' || (!options.allowEmpty && value.length === 0)) {
    throw new Error(
      `missing or invalid required argument "${name}" (got ${JSON.stringify(value)})`
    );
  }
  return value;
}

/** Throws if `args[name]` is not a finite number. See requireString for the error-handling contract. */
export function requireNumber(args: Record<string, unknown>, name: string): number {
  const value = args[name];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(
      `missing or invalid required argument "${name}" (got ${JSON.stringify(value)})`
    );
  }
  return value;
}

/**
 * Returns `args[name]` if it is a finite number, `fallback` if it is absent,
 * and throws otherwise. For values spliced into ExtendScript, where a
 * non-number would become broken or injected code.
 */
export function optionalNumber(
  args: Record<string, unknown>,
  name: string,
  fallback: number
): number {
  const value = args[name];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`invalid argument "${name}": expected a number (got ${JSON.stringify(value)})`);
  }
  return value;
}

/** Upper bound for a caller-chosen script time limit. */
export const MAX_TIMEOUT_SECONDS = 1800;

/**
 * Reads an optional `timeout_seconds` argument as milliseconds, or returns
 * `fallbackMs` when it is absent. Throws outside (0, MAX_TIMEOUT_SECONDS].
 */
export function optionalTimeoutMs<T extends number | undefined>(
  args: Record<string, unknown>,
  fallbackMs: T
): number | T {
  const seconds = args.timeout_seconds;
  if (seconds === undefined || seconds === null) return fallbackMs;
  if (typeof seconds !== 'number' || !(seconds > 0 && seconds <= MAX_TIMEOUT_SECONDS)) {
    throw new Error(
      `timeout_seconds must be between 0 and ${MAX_TIMEOUT_SECONDS} (got ${JSON.stringify(seconds)})`
    );
  }
  return seconds * 1000;
}
