// Spots keystrokes the browser holds back before the page sees them, which no
// page code can cause or fix. On macOS, Chrome polling Bluetooth on its main
// thread is a known cause: it blocks input for ~200 ms every 700 ms.

const DELAY_MS = 100;        // a keystroke waited at least this long to be handled
const WINDOW_MS = 30000;     // ...this many times within this window
const COUNT = 3;
const KEY_EVENTS = new Set(['keydown', 'keypress', 'keyup', 'beforeinput', 'input']);

// Keystrokes that waited DELAY_MS or more while no long task was running in the
// page, so the wait was outside it. `events` are Event Timing entries,
// `longTasks` long task entries ({ startTime, duration }).
export function browserDelays(events, longTasks) {
  return events.filter((event) => {
    if (!KEY_EVENTS.has(event.name) || event.processingStart - event.startTime < DELAY_MS) return false;
    return !longTasks.some((task) => task.startTime < event.processingStart && task.startTime + task.duration > event.startTime);
  });
}

export function watchInputDelay(onDetected) {
  if (typeof PerformanceObserver === 'undefined' || !PerformanceObserver.supportedEntryTypes?.includes('event')) return;
  let longTasks = [];
  let delays = [];
  let reported = false;
  if (PerformanceObserver.supportedEntryTypes.includes('longtask')) {
    new PerformanceObserver((list) => {
      longTasks = longTasks.concat(list.getEntries()).filter((task) => task.startTime > performance.now() - WINDOW_MS);
    }).observe({ type: 'longtask' });
  }
  new PerformanceObserver((list) => {
    if (reported) return;
    delays = delays.concat(browserDelays(list.getEntries(), longTasks)).filter((event) => event.startTime > performance.now() - WINDOW_MS);
    if (delays.length >= COUNT) {
      reported = true;
      onDetected(Math.round(Math.max(...delays.map((event) => event.processingStart - event.startTime))));
    }
  }).observe({ type: 'event', durationThreshold: 16, buffered: true });
}
