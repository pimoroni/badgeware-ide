import { IncompatibleBadgeError, MissingReplError } from './badge.js';

const PAIR_MESSAGES = {
  first: ['Connect your badge', 'Your badge shows up twice in the list, because it has two connections: one for code and one for the debugger. Pick either one. If Chrome only grants that one, the IDE will ask for the other next.'],
  repl: ['One more port', 'That was the debugger connection. Pick the other entry for your badge so the IDE can run your code.'],
  debug: ['Enable debugging', 'To debug, the IDE also needs your badge\'s second connection. Pick the entry you didn\'t choose before.'],
};

export function createConnector({ device, dialog, setStatus = () => {}, onError = () => {}, onChange = () => {} }) {
  let connecting = null;

  function askToPair(kind) {
    const [title, text] = PAIR_MESSAGES[kind];
    dialog.querySelector('h2').textContent = title;
    dialog.querySelector('.pair-text').textContent = text;
    dialog.returnValue = '';
    dialog.showModal();
    return new Promise((resolve) => {
      dialog.addEventListener('close', async () => {
        if (dialog.returnValue !== 'choose') return resolve(false);
        try {
          await device.requestPort();
          resolve(true);
        } catch (_) {
          resolve(false);
        }
      }, { once: true });
    });
  }

  async function connectNow({ prompt = true } = {}) {
    if (device.connected) return true;
    try {
      if (!(await device.knownPorts()).length) {
        if (!prompt || !(await askToPair('first'))) {
          setStatus('');
          return false;
        }
      }
      setStatus('Connecting…');
      try {
        await device.connect();
      } catch (error) {
        if (!(error instanceof MissingReplError) || !prompt || !(await askToPair('repl'))) throw error;
        await device.connect();
      }
      setStatus(`Connected to ${device.ident.board}`);
      return true;
    } catch (error) {
      if (error.name === 'NotFoundError' || (error instanceof MissingReplError && !prompt)) {
        setStatus('');
        return false;
      }
      setStatus(error instanceof IncompatibleBadgeError ? 'Incompatible badge' : 'Could not connect');
      onError(error);
      return false;
    } finally {
      onChange();
    }
  }

  function connect(options) {
    connecting ??= connectNow(options).finally(() => { connecting = null; });
    return connecting;
  }

  window.addEventListener('pagehide', () => {
    if (device.connected) device.repl.restartFirmware();
  });

  return { connect, askToPair };
}
