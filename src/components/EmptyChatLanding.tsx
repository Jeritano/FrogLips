import { lazy, Suspense, useEffect, useState } from "react";
import { BookOpen, Download, Terminal, Users, Zap } from "lucide-react";
import { api } from "../lib/tauri-api";

/*
 * Workstation launchpad (product review 2026-06-10, onboarding #7). The
 * surface every user stares at most in week one previously sold none of the
 * product — four plain-chat chips, one of which ("Summarize the README") was
 * an agent prompt that hallucinated in plain chat. Now: one action card per
 * pillar (Agent / Flows / Table / Knowledge) plus honest plain-chat starters.
 *
 * Zero-model landing (2026-06-11): with NO local models installed every lane
 * card dead-ends (nothing can answer), so the card grid collapses to a single
 * "Download a starter model" card that opens the model browser in place —
 * same lazy-mount pattern as ModelPicker, so the heavy browser chunk only
 * loads on click.
 *
 * Navigation uses a window CustomEvent (`froglips:navigate`) because this
 * component renders deep inside ChatWindow, which doesn't own the view
 * state — same pattern as `chat-input:prefill`.
 */

// Same lazy-load rationale as ModelPicker: keep the browser's tabs + fetchers
// out of the first-paint chunk.
const ModelBrowser = lazy(() =>
  import("./ModelBrowser").then((m) => ({ default: m.ModelBrowser })),
);

const PLAIN_PROMPTS: { title: string; text: string }[] = [
  {
    title: "Explain a concept",
    text: "Explain how async/await works in JavaScript, with a small example.",
  },
  {
    title: "Draft something",
    text: "Draft a concise commit message for a bug fix in the login flow.",
  },
  { title: "Debug an error", text: "Help me debug this error: " },
];

const AGENT_PROMPT = "Summarize the README in this repo.";

function prefill(text: string) {
  window.dispatchEvent(
    new CustomEvent("chat-input:prefill", { detail: { text } }),
  );
}

function navigate(view: string) {
  window.dispatchEvent(
    new CustomEvent("froglips:navigate", { detail: { view } }),
  );
}

export function EmptyChatLanding({
  modelReady = true,
}: {
  modelReady?: boolean;
}) {
  // True only when we POSITIVELY confirmed zero installed models — default
  // false so users with models never see a flash of the download card. Only
  // probed when no model is running (a running model proves one exists, and
  // `listAllModels` shells out to `ollama list`, which is not free).
  const [noModels, setNoModels] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);
  useEffect(() => {
    if (modelReady) {
      setNoModels(false);
      return;
    }
    let cancelled = false;
    api
      .listAllModels()
      .then((m) => {
        if (cancelled) return;
        setNoModels((m.mlx?.length ?? 0) + (m.ollama?.length ?? 0) === 0);
      })
      .catch(() => {
        // Probe failure → keep the lane cards; worst case is the old landing.
      });
    return () => {
      cancelled = true;
    };
  }, [modelReady]);

  if (noModels) {
    return (
      <div className="empty-chat-landing" data-testid="empty-chat-landing">
        <div className="empty-chat-heading">Your local-LLM workstation</div>
        <div className="empty-chat-sub">
          No local models installed yet — grab a starter and everything below
          unlocks.
        </div>

        <div className="launchpad-cards">
          <button
            type="button"
            className="launchpad-card"
            data-testid="launchpad-download-model"
            onClick={() => setBrowserOpen(true)}
          >
            <span className="launchpad-icon">
              <Download size={18} />
            </span>
            <span className="launchpad-title">Download a starter model</span>
            <span className="launchpad-desc">
              Browse the curated library and pull one sized for this Mac — a
              small starter is a ~2 GB download.
            </span>
          </button>
        </div>
        <div className="empty-chat-pointer">
          <strong>⌘K</strong> opens the command palette from anywhere.
        </div>

        {browserOpen && (
          <Suspense
            fallback={
              <div className="lazy-loading">Loading model browser…</div>
            }
          >
            <ModelBrowser
              onClose={() => setBrowserOpen(false)}
              onPulled={() => {
                // A pull means a model now exists — swap straight back to the
                // lane cards (the top-bar picker re-lists on focus).
                setNoModels(false);
                setBrowserOpen(false);
              }}
            />
          </Suspense>
        )}
      </div>
    );
  }

  return (
    <div className="empty-chat-landing" data-testid="empty-chat-landing">
      <div className="empty-chat-heading">Your local-LLM workstation</div>
      <div className="empty-chat-sub">
        {modelReady
          ? "Everything below runs on this machine. Pick a lane:"
          : "First, pick a model in the top bar and press Start — then pick a lane:"}
      </div>

      <div className="launchpad-cards">
        <button
          type="button"
          className="launchpad-card"
          data-testid="launchpad-agent"
          onClick={() => {
            // Same handoff the setup wizard uses: prefill the tool prompt,
            // arm agent mode (flips on when the backend reports capable,
            // prompts for a workspace if none is set).
            prefill(AGENT_PROMPT);
            window.dispatchEvent(
              new CustomEvent("chat-window:agent-first-run"),
            );
          }}
        >
          <span className="launchpad-icon">
            <Terminal size={18} />
          </span>
          <span className="launchpad-title">Run an agent task</span>
          <span className="launchpad-desc">
            46 tools on your files, shell and web — every risky call confirmed.
          </span>
        </button>
        <button
          type="button"
          className="launchpad-card"
          data-testid="launchpad-flows"
          onClick={() => navigate("workflows")}
        >
          <span className="launchpad-icon">
            <Zap size={18} />
          </span>
          <span className="launchpad-title">Build a Flow</span>
          <span className="launchpad-desc">
            Chain models with MoA, critic loops and cascades — small models,
            punching up.
          </span>
        </button>
        <button
          type="button"
          className="launchpad-card"
          data-testid="launchpad-table"
          onClick={() => navigate("roundtable")}
        >
          <span className="launchpad-icon">
            <Users size={18} />
          </span>
          <span className="launchpad-title">Open the Table</span>
          <span className="launchpad-desc">
            Seat several models for a debate, brainstorm or interview.
          </span>
        </button>
        <button
          type="button"
          className="launchpad-card"
          data-testid="launchpad-knowledge"
          onClick={() => navigate("knowledge")}
        >
          <span className="launchpad-icon">
            <BookOpen size={18} />
          </span>
          <span className="launchpad-title">Search your knowledge</span>
          <span className="launchpad-desc">
            Index folders for retrieval and manage what the app remembers.
          </span>
        </button>
      </div>

      <div className="empty-chat-chips">
        {PLAIN_PROMPTS.map((p) => (
          <button
            key={p.title}
            type="button"
            className="empty-chat-chip"
            data-testid="empty-chat-chip"
            onClick={() => prefill(p.text)}
            title={p.text}
          >
            {p.title}
          </button>
        ))}
      </div>
      <div className="empty-chat-pointer">
        <strong>⌘K</strong> opens the command palette from anywhere.
      </div>
    </div>
  );
}
