/* ── In-app diagnostics store ─────────────────────────────────────────────
 *
 * Purely-observational log of warnings/errors that are otherwise swallowed
 * by best-effort `/* ignore *​/` catch blocks scattered across the
 * frontend (and forwarded from Rust via the `app-diagnostics` Tauri event).
 *
 * Design choices:
 *   - In-memory ring buffer, cap CAP_ENTRIES. Older entries dropped FIFO.
 *   - Persisted to localStorage on every push (last PERSIST_ENTRIES) so a
 *     reload doesn't lose the most-recent context for a bug report.
 *   - Pub/sub via `subscribeDiag` so the panel can re-render incrementally.
 *
 * Constraints (per the diagnostics spec):
 *   - This module MUST NOT throw. All persistence / serialization failures
 *     are best-effort and silently swallowed (we'd lose telemetry-of-the-
 *     telemetry, but that's preferable to crashing the host).
 *   - Recovery behaviour of the surrounding code is unchanged — callers
 *     observe failures here without altering control flow.
 */

export type DiagLevel = "info" | "warn" | "error";

export interface DiagEntry {
  /** Unix millis when the entry was captured. */
  ts: number;
  level: DiagLevel;
  /** Short, stable source token used for filtering (e.g. "agent-loop"). */
  source: string;
  message: string;
  /** Optional structured payload. Auto-stringified for display/copy. */
  detail?: unknown;
}

const CAP_ENTRIES = 500;
const PERSIST_ENTRIES = 100;
const STORAGE_KEY = "froglips.diagnostics";

const entries: DiagEntry[] = [];
const subscribers = new Set<(snapshot: DiagEntry[]) => void>();

let hydrated = false;

/**
 * Hydrate from localStorage exactly once. Lazy so we don't touch the DOM
 * in module-init contexts (tests without localStorage, SSR, etc.).
 */
function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  try {
    if (typeof localStorage === "undefined") return;
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    // 2026-05-26 SE review round 2: pre-slice to CAP_ENTRIES so we don't
    // momentarily bloat the ring buffer during hydration. The prior
    // push-then-shift loop is functionally correct but doubles peak
    // memory on a localStorage with > CAP_ENTRIES entries.
    const window = parsed.slice(-CAP_ENTRIES);
    for (const item of window) {
      if (!item || typeof item !== "object") continue;
      const ts = typeof item.ts === "number" ? item.ts : Date.now();
      const level =
        item.level === "error" || item.level === "warn" || item.level === "info"
          ? item.level
          : "info";
      const source = typeof item.source === "string" ? item.source : "unknown";
      const message = typeof item.message === "string" ? item.message : "";
      entries.push({ ts, level, source, message, detail: item.detail });
    }
  } catch {
    /* hydration failure is non-fatal — start with empty buffer */
  }
}

/**
 * Convert an unknown `detail` value to a stable, JSON-serialisable form so
 * the structured clone in localStorage doesn't trip on `Error` instances or
 * circular references.
 */
function normaliseDetail(detail: unknown): unknown {
  if (detail === undefined) return undefined;
  if (detail === null) return null;
  if (detail instanceof Error) {
    return {
      name: detail.name,
      message: detail.message,
      stack: detail.stack,
    };
  }
  if (
    typeof detail === "string" ||
    typeof detail === "number" ||
    typeof detail === "boolean"
  ) {
    return detail;
  }
  // Cheap circular-ref check via JSON.stringify try/catch.
  try {
    return JSON.parse(JSON.stringify(detail));
  } catch {
    try {
      return String(detail);
    } catch {
      return "[unserialisable detail]";
    }
  }
}

function persist(): void {
  try {
    if (typeof localStorage === "undefined") return;
    const slice = entries.slice(-PERSIST_ENTRIES);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(slice));
  } catch {
    /* quota / serialization issues are non-fatal */
  }
}

function notify(): void {
  // Snapshot copy so subscribers can mutate freely without affecting state.
  const snap = entries.slice();
  for (const fn of subscribers) {
    try {
      fn(snap);
    } catch {
      /* a misbehaving subscriber must not crash logDiag */
    }
  }
}

/** Record a single diagnostic entry. Never throws. */
export function logDiag(entry: Omit<DiagEntry, "ts">): void {
  hydrate();
  try {
    const e: DiagEntry = {
      ts: Date.now(),
      level: entry.level,
      source: entry.source,
      message: entry.message,
      detail: normaliseDetail(entry.detail),
    };
    entries.push(e);
    while (entries.length > CAP_ENTRIES) entries.shift();
    persist();
    notify();
  } catch {
    /* logDiag is best-effort */
  }
}

/** Snapshot of the current ring buffer (most-recent at the end). */
export function listDiag(): DiagEntry[] {
  hydrate();
  return entries.slice();
}

/** Drop all in-memory + persisted entries. Notifies subscribers. */
export function clearDiag(): void {
  hydrate();
  entries.length = 0;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    /* non-fatal */
  }
  notify();
}

/**
 * Subscribe to changes. Returns an unsubscribe fn. The supplied callback
 * fires once immediately with the current snapshot so consumers don't need a
 * separate priming read.
 */
export function subscribeDiag(fn: (entries: DiagEntry[]) => void): () => void {
  hydrate();
  subscribers.add(fn);
  try {
    fn(entries.slice());
  } catch {
    /* mirror notify()'s tolerance */
  }
  return () => {
    subscribers.delete(fn);
  };
}

/* ── Boot / time-to-interactive timing ────────────────────────────────────
 *
 * Per-window startup metric so a boot regression is visible beyond the static
 * byte budgets the build gate enforces. `performance.now()` is measured from
 * navigation start inside each webview, so the value at the moment React's
 * root render returns is a cheap, local proxy for time-to-interactive. Recorded
 * as an `info` diagnostic (in-memory ring + localStorage only — no telemetry,
 * no IPC) so it shows up in the Diagnostics panel next to everything else.
 *
 * `label` distinguishes the windows that each have their own entry
 * (e.g. "main", "quick"). Idempotent per label within a window: a duplicate
 * call (StrictMode double-invoke, accidental re-import) is ignored so the panel
 * isn't spammed with two boot lines for one launch.
 */
const bootTimingRecorded = new Set<string>();

export function recordBootTiming(label: string): void {
  if (bootTimingRecorded.has(label)) return;
  bootTimingRecorded.add(label);
  try {
    if (
      typeof performance === "undefined" ||
      typeof performance.now !== "function"
    ) {
      return;
    }
    const tti = Math.round(performance.now());
    logDiag({
      level: "info",
      source: "boot-timing",
      message: `${label} TTI ${tti}ms`,
      detail: { window: label, ttiMs: tti },
    });
  } catch {
    /* timing is best-effort — never block or crash a window boot */
  }
}

/* ── Test hooks ─────────────────────────────────────────────────────────── */

/** Test-only: drop in-memory state without touching localStorage. */
export function __resetDiagnosticsForTests(): void {
  entries.length = 0;
  subscribers.clear();
  hydrated = false;
  bootTimingRecorded.clear();
}
