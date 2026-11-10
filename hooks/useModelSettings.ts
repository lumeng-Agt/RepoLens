import { useCallback, useEffect, useRef, useState } from "react";
import { localExplanationProvider } from "@/data/explanation-provider";

export interface ModelSettingsDraft {
  authMode?: string;
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface ModelSettingsSaved {
  authMode?: string;
  baseUrl: string;
  model: string;
  configured: boolean;
}

export interface UseModelSettingsOptions {
  repositoryId: string;
  repositorySource?: string;
  repositorySessionVersion: number;
}

export function useModelSettings({
  repositoryId,
  repositorySource,
  repositorySessionVersion,
}: UseModelSettingsOptions) {
  const [modelSettingsOpen, setModelSettingsOpen] = useState(false);
  const [aiSettingsDraft, setAiSettingsDraft] = useState<ModelSettingsDraft>({ baseUrl: "", model: "", apiKey: "" });
  const [aiSettingsSaved, setAiSettingsSaved] = useState<ModelSettingsSaved>({ baseUrl: "", model: "", configured: false });
  const [aiSettingsDirty, setAiSettingsDirty] = useState(false);
  const [aiSettingsFeedback, setAiSettingsFeedback] = useState("");
  const [aiSettingsReadError, setAiSettingsReadError] = useState<{ repositoryId: string; sessionVersion: number; message: string } | null>(null);
  const [aiSettingsSaveError, setAiSettingsSaveError] = useState<{ repositoryId: string; sessionVersion: number; message: string } | null>(null);
  const aiSettingsDirtyRef = useRef(false);
  const [aiSettingsReadySession, setAiSettingsReadySession] = useState<{ repositoryId: string; sessionVersion: number } | null>(null);
  const [aiSettingsBusy, setAiSettingsBusy] = useState(false);

  const aiSettingsDraftRevision = useRef(0);
  const aiSettingsSaveSequence = useRef(0);
  const aiSettingsReadSequence = useRef(0);
  const aiSettingsBusyRef = useRef(false);
  const settingsSessionRef = useRef({ repositoryId, sessionVersion: repositorySessionVersion });

  useEffect(() => {
    settingsSessionRef.current = { repositoryId, sessionVersion: repositorySessionVersion };
  }, [repositoryId, repositorySessionVersion]);

  const currentAiSettingsReadError =
    aiSettingsReadError?.repositoryId === repositoryId && aiSettingsReadError.sessionVersion === repositorySessionVersion
      ? aiSettingsReadError.message
      : null;

  const currentAiSettingsSaveError =
    aiSettingsSaveError?.repositoryId === repositoryId && aiSettingsSaveError.sessionVersion === repositorySessionVersion
      ? aiSettingsSaveError.message
      : null;

  const aiSettingsSessionReady =
    repositorySource !== "local" ||
    (aiSettingsReadySession?.repositoryId === repositoryId && aiSettingsReadySession.sessionVersion === repositorySessionVersion);

  const aiSettings = {
    ...aiSettingsDraft,
    configured: aiSettingsSaved.configured && !aiSettingsDirty && aiSettingsSessionReady && !aiSettingsBusy,
  };

  useEffect(() => {
    const clear = () => { aiSettingsBusyRef.current = false; setAiSettingsBusy(false); aiSettingsReadSequence.current++; aiSettingsSaveSequence.current++; aiSettingsDraftRevision.current++; aiSettingsDirtyRef.current = false; setAiSettingsDraft({ baseUrl: "", model: "", apiKey: "" }); setAiSettingsSaved({ baseUrl: "", model: "", configured: false }); setAiSettingsDirty(false); };
    window.addEventListener("repolens:model-cleared", clear);
    return () => window.removeEventListener("repolens:model-cleared", clear);
  }, []);

  const openModelSettingsDialog = useCallback(() => {
    setAiSettingsFeedback("");
    setModelSettingsOpen(true);
  }, []);

  const closeModelSettingsDialog = useCallback(() => setModelSettingsOpen(false), []);

  const editAiSettings = useCallback(
    (patch: Partial<ModelSettingsDraft>) => {
      aiSettingsDraftRevision.current += 1;
      aiSettingsDirtyRef.current = true;
      setAiSettingsDirty(true);
      setAiSettingsFeedback("");
      setAiSettingsDraft((previous) => ({ ...previous, ...(patch.baseUrl !== undefined && patch.baseUrl !== previous.baseUrl ? { apiKey: "" } : {}), ...patch }));
    },
    []
  );

  useEffect(() => {
    const requestId = ++aiSettingsReadSequence.current;
    const draftRevision = aiSettingsDraftRevision.current;
    const sessionVersion = repositorySessionVersion;
    const currentRepoId = repositoryId;
    localExplanationProvider
      .getSettings()
      .then((value) => {
        if (
          requestId !== aiSettingsReadSequence.current ||
          settingsSessionRef.current.sessionVersion !== sessionVersion ||
          settingsSessionRef.current.repositoryId !== currentRepoId
        )
          return;
        setAiSettingsReadError(null);
        setAiSettingsSaved(value);
        setAiSettingsReadySession({ repositoryId: currentRepoId, sessionVersion });
        if (draftRevision === aiSettingsDraftRevision.current && !aiSettingsDirtyRef.current) {
          setAiSettingsDraft((previous) => ({ ...previous, baseUrl: value.baseUrl, model: value.model, apiKey: "", authMode: value.authMode ?? "key" }));
          aiSettingsDirtyRef.current = false;
          setAiSettingsDirty(false);
        }
      })
      .catch((error: Error) => {
        if (
          requestId !== aiSettingsReadSequence.current ||
          settingsSessionRef.current.sessionVersion !== sessionVersion ||
          settingsSessionRef.current.repositoryId !== currentRepoId
        )
          return;
        setAiSettingsReadError({
          repositoryId: currentRepoId,
          sessionVersion,
          message: error instanceof Error ? error.message : "无法读取本地模型配置。",
        });
      });
  }, [repositoryId, repositorySessionVersion]);

  const saveAiSettings = async (event: React.FormEvent) => {
    event.preventDefault();
    if (aiSettingsBusyRef.current) return;
    setAiSettingsSaveError(null);
    aiSettingsBusyRef.current = true;
    setAiSettingsBusy(true);
    const requestId = ++aiSettingsSaveSequence.current;
    aiSettingsReadSequence.current += 1;
    const draftRevision = aiSettingsDraftRevision.current;
    const currentRepoId = repositoryId;
    const sessionVersion = repositorySessionVersion;
    const submittedSettings = { ...aiSettingsDraft };
    try {
      const value = await localExplanationProvider.saveSettings(submittedSettings);
      if (
        requestId !== aiSettingsSaveSequence.current ||
        settingsSessionRef.current.repositoryId !== currentRepoId ||
        settingsSessionRef.current.sessionVersion !== sessionVersion
      )
        return;
      setAiSettingsReadError(null);
      setAiSettingsSaveError(null);
      setAiSettingsSaved(value);
      setAiSettingsReadySession({ repositoryId: currentRepoId, sessionVersion });
      if (draftRevision === aiSettingsDraftRevision.current) {
        setAiSettingsDraft((previous) => ({ ...previous, baseUrl: value.baseUrl, model: value.model, apiKey: "", authMode: value.authMode ?? "key" }));
        aiSettingsDirtyRef.current = false;
        setAiSettingsDirty(false);
        const message = value.configured
          ? "模型设置已应用；桌面版会加密保存模型配置，浏览器版密钥仅在本次服务中保留。"
          : "请填写模型服务地址、模型名称和密钥。";
        setAiSettingsFeedback(value.configured ? message : "");
      } else {
        const message = "较早的模型设置已应用，表单仍有未应用的修改。重新应用后再使用 AI。";
        setAiSettingsFeedback(message);
      }
    } catch (error) {
      if (
        requestId === aiSettingsSaveSequence.current &&
        settingsSessionRef.current.repositoryId === currentRepoId &&
        settingsSessionRef.current.sessionVersion === sessionVersion
      ) {
        setAiSettingsSaveError({
          repositoryId: currentRepoId,
          sessionVersion,
          message: error instanceof Error ? error.message : "无法保存本地模型配置。",
        });
      }
    } finally {
      if (requestId === aiSettingsSaveSequence.current) {
        aiSettingsBusyRef.current = false;
        setAiSettingsBusy(false);
      }
    }
  };

  return {
    modelSettingsOpen,
    openModelSettingsDialog,
    closeModelSettingsDialog,
    aiSettingsDraft,
    aiSettingsSaved,
    aiSettingsDirty,
    aiSettingsFeedback,
    aiSettingsBusy,
    currentAiSettingsReadError,
    currentAiSettingsSaveError,
    aiSettings,
    editAiSettings,
    saveAiSettings,
  };
}
