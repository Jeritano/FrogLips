import type { ToolResult } from "./types";

/**
 * Pure, side-effect-free helpers extracted verbatim from `runner.ts`. These are
 * the genuinely standalone pieces of the agent loop — signature/dedup math, the
 * stall predicate, the bounded-concurrency runner, the tmp-key minter, and the
 * narration-preamble heuristic — with no dependency on the loop's mutable state,
 * IPC, or the gate sequence. Moving them out shrinks `runner.ts` without
 * touching the loop body, streaming consumption, abort handling, or tool-call
 * pairing. Behavior is identical; the loop imports each symbol back unchanged.
 */

// Stall detection: if agent reads the same path > this many times in
// monotonically-advancing tiny chunks, abort the loop with an explanatory msg.
const STALL_SAME_PATH_LIMIT = 6;

/**
 * True when an assistant text reply READS like a preamble that announces an
 * action ("Let me fix X:", "I'll work on Y", "I'm working on the fixes:") —
 * i.e. the model is describing what it's about to do rather than reporting a
 * finished result. Used to detect the "narrates instead of calling tools"
 * stall: a coding agent that emits this with NO tool call (and has done no
 * work) isn't finished, it's stuck talking. Deliberately conservative — a
 * genuine completion summary ("I fixed X, Y, Z. All tests pass.") matches none
 * of these.
 */
export function looksLikeActionPreamble(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  // Ends with a colon — "Here are the fixes:" / "Let me continue with the fixes:"
  if (/[:：]\s*$/.test(t)) return true;
  return /\b(let me|i'?ll|i will|i'?m going to|i am going to|let'?s|now,? i'?ll|first,? i'?ll|next,? i'?ll|i'?m (now )?(working|fixing|going)|continue (fixing|working|with the))\b/i.test(
    t,
  );
}

export function makeTmpKey(): string {
  return `tmp:${crypto.randomUUID()}`;
}

/**
 * Run `tasks` with at most `limit` in flight, resolving once all complete.
 * Each task owns its own result/error handling (the prefetch tasks store into a
 * map and never throw), so this only needs to bound concurrency, not collect
 * return values. Used by the read-only prefetch (opt #1).
 */
export async function runWithConcurrency(
  tasks: Array<() => Promise<void>>,
  limit: number,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const idx = next++;
      if (idx >= tasks.length) return;
      await tasks[idx]();
    }
  };
  const n = Math.min(Math.max(1, limit), tasks.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
}

/**
 * Build a JSON body for a rejected/short-circuited tool call. Mirrors the
 * `{ok:false, kind, message}` protocol every tool result already uses.
 */
export function rejectionBody(kind: string, message: string): string {
  return JSON.stringify({ ok: false, kind, message } satisfies ToolResult);
}

/** Multiset (sig → count) for a single turn. */
function sigMultiset(sigs: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of sigs) m.set(s, (m.get(s) ?? 0) + 1);
  return m;
}

/** True when two turns' tool-call signatures are an exact multiset match. */
function sameTurnMultiset(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const am = sigMultiset(a);
  const bm = sigMultiset(b);
  if (am.size !== bm.size) return false;
  for (const [k, v] of am) {
    if (bm.get(k) !== v) return false;
  }
  return true;
}

/**
 * True when THIS turn's tool calls exactly match (as an order-insensitive
 * multiset) ANY of the last few turns' calls. Comparing against a short
 * history — not just the immediately-prior turn — catches A/B/A/B thrash where
 * the model oscillates between two identical turns and never converges (the
 * one-turn-back check let that run to the iteration cap). The window is kept
 * small (DEDUPE_HISTORY) so legitimate re-reads with real intervening progress
 * (read A, read B, read A again) still slip through.
 */
export function isDuplicateTurn(
  currentSigs: string[],
  prevSigsHistory: string[][],
): boolean {
  if (currentSigs.length === 0) return false;
  return prevSigsHistory.some((prev) => sameTurnMultiset(currentSigs, prev));
}

/**
 * Stall predicate for repeated same-target read-only calls. Bumps a per-key
 * counter and reports whether the agent has exceeded the chunk/repeat limit.
 * Covers `read_file` (keyed by path — catches chunk-thrashing a single file)
 * and `search_files` (keyed by path+pattern — catches re-running the identical
 * grep across turns when the dedupe window has rolled past it). Other tools are
 * never flagged.
 */
export function isToolStalling(
  fnName: string,
  args: Record<string, unknown>,
  readCounts: Map<string, number>,
): { stalling: boolean; key: string; count: number; tool: string } {
  let key: string | null = null;
  if (fnName === "read_file") {
    key = `read_file:${String(args.path ?? "")}`;
  } else if (fnName === "search_files") {
    key = `search_files:${String(args.path ?? "")}${String(args.pattern ?? "")}`;
  } else if (fnName === "read_files") {
    // L21: read_files takes a `paths` array — chunk-thrashing it with varying
    // offsets previously evaded the stall guard. Key by the joined path set.
    const paths = Array.isArray(args.paths)
      ? args.paths.map((p) => String(p)).join(",")
      : String(args.paths ?? "");
    key = `read_files:${paths}`;
  } else if (fnName === "read_pdf") {
    key = `read_pdf:${String(args.path ?? "")}`;
  }
  if (key === null) {
    return { stalling: false, key: "", count: 0, tool: fnName };
  }
  const count = (readCounts.get(key) ?? 0) + 1;
  readCounts.set(key, count);
  return {
    stalling: count > STALL_SAME_PATH_LIMIT,
    key:
      fnName === "search_files"
        ? String(args.pattern ?? "")
        : String(args.path ?? args.paths ?? ""),
    count,
    tool: fnName,
  };
}
