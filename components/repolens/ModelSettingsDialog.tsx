"use client";

import { useEffect, useRef, type FormEvent } from "react";
import { X } from "lucide-react";

export function ModelSettingsDialog({ open, available, busy, configured, dirty, values, readError, saveError, feedback, onChange, onSubmit, onClose }: {
  open: boolean;
  available: boolean;
  busy: boolean;
  configured: boolean;
  dirty: boolean;
  values: { baseUrl: string; model: string; apiKey: string };
  readError: string | null;
  saveError: string | null;
  feedback: string;
  onChange: (key: "baseUrl" | "model" | "apiKey", value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onClose: () => void;
}) {
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
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [href], [tabindex]:not([tabindex="-1"])')];
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
        <label>服务地址<input aria-label="模型服务地址" placeholder="https://api.example.com/v1" value={values.baseUrl} disabled={!available} onChange={(event) => onChange("baseUrl", event.target.value)} /></label>
        <label>模型名称<input aria-label="模型名称" placeholder="输入模型名称" value={values.model} disabled={!available} onChange={(event) => onChange("model", event.target.value)} /></label>
        <label>API 密钥<input aria-label="API 密钥" type="password" autoComplete="off" placeholder={configured ? "密钥已在本地服务中配置" : "输入 API 密钥"} value={values.apiKey} disabled={!available} onChange={(event) => onChange("apiKey", event.target.value)} /></label>
        <div className="settings-actions"><span role="status">{busy ? "正在应用…" : dirty ? "有尚未应用的修改" : configured ? "已配置" : "尚未配置"}</span><button type="button" onClick={onClose}>关闭</button><button type="submit" className="settings-apply" disabled={!available || busy || !dirty}>{busy ? "正在应用…" : "应用设置"}</button></div>
      </form>
    </section>
  </div>;
}
