export function createOpenRequestGate() {
  let generation = 0;
  return {
    begin() { generation += 1; return generation; },
    invalidate() { generation += 1; return generation; },
    isCurrent(token) { return token === generation; },
  };
}
