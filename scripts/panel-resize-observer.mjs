// Keep nested panel writes outside ResizeObserver delivery. This changes when
// layout work executes; native errors and observations remain enabled.
export function deferredPanelObserver(Observer, callback, window) {
  const pending = new Map();
  let frame = 0;
  let timer = 0;
  const cancel = () => {
    if (frame) window.cancelAnimationFrame(frame);
    if (timer) window.clearTimeout(timer);
    frame = timer = 0;
  };
  const flush = () => {
    cancel();
    const entries = [...pending.values()];
    pending.clear();
    callback(entries);
  };
  const observer = new Observer(entries => {
    for (const entry of entries) pending.set(entry.target, entry);
    if (!frame && !timer) {
      frame = window.requestAnimationFrame(flush);
      // Electron native-hidden windows can suspend rAF while reporting a
      // visible document. A task fallback still avoids native RO delivery.
      timer = window.setTimeout(flush, 32);
    }
  });
  const disconnect = observer.disconnect.bind(observer);
  observer.disconnect = () => {
    cancel();
    pending.clear();
    disconnect();
  };
  return observer;
}
