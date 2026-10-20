export const initialNavigationState = Object.freeze({
  selectedFileId: "src/main.tsx",
  tourIndex: 0,
  focusedLine: null,
  focusOrigin: "none",
  focusRouteSignature: null,
  completedSteps: [],
  graphDirectory: "",
});

export function navigationReducer(state, action) {
  if (action.type === "select") return { ...state, selectedFileId: typeof action.value === "function" ? action.value(state.selectedFileId) : action.value };
  if (action.type === "tour") return { ...state, tourIndex: typeof action.value === "function" ? action.value(state.tourIndex) : action.value };
  if (action.type === "reference") {
    const reference = typeof action.value === "function" ? action.value(state.focusedLine) : action.value;
    return { ...state, focusedLine: reference, focusOrigin: reference ? action.origin ?? "reference" : "none", focusRouteSignature: reference && action.origin === "route" ? action.routeSignature ?? null : null };
  }
  if (action.type === "directory") return { ...state, graphDirectory: action.value };
  if (action.type === "directory-select") return { ...state, graphDirectory: action.value, selectedFileId: action.fileId, ...(action.preserveFocus ? {} : { focusedLine: null, focusOrigin: "none", focusRouteSignature: null }) };
  if (action.type === "select-file") return { ...state, selectedFileId: action.fileId, graphDirectory: action.directory, focusedLine: null, focusOrigin: "none", focusRouteSignature: null };
  if (action.type === "reference-navigation") return { ...state, selectedFileId: action.reference.fileId, graphDirectory: action.directory, focusedLine: action.reference, focusOrigin: action.origin ?? "reference", focusRouteSignature: action.origin === "route" ? action.routeSignature ?? null : null };
  if (action.type === "completed") return { ...state, completedSteps: typeof action.value === "function" ? action.value(state.completedSteps) : action.value };
  if (action.type === "restore-progress") return {
    ...state,
    tourIndex: action.stepIndex,
    completedSteps: action.completedSteps,
    ...(action.step && !action.routeStale ? { selectedFileId: action.step.focusFileId, focusedLine: action.step.reference, focusOrigin: "route", focusRouteSignature: action.routeSignature } : { focusedLine: null, focusOrigin: "none", focusRouteSignature: null }),
  };
  if (action.type === "route-step") return {
    ...state,
    tourIndex: action.stepIndex,
    selectedFileId: action.step.focusFileId,
    graphDirectory: "",
    focusedLine: action.step.reference,
    focusOrigin: "route",
    focusRouteSignature: action.routeSignature,
    ...(action.completedStepId ? { completedSteps: state.completedSteps.includes(action.completedStepId) ? state.completedSteps : [...state.completedSteps, action.completedStepId] } : {}),
  };
  if (action.type === "restart-tour") return { ...state, tourIndex: 0, completedSteps: [], selectedFileId: action.step.focusFileId, graphDirectory: "", focusedLine: action.step.reference, focusOrigin: "route", focusRouteSignature: action.routeSignature };
  return { ...state, selectedFileId: action.selectedFileId, graphDirectory: action.graphDirectory, ...(action.resetTour ? { tourIndex: 0, completedSteps: [] } : {}), ...(action.clearFocus ? { focusedLine: null, focusOrigin: "none", focusRouteSignature: null } : {}) };
}
