// Breakpoint options and hover expressions for the debugger, kept free of
// browser APIs so they can be tested on their own.

// A file's breakpoints map line -> null, or { condition, hitCount, logMessage }.
// Stored and sent to the badge as a list of plain line numbers or
// { line, ...options } objects.
export function breakpointEntries(lines) {
  return [...lines].map(([line, options]) => (options ? { line, ...options } : line));
}

export function breakpointLines(entries) {
  return new Map(entries.map((entry) => (typeof entry === 'number' ? [entry, null] : [entry.line, breakpointOptions(entry)])));
}

// Only the options that are set, or null for a plain breakpoint.
export function breakpointOptions({ condition, hitCount, logMessage }) {
  const options = {};
  if (condition?.trim()) options.condition = condition.trim();
  if (`${hitCount ?? ''}`.trim()) options.hitCount = `${hitCount}`.trim();
  if (logMessage?.trim()) options.logMessage = logMessage.trim();
  return Object.keys(options).length ? options : null;
}

export function describeBreakpoint(options) {
  if (!options) return 'Breakpoint';
  const parts = [];
  if (options.condition) parts.push(`when \`${options.condition}\``);
  if (options.hitCount) parts.push(`on hit ${options.hitCount}`);
  if (options.logMessage) parts.push(`logs \`${options.logMessage}\``);
  return (options.logMessage ? 'Logpoint ' : 'Breakpoint ') + parts.join(', ');
}

// The name or dotted attribute (a.b.c) under `column` in a line of Python, up
// to the end of the word the cursor is in, or null.
export function hoverExpression(text, column) {
  const isPart = (char) => /[A-Za-z0-9_.]/.test(char ?? '');
  if (!/[A-Za-z0-9_]/.test(text[column] ?? '')) return null;
  let start = column;
  while (start > 0 && isPart(text[start - 1])) start--;
  let end = column;
  while (/[A-Za-z0-9_]/.test(text[end] ?? '')) end++;
  const expression = text.slice(start, end).replace(/^\.+/, '');
  start = end - expression.length;
  if (!/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/.test(expression)) return null;
  return { text: expression, start, end };
}
