import type { SourceReference, TourStep } from "./model";

export type NavigationState = {
  selectedFileId: string;
  tourIndex: number;
  focusedLine: SourceReference | null;
  focusOrigin: "none" | "reference" | "route";
  focusRouteSignature: string | null;
  completedSteps: string[];
  graphDirectory: string;
};
export type StateUpdate<T> = T | ((previous: T) => T);
export type NavigationAction =
  | { type: "select"; value: StateUpdate<string> }
  | { type: "tour"; value: StateUpdate<number> }
  | { type: "reference"; value: StateUpdate<SourceReference | null>; origin?: "reference" | "route"; routeSignature?: string }
  | { type: "directory"; value: string }
  | { type: "directory-select"; value: string; fileId: string; preserveFocus: boolean }
  | { type: "select-file"; fileId: string; directory: string }
  | { type: "reference-navigation"; reference: SourceReference; directory: string; origin?: "reference" | "route"; routeSignature?: string }
  | { type: "completed"; value: StateUpdate<string[]> }
  | { type: "restore-progress"; stepIndex: number; completedSteps: string[]; step?: TourStep; routeSignature: string; routeStale: boolean }
  | { type: "route-step"; stepIndex: number; step: TourStep; routeSignature: string; completedStepId?: string }
  | { type: "restart-tour"; step: TourStep; routeSignature: string }
  | { type: "snapshot"; selectedFileId: string; graphDirectory: string; clearFocus: boolean; resetTour: boolean };

export const initialNavigationState: NavigationState;
export function navigationReducer(state: NavigationState, action: NavigationAction): NavigationState;
