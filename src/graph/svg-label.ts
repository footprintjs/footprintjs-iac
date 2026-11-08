/** Wrap complete ASCII graph identifiers for a fixed-width monospace label; no characters are dropped. */
export function identifierLines(value: string, columns = 23): string[] {
  const lines: string[] = [];
  let remaining = value;
  while (remaining.length > columns) {
    const separator = remaining.lastIndexOf('-', columns - 1);
    const count = separator >= 7 ? separator + 1 : columns;
    lines.push(remaining.slice(0, count));
    remaining = remaining.slice(count);
  }
  lines.push(remaining);
  return lines;
}
