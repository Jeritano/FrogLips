import { useCallback, useEffect, useRef, useState } from "react";
import {
  MessageSquare,
  Cpu,
  Terminal,
  Zap,
  BookOpen,
  X,
} from "lucide-react";
import { useModalA11y } from "../lib/use-modal-a11y";
import { Button } from "./ui";

/*
 * First-run guided tour (W5B). A short, skippable overlay that introduces the
 * five pillars (Chat, model picker, Agent, Flows, Knowledge) beyond the single
 * Cmd+K hint on the empty-chat landing.
 *
 * Discoverability gate:
 *   - Shown ONCE for a fresh user, gated on the `froglips.tourSeen` localStorage
 *     flag — deliberately NOT `setup_complete` (the wizard is a separate flow).
 *   - A returning user (flag already set) NEVER sees it auto-open. Existing
 *     installs whose flag is absent would normally qualify, so App seeds the
 *     flag for them on first mount (see the App.tsx wiring note in the group
 *     summary) — the tour is for genuinely-new users only.
 *
 * Re-trigger: a `froglips:start-tour` window CustomEvent re-opens it on demand,
 * fired by the "Take a tour" command-palette action and the EmptyChatLanding
 * link. Same window-event pattern as `froglips:navigate` / `chat-input:prefill`.
 *
 * Non-blocking: it's a centered card (no spotlight cut-out that could pin the
 * UI), dismissable with Esc / the × / Skip / clicking the backdrop, and it
 * marks itself seen the moment it closes by any path, so it can't nag.
 */

const TOUR_SEEN_KEY = "froglips.tourSeen";

/** Event that (re-)opens the tour from anywhere. */
export const START_TOUR_EVENT = "froglips:start-tour";

/** Imperative re-trigger used by CommandPalette + EmptyChatLanding. */
export function startFirstRunTour() {
  window.dispatchEvent(new CustomEvent(START_TOUR_EVENT));
}

/** True once the user has seen (or skipped) the tour. Read defensively — a
 *  blocked localStorage (private mode) reports "seen" so we never loop the
 *  overlay on a user who can't persist the flag. */
function tourSeen(): boolean {
  try {
    return localStorage.getItem(TOUR_SEEN_KEY) === "true";
  } catch {
    return true;
  }
}

function markTourSeen() {
  try {
    localStorage.setItem(TOUR_SEEN_KEY, "true");
  } catch {
    /* private mode / quota — the in-memory state still hides it this session */
  }
}

interface Step {
  icon: React.ReactNode;
  title: string;
  body: string;
}

const STEPS: Step[] = [
  {
    icon: <MessageSquare size={22} />,
    title: "Chat runs on your Mac",
    body: "Type anything in the composer below. Every token is generated locally — nothing leaves this machine.",
  },
  {
    icon: <Cpu size={22} />,
    title: "Pick a model up top",
    body: "The model picker in the top bar is where you choose and start a model. Press ⌘L any time to browse and download more.",
  },
  {
    icon: <Terminal size={22} />,
    title: "Agent mode = real tools",
    body: "Flip on Agent in the chat toolbar to let the model read files, run the shell and search the web — every risky step asks first.",
  },
  {
    icon: <Zap size={22} />,
    title: "Flows chain models together",
    body: "Open Flows from the sidebar to wire models into critic loops, mixtures and cascades — small local models, punching up.",
  },
  {
    icon: <BookOpen size={22} />,
    title: "Knowledge remembers",
    body: "Index folders for retrieval and manage what the app remembers in Knowledge. Press ⌘K for the command palette from anywhere.",
  },
];

export function FirstRunTour() {
  // `undefined` until the first-run check resolves so nothing flashes; then a
  // concrete boolean drives mount. Auto-open only for a genuinely-fresh user.
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const ref = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    markTourSeen();
  }, []);

  useModalA11y({ open, onClose: close, containerRef: ref });

  // Auto-open once for a fresh user. A returning user (flag set) is skipped.
  useEffect(() => {
    if (!tourSeen()) {
      setStep(0);
      setOpen(true);
    }
  }, []);

  // Re-trigger from the command palette / landing link. Always resets to the
  // first step and opens, even for a user who's already seen it.
  useEffect(() => {
    const handler = () => {
      setStep(0);
      setOpen(true);
    };
    window.addEventListener(START_TOUR_EVENT, handler);
    return () => window.removeEventListener(START_TOUR_EVENT, handler);
  }, []);

  if (!open) return null;

  const isLast = step >= STEPS.length - 1;
  const s = STEPS[step];

  return (
    <div
      className="tour-overlay"
      data-testid="first-run-tour"
      role="dialog"
      aria-modal="true"
      aria-label="Welcome tour"
      onClick={(e) => {
        // Click on the dimmed backdrop (not the card) dismisses — it's a tour,
        // not a gate.
        if (e.target === e.currentTarget) close();
      }}
    >
      <div ref={ref} className="tour-card">
        <div className="tour-card-head">
          <span className="tour-icon" aria-hidden="true">
            {s.icon}
          </span>
          <button
            type="button"
            className="tour-close"
            data-testid="tour-skip"
            aria-label="Skip tour"
            onClick={close}
          >
            <X size={16} />
          </button>
        </div>

        <h2 className="tour-title">{s.title}</h2>
        <p className="tour-body">{s.body}</p>

        {/* Step dots — current step highlighted; click to jump. */}
        <div className="tour-dots" aria-hidden="true">
          {STEPS.map((_, i) => (
            <button
              key={i}
              type="button"
              tabIndex={-1}
              className={`tour-dot${i === step ? " active" : ""}`}
              onClick={() => setStep(i)}
            />
          ))}
        </div>

        <div className="tour-actions">
          <button
            type="button"
            className="tour-skip-text"
            data-testid="tour-skip-text"
            onClick={close}
          >
            Skip
          </button>
          <div className="tour-actions-right">
            {step > 0 && (
              <Button
                variant="secondary"
                size="sm"
                data-testid="tour-back"
                onClick={() => setStep((v) => Math.max(0, v - 1))}
              >
                Back
              </Button>
            )}
            <Button
              variant="primary"
              size="sm"
              data-testid="tour-next"
              onClick={() => {
                if (isLast) close();
                else setStep((v) => Math.min(STEPS.length - 1, v + 1));
              }}
            >
              {isLast ? "Get started" : "Next"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
