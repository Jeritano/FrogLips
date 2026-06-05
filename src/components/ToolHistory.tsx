import { useMemo, useState } from "react";
import { X } from "lucide-react";
import type { Message } from "../types";

interface Props {
  messages: Message[];
  onClose: () => void;
}

interface Pair {
  name: string;
  args: unknown;
  id: string;
  result?: string;
  ok: boolean;
}

function parseArgs(raw: unknown): unknown {
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return raw; }
  }
  return raw ?? {};
}

function parseResult(content: string): { ok: boolean; pretty: string } {
  try {
    const parsed = JSON.parse(content);
    const ok = !(parsed && typeof parsed === "object" && parsed.ok === false);
    return { ok, pretty: JSON.stringify(parsed, null, 2) };
  } catch {
    return { ok: true, pretty: content };
  }
}

export function ToolHistory({ messages, onClose }: Props) {
  const [expandedArgs, setExpandedArgs] = useState<Set<string>>(new Set());
  const [expandedResults, setExpandedResults] = useState<Set<string>>(new Set());

  const pairs: Pair[] = useMemo(() => {
    const out: Pair[] = [];
    // Walk messages, pair assistant tool_calls with subsequent tool results by id
    const resultsById = new Map<string, string>();
    for (const m of messages) {
      if (m.role === "tool" && m.tool_call_id) {
        resultsById.set(m.tool_call_id, m.content);
      }
    }
    for (const m of messages) {
      if (m.role === "assistant" && m.tool_calls?.length) {
        for (const tc of m.tool_calls) {
          const result = tc.id ? resultsById.get(tc.id) : undefined;
          const parsed = result ? parseResult(result) : { ok: true, pretty: "(no result)" };
          out.push({
            id: tc.id ?? `${out.length}`,
            name: tc.function?.name ?? "unknown",
            args: parseArgs(tc.function?.arguments),
            result: parsed.pretty,
            ok: parsed.ok,
          });
        }
      }
    }
    return out;
  }, [messages]);

  function toggle(set: Set<string>, id: string, setter: (s: Set<string>) => void) {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setter(next);
  }

  return (
    <div
      className="tool-history-overlay"
      role="dialog"
      aria-label="Tool history"
      onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } }}
    >
      <div className="tool-history-header">
        <span className="tool-history-title">Tool history ({pairs.length})</span>
        <button className="tool-history-close" onClick={onClose} aria-label="Close tool history"><X size={16} /></button>
      </div>
      <div className="tool-history-list">
        {pairs.length === 0 && (
          <div className="tool-history-empty">No tool calls in this conversation.</div>
        )}
        {pairs.map((p, i) => {
          const argsKey = `${p.id}-args`;
          const resKey = `${p.id}-res`;
          const argsExpanded = expandedArgs.has(argsKey);
          const resExpanded = expandedResults.has(resKey);
          return (
            <div key={`${p.id}-${i}`} className="tool-history-item">
              <div className="tool-history-call-header">
                <span className="tool-history-name">{p.name}</span>
                <span className={`tool-history-status ${p.ok ? "ok" : "err"}`}>
                  {p.ok ? "ok" : "err"}
                </span>
                <button
                  className="tool-history-toggle"
                  onClick={() => toggle(expandedArgs, argsKey, setExpandedArgs)}
                >
                  {argsExpanded ? "Hide args" : "Args"}
                </button>
                <button
                  className="tool-history-toggle"
                  onClick={() => toggle(expandedResults, resKey, setExpandedResults)}
                >
                  {resExpanded ? "Hide result" : "Result"}
                </button>
              </div>
              {argsExpanded && (
                <pre className="tool-history-args">{JSON.stringify(p.args, null, 2)}</pre>
              )}
              {resExpanded && (
                <pre className="tool-history-result">{p.result}</pre>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
