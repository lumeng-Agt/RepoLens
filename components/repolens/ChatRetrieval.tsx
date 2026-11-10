import { useEffect, useRef, useState } from 'react';
import type { RepositorySnapshot } from '@/data/model';
import { localApiOrigin } from '@/data/runtime-config';
import type { ChatAttachment } from './chat-intent';

type RetrievalProps = { repository: RepositorySnapshot; question: string; disabled: boolean; active: boolean; clearVersion: number; onAttach: (items: ChatAttachment[]) => void };

export function ChatRetrieval(props: RetrievalProps) {
  const [prefix, setPrefix] = useState('');
  // Only the disposable summary request is remounted. The conversation and
  // directory input remain owned by their existing parents.
  const requestKey = JSON.stringify([props.repository.workspaceId ?? props.repository.id,
    props.repository.persistenceSessionId, props.repository.revision, props.question,
    props.clearVersion]);
  return <RetrievalContext key={requestKey} {...props} prefix={prefix} onPrefixChange={setPrefix} />;
}

type ContextProps = RetrievalProps & { prefix: string; onPrefixChange: (value: string) => void };
type Candidate = ChatAttachment & { reason: string };

function RetrievalContext(props: ContextProps) {
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<Candidate[]>([]);
  // Pausing or hiding chat invalidates only the pending request and preview.
  // Keep completed recommendations and disclosure state for this question.
  return <div className="chat-assisted-retrieval">
    <button type="button" disabled={props.disabled || !props.question.trim()} onClick={() => setOpen(value => !value)}>让 AI 帮忙找文件</button>
    {open && <div>
      <RetrievalRequest key={`${props.active}:${props.disabled}`} {...props} onResults={setResults} />
      {results.map(item => <div key={`${item.fileId}:${item.startLine}`}>
        <span>{item.fileId}{item.startLine ? `:${item.startLine}–${item.endLine}` : ''}</span>
        <p>模型推断：{item.reason}</p>
        <button type="button" disabled={props.disabled} onClick={() => props.onAttach([item])}>加入下一次发送</button>
      </div>)}
    </div>}
  </div>;
}

function RetrievalRequest({ repository, question, disabled, active, prefix, onPrefixChange: setPrefix, onResults }: ContextProps & { onResults: (results: Candidate[]) => void }) {
  const [preview, setPreview] = useState<{ id: string; characters: number; summary: unknown[] } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const request = async (send: boolean) => {
    if (!active || disabled) return;
    controller.current?.abort(); const current = new AbortController(); controller.current = current; setBusy(true); setError('');
    try {
      const response = await fetch(`${localApiOrigin()}/api/ai/retrieve${send ? '' : '/preview'}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: current.signal, body: JSON.stringify({ repositoryId: repository.id, persistenceSessionId: repository.persistenceSessionId, revision: repository.revision, question, prefix, previewId: send ? preview?.id : undefined }) });
      const body = await response.json() as { error?: string; id: string; characters: number; summary: unknown[]; candidates: (ChatAttachment & { reason: string })[] };
      if (!response.ok) throw new Error(body.error ?? '检索失败。');
      if (current.signal.aborted) return;
      if (send) { onResults(body.candidates); setPreview(null); } else setPreview(body);
    } catch (error) { if (!current.signal.aborted) setError((error as Error).message); }
    finally { if (!current.signal.aborted) setBusy(false); }
  };
  return <>
    <p>先查看索引摘要，再发送一次选材请求。不会自动发送源码或继续回答。</p>
    <label>目录范围<input aria-label="辅助检索目录" value={prefix} disabled={busy} onChange={event => { setPrefix(event.target.value); setPreview(null); }}/></label>
    <button type="button" disabled={busy || disabled} onClick={() => void request(false)}>查看将发送的摘要</button>
    {preview && <><p>{preview.characters.toLocaleString()} 字符 · 不含源码正文</p><details><summary>目录与符号摘要</summary><pre>{JSON.stringify(preview.summary, null, 2)}</pre></details><button type="button" disabled={busy || disabled} onClick={() => void request(true)}>发送摘要，让 AI 选择文件</button></>}
    {busy && <button type="button" onClick={() => { controller.current?.abort(); setBusy(false); setPreview(null); }}>停止检索</button>}
    {error && <p role="alert">{error}</p>}
  </>;
}
