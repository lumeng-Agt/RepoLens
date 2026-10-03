/**
 * @param {string | null} raw
 * @param {import("./model").TourStep[]} tour
 * @returns {{stepIndex: number, completedSteps: string[]} | null}
 */
export function parseTourProgress(raw, tour) {
  if (!raw || !tour.length) return null;
  const progress = JSON.parse(raw);
  if (!progress || typeof progress !== "object" || Array.isArray(progress)) {
    throw new Error("Invalid saved tour progress.");
  }
  if (!Number.isInteger(progress.stepIndex) || progress.stepIndex < 0 || progress.stepIndex >= tour.length) {
    throw new Error("Saved tour step is out of range.");
  }
  if (!Array.isArray(progress.completedSteps)) {
    throw new Error("Invalid completed tour steps.");
  }
  const validIds = new Set(tour.map((step) => step.id));
  const completedSteps = progress.completedSteps;
  if (completedSteps.some((id) => typeof id !== "string" || !validIds.has(id)) || new Set(completedSteps).size !== completedSteps.length) {
    throw new Error("Saved tour steps do not match this route.");
  }
  return { stepIndex: progress.stepIndex, completedSteps };
}
