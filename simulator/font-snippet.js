const ROM_FONTS = '/rom/fonts/';
const VECTOR_SEARCH = ['/rom/fonts/', '/system/assets/fonts/', '/fonts/', '/assets/'];
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
  if (!vector && dir === ROM_FONTS && /^[A-Za-z_]\w*$/.test(name)) load = `font.${name}`;
  else if (vector && VECTOR_SEARCH.includes(dir)) load = `font.load("${name}")`;
  else load = `font.load("${path}")`;
  return [
    `screen.font = ${load}`,
    vector ? `screen.text("Hello, badge!", 10, 10, ${VECTOR_SIZE})  # size in px` : 'screen.text("Hello, badge!", 10, 10)',
  ].join('\n');
}
