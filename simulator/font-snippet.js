const ROM_FONTS = '/rom/fonts/';
const VECTOR_SEARCH = ['/rom/fonts/', '/fonts/', '/assets/'];
const VECTOR_SIZE = 24;

const escapeHtml = (text) => text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function highlightPython(code) {
  return escapeHtml(code)
    .replace(/(#[^\n]*)/g, '<span class="tok-comment">$1</span>')
    .replace(/(&quot;[^&]*&quot;)/g, '<span class="tok-str">$1</span>')
    .replace(/\b(font\.\w+)\b/g, '<span class="tok-fn">$1</span>');
}

export function fontUsage(path) {
  const match = path.match(/^(.*\/)?([^/]+)\.(ppf|af)$/i);
  if (!match) return null;
  const [, dir = '/', name, extension] = match;
  const vector = extension.toLowerCase() === 'af';
  let load;
  if (dir === ROM_FONTS && /^[A-Za-z_]\w*$/.test(name)) load = `font.${name}`;
  else if (vector && VECTOR_SEARCH.includes(dir)) load = `font.load("${name}")`;
  else load = `font.load("${path}")`;
  return [
    `screen.font = ${load}`,
    vector ? `screen.text("Hello, badge!", 10, 10, ${VECTOR_SIZE})  # size in px` : 'screen.text("Hello, badge!", 10, 10)',
  ].join('\n');
}

// Heap a loaded font takes on the badge, from PicoVector's 32-bit structures:
// 20 bytes a glyph and 8 a path for a vector font, 8 a glyph for a pixel font.
// From ROMFS the points (narrow fonts) or bitmaps are used in place; from the
// filesystem they are copied in too. Object overhead adds about 150 bytes.
export function fontRamCost(kind, font) {
  if (kind === 'vector') {
    const tables = font.glyphCount * 20 + font.pathCount * 8;
    const points = font.pointCount * (font.wide ? 4 : 2);
    return { rom: tables + (font.wide ? points : 0), copied: tables + points };
  }
  const index = font.glyphCount * 8;
  return { rom: index, copied: index + font.glyphCount * font.bpr * font.glyphHeight };
}

// A Python string literal for one character: printable ASCII as itself,
// anything else as an escape, so it survives being pasted into code.
export function pythonChar(codepoint) {
  if (codepoint >= 0x20 && codepoint < 0x7f) return JSON.stringify(String.fromCodePoint(codepoint));
  return codepoint > 0xffff ? `"\\U${codepoint.toString(16).padStart(8, '0')}"` : `"\\u${codepoint.toString(16).padStart(4, '0')}"`;
}
