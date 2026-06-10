import { lazy, Suspense, useState } from "react";

/**
 * Top-level view for the user's knowledge pillar. Peer to `WorkflowsPage`.
 *
 * Act 2 (2026-06-10): grew from a RagPanel shell into the pillar surface the
 * positioning promises — Corpora (RAG folders) and History (full-text
 * message search) as tabs. Memories stay reachable via the Memories modal /
 * command palette for now; folding them in is the next step of the
 * unification (product review IA #4 second half).
 */
const RagPanel = lazy(() =>
  import("./RagPanel").then((m) => ({ default: m.RagPanel })),
);
const HistorySearch = lazy(() =>
  import("./HistorySearch").then((m) => ({ default: m.HistorySearch })),
);

type Tab = "corpora" | "history";

export function KnowledgeView() {
  const [tab, setTab] = useState<Tab>("corpora");
  return (
    <div className="knowledge-view" data-testid="knowledge-view">
      <header className="knowledge-view-header">
        <h2 className="knowledge-view-title">
          <span aria-hidden="true">📚</span> Knowledge
        </h2>
        <div
          className="knowledge-tabs"
          role="tablist"
          aria-label="Knowledge sections"
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab === "corpora"}
            className={`knowledge-tab${tab === "corpora" ? " sel" : ""}`}
            data-testid="knowledge-tab-corpora"
            onClick={() => setTab("corpora")}
          >
            Corpora
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "history"}
            className={`knowledge-tab${tab === "history" ? " sel" : ""}`}
            data-testid="knowledge-tab-history"
            onClick={() => setTab("history")}
          >
            History
          </button>
        </div>
        {tab === "corpora" && (
          <p className="knowledge-view-hint">
            Indexed folders the agent can search via{" "}
            <code>search_project_knowledge</code>. Drop in code, docs — and now
            PDFs. With Ollama&apos;s <code>nomic-embed-text</code> installed,
            indexing upgrades to semantic embeddings automatically.
          </p>
        )}
      </header>
      <div className="knowledge-view-body">
        <Suspense fallback={null}>
          {tab === "corpora" ? <RagPanel /> : <HistorySearch />}
        </Suspense>
      </div>
    </div>
  );
}
