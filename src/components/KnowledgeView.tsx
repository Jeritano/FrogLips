import { lazy, Suspense } from "react";

/**
 * Top-level view for the user's knowledge library (RAG corpora). Peer to
 * `WorkflowsPage` and `ImageView` — opens when the user clicks the
 * Knowledge entry in the sidebar Views group.
 *
 * Design research conclusion: every modern AI tool that supports
 * vectorised user knowledge surfaces it as a first-class top-level
 * concept (Claude.ai Projects, Cursor @docs, ChatGPT custom-GPT
 * knowledge). Burying it inside a chat-agent gear menu — where it
 * lived previously — broke discoverability: an agent would call
 * `search_project_knowledge` and the user had no obvious path to
 * stand up a corpus. Lifting RagPanel out of AgentSettingsPanel and
 * into this view fixes the access pattern: one sidebar click from
 * anywhere in the app, mirrors the Workflows / Images access model.
 *
 * RagPanel itself stays unchanged — this is purely a view-shell
 * around it with a header consistent with the other top-level views.
 */
const RagPanel = lazy(() =>
  import("./RagPanel").then((m) => ({ default: m.RagPanel })),
);

export function KnowledgeView() {
  return (
    <div className="knowledge-view" data-testid="knowledge-view">
      <header className="knowledge-view-header">
        <h2 className="knowledge-view-title">
          <span aria-hidden="true">📚</span> Knowledge
        </h2>
        <p className="knowledge-view-hint">
          Indexed folders the agent can search via{" "}
          <code>search_project_knowledge</code>. Add a corpus by pointing at a
          folder; the agent loop and any workflow that grants the tool can
          retrieve from it during a run.
        </p>
      </header>
      <div className="knowledge-view-body">
        {/* Audit L-F2: every other lazy panel in App.tsx uses
            `fallback={null}` to avoid a "Loading…" flash on first open.
            Match that convention here. */}
        <Suspense fallback={null}>
          <RagPanel />
        </Suspense>
      </div>
    </div>
  );
}
