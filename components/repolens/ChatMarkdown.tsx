import { useMemo, useState, type ReactNode } from "react";
import { Copy, Check } from "lucide-react";
import Prism, { type TokenStream } from "prismjs";
import "prismjs/components/prism-javascript";
import "prismjs/components/prism-jsx";
import "prismjs/components/prism-typescript";
import "prismjs/components/prism-tsx";
import "prismjs/components/prism-python";
import "prismjs/components/prism-go";

function inline(text: string): ReactNode[] {
  // React escapes all strings. Links and images remain inert text.
  return text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*)/g).map((part, index) => part.startsWith("`") && part.endsWith("`") ? <code key={index}>{part.slice(1, -1)}</code> : part.startsWith("**") && part.endsWith("**") ? <strong key={index}>{part.slice(2, -2)}</strong> : part.startsWith("*") && part.endsWith("*") ? <em key={index}>{part.slice(1, -1)}</em> : part);
}

export function ChatCopyButton({ text, label = "复制回答" }: { text: string; label?: string }) {
  const [status, setStatus] = useState("");
  return <button type="button" className="chat-copy-answer" aria-label={label} title={status || label} onClick={() => { void navigator.clipboard.writeText(text).then(() => setStatus("已复制"), () => setStatus("复制失败")); }}><Copy size={13}/>{status && <span role="status">{status}</span>}</button>;
}

function renderTokens(tokens: TokenStream): ReactNode {
  return (Array.isArray(tokens) ? tokens : [tokens]).map((token, index) => typeof token === "string" ? token : <span key={index} className={`token ${token.type}`}>{renderTokens(token.content)}</span>);
}
function CodeBlock({ code, language }: { code: string; language: string }) {
  const [status, setStatus] = useState("");
  const highlighted = useMemo(() => {
    const lang = ({ ts: "typescript", js: "javascript", py: "python" } as Record<string, string>)[language] ?? language;
    const grammar = Prism.languages[lang];
    // Large/unfinished snippets remain readable without a synchronous tokenizer pause.
    return code.length <= 30000 && grammar ? renderTokens(Prism.tokenize(code, grammar)) : code;
  }, [code, language]);
  return <div className="chat-code"><div><span>{language || "代码"}</span><button type="button" aria-label="复制代码" onClick={() => { void navigator.clipboard.writeText(code).then(() => setStatus("已复制"), () => setStatus("复制失败")); }}>{status === "已复制" ? <Check size={13}/> : <Copy size={13}/>}<span>{status || "复制"}</span></button></div><pre><code>{highlighted}</code></pre></div>;
}
const cells = (line: string) => line.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map(cell => cell.trim().replace(/\\\|/g, "|"));
const listItem = (line: string) => /^(\s*)([-+*]|\d+[.)])\s+(.*)$/.exec(line);
const separator = (line: string) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);
function blocks(lines: string[], depth = 0): ReactNode[] {
  if (depth > 12) return [<p key="depth">{lines.join("\n")}</p>];
  const result: ReactNode[] = [];
  for (let i = 0; i < lines.length;) {
    const key = i; const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = /^\s*(`{3,}|~{3,})([^ ]*)\s*$/.exec(line);
    if (fence) {
      const code: string[] = []; i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) code.push(lines[i++]);
      if (i < lines.length) i++;
      result.push(<CodeBlock key={key} code={code.join("\n")} language={fence[2]}/>); continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) { const Tag = `h${Math.min(6, heading[1].length + 1)}` as "h2" | "h3" | "h4" | "h5" | "h6"; result.push(<Tag key={key}>{inline(heading[2])}</Tag>); i++; continue; }
    if (/^\s*>/.test(line)) {
      const quote: string[] = []; while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*> ?/, ""));
      result.push(<blockquote key={key}>{blocks(quote, depth + 1)}</blockquote>); continue;
    }
    if (i + 1 < lines.length && line.includes("|") && separator(lines[i + 1])) {
      const head = cells(line); i += 2; const rows: string[][] = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(cells(lines[i++]));
      result.push(<div key={key} className="chat-table-scroll" tabIndex={0} aria-label="回答表格"><table><thead><tr>{head.map((cell, j) => <th key={j}>{inline(cell)}</th>)}</tr></thead><tbody>{rows.map((row, j) => <tr key={j}>{head.map((_, k) => <td key={k}>{inline(row[k] ?? "")}</td>)}</tr>)}</tbody></table></div>); continue;
    }
    const first = listItem(line);
    if (first) {
      const indent = first[1].length; const ordered = /^\d/.test(first[2]); const items: ReactNode[] = [];
      while (i < lines.length) {
        const match = listItem(lines[i]); if (!match || match[1].length !== indent || /^\d/.test(match[2]) !== ordered) break;
        const body = [match[3]]; i++;
        while (i < lines.length && (lines[i].trim() && (lines[i].match(/^\s*/)?.[0].length ?? 0) > indent)) body.push(lines[i++].slice(indent + 2));
        items.push(<li key={items.length}>{blocks(body, depth + 1)}</li>);
      }
      result.push(ordered ? <ol key={key} start={parseInt(first[2], 10)}>{items}</ol> : <ul key={key}>{items}</ul>); continue;
    }
    const paragraph = [line]; i++;
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*>|\s*```|\s*~~~)/.test(lines[i]) && !listItem(lines[i]) && !(lines[i].includes("|") && i + 1 < lines.length && separator(lines[i + 1]))) paragraph.push(lines[i++]);
    result.push(<p key={key}>{inline(paragraph.join("\n"))}</p>);
  }
  return result;
}

export function ChatMarkdown({ text }: { text: string }) {
  const content = useMemo(() => blocks(text.replace(/\r\n/g, "\n").split("\n")), [text]);
  return <div className="chat-markdown">{content}</div>;
}
