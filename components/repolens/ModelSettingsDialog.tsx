"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { localApiOrigin } from "@/data/runtime-config";
import { X } from "lucide-react";

export function ModelSettingsDialog({ open, available, busy, configured, dirty, values, readError, saveError, feedback, onChange, onSubmit, onClose }: {
  open: boolean;
  available: boolean;
  busy: boolean;
  configured: boolean;
  dirty: boolean;
  values: { baseUrl: string; model: string; apiKey: string; authMode?: string };
  readError: string | null;
  saveError: string | null;
  feedback: string;
  onChange: (key: "baseUrl" | "model" | "apiKey" | "authMode", value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onClose: () => void;
}) {
  const [checkStatus, setCheckStatus] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [checking, setChecking] = useState(false);
  const checkController = useRef<AbortController | null>(null);
  const [checkContext, setCheckContext] = useState({ open, values });
  // Reset check results before committing edited fields, without remounting the
  // form (which would lose keyboard focus). Cancelling transport remains an effect.
  // useModelSettings replaces the draft on edits. Retain its identity instead of
  // copying configuration fields, including the key, into a second state object.
  if (checkContext.open !== open || checkContext.values !== values) {
    setCheckContext({ open, values });
    setChecking(false); setCheckStatus(""); setModels([]);
  }
  useEffect(() => { checkController.current?.abort(); }, [open, values]);
  useEffect(() => () => checkController.current?.abort(), []);
  const check = async (action: string) => {
    const controller = new AbortController(); checkController.current?.abort(); checkController.current = controller;
    setChecking(true); setCheckStatus(action === "models" ? "正在获取模型列表…" : "正在发送固定测试文字…");
    try { const response = await fetch(`${localApiOrigin()}/api/ai/settings/check`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...values, action }), signal: controller.signal }); const result = await response.json() as { error?: string; models: string[] }; if (!response.ok) throw new Error(result.error ?? "模型检查失败。"); if (controller.signal.aborted) return; if (action === "models") setModels(result.models); setCheckStatus(action === "models" ? `获取到 ${result.models.length} 个模型；尚未验证生成能力。` : "模型已返回有效文本；测试配置尚未自动保存。"); } catch (error) { if (!controller.signal.aborted) setCheckStatus((error as Error).message); } finally { if (!controller.signal.aborted) setChecking(false); }
  };
  const closeButton = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus();
    const dialog = closeButton.current?.closest<HTMLElement>("[role='dialog']");
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), [href], [tabindex]:not([tabindex="-1"])')];
      if (!focusable.length) return;
      const first = focusable[0]; const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => { window.removeEventListener("keydown", closeOnEscape); returnFocus.current?.focus(); };
  }, [open, onClose]);
  if (!open) return null;
  return <div className="settings-layer">
    <button className="settings-backdrop" type="button" aria-label="关闭模型设置" onClick={onClose} />
    <section className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="model-settings-title">
      <header><div><h2 id="model-settings-title">模型设置</h2><p>桌面版会加密保存模型配置，下次启动自动恢复；浏览器版密钥仅在本次服务中保留。</p></div><button type="button" ref={closeButton} className="settings-close" aria-label="关闭模型设置" onClick={onClose}><X size={18} /></button></header>
      {!available && <p className="settings-error" role="alert">本地服务不可用，暂时无法读取或应用配置。</p>}
      {readError && <p className="settings-error ai-settings-read-error" role="alert">读取模型设置失败：{readError}</p>}
      {saveError && <p className="settings-error ai-settings-save-error" role="alert">应用模型设置失败：{saveError}</p>}
      {feedback && <p className="settings-feedback" role="status">{feedback}</p>}
      <form onSubmit={onSubmit} className="settings-form">
        <label>服务预设<select aria-label="服务预设" defaultValue="" onChange={event => { const preset = { openai: ["https://api.openai.com/v1", ""], deepseek: ["https://api.deepseek.com/v1", "deepseek-chat"], ollama: ["http://127.0.0.1:11434/v1", ""], lmstudio: ["http://127.0.0.1:1234/v1", ""] }[event.target.value]; if (preset) { onChange("baseUrl", preset[0]); onChange("model", preset[1]); onChange("apiKey", ""); onChange("authMode", "key"); } }}><option value="">自定义 OpenAI 兼容接口</option><option value="openai">OpenAI</option><option value="deepseek">DeepSeek</option><option value="ollama">Ollama</option><option value="lmstudio">LM Studio</option></select></label>
        <label>认证方式<select aria-label="模型认证方式" value={values.authMode ?? "key"} onChange={event => onChange("authMode", event.target.value)}><option value="key">API 密钥</option><option value="none">本机免密（仅回环地址）</option></select></label>
        <label>服务地址<input aria-label="模型服务地址" placeholder="https://api.example.com/v1" value={values.baseUrl} disabled={!available} onChange={(event) => onChange("baseUrl", event.target.value)} /></label>
        <label>模型名称<input aria-label="模型名称" placeholder="输入模型名称" value={values.model} disabled={!available} onChange={(event) => onChange("model", event.target.value)} /></label>
        <label>API 密钥<input disabled={values.authMode === "none" || !available} aria-label="API 密钥" type="password" autoComplete="off" placeholder={configured ? "密钥已在本地服务中配置" : "输入 API 密钥"} value={values.apiKey} onChange={(event) => onChange("apiKey", event.target.value)} /></label>
        <div><button type="button" disabled={checking || !available} onClick={() => void check("models")}>获取模型列表</button><button type="button" disabled={checking || !available || !values.model} onClick={() => void check("test")}>发送固定文字测试模型</button>{checking && <button type="button" onClick={() => { checkController.current?.abort(); setChecking(false); setCheckStatus("已取消检查。"); }}>取消检查</button>}</div>
        {checkStatus && <p role="status">{checkStatus}</p>}{models.length > 0 && <label>可用模型<select aria-label="可用模型" value="" onChange={event => onChange("model", event.target.value)}><option value="">选择模型</option>{models.map(model => <option key={model}>{model}</option>)}</select></label>}
        <div className="settings-actions"><span role="status">{busy ? "正在应用…" : dirty ? "有尚未应用的修改" : configured ? "已配置" : "尚未配置"}</span><button type="button" onClick={onClose}>关闭</button><button type="submit" className="settings-apply" disabled={!available || busy || !dirty}>{busy ? "正在应用…" : "应用设置"}</button></div>
      </form>
    </section>
  </div>;
}
