/**
 * Helpers for splicing values into generated ExtendScript source.
 *
 * Every tool builds its script as a template string, so any value that comes
 * from a tool argument has to be turned into valid ExtendScript first. Hand
 * escaping only `"` (what most call sites used to do) breaks on newlines,
 * backslashes and `'`, so a multi-line text layer or a Windows path produced a
 * syntax error or silently different text.
 */

/**
 * Returns `value` as a double-quoted ExtendScript string literal, quotes
 * included: `jsxString('a"b\nc')` → `"a\"b\nc"`.
 *
 * JSON.stringify covers quotes, backslashes and control characters. U+2028 and
 * U+2029 are also escaped: JSON allows them raw, but ExtendScript (ES3) treats
 * them as line terminators, which would end the string early.
 */
export function jsxString(value: string): string {
  return JSON.stringify(String(value))
    .replace(new RegExp('\\u2028', 'g'), '\\u2028')
    .replace(new RegExp('\\u2029', 'g'), '\\u2029');
}

/**
 * Returns `value` unchanged when it is one of `allowed`, otherwise throws.
 * Use for values spliced in as identifiers (e.g. `BlendMode.${mode}`), where
 * quoting is not an option.
 */
export function jsxEnum<T extends string>(value: string, allowed: readonly T[], name: string): T {
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`invalid ${name} "${value}"; expected one of: ${allowed.join(', ')}`);
  }
  return value as T;
}
