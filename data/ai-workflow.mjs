export const initialAiWorkflowState = {
  status: "idle",
  requestId: 0,
  contextKey: null,
  mode: null,
  preview: null,
  candidates: [],
  selectedFiles: [],
  ranges: {},
  message: "",
};

function matches(state, action) {
  return state.requestId === action.requestId && state.contextKey === action.contextKey;
}

export function aiWorkflowReducer(state, action) {
  switch (action.type) {
    case "start":
      if (action.requestId <= state.requestId) return state;
      return {
        ...initialAiWorkflowState,
        ...(action.preserveScope && action.mode === state.mode ? { candidates: state.candidates, selectedFiles: state.selectedFiles, ranges: state.ranges } : {}),
        requestId: action.requestId,
        status: action.stage,
        contextKey: action.contextKey,
        mode: action.mode,
        preview: action.preview ?? null,
      };
    case "previewReady":
      if (!matches(state, action) || state.status !== "previewing") return state;
      return { ...state, status: "ready", preview: action.preview, candidates: [], selectedFiles: [], ranges: {}, message: "" };
    case "scopeRequired":
      if (!matches(state, action) || state.status !== "previewing") return state;
      return { ...state, status: "ready", preview: null, candidates: action.candidates, selectedFiles: action.selectedFiles, ranges: action.ranges, message: action.message };
    case "scopeChanged":
      if (action.requestId <= state.requestId || !["ready", "error"].includes(state.status) || !state.candidates.length) return state;
      return { ...state, requestId: action.requestId, status: "ready", preview: null, selectedFiles: action.selectedFiles, ranges: action.ranges, message: "" };
    case "succeeded":
      if (!matches(state, action) || state.status !== "generating") return state;
      return { ...initialAiWorkflowState, requestId: state.requestId, message: action.message };
    case "failed":
      if (!matches(state, action) || !["previewing", "generating"].includes(state.status)) return state;
      return { ...state, status: "error", preview: null, message: action.message };
    case "message":
      return { ...state, message: action.message };
    case "invalidate":
      if (action.requestId <= state.requestId) return state;
      return { ...initialAiWorkflowState, ...(action.preserveScope ? { mode: state.mode, candidates: state.candidates, selectedFiles: state.selectedFiles, ranges: state.ranges } : {}), requestId: action.requestId };
    default:
      return state;
  }
}
