import { DEFAULT_SECRETS, KNOWN_KEYS, REGIONS, isValidKey, parseSecrets, updateSecrets } from './secrets-file.js';

const SECRETS_PATH = '/secrets.py';
const BASE_PATHS = ['/secrets.py'];

const element = (tag, attributes = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (name === 'className') node.className = value;
    else if (name in node && typeof value !== 'string') node[name] = value;
    else node.setAttribute(name, value);
  }
  node.append(...children);
  return node;
};

const typeOf = (value) => (typeof value === 'boolean' ? 'bool' : typeof value === 'number' ? 'number' : 'text');

export function createConfigPane(el, { userFS, flashStatus, openFile, isConnected, firmwareText = () => '', onFirmware = () => {} }) {
  const form = el.querySelector('form');
  const fields = {
    ssid: form.elements.wifi_ssid,
    password: form.elements.wifi_password,
    region: form.elements.region,
    timezone: form.elements.timezone,
  };
  const customList = el.querySelector('.config-custom');
  const notice = el.querySelector('.config-notice');
  const unsupportedNote = el.querySelector('.config-unsupported');
  let parsed = null;

  fields.region.replaceChildren(...REGIONS.map(([value, label]) => element('option', { value }, label)));

  async function readEntry(path) {
    const entry = userFS.get(path);
    if (!entry || entry.isDir) return null;
    const loaded = entry.unloaded ? await userFS.load(path) : entry;
    return loaded && !loaded.binary ? loaded.text : null;
  }

  async function readBase() {
    for (const path of BASE_PATHS) {
      const text = await readEntry(path);
      if (text != null) return text;
    }
    return DEFAULT_SECRETS;
  }

  function customRow(key = '', value = '') {
    const type = typeOf(value);
    const keyInput = element('input', { type: 'text', value: key, placeholder: 'GITHUB_USERNAME', spellcheck: false, autocomplete: 'off', className: 'config-key' });
    const typeSelect = element('select', { className: 'config-type' },
      element('option', { value: 'text' }, 'Text'),
      element('option', { value: 'number' }, 'Number'),
      element('option', { value: 'bool' }, 'Yes / No'));
    typeSelect.value = type;
    const textInput = element('input', { type: 'text', value: type === 'bool' ? '' : String(value ?? ''), spellcheck: false, autocomplete: 'off', className: 'config-value' });
    const boolInput = element('input', { type: 'checkbox', className: 'config-bool' });
    boolInput.checked = value === true;
    const syncType = () => {
      textInput.hidden = typeSelect.value === 'bool';
      boolInput.hidden = typeSelect.value !== 'bool';
      textInput.inputMode = typeSelect.value === 'number' ? 'decimal' : 'text';
    };
    typeSelect.addEventListener('change', syncType);
    syncType();
    const remove = element('button', { type: 'button', title: 'Remove setting', className: 'config-remove' }, element('span', { className: 'material-symbols-outlined' }, 'delete'));
    const row = element('li', {}, keyInput, typeSelect, textInput, boolInput, remove);
    remove.addEventListener('click', () => row.remove());
    return row;
  }

  function readCustom() {
    const values = {};
    for (const row of customList.querySelectorAll('li')) {
      const key = row.querySelector('.config-key').value.trim();
      const type = row.querySelector('.config-type').value;
      const raw = row.querySelector('.config-value').value;
      if (!key && !raw) continue;
      if (!isValidKey(key)) throw new Error(`"${key}" can't be used as a setting name. Use letters, numbers and _, not starting with a number.`);
      if (KNOWN_KEYS.includes(key) || key in values) throw new Error(`${key} is set more than once.`);
      if (type === 'bool') values[key] = row.querySelector('.config-bool').checked;
      else if (type === 'number') {
        const number = Number(raw);
        if (raw.trim() === '' || !Number.isFinite(number)) throw new Error(`${key} needs a number.`);
        values[key] = number;
      } else values[key] = raw;
    }
    return values;
  }

  function render(values) {
    fields.ssid.value = values.WIFI_SSID ?? '';
    fields.password.value = values.WIFI_PASSWORD ?? '';
    const region = String(values.REGION ?? 'eu');
    if (![...fields.region.options].some((option) => option.value === region)) fields.region.append(element('option', { value: region }, region));
    fields.region.value = region;
    fields.timezone.value = values.TIMEZONE ?? 0;
    customList.replaceChildren(...Object.entries(values)
      .filter(([key]) => !KNOWN_KEYS.includes(key))
      .map(([key, value]) => customRow(key, value)));
    const count = parsed.unsupported.length;
    unsupportedNote.hidden = count === 0;
    unsupportedNote.querySelector('span').textContent = `${count} line${count === 1 ? '' : 's'} in secrets.py can't be edited here and will be kept as ${count === 1 ? 'it is' : 'they are'}.`;
  }

  async function load() {
    el.querySelector('.config-firmware-version').innerHTML = firmwareText();
    const blocked = !isConnected();
    notice.hidden = !blocked;
    form.hidden = blocked;
    if (blocked) return;
    parsed = parseSecrets(await readBase());
    render(parsed.values);
  }

  async function save() {
    const timezone = Number(fields.timezone.value);
    if (!Number.isFinite(timezone) || timezone < -12 || timezone > 14) throw new Error('Timezone should be an offset in hours between -12 and 14.');
    const values = {
      ...readCustom(),
      WIFI_SSID: fields.ssid.value,
      WIFI_PASSWORD: fields.password.value,
      REGION: fields.region.value,
      TIMEZONE: timezone,
    };
    const ordered = Object.fromEntries([...KNOWN_KEYS.map((key) => [key, values[key]]), ...Object.entries(values).filter(([key]) => !KNOWN_KEYS.includes(key))]);
    const text = updateSecrets(parsed, ordered);
    userFS.set(SECRETS_PATH, { text, binary: false });
    await userFS.flush();
    parsed = parseSecrets(text);
    flashStatus('✓ Saved settings to your badge', 3000);
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await save();
    } catch (error) {
      flashStatus('✕ ' + error.message, 5000);
    }
  });
  el.querySelector('[data-config="firmware"]').addEventListener('click', () => onFirmware());
  el.querySelector('[data-config="add"]').addEventListener('click', () => {
    const row = customRow();
    customList.append(row);
    row.querySelector('input').focus();
  });
  el.querySelector('[data-config="reveal"]').addEventListener('click', (event) => {
    const reveal = fields.password.type === 'password';
    fields.password.type = reveal ? 'text' : 'password';
    event.currentTarget.querySelector('span').textContent = reveal ? 'visibility_off' : 'visibility';
  });
  el.querySelector('[data-config="code"]').addEventListener('click', async () => {
    if (!userFS.get(SECRETS_PATH)) {
      userFS.set(SECRETS_PATH, { text: await readBase(), binary: false });
      await userFS.flush();
    }
    openFile(SECRETS_PATH);
  });

  return { load };
}
