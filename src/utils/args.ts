/**
 * Throws if `args[name]` is not a non-empty string. Any tool handler this is
 * called from is invoked via the MCP server's CallToolRequestSchema handler
 * (src/core/server.ts), which catches thrown errors and turns them into a
 * `{ isError: true }` ToolResult — so callers don't need a local try/catch
 * just to use this.
 */
export function requireString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`missing or invalid required argument "${name}" (got ${JSON.stringify(value)})`);
  }
  return value;
}
