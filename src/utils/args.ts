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
    throw new Error(`missing or invalid required argument "${name}" (got ${JSON.stringify(value)})`);
  }
  return value;
}

/** Throws if `args[name]` is not a finite number. See requireString for the error-handling contract. */
export function requireNumber(args: Record<string, unknown>, name: string): number {
  const value = args[name];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`missing or invalid required argument "${name}" (got ${JSON.stringify(value)})`);
  }
  return value;
}
