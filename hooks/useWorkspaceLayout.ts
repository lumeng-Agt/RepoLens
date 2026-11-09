import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { GroupImperativeHandle } from "react-resizable-panels";
import { localWorkspaceProvider } from "@/data/providers";
import { enqueueWorkspacePersistence } from "@/data/workspace-persistence.mjs";
import {
  afterLayoutMeasurements,
  DEFAULT_WORKSPACE_LAYOUT,
  normalizeWorkspaceLayout,
  observeWorkspacePanelSizes,
  updateWorkspaceLayout,
  workspaceInnerLayout,
  workspaceOuterLayout,
} from "@/data/workspace-layout.mjs";

export const WORKSPACE_LAYOUT_STORAGE_KEY = "repolens:layout-preferences:v1";
export const WORKSPACE_LAYOUT_PERSISTENCE_ID = "repolens:global-layout-preferences";

export interface UseWorkspaceLayoutOptions {
  desktopMode: boolean;
  savedDataClearBusy: boolean;
  layoutMode: "structure" | "reading";
  showGuideWelcome: boolean;
  chatOpen: boolean;
  chatDocked: boolean;
  workspaceViewportWidth: number;
  narrowLayout: boolean;
  onSetRepoMessage: (message: string) => void;
}

export function useWorkspaceLayout({
  desktopMode,
  savedDataClearBusy,
  layoutMode,
  showGuideWelcome,
  chatOpen,
  chatDocked,
  workspaceViewportWidth,
  narrowLayout,
  onSetRepoMessage,
}: UseWorkspaceLayoutOptions) {
  const [workspaceLayoutPreferences, setWorkspaceLayoutPreferences] = useState(DEFAULT_WORKSPACE_LAYOUT);
  const [workspaceLayoutReady, setWorkspaceLayoutReady] = useState(false);
  const [browserLayoutSaveError, setBrowserLayoutSaveError] = useState("");
  const workspaceLayoutInitializedRef = useRef(false);

  const chatGroupRef = useRef<GroupImperativeHandle | null>(null);
  const chatContainerRef = useRef<HTMLDivElement | null>(null);
  const workspaceOuterGroupRef = useRef<GroupImperativeHandle | null>(null);
  const workspaceInnerGroupRef = useRef<GroupImperativeHandle | null>(null);

  const lastAppliedOuterLayoutRef = useRef("");
  const lastAppliedInnerLayoutRef = useRef("");
  const outerLayoutReplay = useRef<(() => void) | null>(null);
  const innerLayoutReplay = useRef<(() => void) | null>(null);

  // Load browser layout preferences when not in desktop mode
  useEffect(() => {
    if (desktopMode) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      if (cancelled) return;
      try {
        const raw = window.localStorage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY);
        if (raw === null) {
          workspaceLayoutInitializedRef.current = true;
          setWorkspaceLayoutReady(true);
          return;
        }
        const normalized = normalizeWorkspaceLayout(JSON.parse(raw));
        if (!normalized) {
          onSetRepoMessage("无法读取已保存的栏目宽度；本次使用默认布局，原记录未被覆盖。");
          setWorkspaceLayoutReady(true);
          return;
        }
        setWorkspaceLayoutPreferences(normalized);
        workspaceLayoutInitializedRef.current = true;
        setWorkspaceLayoutReady(true);
      } catch (error) {
        setWorkspaceLayoutReady(true);
        onSetRepoMessage(
          `无法读取已保存的栏目宽度；本次使用默认布局，原记录未被覆盖：${
            error instanceof Error ? error.message : "浏览器存储不可用。"
          }`
        );
      }
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [desktopMode, onSetRepoMessage]);

  // Adjust chat column width
  useLayoutEffect(() => {
    const apply = () => {
      const width =
        (chatContainerRef.current?.getBoundingClientRect().width ?? 0) -
        (chatContainerRef.current?.querySelector(".chat-resize-handle")?.getBoundingClientRect().width ?? 0);
      if (!width || !chatGroupRef.current) return;
      const assistant =
        chatOpen && chatDocked ? Math.min(45, ((workspaceLayoutPreferences.chatWidth ?? 360) / width) * 100) : 0;
      chatGroupRef.current.setLayout({ reader: 100 - assistant, assistant });
    };
    apply();
    return afterLayoutMeasurements(apply);
  }, [chatOpen, chatDocked, workspaceViewportWidth, workspaceLayoutPreferences.chatWidth]);

  const outerPanelLayoutApplyKey = `${showGuideWelcome}:${workspaceViewportWidth}:${layoutMode}:${JSON.stringify(
    workspaceOuterLayout(workspaceLayoutPreferences, layoutMode)
  )}`;
  const innerPanelLayoutApplyKey = `${showGuideWelcome}:${workspaceViewportWidth}:${layoutMode}:${JSON.stringify(
    workspaceInnerLayout(workspaceLayoutPreferences, layoutMode)
  )}`;

  const saveWorkspaceLayoutPreferences = useCallback(
    (next: typeof DEFAULT_WORKSPACE_LAYOUT) => {
      setWorkspaceLayoutPreferences(next);
      if (!workspaceLayoutReady || savedDataClearBusy) return;
      if (!workspaceLayoutInitializedRef.current) {
        onSetRepoMessage("栏目宽度仅在本页生效。原偏好未能读取；双击分隔线可明确重置并保存。");
        return;
      }
      if (!desktopMode) {
        try {
          window.localStorage.setItem(WORKSPACE_LAYOUT_STORAGE_KEY, JSON.stringify(next));
          setBrowserLayoutSaveError("");
        } catch (error) {
          setBrowserLayoutSaveError(error instanceof Error ? error.message : "浏览器存储不可用。");
          onSetRepoMessage(`栏目宽度未能保存：${error instanceof Error ? error.message : "浏览器存储不可用。"}`);
        }
        return;
      }
      void enqueueWorkspacePersistence(
        WORKSPACE_LAYOUT_PERSISTENCE_ID,
        () => localWorkspaceProvider.saveLayoutPreferences(next),
        { key: "layout-preferences" }
      ).catch((error: Error) => {
        onSetRepoMessage(`栏目宽度未能保存：${error.message}`);
      });
    },
    [desktopMode, onSetRepoMessage, savedDataClearBusy, workspaceLayoutReady]
  );

  const handleWorkspaceOuterLayoutChanged = useCallback(
    (layout: Record<string, number>, meta: { isUserInteraction: boolean }) => {
      outerLayoutReplay.current?.();
      if (!meta.isUserInteraction) {
        const preferred = workspaceOuterLayout(workspaceLayoutPreferences, layoutMode);
        if (
          workspaceLayoutReady &&
          !savedDataClearBusy &&
          !narrowLayout &&
          Object.entries(preferred).some(([id, value]) => Math.abs((layout[id] ?? 0) - value) > 0.05)
        ) {
          outerLayoutReplay.current = afterLayoutMeasurements(() => workspaceOuterGroupRef.current?.setLayout(preferred));
        }
        return;
      }
      if (!workspaceLayoutReady || savedDataClearBusy || narrowLayout) return;
      const next = updateWorkspaceLayout(workspaceLayoutPreferences, layoutMode, "outer", layout);
      if (JSON.stringify(next) === JSON.stringify(workspaceLayoutPreferences)) return;
      lastAppliedOuterLayoutRef.current = `${workspaceViewportWidth}:${layoutMode}:${JSON.stringify(
        workspaceOuterLayout(next, layoutMode)
      )}`;
      saveWorkspaceLayoutPreferences(next);
    },
    [
      layoutMode,
      narrowLayout,
      saveWorkspaceLayoutPreferences,
      savedDataClearBusy,
      workspaceLayoutPreferences,
      workspaceLayoutReady,
      workspaceViewportWidth,
    ]
  );

  const handleWorkspaceInnerLayoutChanged = useCallback(
    (layout: Record<string, number>, meta: { isUserInteraction: boolean }) => {
      innerLayoutReplay.current?.();
      if (!meta.isUserInteraction) {
        const preferred = workspaceInnerLayout(workspaceLayoutPreferences, layoutMode);
        if (
          workspaceLayoutReady &&
          !savedDataClearBusy &&
          !narrowLayout &&
          Object.entries(preferred).some(([id, value]) => Math.abs((layout[id] ?? 0) - value) > 0.05)
        ) {
          innerLayoutReplay.current = afterLayoutMeasurements(() => workspaceInnerGroupRef.current?.setLayout(preferred));
        }
        return;
      }
      if (layoutMode !== "structure" || !workspaceLayoutReady || savedDataClearBusy || narrowLayout) return;
      const next = updateWorkspaceLayout(workspaceLayoutPreferences, layoutMode, "inner", layout);
      if (JSON.stringify(next) === JSON.stringify(workspaceLayoutPreferences)) return;
      lastAppliedInnerLayoutRef.current = `${workspaceViewportWidth}:${layoutMode}:${JSON.stringify(
        workspaceInnerLayout(next, layoutMode)
      )}`;
      saveWorkspaceLayoutPreferences(next);
    },
    [
      layoutMode,
      narrowLayout,
      saveWorkspaceLayoutPreferences,
      savedDataClearBusy,
      workspaceLayoutPreferences,
      workspaceLayoutReady,
      workspaceViewportWidth,
    ]
  );

  useEffect(() => () => {
    outerLayoutReplay.current?.();
    innerLayoutReplay.current?.();
  }, [workspaceLayoutPreferences, layoutMode, narrowLayout, savedDataClearBusy]);

  const resetWorkspaceColumnLayout = useCallback(() => {
    if (!workspaceLayoutReady || savedDataClearBusy || narrowLayout) return;
    workspaceLayoutInitializedRef.current = true;
    saveWorkspaceLayoutPreferences({
      ...workspaceLayoutPreferences,
      [layoutMode]: DEFAULT_WORKSPACE_LAYOUT[layoutMode],
    });
  }, [
    layoutMode,
    narrowLayout,
    saveWorkspaceLayoutPreferences,
    savedDataClearBusy,
    workspaceLayoutPreferences,
    workspaceLayoutReady,
  ]);

  useLayoutEffect(() => {
    if (!workspaceLayoutReady || narrowLayout) return;
    const targets = new Map<Element, () => void>();
    const outer = document.getElementById('workspace-columns');
    const inner = document.getElementById('workspace-graph-details');
    if (outer) targets.set(outer, () => workspaceOuterGroupRef.current?.setLayout(workspaceOuterLayout(workspaceLayoutPreferences, layoutMode)));
    if (inner && layoutMode === 'structure') targets.set(inner, () => workspaceInnerGroupRef.current?.setLayout(workspaceInnerLayout(workspaceLayoutPreferences, layoutMode)));
    return observeWorkspacePanelSizes(targets);
  }, [layoutMode, narrowLayout, workspaceLayoutPreferences, workspaceLayoutReady]);

  useLayoutEffect(() => {
    const outer = workspaceOuterGroupRef.current;
    const inner = workspaceInnerGroupRef.current;
    if (!outer || !inner || !workspaceLayoutReady) return;
    if (narrowLayout) {
      lastAppliedOuterLayoutRef.current = "";
      lastAppliedInnerLayoutRef.current = "";
      return;
    }
    const applyOuter = lastAppliedOuterLayoutRef.current !== outerPanelLayoutApplyKey;
    const applyInner = layoutMode === "structure" && lastAppliedInnerLayoutRef.current !== innerPanelLayoutApplyKey;
    if (applyOuter) {
      outer.setLayout(workspaceOuterLayout(workspaceLayoutPreferences, layoutMode));
      lastAppliedOuterLayoutRef.current = outerPanelLayoutApplyKey;
    }
    if (layoutMode === "reading") {
      lastAppliedInnerLayoutRef.current = "";
    }
    if (applyInner) {
      inner.setLayout(workspaceInnerLayout(workspaceLayoutPreferences, layoutMode));
      lastAppliedInnerLayoutRef.current = innerPanelLayoutApplyKey;
    }
    if (!applyOuter && !applyInner) return;
    return afterLayoutMeasurements(() => {
      if (applyOuter) outer.setLayout(workspaceOuterLayout(workspaceLayoutPreferences, layoutMode));
      if (applyInner) inner.setLayout(workspaceInnerLayout(workspaceLayoutPreferences, layoutMode));
    });
  }, [
    innerPanelLayoutApplyKey,
    layoutMode,
    narrowLayout,
    outerPanelLayoutApplyKey,
    workspaceLayoutPreferences,
    workspaceLayoutReady,
  ]);

  return {
    workspaceLayoutPreferences,
    setWorkspaceLayoutPreferences,
    workspaceLayoutReady,
    setWorkspaceLayoutReady,
    workspaceLayoutInitializedRef,
    browserLayoutSaveError,
    setBrowserLayoutSaveError,
    chatGroupRef,
    chatContainerRef,
    workspaceOuterGroupRef,
    workspaceInnerGroupRef,
    saveWorkspaceLayoutPreferences,
    handleWorkspaceOuterLayoutChanged,
    handleWorkspaceInnerLayoutChanged,
    resetWorkspaceColumnLayout,
  };
}
