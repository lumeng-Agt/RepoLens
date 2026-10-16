/** Calculate the visible source lines for a fixed-height code viewport. */
export function visibleLineWindow({ lineCount, scrollTop, viewportHeight, rowHeight = 24, headerHeight = 45, overscan = 12 }) {
  if (!Number.isFinite(lineCount) || lineCount <= 0) return { start: 0, end: 0, top: 0, bottom: 0 };
  const firstVisible = Math.min(lineCount - 1, Math.max(0, Math.floor(Math.max(0, scrollTop - headerHeight) / rowHeight)));
  const visibleCount = Math.max(1, Math.ceil(Math.max(0, viewportHeight) / rowHeight));
  const start = Math.max(0, firstVisible - overscan);
  const end = Math.min(lineCount, firstVisible + visibleCount + overscan);
  return { start, end, top: start * rowHeight, bottom: (lineCount - end) * rowHeight };
}
