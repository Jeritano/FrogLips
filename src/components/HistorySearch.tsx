import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { api } from "../lib/tauri-api";
import { EmptyState } from "./EmptyState";
import type { FtsMessageHit } from "../types";

/*
 * Knowledge → History: full-text message search (product review Act 2,
 * 2026-06-10). "Where did we discuss the watermark swap?" used to mean a
 * shorter sidebar conversation list and manual scrolling; this surfaces the
 * MESSAGE — BM25-ranked FTS5 hits with snippets — and clicking a hit opens
 * its conversation (via the App-level `froglips:open-conversation` event,
 * same pattern as the launchpad's navigate).
 */

const DEBOUNCE_MS = 250;
const LIMIT = 50;

/** Render an FTS snippet, highlighting the [bracketed] match terms. */
function Snippet({ text }: { text: string }) {
  const parts = text.split(/\[([^\]]*)\]/);
  return (
    <span className="history-hit-snippet">
      {parts.map((p, i) =>
        i % 2 === 1 ? <mark key={i}>{p}</mark> : <span key={i}>{p}</span>,
      )}
    </span>
  );
}

export function HistorySearch() {
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<FtsMessageHit[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setHits([]);
      setErr(null);
      return;
    }
    const mySeq = ++seq.current;
    const t = setTimeout(() => {
      setBusy(true);
      api
        .searchMessagesFts(q, LIMIT)
        .then((rows) => {
          if (seq.current !== mySeq) return; // superseded
          setHits(rows);
          setErr(null);
        })
        .catch((e) => {
          if (seq.current !== mySeq) return;
          setErr(String(e));
        })
        .finally(() => {
          if (seq.current === mySeq) setBusy(false);
        });
    }, DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  return (
    <div className="history-search" data-testid="history-search">
      <div className="history-search-bar">
        <Search size={15} aria-hidden="true" />
        <input
          className="history-search-input"
          data-testid="history-search-input"
          placeholder="Search every message…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {busy && <span className="history-search-busy">…</span>}
      </div>
      {err && <div className="history-search-err">{err}</div>}
      {!query.trim() && (
        <EmptyState
          icon={<Search size={24} />}
          heading="Search your entire chat history"
          sub="Full-text, ranked by relevance — results land on the message, not just the conversation."
        />
      )}
      {query.trim() && !busy && hits.length === 0 && !err && (
        <EmptyState
          icon={<Search size={24} />}
          heading="No matches"
          sub="Try fewer or different words."
        />
      )}
      <div className="history-hits">
        {hits.map((h) => (
          <button
            key={h.message_id}
            type="button"
            className="history-hit"
            data-testid="history-hit"
            onClick={() =>
              window.dispatchEvent(
                new CustomEvent("froglips:open-conversation", {
                  detail: { id: h.conversation_id },
                }),
              )
            }
          >
            <span className="history-hit-meta">
              <span className="history-hit-title">{h.conversation_title}</span>
              <span className="history-hit-role">{h.role}</span>
              <span className="history-hit-date">
                {new Date(h.created_at * 1000).toLocaleDateString()}
              </span>
            </span>
            <Snippet text={h.snippet} />
          </button>
        ))}
      </div>
    </div>
  );
}
