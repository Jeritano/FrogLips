import type { ServerStatus } from "../types";
import { modelContextTokens } from "./agent-loop/context-manager";
import { api } from "./tauri-api";
import { logDiag } from "./diagnostics";

/**
 * Authoritative context-window lookup, with the static name-heuristic from
 * `context-manager.ts` as a safe fallback.
 *
 * The heuristic — regex on the model id — is fast but lies often: a model
 * named `qwen3.5:latest` may actually be a long-context fine-tune, an Ollama
 * Modelfile may have set `PARAMETER num_ctx 65536`, etc. So when the active
 * backend exposes the value we cache it and report it instead.
 *
 * Resolution order (item 2):
 *   1. Rust `model_metadata` command — authoritative for ALL local backends
 *      (Ollama `/api/show`, plus MLX/native via their HF `config.json`
 *      `max_position_embeddings`).
 *   2. Direct Ollama `/api/show` fetch — fallback when the Rust command is
 *      unavailable (older build) but the daemon is reachable.
 *   3. The name heuristic from `context-manager.ts`.
 */

/** Cache: `${backend}:${modelId}` -> resolved tokens. */
const cache = new Map<string, number>();

function key(model: string, backend: string): string {
  return `${backend}:${model}`;
}

/**
 * Sync resolver — returns the cached authoritative value if we've fetched
 * it, otherwise the static heuristic. Safe to call from render.
 */
export function resolveContextTokens(
  model: string | null | undefined,
  status: ServerStatus | null,
): number {
  if (!model) return modelContextTokens(model);
  const backend = status?.backend ?? "";
  const cached = cache.get(key(model, backend));
  if (cached && cached > 0) return cached;
  return modelContextTokens(model);
}

/**
 * Best-effort async fetch of the model's true context length. Resolves to
 * the size in tokens, or `null` when the backend doesn't expose it or the
 * call fails. Caches successful lookups so repeated calls are free.
 */
export async function prefetchContextLength(
  model: string | null | undefined,
  status: ServerStatus | null,
): Promise<number | null> {
  if (!model || !status || !status.backend) return null;
  const k = key(model, status.backend);
  const existing = cache.get(k);
  if (existing && existing > 0) return existing;

  // 1. Authoritative Rust command — works for ollama AND mlx/native. Failures
  //    (older build without the command, unreachable daemon, no HF config)
  //    fall through to the legacy direct fetch / heuristic below.
  try {
    const meta = await api.modelMetadata(model, status.backend);
    const n = meta?.context_length;
    if (typeof n === "number" && n > 0) {
      cache.set(k, n);
      return n;
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
    const json = (await res.json()) as {
      model_info?: Record<string, unknown>;
      parameters?: string;
    };

    // `parameters` is the Modelfile text — `num_ctx <N>` here is what the
    // model is actually run with, which overrides the architectural default.
    // Prefer it when present.
    if (typeof json.parameters === "string") {
      const m = /(?:^|\n)\s*num_ctx\s+(\d+)/i.exec(json.parameters);
      if (m) {
        const n = Number(m[1]);
        if (Number.isFinite(n) && n > 0) {
          cache.set(k, n);
          return n;
        }
      }
    }

    const info = json.model_info ?? {};
    // Ollama exposes context length under an architecture-prefixed key like
    // `llama.context_length`, `qwen3.context_length`, etc. Match by suffix.
    for (const [name, value] of Object.entries(info)) {
      if (
        name.endsWith(".context_length") &&
        typeof value === "number" &&
        value > 0
      ) {
        cache.set(k, value);
        return value;
      }
    }
    return null;
  } catch (e) {
    logDiag({
      level: "info",
      source: "model-context-lookup",
      message: `ollama /api/show context lookup failed for ${model}`,
      detail: e,
    });
    return null;
  }
}
