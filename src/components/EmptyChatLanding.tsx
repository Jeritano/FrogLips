import { BookOpen, Terminal, Users, Zap } from "lucide-react";

/*
 * Workstation launchpad (product review 2026-06-10, onboarding #7). The
 * surface every user stares at most in week one previously sold none of the
 * product — four plain-chat chips, one of which ("Summarize the README") was
 * an agent prompt that hallucinated in plain chat. Now: one action card per
 * pillar (Agent / Flows / Table / Knowledge) plus honest plain-chat starters.
 *
 * Navigation uses a window CustomEvent (`froglips:navigate`) because this
 * component renders deep inside ChatWindow, which doesn't own the view
 * state — same pattern as `chat-input:prefill`.
 */

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
