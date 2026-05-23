import { useCallback, useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api } from "../lib/tauri-api";
import { logDiag } from "../lib/diagnostics";
import type { ImageGenOpts } from "../types";

/**
 * Phase reported by the Rust `image-progress` event. `loading` covers cold
 * weight load (HF download + Metal kernel init); `sampling` covers the actual
 * diffusion steps. `loading` can take minutes the first time a model is used;
 * subsequent runs jump straight to `sampling`.
 *
 * Event contract (must stay in lock-step with `src-tauri/src/commands/image.rs`):
 *
 *   1. Caller mints `op_id` (a UUID).
 *   2. This hook registers `image-progress` / `image-done` / `image-error`
 *      listeners that filter on the matching `op_id`. Listeners MUST be armed
 *      BEFORE `image_generate` is dispatched — Rust can emit a
 *      `Loading{stage:"warmup"}` event the instant the engine starts, and a
 *      late-registered listener would drop it (H3 in the remediation tracker).
 *   3. The IPC call returns the persisted image row id synchronously but the
 *      real flow gates on the `image-done` event so resolve order matches
 *      event order.
 */
export type ImageGenPhase = "idle" | "loading" | "sampling";

export interface ImageGenProgress {
  phase: ImageGenPhase;
  step?: number;
  total?: number;
  /** Optional human-readable stage label from the Rust side. */
  stage?: string;
}

export interface UseImageGenerationResult {
  /** True while a generate is in flight (between submit and image-done/error). */
  running: boolean;
  /** Phase + step counter from the Rust progress stream. */
  progress: ImageGenProgress;
  /** Last error message from `image-error` (or local IPC throw). Cleared on next generate. */
  error: string | null;
  /** Image row id from the most recent successful `image-done`. Cleared on next generate. */
  lastImageId: number | null;
  /**
   * Kick off a generation. Mints a fresh op_id, subscribes to the three
   * keyed events for it, and resolves the returned promise with the row id
   * on success (or rejects on error / cancel). The op_id is internal — the
   * caller doesn't need it. `cancel()` targets the in-flight op.
   */
  generate: (args: {
    prompt: string;
    model: string;
    opts: ImageGenOpts;
    convId: number | null;
  }) => Promise<number>;
  /** Best-effort cancel; resolves once the cancel IPC returns. No-op when idle. */
  cancel: () => Promise<void>;
}

interface EventPayload {
  op_id?: string;
  step?: number;
  total?: number;
  stage?: string;
  image_id?: number;
  message?: string;
}

/**
 * Owns the generate flow for ImageView. Single in-flight op at a time — calling
 * `generate` while a previous run is still going rejects the second caller; the
 * UI should disable the Generate button while `running`.
 */
export function useImageGeneration(): UseImageGenerationResult {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ImageGenProgress>({ phase: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [lastImageId, setLastImageId] = useState<number | null>(null);
  const opIdRef = useRef<string | null>(null);
  /**
   * Active unlisten handles for the in-flight op. We keep this on a ref (not in
   * the Promise closure) so an unmount-time effect can drain them even when
   * the consumer never awaits the generate promise. Without this, switching
   * views mid-generate leaked Tauri listeners and could call setState on an
   * unmounted hook (M4 in the remediation tracker).
   */
  const cleanupsRef = useRef<UnlistenFn[]>([]);

  // Component-unmount safety net — fire any unlisten handles that are still
  // outstanding when the owner React tree goes away. The normal happy-path
  // also calls these (and clears the ref) inside `finalize` below.
  useEffect(() => {
    return () => {
      for (const off of cleanupsRef.current) {
        try { off(); } catch {/* unlisten failures are non-fatal */}
      }
      cleanupsRef.current = [];
    };
  }, []);

  const generate = useCallback<UseImageGenerationResult["generate"]>(
    async ({ prompt, model, opts, convId }) => {
      if (opIdRef.current) {
        throw new Error("Another image generation is already running");
      }
      const opId = crypto.randomUUID();
      opIdRef.current = opId;
      setRunning(true);
      setError(null);
      setLastImageId(null);
      // Default phase is `loading` — the first event from Rust may be a
      // Loading stage (cold model) OR jump straight to Step #1. Either way
      // the UI shows useful copy ("Loading model…") until that first event
      // lands.
      setProgress({ phase: "loading" });

      return await new Promise<number>((resolve, reject) => {
        const finalize = (fn: () => void) => {
          for (const off of cleanupsRef.current) {
            try { off(); } catch {/* unlisten failures are non-fatal */}
          }
          cleanupsRef.current = [];
          opIdRef.current = null;
          setRunning(false);
          fn();
        };

        const subscribe = async () => {
          try {
            // Step 1: register all three listeners and CAPTURE their unlisten
            // handles before any IPC is dispatched. If `image_generate` were
            // to fire `Loading{stage:"warmup"}` before this point the event
            // would be lost and the UI would freeze on "Loading model…".
            const offProgress = await listen<EventPayload>("image-progress", (e) => {
              const p = e.payload;
              if (!p || p.op_id !== opId) return;
              // M8: a Loading event carries `step:0, total:0` AND a `stage`
              // string — checking `stage` first means we don't misclassify it
              // as a "Generating step 0/0" sampling tick. Sampling events
              // omit `stage` entirely.
              if (typeof p.stage === "string" && p.stage.length > 0) {
                setProgress({ phase: "loading", stage: p.stage });
              } else if (typeof p.step === "number") {
                setProgress({
                  phase: "sampling",
                  step: p.step,
                  total: typeof p.total === "number" ? p.total : undefined,
                });
              } else {
                // Bare progress event with no step + no stage — treat as a
                // ping that the run has moved past "Loading" into sampling
                // setup. Keep `loading` so the UI doesn't flash empty copy.
                setProgress((prev) => prev.phase === "idle" ? { phase: "loading" } : prev);
              }
            });
            cleanupsRef.current.push(offProgress);

            const offDone = await listen<EventPayload>("image-done", (e) => {
              const p = e.payload;
              if (!p || p.op_id !== opId) return;
              const id = typeof p.image_id === "number" ? p.image_id : null;
              if (id != null) setLastImageId(id);
              setProgress({ phase: "idle" });
              finalize(() => {
                if (id != null) resolve(id);
                else reject(new Error("image-done missing image_id"));
              });
            });
            cleanupsRef.current.push(offDone);

            const offErr = await listen<EventPayload>("image-error", (e) => {
              const p = e.payload;
              if (!p || p.op_id !== opId) return;
              const msg = typeof p.message === "string" ? p.message : "Image generation failed";
              setError(msg);
              setProgress({ phase: "idle" });
              finalize(() => reject(new Error(msg)));
            });
            cleanupsRef.current.push(offErr);

            // Step 2: listeners are armed — kick off the actual IPC. The Rust
            // side returns the row id as soon as it's persisted but emits the
            // events out-of-band; we ignore the synchronous return value and
            // gate on `image-done` so resolve order matches event order.
            try {
              await api.imageGenerate(prompt, model, opts, convId, opId);
            } catch (err) {
              // IPC-level throw (validation, etc.) — never reached the event
              // path. Treat exactly like `image-error`.
              const msg = err instanceof Error ? err.message : String(err);
              setError(msg);
              setProgress({ phase: "idle" });
              finalize(() => reject(new Error(msg)));
            }
          } catch (err) {
            logDiag({
              level: "warn",
              source: "image-gen",
              message: "useImageGeneration: listen() failed",
              detail: err,
            });
            finalize(() => reject(err instanceof Error ? err : new Error(String(err))));
          }
        };
        void subscribe();
      });
    },
    [],
  );

  const cancel = useCallback(async () => {
    const opId = opIdRef.current;
    if (!opId) return;
    try {
      await api.imageCancel(opId);
    } catch (err) {
      logDiag({
        level: "info",
        source: "image-gen",
        message: "imageCancel rejected — best-effort cancel",
        detail: err,
      });
    }
  }, []);

  return { running, progress, error, lastImageId, generate, cancel };
}
