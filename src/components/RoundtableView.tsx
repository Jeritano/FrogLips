import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Check,
  FileText,
  Play,
  RotateCcw,
  RotateCw,
  Save,
  Users,
  X,
} from "lucide-react";
import { EmptyState } from "./EmptyState";
import { api } from "../lib/tauri-api";
import { Button, Input, Spinner, Badge } from "./ui";
import { usePersistedState } from "../hooks/usePersistedState";
import { useRoundtableRun } from "../lib/roundtable/run-context";
import {
  parsePrice,
  formatUsd,
  type PriceTable,
  type SeatPrice,
} from "../lib/roundtable/cost";
import { renderMarkdown } from "../lib/markdown";
import { logDiag } from "../lib/diagnostics";
import type { RoundtableRunSummary } from "../types";
import type {
  RoundtableConfig,
  Seat,
  SeatBackend,
  MemoryMode,
  TurnControl,
  Turn,
  RoundtableTotals,
  RoundtableEndReason,
} from "../lib/roundtable/types";
import "../styles/roundtable.css";

// Cross-render markdown cache (perf, medium). The RtTurnBubble memo only holds
// while turn objects keep referential identity during a live run; discrete
// events (opening a saved outcome, view-switch/remount, theme toggle) drop that
// identity and would otherwise re-run the full marked → highlight.js → DOMPurify
// pipeline for every visible bubble. Keyed by the (immutable) content string so
// a completed turn's HTML is parsed once and reused thereafter, mirroring
// MessageList's `cachedMarkdown` (which is module-private there, so we keep a
// local twin rather than reach across files). FIFO eviction bounds it.
const RT_MARKDOWN_CACHE_MAX = 500;
const rtMarkdownCache = new Map<string, string>();
function rtCachedMarkdown(text: string): string {
  const hit = rtMarkdownCache.get(text);
  if (hit !== undefined) return hit;
  const rendered = renderMarkdown(text);
  if (rtMarkdownCache.size >= RT_MARKDOWN_CACHE_MAX) {
    const firstKey = rtMarkdownCache.keys().next().value;
    if (firstKey !== undefined) rtMarkdownCache.delete(firstKey);
  }
  rtMarkdownCache.set(text, rendered);
  return rendered;
}

/**
 * One transcript bubble. Memoized: done turns keep referential identity across
 * the 16ms delta flushes (the provider's flush map returns unchanged turns by
 * reference), so a completed bubble's markdown is parsed once, not re-parsed
 * ~60×/sec for every prior turn while a later turn streams.
 */
const RtTurnBubble = memo(function RtTurnBubble({ turn: t }: { turn: Turn }) {
  return (
    <div
      className={`rt-bubble rt-${t.kind}${t.status === "error" ? " rt-err" : ""}`}
      style={{ ["--seat" as string]: t.color }}
    >
      <div className="rt-bubble-head">
        <span className="rt-dot" /> {t.speaker}
        {t.status === "streaming" && (
          <span className="rt-typing"> · typing…</span>
        )}
        {t.status === "error" && (
          <span className="rt-typing"> · {t.error ?? "failed"}</span>
        )}
      </div>
      {t.status === "streaming" ? (
        <div className="rt-bubble-body rt-streaming">
          {t.text}
          <span className="rt-cursor">▍</span>
        </div>
      ) : (
        <div
          className="rt-bubble-body markdown"
          dangerouslySetInnerHTML={{ __html: rtCachedMarkdown(t.text) }}
        />
      )}
    </div>
  );
});

export const SEAT_COLORS = [
  "#22c55e",
  "#3b82f6",
  "#a855f7",
  "#f59e0b",
  "#ef4444",
  "#14b8a6",
];

/** A pickable model option, flattened across backends. */
interface ModelOption {
  key: string; // `${backend}::${model}`
  backend: SeatBackend;
  model: string;
  label: string;
  group: "OpenRouter" | "Custom backends" | "Ollama";
  price?: SeatPrice | null;
}

interface PersonaTemplate {
  name: string;
  system: string;
}
interface Preset {
  id: string;
  label: string;
  /** Gallery grouping chip (Debate / Create / Decide / Learn). */
  category: string;
  /** One-line gallery card summary. */
  summary: string;
  topic: string;
  personas: PersonaTemplate[];
  turnControl: TurnControl;
  maxRounds: number;
}

const PRESETS: Preset[] = [
  {
    id: "debate",
    label: "Debate",
    category: "Debate",
    summary: "Two sides argue a hard question and stress-test each other.",
    topic: "Should AGI development be paused? Argue your side.",
    turnControl: "round-robin",
    maxRounds: 4,
    personas: [
      {
        name: "The Optimist",
        system:
          "You argue the optimistic case. Push back hard on doom framing; cite upside and steerability.",
      },
      {
        name: "The Skeptic",
        system:
          "You argue the cautious case. Stress-test every optimistic claim; demand evidence and name failure modes.",
      },
    ],
  },
  {
    id: "brainstorm",
    label: "Brainstorm",
    category: "Create",
    summary: "Diverge wild then converge — ideas thrown out, then sharpened.",
    topic: "Generate and refine ideas for: ",
    turnControl: "round-robin",
    maxRounds: 3,
    personas: [
      {
        name: "The Generator",
        system:
          "Throw out bold, divergent ideas. Quantity over polish. Build on others.",
      },
      {
        name: "The Refiner",
        system:
          "Take the rawest idea on the table and sharpen it into something concrete and testable.",
      },
    ],
  },
  {
    id: "interview",
    label: "Interview",
    category: "Learn",
    summary:
      "A sharp interviewer draws an expert out, one probing question at a time.",
    topic: "Interview about: ",
    turnControl: "round-robin",
    maxRounds: 4,
    personas: [
      {
        name: "The Interviewer",
        system:
          "Ask one sharp, probing question per turn. Follow up on the last answer; never lecture.",
      },
      {
        name: "The Expert",
        system:
          "Answer concisely and concretely from deep expertise. One claim, well-supported, per turn.",
      },
    ],
  },
  {
    id: "devils",
    label: "Devil's advocate",
    category: "Decide",
    summary:
      "Propose a plan, then have it torn apart by a relentless adversary.",
    topic: "Propose a plan, then have it torn apart: ",
    turnControl: "round-robin",
    maxRounds: 4,
    personas: [
      {
        name: "The Proposer",
        system:
          "Make the strongest case for your plan and defend it under fire.",
      },
      {
        name: "The Adversary",
        system:
          "Find the fatal flaw. Attack assumptions, incentives, and second-order effects relentlessly.",
      },
    ],
  },
  {
    id: "worldbuilding",
    label: "Sci-fi worldbuilding",
    category: "Create",
    summary:
      "An architect, a historian, and a dissident invent a believable world.",
    topic: "Build a world where: ",
    turnControl: "round-robin",
    maxRounds: 4,
    personas: [
      {
        name: "The Architect",
        system:
          "Define the world's rules — physics, tech, society. Be concrete and internally consistent; one new system per turn.",
      },
      {
        name: "The Historian",
        system:
          "Invent this world's PAST — the war, the schism, the discovery that made it this way. Tie events to the Architect's rules.",
      },
      {
        name: "The Dissident",
        system:
          "Find the contradictions and the human cost. Who suffers under these rules? What breaks? Keep it honest, not utopian.",
      },
    ],
  },
  {
    id: "writers-room",
    label: "Writers' room",
    category: "Create",
    summary: "Showrunner, cynic, and heart break a story together.",
    topic: "Break a story about: ",
    turnControl: "round-robin",
    maxRounds: 4,
    personas: [
      {
        name: "The Showrunner",
        system:
          "Pitch the arc — beginning, turn, ending. Keep momentum; end each turn on a hook.",
      },
      {
        name: "The Cynic",
        system:
          "Kill the clichés. Name the trope, then twist it into something fresher. Be ruthless about the obvious.",
      },
      {
        name: "The Heart",
        system:
          "Guard the emotional truth. Why does this matter to the character? Keep the stakes human.",
      },
    ],
  },
  {
    id: "startup-panel",
    label: "Startup pitch panel",
    category: "Decide",
    summary: "Founder pitches; a VC and a real user pressure-test it.",
    topic: "Pitch and pressure-test: ",
    turnControl: "round-robin",
    maxRounds: 4,
    personas: [
      {
        name: "The Founder",
        system:
          "Pitch the vision and defend it. Concrete on what you build, for whom, and why now.",
      },
      {
        name: "The VC",
        system:
          "Grill the unit economics, moat, and go-to-market. Ask the one question that kills weak startups.",
      },
      {
        name: "The User",
        system:
          "You're the target customer. Would you actually use + pay for this? Be honest about your real alternatives.",
      },
    ],
  },
  {
    id: "decision-council",
    label: "Decision council",
    category: "Decide",
    summary:
      "Pragmatist, visionary, and realist weigh a real decision you face.",
    topic: "Help me decide: ",
    turnControl: "round-robin",
    maxRounds: 3,
    personas: [
      {
        name: "The Pragmatist",
        system:
          "Optimize for what works now with least risk. Name the cheapest reversible next step.",
      },
      {
        name: "The Visionary",
        system:
          "Argue for the boldest long-game option. What does the best possible outcome look like, and what's the path?",
      },
      {
        name: "The Realist",
        system:
          "Weigh both against constraints — time, money, energy. Force a recommendation with its tradeoff stated.",
      },
    ],
  },
  {
    id: "socratic",
    label: "Socratic tutor",
    category: "Learn",
    summary: "A tutor teaches only by questions; a student reasons aloud.",
    topic: "Teach me: ",
    turnControl: "round-robin",
    maxRounds: 5,
    personas: [
      {
        name: "The Tutor",
        system:
          "Never lecture. Lead with ONE question that exposes the next gap in understanding. Build on the student's last answer.",
      },
      {
        name: "The Student",
        system:
          "Reason out loud. Attempt each question honestly, show your work, and admit what you're unsure of.",
      },
    ],
  },
  {
    id: "comedy",
    label: "Comedy writers",
    category: "Create",
    summary:
      "A setup, a punchline, and a heckler riff until it's actually funny.",
    topic: "Riff on: ",
    turnControl: "round-robin",
    maxRounds: 3,
    personas: [
      {
        name: "The Setup",
        system:
          "Find the funny premise and the straight-faced framing. Hand the next seat a clean runway.",
      },
      {
        name: "The Punchline",
        system:
          "Land the joke — surprise + truth. Shortest version that hits. No explaining it.",
      },
      {
        name: "The Heckler",
        system:
          "If a bit isn't landing, say so and twist it harder. Push for the better, weirder angle.",
      },
    ],
  },
];

/** A configurable seat in the setup form (model split out from Seat for the UI). */
interface DraftSeat {
  id: string;
  name: string;
  color: string;
  optionKey: string; // ModelOption.key, or "" if unset
  system: string;
  temperature: number;
}

let seatCounter = 0;
export function newSeat(persona?: PersonaTemplate): DraftSeat {
  // Read the index ONCE — the old code post-incremented in the id but then read
  // the already-incremented counter for name + color, shifting both by one.
  const i = seatCounter++;
  return {
    id: `s${i}-${Date.now()}`,
    name: persona?.name ?? `Seat ${i + 1}`,
    color: SEAT_COLORS[i % SEAT_COLORS.length],
    optionKey: "",
    system: persona?.system ?? "",
    temperature: 0.8,
  };
}

export function isDraftSeatArray(v: unknown): v is DraftSeat[] {
  return (
    Array.isArray(v) &&
    v.every((s) => s && typeof s === "object" && "id" in s && "optionKey" in s)
  );
}

/** A user-saved roundtable config (a reusable template, persisted locally). */
interface SavedTable {
  id: string;
  name: string;
  seats: DraftSeat[];
  topic: string;
  memoryMode: MemoryMode;
  maxRounds: number;
  maxUsd: number;
}
export function isSavedTableArray(v: unknown): v is SavedTable[] {
  return (
    Array.isArray(v) &&
    v.every(
      (t) =>
        t &&
        typeof t === "object" &&
        "id" in t &&
        "name" in t &&
        "seats" in t &&
        Array.isArray((t as SavedTable).seats),
    )
  );
}

// Short-lived module-level cache for the picker's model list — a fetch-dedupe
// across quick remounts (settings IPC + OpenRouter catalogue fetch). The 5-min
// TTL was to dodge a per-mount macOS Keychain prompt, but keys now live in a
// local secrets file (no prompt), so a tight 30s TTL is enough to dedupe rapid
// remounts while keeping the list fresh after a Settings change.
let cachedOptions: ModelOption[] | null = null;
let cachedOptionsAt = 0;
const OPTIONS_TTL_MS = 30 * 1000;

/** Ollama Cloud models (`…:cloud` / `…-cloud`) run remotely on ollama.com —
 *  they don't occupy local VRAM. */
function isCloudOllama(model: string | undefined): boolean {
  return !!model && (model.includes(":cloud") || model.endsWith("-cloud"));
}
/** A genuinely LOCAL Ollama seat that reloads between turns. Excludes Ollama
 *  Cloud, which is served remotely and never reloads — so it must NOT trigger
 *  the "2+ local models reload each turn" warning/gate. */
function isLocalReloading(
  backend: SeatBackend | undefined,
  model: string | undefined,
): boolean {
  return backend === "ollama" && !isCloudOllama(model);
}

/**
 * The blob stored per saved outcome. `editor` is the snapshot needed to re-run
 * (seats/topic/settings); `run` is the result (transcript + totals) for display
 * and file export. Versioned so a future shape change can be detected.
 */
interface OutcomePayload {
  v: 1;
  editor: {
    seats: DraftSeat[];
    topic: string;
    memoryMode: MemoryMode;
    maxRounds: number;
    maxUsd: number;
  };
  run: {
    config: RoundtableConfig | null;
    turns: Turn[];
    totals: RoundtableTotals;
    endReason: RoundtableEndReason | null;
    completedAt: number;
  };
}

/** Module-level dedupe: a run's `completedAt` we've already persisted. Survives
 *  component remounts (navigating away + back) so an outcome is saved exactly
 *  once; a full app reload clears the run-context too, so resetting to 0 here
 *  on reload is correct. */
let lastSavedOutcomeAt = 0;

/** Render a completed roundtable as a Markdown document for file export. */
function outcomeToMarkdown(
  topic: string,
  turns: Turn[],
  totals: RoundtableTotals,
): string {
  const head =
    `# Roundtable — ${topic}\n\n` +
    `_${turns.filter((t) => t.status === "done").length} turns · ` +
    `${(totals.tokensIn + totals.tokensOut).toLocaleString()} tokens · ` +
    `${formatUsd(totals.usd)}${totals.usdPartial ? "+" : ""}_\n\n---\n\n`;
  const body = turns
    .filter((t) => t.status === "done")
    .map((t) => `**${t.speaker}:**\n\n${t.text}`)
    .join("\n\n---\n\n");
  return head + body + "\n";
}

export function RoundtableView() {
  const run = useRoundtableRun();
  const [options, setOptions] = useState<ModelOption[]>(
    () => cachedOptions ?? [],
  );
  const [loadingModels, setLoadingModels] = useState(true);
  const [modelErr, setModelErr] = useState<string | null>(null);

  const [seats, setSeats] = usePersistedState<DraftSeat[]>(
    "roundtable.seats",
    [newSeat(PRESETS[0].personas[0]), newSeat(PRESETS[0].personas[1])],
    isDraftSeatArray,
  );
  const [topic, setTopic] = usePersistedState<string>(
    "roundtable.topic",
    PRESETS[0].topic,
  );
  const [turnControl] = useState<TurnControl>("round-robin");
  const [memoryMode, setMemoryMode] = usePersistedState<MemoryMode>(
    "roundtable.memory",
    "recent",
  );
  const [maxRounds, setMaxRounds] = usePersistedState<number>(
    "roundtable.rounds",
    4,
    (v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 1,
  );
  const [maxUsd, setMaxUsd] = usePersistedState<number>(
    "roundtable.maxusd",
    0.5,
    (v): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0,
  );
  const [confirmLocal, setConfirmLocal] = useState(false);
  // Re-arm the 2-local-models confirm whenever the seat set changes, so a
  // user who edited the config gets warned again instead of starting a
  // different bad config on the first click.
  useEffect(() => setConfirmLocal(false), [seats]);

  // Portal target in the App header — lets the Roundtable header (title +
  // presets/Reset, or the live meter/actions) share the theme-toggle's row.
  const [topbarSlot, setTopbarSlot] = useState<HTMLElement | null>(null);
  useEffect(
    () => setTopbarSlot(document.getElementById("roundtable-topbar-slot")),
    [],
  );

  // First-open demo outcome (product review 2026-06-10, onboarding #3): the
  // outcomes list started empty, so the payoff of a finished multi-model
  // debate was invisible until the user designed one themselves. Seed one
  // canned transcript exactly once (clearly labeled as a sample), only when
  // there are no real outcomes to drown out.
  useEffect(() => {
    if (localStorage.getItem("froglips.demoTableSeeded")) return;
    void (async () => {
      try {
        const existing = await api.roundtableRunList(null);
        if (existing.length > 0) {
          localStorage.setItem("froglips.demoTableSeeded", "1");
          return;
        }
        const topic =
          "Can small local models replace cloud APIs for daily work?";
        const mk = (
          i: number,
          seatId: string,
          speaker: string,
          color: string,
          round: number,
          text: string,
        ) => ({
          id: `demo-${i}`,
          seatId,
          speaker,
          color,
          text,
          status: "done" as const,
          round,
          kind: "seat" as const,
        });
        const turns = [
          mk(
            1,
            "s-opt",
            "The Optimist",
            SEAT_COLORS[0],
            0,
            "For 80% of daily work — summarize, draft, rename, triage — a 3B on this Mac answers in under a second, offline, for free. The cloud is paying rent for capability you rarely need.",
          ),
          mk(
            2,
            "s-skep",
            "The Skeptic",
            SEAT_COLORS[1],
            0,
            "Until the 20% shows up: a gnarly refactor, a long legal doc, anything multi-step. Small models drop the thread. The question isn't *can* they answer — it's whether you can trust the answer without checking it.",
          ),
          mk(
            3,
            "s-opt",
            "The Optimist",
            SEAT_COLORS[0],
            1,
            "That's what orchestration is for. Run the 3B three times and majority-vote, or have a critic pass review the draft. Scaffolding buys back most of the gap — and it's exactly what Flows automates.",
          ),
          mk(
            4,
            "s-skep",
            "The Skeptic",
            SEAT_COLORS[1],
            1,
            "Fair — mixture-of-agents on small models genuinely surprises me. I'll concede daily-driver status if the router is smart enough to escalate the hard 20% to a bigger model without me noticing.",
          ),
          mk(
            5,
            "s-opt",
            "The Optimist",
            SEAT_COLORS[0],
            2,
            "Then we agree: local-first, escalate-rarely. The default should live on your machine; the cloud should be the exception you opt into — not the tollbooth you start at.",
          ),
        ];
        const payload = {
          v: 1,
          editor: {
            seats: [],
            topic,
            memoryMode: "full" as MemoryMode,
            maxRounds: 3,
            maxUsd: 0,
          },
          run: {
            config: null,
            turns,
            totals: {
              turns: turns.length,
              tokensIn: 0,
              tokensOut: 0,
              usd: 0,
              usdPartial: false,
            },
            endReason: null,
            completedAt: 1, // sentinel — clearly not a real wall-clock run
          },
        };
        await api.roundtableRunSave(
          null,
          "Sample — two models debate local vs cloud (delete me)",
          topic,
          turns.length,
          JSON.stringify(payload),
        );
        localStorage.setItem("froglips.demoTableSeeded", "1");
      } catch (e) {
        logDiag({
          level: "info",
          source: "roundtable",
          message: "demo outcome seed skipped",
          detail: e,
        });
      }
    })();
  }, []);
  const [setupErr, setSetupErr] = useState<string | null>(null);
  const [injectText, setInjectText] = useState("");

  // Saved-table library: name + save the current config, load any saved one
  // to tinker later, keep multiple. Persisted locally.
  const [savedTables, setSavedTables] = usePersistedState<SavedTable[]>(
    "roundtable.saved",
    [],
    isSavedTableArray,
  );
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [saveName, setSaveName] = useState("");
  // false = list landing (saved roundtables); true = config editor.
  const [editing, setEditing] = useState(false);
  // Saved outcomes for the open table (Stage 2 run history).
  const [outcomes, setOutcomes] = useState<RoundtableRunSummary[]>([]);
  const [showOutcomes, setShowOutcomes] = useState(false);
  // A reopened outcome (read-only transcript viewer); null = not viewing one.
  const [viewing, setViewing] = useState<{
    meta: RoundtableRunSummary;
    payload: OutcomePayload;
  } | null>(null);
  // Transient "Saved to <path>" / error note for the file-export action.
  const [fileMsg, setFileMsg] = useState<string | null>(null);

  // One-time import: if no saved tables exist yet but a non-empty draft does
  // (older single-draft persistence), seed it as a saved table so the user's
  // in-progress config isn't stranded by the new list UI.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    if (savedTables.length === 0 && seats.length >= 2) {
      setSavedTables([
        {
          id: `rt${Date.now()}`,
          name: "My roundtable",
          seats,
          topic,
          memoryMode,
          maxRounds,
          maxUsd,
        },
      ]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // While editing, auto-save the config back into its saved entry. Debounced
  // (perf, low): the seat-name / persona / topic inputs change `seats`/`topic`
  // on EVERY keystroke, so an un-debounced write-back rebuilt the whole
  // savedTables array AND re-serialized the full blob to localStorage per
  // character. Coalesce to one write ~400ms after the user pauses, mirroring
  // WorkflowsPage's `saveTimer` pattern.
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirror the latest savedTables so the unmount-only flush can compute + write
  // the final array directly (the usePersistedState write-back effect won't run
  // once the component is unmounting).
  const savedTablesRef = useRef(savedTables);
  savedTablesRef.current = savedTables;
  // The newest queued write. Kept in a ref so the unmount-only flush below can
  // persist a pause-less edit (typed then navigated away) without dropping it —
  // re-run cleanups must NOT flush, or every keystroke would write and the
  // debounce would do nothing. `direct` writes localStorage itself, for the
  // unmount path where the hook's effect can no longer fire.
  const pendingSavePersist = useRef<((direct: boolean) => void) | null>(null);
  useEffect(() => {
    if (!editing || !loadedId) return;
    // Capture the current snapshot so the deferred write persists what the user
    // had typed when this effect ran, not whatever state exists at fire time.
    const snapshot = {
      name: saveName.trim(),
      seats,
      topic,
      memoryMode,
      maxRounds,
      maxUsd,
    };
    const apply = (cur: SavedTable[]) =>
      cur.map((t) =>
        t.id === loadedId
          ? {
              ...t,
              name: snapshot.name || t.name,
              seats: snapshot.seats,
              topic: snapshot.topic,
              memoryMode: snapshot.memoryMode,
              maxRounds: snapshot.maxRounds,
              maxUsd: snapshot.maxUsd,
            }
          : t,
      );
    const flush = (direct: boolean) => {
      autoSaveTimer.current = null;
      pendingSavePersist.current = null;
      if (direct) {
        // Unmount path: setState won't reach localStorage via the hook, so
        // write the computed array straight to the persisted slot.
        const next = apply(savedTablesRef.current);
        try {
          localStorage.setItem("roundtable.saved", JSON.stringify(next));
        } catch {
          /* quota / unavailable — best-effort, mirrors usePersistedState */
        }
        return;
      }
      setSavedTables(apply);
    };
    pendingSavePersist.current = flush;
    autoSaveTimer.current = setTimeout(() => flush(false), 400);
    // Re-run cleanup only cancels the pending timer; it does NOT flush, since a
    // newer keystroke is about to schedule a fresher write. The final flush is
    // handled by the unmount-only effect below.
    return () => {
      if (autoSaveTimer.current) {
        clearTimeout(autoSaveTimer.current);
        autoSaveTimer.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    editing,
    loadedId,
    saveName,
    seats,
    topic,
    memoryMode,
    maxRounds,
    maxUsd,
  ]);
  // Unmount-only: flush any write the user queued then navigated away from
  // before the 400ms debounce fired, so the last edit is never lost.
  useEffect(
    () => () => {
      pendingSavePersist.current?.(true);
    },
    [],
  );

  const loadTable = useCallback(
    (id: string) => {
      const t = savedTables.find((x) => x.id === id);
      if (!t) return;
      setSeats(t.seats.map((s) => ({ ...s }))); // copy so edits don't mutate the saved one
      setTopic(t.topic);
      setMemoryMode(t.memoryMode);
      setMaxRounds(t.maxRounds);
      setMaxUsd(t.maxUsd);
      setLoadedId(t.id);
      setSaveName(t.name);
      setConfirmLocal(false);
      setSetupErr(null);
    },
    [savedTables, setSeats, setTopic, setMemoryMode, setMaxRounds, setMaxUsd],
  );

  const deleteTable = useCallback(
    (id: string) => {
      setSavedTables((cur) => cur.filter((t) => t.id !== id));
      if (loadedId === id) {
        setLoadedId(null);
        setSaveName("");
      }
    },
    [loadedId, setSavedTables],
  );

  // Create a fresh roundtable (default config), register it, and open the editor.
  const newRoundtable = useCallback(() => {
    const seats0 = [
      newSeat(PRESETS[0].personas[0]),
      newSeat(PRESETS[0].personas[1]),
    ];
    const id = `rt${Date.now()}`;
    setSavedTables((cur) => [
      ...cur,
      {
        id,
        name: "Untitled roundtable",
        seats: seats0,
        topic: PRESETS[0].topic,
        memoryMode: "recent",
        maxRounds: 4,
        maxUsd: 0.5,
      },
    ]);
    setSeats(seats0);
    setTopic(PRESETS[0].topic);
    setMemoryMode("recent");
    setMaxRounds(4);
    setMaxUsd(0.5);
    setLoadedId(id);
    setSaveName("Untitled roundtable");
    setConfirmLocal(false);
    setSetupErr(null);
    setEditing(true);
  }, [
    setSavedTables,
    setSeats,
    setTopic,
    setMemoryMode,
    setMaxRounds,
    setMaxUsd,
  ]);

  // Create a new roundtable seeded from a template (personas + topic + rounds),
  // register it, and open the editor so the user assigns models + hits Start.
  const createFromPreset = useCallback(
    (p: Preset) => {
      const seats0 = p.personas.map((persona) => newSeat(persona));
      const id = `rt${Date.now()}`;
      setSavedTables((cur) => [
        ...cur,
        {
          id,
          name: p.label,
          seats: seats0,
          topic: p.topic,
          memoryMode: "recent",
          maxRounds: p.maxRounds,
          maxUsd: 0.5,
        },
      ]);
      setSeats(seats0);
      setTopic(p.topic);
      setMemoryMode("recent");
      setMaxRounds(p.maxRounds);
      setMaxUsd(0.5);
      setLoadedId(id);
      setSaveName(p.label);
      setConfirmLocal(false);
      setSetupErr(null);
      setEditing(true);
    },
    [
      setSavedTables,
      setSeats,
      setTopic,
      setMemoryMode,
      setMaxRounds,
      setMaxUsd,
    ],
  );

  const openTable = useCallback(
    (id: string) => {
      loadTable(id);
      setEditing(true);
    },
    [loadTable],
  );

  // ── Outcomes (Stage 1-2): persist a finished run + load a table's history ──

  const refreshOutcomes = useCallback((tableId: string | null) => {
    api
      .roundtableRunList(tableId)
      .then(setOutcomes)
      .catch((e) =>
        logDiag({
          level: "warn",
          source: "roundtable",
          message: "list outcomes failed",
          detail: e,
        }),
      );
  }, []);

  // Auto-save the outcome when a run finishes. `run.completedAt` flips once per
  // run (set in the provider's finally); the module-level guard makes it
  // exactly-once even across navigate-away-and-back remounts.
  useEffect(() => {
    const at = run.completedAt;
    if (!at || run.running || run.turns.length === 0) return;
    if (lastSavedOutcomeAt === at) return;
    lastSavedOutcomeAt = at;
    const topicStr = run.config?.topic ?? topic;
    const when = new Date(at).toLocaleString();
    const name = `${(topicStr || "Roundtable").slice(0, 60)} · ${when}`;
    const payload: OutcomePayload = {
      v: 1,
      editor: { seats, topic, memoryMode, maxRounds, maxUsd },
      run: {
        config: run.config,
        turns: run.turns,
        totals: run.totals,
        endReason: run.endReason,
        completedAt: at,
      },
    };
    api
      .roundtableRunSave(
        loadedId,
        name,
        topicStr,
        run.turns.length,
        JSON.stringify(payload),
      )
      .then(() => {
        if (loadedId) refreshOutcomes(loadedId);
      })
      .catch((e) => {
        // Do NOT reset the dedupe guard here: the IPC may have committed the
        // row before reporting failure (e.g. a post-write timeout), so a retry
        // on the next dep change / remount could duplicate the outcome. Stay
        // at-most-once; the run is still in-memory + can be saved to file or
        // re-run if this auto-save genuinely failed.
        logDiag({
          level: "error",
          source: "roundtable",
          message: "save outcome failed",
          detail: e,
        });
      });
  }, [
    run.completedAt,
    run.running,
    run.turns,
    run.config,
    run.totals,
    run.endReason,
    loadedId,
    topic,
    seats,
    memoryMode,
    maxRounds,
    maxUsd,
    refreshOutcomes,
  ]);

  // Load a table's saved outcomes when its editor opens.
  useEffect(() => {
    if (editing && loadedId) refreshOutcomes(loadedId);
  }, [editing, loadedId, refreshOutcomes]);

  // Open one saved outcome into the read-only viewer.
  const openOutcome = useCallback((id: number) => {
    api
      .roundtableRunGet(id)
      .then((row) => {
        let payload: OutcomePayload;
        try {
          payload = JSON.parse(row.transcript_json) as OutcomePayload;
        } catch {
          setFileMsg("Could not read that outcome (corrupt data).");
          return;
        }
        setViewing({ meta: row, payload });
        setShowOutcomes(false);
      })
      .catch((e) =>
        logDiag({
          level: "warn",
          source: "roundtable",
          message: "open outcome failed",
          detail: e,
        }),
      );
  }, []);

  const deleteOutcome = useCallback(
    (id: number) => {
      api
        .roundtableRunDelete(id)
        .then(() => {
          if (loadedId) refreshOutcomes(loadedId);
        })
        .catch((e) =>
          logDiag({
            level: "warn",
            source: "roundtable",
            message: "delete outcome failed",
            detail: e,
          }),
        );
    },
    [loadedId, refreshOutcomes],
  );

  // Restore a saved outcome's config into the editor so the user can re-run it.
  const runAgain = useCallback(
    (payload: OutcomePayload) => {
      const ed = payload.editor;
      setSeats(ed.seats.map((s) => ({ ...s })));
      setTopic(ed.topic);
      setMemoryMode(ed.memoryMode);
      setMaxRounds(ed.maxRounds);
      setMaxUsd(ed.maxUsd);
      setViewing(null);
      setShowOutcomes(false);
      setEditing(true);
    },
    [setSeats, setTopic, setMemoryMode, setMaxRounds, setMaxUsd],
  );

  // Save a transcript to a user-chosen file (Markdown or JSON). "Cloud" = just
  // pick a synced folder (iCloud Drive / Dropbox / …) in the dialog.
  const saveToFile = useCallback(
    async (topicStr: string, turns: Turn[], totals: RoundtableTotals) => {
      setFileMsg(null);
      let dest: string | null = null;
      try {
        const { save } = await import("@tauri-apps/plugin-dialog");
        const base =
          (topicStr || "roundtable")
            .replace(/[^a-z0-9._-]+/gi, "_")
            .slice(0, 50) || "roundtable";
        dest = await save({
          defaultPath: `${base}.md`,
          filters: [
            { name: "Markdown", extensions: ["md"] },
            { name: "JSON", extensions: ["json"] },
          ],
          title: "Save roundtable outcome",
        });
      } catch (e) {
        setFileMsg(
          `Save failed: ${e instanceof Error ? e.message : String(e)}`,
        );
        return;
      }
      if (!dest) return;
      const content = dest.toLowerCase().endsWith(".json")
        ? JSON.stringify({ topic: topicStr, totals, turns }, null, 2)
        : outcomeToMarkdown(topicStr, turns, totals);
      try {
        await api.roundtableSaveFile(dest, content);
        setFileMsg(`Saved to ${dest}`);
      } catch (e) {
        setFileMsg(
          `Save failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    },
    [],
  );

  // ── Load available models once (cloud-first: custom + OpenRouter + Ollama) ──
  useEffect(() => {
    // Reuse the cached list (avoids a Keychain prompt on every Table open).
    if (cachedOptions && Date.now() - cachedOptionsAt < OPTIONS_TTL_MS) {
      setOptions(cachedOptions);
      setLoadingModels(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoadingModels(true);
      const opts: ModelOption[] = [];
      try {
        const settings = await api.settingsGet().catch(() => null);
        for (const b of settings?.custom_backends ?? []) {
          opts.push({
            key: `custom::${b.id}`,
            backend: "custom",
            model: b.id,
            label: `${b.name} (${b.model})`,
            group: "Custom backends",
          });
        }
        const hasOr = await api.openrouterHasKey().catch(() => false);
        if (hasOr) {
          const ors = await api.openrouterListModels().catch(() => []);
          for (const m of ors) {
            opts.push({
              key: `openrouter::${m.id}`,
              backend: "openrouter",
              model: m.id,
              label: m.name || m.id,
              group: "OpenRouter",
              price: {
                inPerToken: parsePrice(m.prompt_price),
                outPerToken: parsePrice(m.completion_price),
              },
            });
          }
        }
        const all = await api.listAllModels().catch(() => null);
        for (const e of all?.ollama ?? []) {
          opts.push({
            key: `ollama::${e.id}`,
            backend: "ollama",
            model: e.id,
            label: e.id,
            group: "Ollama",
          });
        }
        if (!cancelled) {
          // Don't cache an empty/failed list — a transient backend hiccup would
          // otherwise pin the picker empty for the whole TTL even after the
          // backend recovers.
          if (opts.length > 0) {
            cachedOptions = opts;
            cachedOptionsAt = Date.now();
          }
          setOptions(opts);
          if (opts.length === 0)
            setModelErr(
              "No cloud or Ollama models found. Add a custom backend or an OpenRouter key in Settings.",
            );
        }
      } catch (e) {
        if (!cancelled) setModelErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoadingModels(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const optionByKey = useMemo(() => {
    const m = new Map<string, ModelOption>();
    for (const o of options) m.set(o.key, o);
    return m;
  }, [options]);

  const groups = useMemo(() => {
    const g: Record<string, ModelOption[]> = {};
    for (const o of options) (g[o.group] ??= []).push(o);
    return g;
  }, [options]);

  const updateSeat = useCallback(
    (id: string, patch: Partial<DraftSeat>) =>
      setSeats((s) => s.map((x) => (x.id === id ? { ...x, ...patch } : x))),
    [setSeats],
  );
  const removeSeat = useCallback(
    (id: string) =>
      setSeats((s) => (s.length <= 2 ? s : s.filter((x) => x.id !== id))),
    [setSeats],
  );
  const addSeat = useCallback(
    () => setSeats((s) => (s.length >= 6 ? s : [...s, newSeat()])),
    [setSeats],
  );

  const applyPreset = useCallback(
    (p: Preset) => {
      setTopic(p.topic);
      setMaxRounds(p.maxRounds);
      // Reset the first N seats to the preset's personas (keeping each seat's
      // existing id + model pick), and PRESERVE any extra seats the user added
      // beyond the preset's persona count. `newSeat()` is called at most once
      // per slot (the old code called it twice, double-advancing the counter).
      setSeats((cur) => {
        const mapped = p.personas.map((persona, i) => {
          const base = cur[i] ?? newSeat();
          return {
            ...base,
            name: persona.name,
            system: persona.system,
            color: SEAT_COLORS[i % SEAT_COLORS.length],
          };
        });
        // Recolor preserved extra seats by their final index too, so applying
        // a preset can't leave two seats sharing a color.
        const extra = cur.slice(p.personas.length).map((s, j) => ({
          ...s,
          color: SEAT_COLORS[(p.personas.length + j) % SEAT_COLORS.length],
        }));
        return [...mapped, ...extra];
      });
    },
    [setSeats, setTopic, setMaxRounds],
  );

  const localCount = seats.filter((s) => {
    const o = optionByKey.get(s.optionKey);
    return isLocalReloading(o?.backend, o?.model);
  }).length;

  const startRun = useCallback(() => {
    setSetupErr(null);
    if (!topic.trim()) return setSetupErr("Enter a topic.");
    if (seats.length < 2)
      return setSetupErr("A roundtable needs at least 2 seats.");
    const resolved = seats.map((d) => ({
      d,
      opt: optionByKey.get(d.optionKey),
    }));
    const unset = resolved.find((r) => !r.opt);
    if (unset) return setSetupErr(`Pick a model for "${unset.d.name}".`);

    // Gate the known-bad "2+ local models" config (resolved backends, not the
    // possibly-stale draft): Ollama keeps ~1 model resident, so each turn
    // reloads the other and usually times out → "all failed". Two-click confirm
    // so a user with the VRAM for it can still proceed.
    const localSeats = resolved.filter((r) =>
      isLocalReloading(r.opt?.backend, r.opt?.model),
    ).length;
    if (localSeats >= 2 && !confirmLocal) {
      setConfirmLocal(true);
      return setSetupErr(
        `${localSeats} local models will reload every turn and usually time out ("all failed"). Use cloud models, or click Start again to run anyway.`,
      );
    }

    const builtSeats: Seat[] = resolved.map(({ d, opt }) => ({
      id: d.id,
      name: d.name.trim() || "Speaker",
      color: d.color,
      backend: opt!.backend,
      model: opt!.model,
      modelLabel: opt!.label,
      system: d.system,
      temperature: d.temperature,
      maxTokens: 512,
    }));
    const prices: PriceTable = {};
    for (const { d, opt } of resolved) prices[d.id] = opt!.price ?? null;

    const config: RoundtableConfig = {
      seats: builtSeats,
      topic: topic.trim(),
      turnControl,
      memoryMode,
      recentWindow: 6,
      stop: {
        // Enforce the 1–30 cap even if a stale/hand-edited persisted value
        // slipped past the input's max.
        maxRounds: Math.min(30, Math.max(1, Math.round(maxRounds))),
        maxTokens: null,
        maxUsd: maxUsd > 0 ? maxUsd : null,
      },
    };
    if (!run.start(config, prices)) {
      setSetupErr("A roundtable is already running.");
    } else {
      setConfirmLocal(false); // run launched — disarm the local-models confirm
    }
  }, [
    seats,
    topic,
    optionByKey,
    turnControl,
    memoryMode,
    maxRounds,
    maxUsd,
    confirmLocal,
    run,
  ]);

  // Full "start over": clear any finished run AND restore the default config
  // (seats / topic / rounds / budget / memory). No-op mid-run — Stop first.
  const resetAll = useCallback(() => {
    if (run.running) return;
    run.clear();
    // Detach from any loaded saved table FIRST: the auto-save effect keys on
    // `loadedId`, so resetting the config while still "loaded" would persist
    // these defaults back over the saved entry (silent data loss). Clearing
    // `loadedId` turns reset into a fresh, unsaved draft instead.
    setLoadedId(null);
    setSaveName("");
    setSeats([
      newSeat(PRESETS[0].personas[0]),
      newSeat(PRESETS[0].personas[1]),
    ]);
    setTopic(PRESETS[0].topic);
    setMaxRounds(4);
    setMaxUsd(0.5);
    setMemoryMode("recent");
    setSetupErr(null);
    setConfirmLocal(false);
    setInjectText("");
  }, [run, setSeats, setTopic, setMaxRounds, setMaxUsd, setMemoryMode]);

  const exportTranscript = useCallback(() => {
    const md = run.turns
      .filter((t) => t.status === "done")
      .map((t) => `**${t.speaker}:** ${t.text}`)
      .join("\n\n");
    void navigator.clipboard.writeText(
      `# Roundtable — ${run.config?.topic ?? ""}\n\n${md}`,
    );
  }, [run.turns, run.config]);

  const showLive = run.running || run.turns.length > 0;

  // ── Live view ──
  // While a run is ACTIVE the live view always wins. Once it has only
  // completed (not running), an opened Outcome viewer / Outcomes list takes
  // precedence so those views aren't shadowed by a stale finished transcript.
  if (showLive && (run.running || (!viewing && !showOutcomes))) {
    const liveHead = (
      <>
        <div className="rt-live-title">
          Roundtable{" "}
          {run.statusLabel && (
            <span className="rt-status">· {run.statusLabel}</span>
          )}
        </div>
        <div className="rt-meter">
          <span>{run.totals.turns} turns</span>
          <span>
            {(run.totals.tokensIn + run.totals.tokensOut).toLocaleString()} tok
          </span>
          <span
            title={
              run.totals.usdPartial
                ? "Some models have no published price — lower bound"
                : undefined
            }
          >
            {formatUsd(run.totals.usd)}
            {run.totals.usdPartial ? "+" : ""}
          </span>
        </div>
        <div className="rt-live-actions">
          {run.running ? (
            <Button size="sm" variant="danger" onClick={run.stop}>
              Stop
            </Button>
          ) : (
            <>
              <Button size="sm" variant="ghost" onClick={run.clear}>
                New table
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={resetAll}
                title="Clear the run and restore default seats, topic, and settings"
              >
                <RotateCcw size={16} /> Reset
              </Button>
            </>
          )}
        </div>
      </>
    );
    return (
      <div className="rt-root" data-testid="roundtable-live">
        {topbarSlot ? (
          createPortal(
            <div className="rt-live-head in-topbar">{liveHead}</div>,
            topbarSlot,
          )
        ) : (
          <div className="rt-live-head">{liveHead}</div>
        )}

        {run.config && (
          <div className="rt-roster">
            {run.config.seats.map((s) => (
              <span
                key={s.id}
                className="rt-chip"
                style={{ ["--seat" as string]: s.color }}
              >
                <span className="rt-dot" /> {s.name}
              </span>
            ))}
            {run.config.seats.filter((s) =>
              isLocalReloading(s.backend, s.model),
            ).length >= 2 && (
              <span className="rt-warn">
                ⚠ 2+ local models reload each turn
              </span>
            )}
          </div>
        )}

        <div className="rt-transcript">
          {run.turns.map((t) => (
            <RtTurnBubble key={t.id} turn={t} />
          ))}
          {run.turns.length === 0 && <div className="rt-empty">Starting…</div>}
        </div>

        {run.endReason && !run.running && (
          <div className="rt-end" role="status">
            Ended — {run.endReason.replace("_", " ")} · {run.totals.turns} turns
            · {formatUsd(run.totals.usd)} · saved <Check size={14} />
            <Button size="sm" variant="ghost" onClick={exportTranscript}>
              Copy
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                void saveToFile(
                  run.config?.topic ?? topic,
                  run.turns,
                  run.totals,
                )
              }
            >
              <Save size={16} /> Save to file…
            </Button>
          </div>
        )}
        {fileMsg && (
          <div className="rt-warn-banner" role="status">
            {fileMsg}
          </div>
        )}

        {run.running && (
          <div className="rt-inject">
            <Input
              placeholder="Moderator: steer the conversation… (Enter to inject)"
              value={injectText}
              onChange={(e) => setInjectText(e.target.value)}
              onKeyDown={(e) => {
                // Ignore the Enter that commits an IME composition (CJK), and
                // allow Shift+Enter for a newline.
                if (
                  e.key === "Enter" &&
                  !e.shiftKey &&
                  !e.nativeEvent.isComposing &&
                  injectText.trim()
                ) {
                  run.inject(injectText);
                  setInjectText("");
                }
              }}
            />
          </div>
        )}
      </div>
    );
  }

  // ── Outcome viewer (read-only transcript of a saved run) ──
  if (viewing) {
    const { meta, payload } = viewing;
    const vHead = (
      <>
        <button
          type="button"
          className="wf-btn"
          onClick={() => {
            setViewing(null);
            setShowOutcomes(true);
          }}
        >
          ← Outcomes
        </button>
        <h1
          className="topbar-view-title"
          style={{
            fontSize: 16,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {meta.name}
        </h1>
        <div className="rt-live-actions" style={{ marginLeft: "auto" }}>
          <Button size="sm" variant="ghost" onClick={() => runAgain(payload)}>
            <RotateCw size={16} /> Run again
          </Button>
          <Button
            size="sm"
            variant="secondary"
            onClick={() =>
              void saveToFile(
                payload.run.config?.topic ?? meta.topic,
                payload.run.turns,
                payload.run.totals,
              )
            }
          >
            <Save size={16} /> Save to file…
          </Button>
        </div>
      </>
    );
    return (
      <div className="rt-root" data-testid="roundtable-outcome">
        {topbarSlot ? (
          createPortal(
            <div className="rt-live-head in-topbar">{vHead}</div>,
            topbarSlot,
          )
        ) : (
          <div className="rt-live-head">{vHead}</div>
        )}
        <div className="rt-roster">
          {(payload.run.config?.seats ?? []).map((s) => (
            <span
              key={s.id}
              className="rt-chip"
              style={{ ["--seat" as string]: s.color }}
            >
              <span className="rt-dot" /> {s.name}
            </span>
          ))}
          <span className="rt-status">
            {payload.run.totals.turns} turns ·{" "}
            {formatUsd(payload.run.totals.usd)}
            {payload.run.totals.usdPartial ? "+" : ""}
          </span>
        </div>
        <div className="rt-transcript">
          {payload.run.turns.map((t) => (
            <RtTurnBubble key={t.id} turn={t} />
          ))}
          {payload.run.turns.length === 0 && (
            <div className="rt-empty">Empty transcript.</div>
          )}
        </div>
        {fileMsg && (
          <div className="rt-warn-banner" role="status">
            {fileMsg}
          </div>
        )}
      </div>
    );
  }

  // ── Outcomes list (saved runs for the open table) — uniform with the picker ──
  if (showOutcomes) {
    const oHead = (
      <>
        <button
          type="button"
          className="wf-btn"
          onClick={() => setShowOutcomes(false)}
        >
          ← {saveName || "Table"}
        </button>
        <h1 className="topbar-view-title">Outcomes</h1>
      </>
    );
    return (
      <div className="wf-page wf-picker" data-testid="roundtable-outcomes">
        {topbarSlot ? (
          createPortal(oHead, topbarSlot)
        ) : (
          <div className="rt-setup-head">{oHead}</div>
        )}
        {outcomes.length === 0 ? (
          <EmptyState
            icon={<FileText size={24} />}
            heading="No saved outcomes yet"
            sub="Run this roundtable and its result is saved here automatically."
          />
        ) : (
          <ul className="wf-list">
            {outcomes.map((o) => (
              <li key={o.id} className="wf-list-item">
                <button
                  type="button"
                  className="wf-list-open"
                  onClick={() => openOutcome(o.id)}
                >
                  <span className="wf-list-name">{o.name}</span>
                  <span className="wf-list-meta">{o.turns} turns</span>
                </button>
                <button
                  type="button"
                  className="wf-list-del"
                  onClick={() => deleteOutcome(o.id)}
                  aria-label={`Delete outcome ${o.name}`}
                >
                  <X size={16} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  // ── Setup view ──
  // ── List landing (saved roundtables) — mirrors the Workflows picker ──
  if (!editing) {
    const listHead = (
      <>
        <h1 className="topbar-view-title">Roundtable</h1>
        <button
          type="button"
          className="wf-btn wf-btn-primary topbar-action"
          onClick={newRoundtable}
          style={{ marginLeft: "auto" }}
        >
          + New roundtable
        </button>
      </>
    );
    return (
      <div className="wf-page wf-picker" data-testid="roundtable-list">
        {topbarSlot ? (
          createPortal(listHead, topbarSlot)
        ) : (
          <div className="rt-setup-head">{listHead}</div>
        )}

        <section className="rt-templates" data-testid="rt-templates">
          <h2 className="rt-templates-title">Start from a template</h2>
          <p className="rt-templates-sub">
            Drop a cast of personas onto the table and go. Pick one, assign
            models to the seats, and hit Start — tweak anything after.
          </p>
          <div className="rt-template-grid">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                className="rt-template-card"
                data-testid={`rt-template-${p.id}`}
                onClick={() => createFromPreset(p)}
              >
                <span className="rt-template-cat">{p.category}</span>
                <span className="rt-template-name">{p.label}</span>
                <span className="rt-template-summary">{p.summary}</span>
                <span className="rt-template-meta">
                  {p.personas.length} seats · {p.maxRounds} rounds →
                </span>
              </button>
            ))}
          </div>
        </section>

        {savedTables.length > 0 && (
          <h2 className="rt-templates-title rt-your-tables">
            Your roundtables
          </h2>
        )}
        {savedTables.length === 0 ? (
          <EmptyState
            icon={<Users size={24} />}
            heading="No saved roundtables yet"
            sub="Use a template above, or start a blank one, to have several models debate or brainstorm a topic."
          />
        ) : (
          <ul className="wf-list">
            {savedTables.map((t) => (
              <li key={t.id} className="wf-list-item">
                <button
                  type="button"
                  className="wf-list-open"
                  onClick={() => openTable(t.id)}
                >
                  <span className="wf-list-name">{t.name}</span>
                  <span className="wf-list-meta">{t.seats.length} seats</span>
                </button>
                <button
                  type="button"
                  className="wf-list-del"
                  onClick={() => deleteTable(t.id)}
                  aria-label={`Delete ${t.name}`}
                >
                  <X size={16} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  // ── Editor view ──
  const setupHead = (
    <>
      <button
        type="button"
        className="wf-btn"
        onClick={() => setEditing(false)}
      >
        ← Tables
      </button>
      <input
        className="wf-name-input"
        value={saveName}
        onChange={(e) => setSaveName(e.target.value)}
        placeholder="Roundtable name"
        aria-label="Roundtable name"
      />
      <div className="rt-presets">
        <button
          className="rt-preset-btn"
          onClick={() => setShowOutcomes(true)}
          title="Saved transcripts of this roundtable's past runs"
        >
          <FileText size={16} /> Outcomes
          {outcomes.length > 0 ? ` (${outcomes.length})` : ""}
        </button>
        {PRESETS.map((p) => (
          <button
            key={p.id}
            className="rt-preset-btn"
            onClick={() => applyPreset(p)}
          >
            {p.label}
          </button>
        ))}
        <button
          className="rt-preset-btn"
          onClick={resetAll}
          title="Restore default seats, topic, and settings"
        >
          <RotateCcw size={16} /> Reset
        </button>
      </div>
    </>
  );
  return (
    <div className="rt-root" data-testid="roundtable-setup">
      {topbarSlot ? (
        createPortal(
          <div className="rt-setup-head in-topbar">{setupHead}</div>,
          topbarSlot,
        )
      ) : (
        <div className="rt-setup-head">{setupHead}</div>
      )}

      {modelErr && (
        <div className="rt-err-banner" role="alert">
          {modelErr}
        </div>
      )}

      <div className="rt-section-label">
        Participants <span className="rt-hint">(order = turn order)</span>
      </div>
      <div className="rt-seats">
        {seats.map((s) => (
          <div
            key={s.id}
            className="rt-seat"
            style={{ ["--seat" as string]: s.color }}
          >
            <div className="rt-seat-top">
              <span className="rt-dot" />
              <Input
                className="rt-seat-name"
                value={s.name}
                onChange={(e) => updateSeat(s.id, { name: e.target.value })}
                aria-label="Seat name"
              />
              <select
                className="rt-seat-model"
                value={s.optionKey}
                onChange={(e) =>
                  updateSeat(s.id, { optionKey: e.target.value })
                }
                aria-label="Model"
                disabled={loadingModels}
              >
                <option value="">
                  {loadingModels ? "Loading models…" : "Pick a model…"}
                </option>
                {Object.entries(groups).map(([g, opts]) => (
                  <optgroup key={g} label={g}>
                    {opts.map((o) => (
                      <option key={o.key} value={o.key}>
                        {o.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              {seats.length > 2 && (
                <button
                  className="rt-seat-x"
                  onClick={() => removeSeat(s.id)}
                  aria-label="Remove seat"
                >
                  <X size={16} />
                </button>
              )}
            </div>
            <textarea
              className="rt-seat-persona"
              rows={2}
              placeholder="Persona / stance (system prompt for this seat)…"
              value={s.system}
              onChange={(e) => updateSeat(s.id, { system: e.target.value })}
            />
          </div>
        ))}
      </div>
      {seats.length < 6 && (
        <Button size="sm" variant="secondary" onClick={addSeat}>
          + Add participant
        </Button>
      )}

      <div className="rt-section-label">Topic</div>
      <textarea
        className="rt-topic"
        rows={3}
        placeholder="What should they discuss?"
        value={topic}
        onChange={(e) => setTopic(e.target.value)}
      />

      <div className="rt-controls-grid">
        <label className="rt-ctl">
          <span>Memory</span>
          <select
            value={memoryMode}
            onChange={(e) => setMemoryMode(e.target.value as MemoryMode)}
          >
            <option value="recent">Recent (cheaper)</option>
            <option value="full">Full (best memory, costs more)</option>
          </select>
        </label>
        <label className="rt-ctl">
          <span>Max rounds</span>
          <Input
            type="number"
            min={1}
            max={30}
            value={maxRounds}
            onChange={(e) =>
              setMaxRounds(
                Math.min(30, Math.max(1, Number(e.target.value) || 1)),
              )
            }
          />
        </label>
        <label className="rt-ctl">
          <span>$ budget (0 = none)</span>
          <Input
            type="number"
            min={0}
            step={0.1}
            value={maxUsd}
            onChange={(e) =>
              setMaxUsd(Math.max(0, Number(e.target.value) || 0))
            }
          />
        </label>
      </div>

      {setupErr && (
        <div className="rt-err-banner" role="alert">
          {setupErr}
        </div>
      )}
      {localCount >= 2 && (
        <div className="rt-warn-banner">
          ⚠ Two local (Ollama) models reload on every turn — slow. Prefer cloud
          models, or one local at most.
        </div>
      )}

      <div className="rt-start-row">
        <Button variant="primary" onClick={startRun} disabled={loadingModels}>
          {loadingModels ? (
            <Spinner label="Loading" />
          ) : (
            <>
              <Play size={16} /> Start roundtable
            </>
          )}
        </Button>
        <Badge tone="neutral">
          {seats.length} seats · {Math.min(30, Math.max(1, maxRounds))} rounds ·
          cloud-first
        </Badge>
      </div>
    </div>
  );
}
