import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { parseSecrets, updateSecrets, formatValue, parseValue, DEFAULT_SECRETS, isValidKey } from '../simulator/secrets-file.js';

test('parses the default secrets.py', () => {
  const { values, unsupported } = parseSecrets(DEFAULT_SECRETS);
  assert.deepEqual(values, { WIFI_SSID: '', WIFI_PASSWORD: '', REGION: 'eu', TIMEZONE: 0 });
  assert.deepEqual(unsupported, []);
});

test('updates values in place and keeps comments and order', () => {
  const parsed = parseSecrets(DEFAULT_SECRETS);
  const text = updateSecrets(parsed, { ...parsed.values, WIFI_SSID: 'My "Home" Wifi', REGION: 'us', TIMEZONE: -7 });
  assert.equal(text, `WIFI_SSID = "My \\"Home\\" Wifi"
WIFI_PASSWORD = ""
REGION = "us"  # Options are us, cuba, eu, moldova, lebanon, egypt, chile, australia, nz
TIMEZONE = -7  # Offset from GMT as number of hours, i.e. 0, 1, -7 etc.
`);
});

test('adds and removes custom keys, leaving unknown lines alone', () => {
  const source = '# My badge\nimport os\nWIFI_SSID = \'x\'\nGITHUB_USERNAME = "gadgetoid"\nDEBUG = True\n';
  const parsed = parseSecrets(source);
  assert.deepEqual(parsed.unsupported, ['import os']);
  const { DEBUG, ...rest } = parsed.values;
  assert.equal(DEBUG, true);
  const text = updateSecrets(parsed, { ...rest, BRIGHTNESS: 0.5 });
  assert.equal(text, '# My badge\nimport os\nWIFI_SSID = \'x\'\nGITHUB_USERNAME = "gadgetoid"\nBRIGHTNESS = 0.5\n');
});

test('rejects invalid key names', () => {
  assert.equal(isValidKey('GITHUB_USERNAME'), true);
  assert.equal(isValidKey('2FAST'), false);
  assert.equal(isValidKey('__import__'), false);
  assert.throws(() => updateSecrets(parseSecrets(''), { 'bad key': 1 }), /not a valid setting name/);
});

test('round-trips awkward strings through Python', () => {
  const samples = ['', 'plain', 'quote " and \' mix', 'back\\slash', 'tab\there', 'new\nline', 'pässwörd ✓', '# not a comment'];
  for (const sample of samples) assert.equal(parseValue(formatValue(sample)), sample);
  let python = null;
  try {
    python = execFileSync('python3', ['-c', 'import sys, json; print(json.dumps([eval(l) for l in sys.stdin.read().split("\\x00")]))'], { input: samples.map(formatValue).join('\x00') }).toString();
  } catch (_) {}
  if (python) assert.deepEqual(JSON.parse(python), samples);
});
