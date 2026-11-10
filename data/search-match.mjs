// @ts-check
// Shared by the search worker (injected through Function#toString) and the sample-repository search in the
// browser, so both produce identical match positions. Both functions must stay self-contained: they may only
// reference their own arguments and language built-ins.
//
// Column contract: every `*Column` is a 1-based, inclusive UTF-16 column of the original line. To slice, convert
// back to a zero-based offset (`column - 1`) and use `end` as exclusive (`matchEndColumn`).

/** @typedef {{ query: string, regex?: boolean, wholeWord?: boolean, matchCase?: boolean }} SearchMatcherOptions */
/** @typedef {{ text: string, contextStartColumn: number, contextEndColumn: number, lineLength: number, matchStartColumn: number, matchEndColumn: number }} SearchMatchDescription */

/** @param {SearchMatcherOptions} options */
export function buildSearchMatcher(options) {
  const escaped = options.regex ? options.query : options.query.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
  const source = options.wholeWord ? "(?<![\\p{L}\\p{N}_])(?:" + escaped + ")(?![\\p{L}\\p{N}_])" : escaped;
  return new RegExp(source, "gu" + (options.matchCase ? "" : "i"));
}

/** @param {string} line @param {RegExpExecArray} match @returns {SearchMatchDescription} */
export function describeSearchMatch(line, match) {
  const width = 400;
  const matchLength = Math.max(1, match[0].length);
  const matchStart = match.index;
  const matchEnd = Math.min(line.length, match.index + matchLength);
  let contextStart = Math.max(0, matchStart - Math.floor((width - Math.min(matchLength, width)) / 2));
  let contextEnd = Math.min(line.length, contextStart + width);
  contextStart = Math.max(0, contextEnd - width);
  // Never cut a surrogate pair in half at the context boundaries.
  if (contextStart > 0 && contextStart < line.length) {
    const unit = line.charCodeAt(contextStart);
    if (unit >= 0xdc00 && unit <= 0xdfff) contextStart -= 1;
  }
  if (contextEnd < line.length) {
    const unit = line.charCodeAt(contextEnd);
    if (unit >= 0xdc00 && unit <= 0xdfff) contextEnd -= 1;
  }
  return {
    text: line.slice(contextStart, contextEnd),
    contextStartColumn: contextStart + 1,
    contextEndColumn: contextEnd,
    lineLength: line.length,
    matchStartColumn: matchStart + 1,
    matchEndColumn: Math.max(matchStart + 1, matchEnd),
  };
}

/** Splits a described match into the text before, inside and after the highlight.
 * @param {Pick<SearchMatchDescription, "text" | "contextStartColumn" | "matchStartColumn" | "matchEndColumn">} result
 */
export function splitSearchHighlight(result) {
  const start = Math.max(0, result.matchStartColumn - result.contextStartColumn);
  const end = Math.max(start, result.matchEndColumn - result.contextStartColumn + 1);
  return { before: result.text.slice(0, start), match: result.text.slice(start, end), after: result.text.slice(end) };
}
