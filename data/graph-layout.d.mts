export type LayoutNode = {
  id: string;
  position: { x: number; y: number };
  width?: number;
  height?: number;
  measured?: { width?: number; height?: number };
  selected?: boolean;
  data?: { selected?: boolean };
  [key: string]: unknown;
};

export function separateOverlappingGraphNodes<T extends LayoutNode>(
  nodes: T[],
  options?: { gap?: number; width?: number; height?: number; anchorId?: string },
): T[];
