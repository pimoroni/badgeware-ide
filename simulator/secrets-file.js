export const REGIONS = [
  ['eu', 'Europe'],
  ['us', 'United States / Canada'],
  ['australia', 'Australia'],
  ['nz', 'New Zealand'],
  ['chile', 'Chile'],
  ['cuba', 'Cuba'],
  ['egypt', 'Egypt'],
  ['lebanon', 'Lebanon'],
  ['moldova', 'Moldova'],
];

export const KNOWN_KEYS = ['WIFI_SSID', 'WIFI_PASSWORD', 'REGION', 'TIMEZONE'];

export const DEFAULT_SECRETS = `WIFI_SSID = ""
WIFI_PASSWORD = ""
REGION = "eu"  # Options are us, cuba, eu, moldova, lebanon, egypt, chile, australia, nz
TIMEZONE = 0  # Offset from GMT as number of hours, i.e. 0, 1, -7 etc.
`;

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

export const isValidKey = (key) => KEY_PATTERN.test(key) && !key.startsWith('__');

function splitComment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#') {
      return [text.slice(0, i).trimEnd(), text.slice(i)];
    }
  }
  return [text.trimEnd(), ''];
}

function parseString(literal) {
  const quote = literal[0];
  if ((quote !== '"' && quote !== "'") || literal.length < 2 || literal.at(-1) !== quote) return undefined;
  let out = '';
  for (let i = 1; i < literal.length - 1; i++) {
    const c = literal[i];
    if (c === quote) return undefined;
    if (c !== '\\') {
      out += c;
      continue;
    }
    const next = literal[++i];
    const escapes = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', 0: '\0' };
    if (next in escapes) out += escapes[next];
    else if (next === 'x') {
      out += String.fromCharCode(parseInt(literal.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (next === 'u') {
      out += String.fromCharCode(parseInt(literal.slice(i + 1, i + 5), 16));
      i += 4;
    } else out += '\\' + next;
  }
  return out;
}

export function parseValue(literal) {
  if (literal === 'True') return true;
  if (literal === 'False') return false;
  if (literal === 'None') return null;
  if (/^[+-]?\d+$/.test(literal)) return parseInt(literal, 10);
  if (/^[+-]?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/.test(literal)) return parseFloat(literal);
  return parseString(literal);
}

export function formatValue(value) {
  if (value === true) return 'True';
  if (value === false) return 'False';
  if (value === null) return 'None';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Numbers must be finite');
    return String(value);
  }
  let out = '"';
  for (const c of String(value)) {
    const code = c.charCodeAt(0);
    if (c === '"' || c === '\\') out += '\\' + c;
    else if (c === '\n') out += '\\n';
    else if (c === '\t') out += '\\t';
    else if (c === '\r') out += '\\r';
    else if (code < 0x20 || code === 0x7f) out += '\\x' + code.toString(16).padStart(2, '0');
    else out += c;
  }
  return out + '"';
}

export function parseSecrets(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const values = {};
  const unsupported = [];
  const parsed = lines.map((raw) => {
    const [code, comment] = splitComment(raw);
    const match = code.match(ASSIGNMENT);
    if (!match) {
      if (code.trim()) unsupported.push(raw);
      return { raw };
    }
    const value = parseValue(match[2]);
    if (value === undefined) {
      unsupported.push(raw);
      return { raw };
    }
    values[match[1]] = value;
    return { raw, key: match[1], comment };
  });
  return { lines: parsed, values, unsupported };
}

export function updateSecrets(parsed, values) {
  const seen = new Set();
  const out = [];
  for (const line of parsed.lines) {
    if (!line.key) {
      out.push(line.raw);
      continue;
    }
    if (!(line.key in values) || seen.has(line.key)) continue;
    seen.add(line.key);
    const value = values[line.key];
    out.push(value === parsed.values[line.key]
      ? line.raw
      : `${line.key} = ${formatValue(value)}${line.comment ? '  ' + line.comment : ''}`);
  }
  for (const [key, value] of Object.entries(values)) {
    if (seen.has(key)) continue;
    if (!isValidKey(key)) throw new Error(`"${key}" is not a valid setting name`);
    out.push(`${key} = ${formatValue(value)}`);
  }
  return out.join('\n') + '\n';
}
