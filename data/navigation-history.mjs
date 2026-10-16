function sameLocation(left, right) {
  return left?.fileId === right?.fileId && left?.line === right?.line && left?.endLine === right?.endLine;
}

export const emptyNavigationHistory = Object.freeze({ entries: [], index: -1 });

/** Add the current location and destination, truncating any forward branch. */
export function pushNavigationHistory(state, current, destination, limit = 100) {
  if (!destination?.fileId || sameLocation(current, destination)) return state;
  let entries = state.entries.slice(0, state.index + 1);
  if (state.index < 0) entries.push(current);
  else if (!sameLocation(entries.at(-1), current)) entries.push(current);
  if (!sameLocation(entries.at(-1), destination)) entries.push(destination);
  entries = entries.slice(-limit);
  return { entries, index: entries.length - 1 };
}

export function moveNavigationHistory(state, direction) {
  const index = state.index + direction;
  if (index < 0 || index >= state.entries.length) return { state, location: null };
  return { state: { ...state, index }, location: state.entries[index] };
}
