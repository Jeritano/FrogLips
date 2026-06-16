import type { ServerStatus } from "../types";
import { modelSupportsVision } from "./model-capabilities";
import { api } from "./tauri-api";
import { logDiag } from "./diagnostics";

/**
 * Authoritative model-capability lookup (currently: vision support),
 * with the static name-heuristic from `model-capabilities.ts` as the
 * safe fallback.
 *
 * Mirrors `model-context-lookup.ts`: the regex heuristic is fast but
 * lies — a brand-new multimodal family the pattern list hasn't caught
 * gets its image-attach button hidden, and a text model whose name
 * happens to contain "vision" gets a button that does nothing. When
 * the active backend reports the truth we cache + trust it.
 *
 * Resolution order (item 2):
 *   1. Rust `model_metadata` — authoritative for ALL local backends
 *      (Ollama capabilities array, plus MLX/native via their HF config's
 *      `vision_config` / multimodal `model_type`).
 *   2. Direct Ollama `/api/show` fetch — fallback when the Rust command
 *      is unavailable but the daemon is reachable.
 *   3. The name heuristic from `model-capabilities.ts`.
 */

/** Cache: `${backend}:${modelId}` -> vision-capable bool. */
const visionCache = new Map<string, boolean>();

function key(model: string, backend: string): string {
  return `${backend}:${model}`;
}

/**
 * Sync resolver — returns the cached authoritative answer if we've
 * fetched it, otherwise the static heuristic. Safe to call from render.
 */
export function resolveVisionSupport(
  model: string | null | undefined,
  status: ServerStatus | null,
): boolean {
  if (!model) return false;
  const backend = status?.backend ?? "";
  const cached = visionCache.get(key(model, backend));
  if (cached !== undefined) return cached;
  return modelSupportsVision(model);
}

/**
 * Best-effort async fetch of the model's true vision capability via
 * Ollama's `/api/show`. Resolves to the boolean, or `null` when the
 * backend doesn't expose it (non-Ollama) or the call fails. Caches
 * successful lookups so repeated calls are free.
 *
 * On a failed/absent lookup we DON'T cache — so a later retry (e.g.
 * after the daemon comes up) can still populate the authoritative
 * value, and the heuristic keeps covering in the meantime.
 */
export async function prefetchVisionSupport(
  model: string | null | undefined,
  status: ServerStatus | null,
): Promise<boolean | null> {
  if (!model || !status || !status.backend) return null;
  const k = key(model, status.backend);
  const existing = visionCache.get(k);
  if (existing !== undefined) return existing;

  // 1. Authoritative Rust command — works for ollama AND mlx/native. Only a
  //    definite boolean is cached/returned; a null (undeterminable) falls
  //    through so the heuristic keeps covering and a later retry can resolve.
  try {
    const meta = await api.modelMetadata(model, status.backend);
    if (meta && typeof meta.vision === "boolean") {
      visionCache.set(k, meta.vision);
      return meta.vision;
    }
  } catch {
    /* fall through to the direct fetch below */
  }

  // 2. Direct Ollama /api/show — only meaningful for the ollama backend.
  if (status.backend !== "ollama") return null;

  try {
    const res = await fetch(`http://${status.host}:${status.port}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: model }),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { capabilities?: unknown };
    if (Array.isArray(json.capabilities)) {
      const vision = json.capabilities.some(
        (c) => typeof c === "string" && c.toLowerCase() === "vision",
      );
      visionCache.set(k, vision);
      return vision;
    }
    return null;
  } catch (e) {
    logDiag({
      level: "info",
      source: "model-capability-lookup",
      message: `ollama /api/show capability lookup failed for ${model}`,
      detail: e,
    });
    return null;
  }
}

/** Test-only: clear the capability cache between cases. */
export function __clearVisionCacheForTest(): void {
  visionCache.clear();
}
