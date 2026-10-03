export function createProgressSessionGate() {
  let generation = 0;
  let activeKey = null;
  let readyKey = null;

  return {
    begin(key, forceRestore = false) {
      if (key !== activeKey || forceRestore) {
        generation += 1;
        activeKey = key;
        readyKey = null;
      }
      return { key, generation };
    },
    complete(token) {
      if (!token || token.generation !== generation || token.key !== activeKey) return false;
      readyKey = token.key;
      return true;
    },
    canSave(key) { return key === activeKey && key === readyKey; },
    current() { return { key: activeKey, generation, ready: activeKey !== null && activeKey === readyKey }; },
  };
}
