const flushers = new Map();

export function registerChatPreferenceFlush(flush, retry = flush) {
  flushers.set(flush, retry);
  return () => { flushers.delete(flush); };
}

async function runCallbacks(callbacks, signal) {
  signal?.throwIfAborted();
  const saving = Promise.all(callbacks.map(flush => flush()));
  if (!signal) { await saving; return; }
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try { await Promise.race([saving, cancelled]); }
  finally { signal.removeEventListener("abort", abort); }
}
export function flushChatPreferences(signal) { return runCallbacks([...flushers.keys()], signal); }
export function retryChatPreferences(signal) { return runCallbacks([...flushers.values()], signal); }
