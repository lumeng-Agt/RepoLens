// Unsendable tasks are failures, never zero-waste successes. Keep the ordinary
// character ratio nullable; this separate loss compares all tasks fairly.
export function contextLoss(scopeRequired, irrelevantRatio) {
  return scopeRequired || irrelevantRatio === null ? 1 : irrelevantRatio;
}

export function checkQuality(before, after, aggregate = false) {
  const comparableRatio = before.irrelevantRatio !== null && after.irrelevantRatio !== null;
  return {
    ratioComparison: comparableRatio ? 'comparable' : 'unavailable',
    passed: before.samples > 0 && before.samples === after.samples
      && after.recall5 >= before.recall5
      && after.necessaryCoverage >= before.necessaryCoverage
      && after.rangeCoverage >= before.rangeCoverage
      && after.validSamples > before.validSamples
      && after.contextLoss < before.contextLoss
      && (!comparableRatio || after.irrelevantRatio < before.irrelevantRatio)
      && (!aggregate || after.recall5 > before.recall5 || after.necessaryCoverage > before.necessaryCoverage),
  };
}
