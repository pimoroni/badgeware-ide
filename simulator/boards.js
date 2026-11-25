const BOARD_KEY = 'badgeware.board';

const FLASH = {
  romfsBase: 0x10300000,
  romfsSize: 0x100000,
  filesystemBase: 0x10400000,
};

export const BOARDS = {
  tufty: {
    id: 'tufty',
    model: 'tufty2350',
    label: 'Tufty 2350',
    usbProductId: 0x1101,
    screen: { width: 320, height: 240, kind: 'lcd' },
    buttons: ['a', 'b', 'c', 'up', 'down', 'home'],
    simulator: 'boards/tufty/',
    userStore: 'badgeware.userfs',
    sessionStore: 'badgeware.session',
    firmware: { manifestKey: 'tufty2350', repo: 'pimoroni/tufty2350', ...FLASH },
    view: { model: 'badgeware.glb', node: 'tufty', screen: 'tufty_screen_active', tint: [1.0, 0.42, 0.0], markers: true },
  },
  badger: {
    id: 'badger',
    model: 'badger2350',
    label: 'Badger 2350',
    usbProductId: 0x1100,
    screen: { width: 264, height: 176, kind: 'eink' },
    buttons: ['a', 'b', 'c', 'up', 'down', 'home'],
    simulator: 'boards/badger/',
    userStore: 'badgeware.userfs.badger',
    sessionStore: 'badgeware.session.badger',
    firmware: { manifestKey: 'badger2350', repo: 'pimoroni/badger2350', ...FLASH },
    view: { model: 'badgeware-boards.glb', node: 'badger', screen: 'badger_screen_active', tint: null, markers: false },
  },
  blinky: {
    id: 'blinky',
    model: 'blinky2350',
    label: 'Blinky 2350',
    usbProductId: 0x1102,
    screen: { width: 39, height: 26, kind: 'led' },
    buttons: ['a', 'b', 'c', 'up', 'down', 'home'],
    simulator: 'boards/blinky/',
    userStore: 'badgeware.userfs.blinky',
    sessionStore: 'badgeware.session.blinky',
    firmware: { manifestKey: 'blinky2350', repo: 'pimoroni/blinky2350', ...FLASH },
    view: { model: 'badgeware-boards.glb', node: 'blinky', screen: 'Plane006', tint: [0.65, 1.0, 0.0], markers: false },
  },
};

export const DEFAULT_BOARD = 'tufty';

export const BOARD_LIST = Object.values(BOARDS);

export const getBoard = (id) => BOARDS[id] ?? BOARDS[DEFAULT_BOARD];

export const boardForModel = (model) => BOARD_LIST.find((board) => board.model === model) ?? null;

export const boardForProductId = (productId) => BOARD_LIST.find((board) => board.usbProductId === productId) ?? null;

export const appliesTo = (entry, id) => !entry?.boards || entry.boards.includes(id);

function queryBoard() {
  try {
    return new URLSearchParams(globalThis.location?.search ?? '').get('board');
  } catch (_) {
    return null;
  }
}

function storedBoard() {
  try {
    return globalThis.localStorage?.getItem(BOARD_KEY) ?? null;
  } catch (_) {
    return null;
  }
}

export function setActiveBoard(id) {
  if (!BOARDS[id]) return;
  try {
    globalThis.localStorage?.setItem(BOARD_KEY, id);
  } catch (_) {}
}

export function activeBoardId() {
  const requested = queryBoard();
  if (BOARDS[requested]) {
    setActiveBoard(requested);
    return requested;
  }
  const stored = storedBoard();
  return BOARDS[stored] ? stored : DEFAULT_BOARD;
}

export const activeBoard = () => getBoard(activeBoardId());
