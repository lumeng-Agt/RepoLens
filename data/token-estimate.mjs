/** A deliberately rough display estimate, not model tokenizer or billing data. */
export function estimateTokens(text) {
  let estimate = 0;
  let asciiRun = 0;
  const flushAscii = () => { estimate += Math.ceil(asciiRun / 4); asciiRun = 0; };
  for (const character of String(text)) {
    const code = character.codePointAt(0);
    const isAsciiWord = (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || character === "_";
    if (isAsciiWord) { asciiRun += 1; continue; }
    flushAscii();
    if (/\s/u.test(character)) continue;
    // Chinese and other non-ASCII symbols vary by tokenizer; counting each as
    // one keeps the UI useful while the label makes the uncertainty explicit.
    estimate += 1;
  }
  flushAscii();
  return estimate;
}
