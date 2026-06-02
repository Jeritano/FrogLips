import type { ServerStatus } from "../types";
import { modelContextTokens } from "./agent-loop/context-manager";
import { logDiag } from "./diagnostics";

/**
 * Authoritative context-window lookup, with the static name-heuristic from
 * `context-manager.ts` as a safe fallback.
 *
 * The heuristic — regex on the model id — is fast but lies often: a model
 * named `qwen3.5:latest` may actually be a long-context fine-tune, an Ollama
 * Modelfile may have set `PARAMETER num_ctx 65536`, etc. So when the active
 * backend exposes the value over IPC we cache it and report it instead.
 *
 * Today only Ollama's `/api/show` exposes this cleanly (under
 * `model_info["{arch}.context_length"]`). MLX and the in-process native
 * backend currently fall through to the heuristic; both are TODOs.
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
      if (name.endsWith(".context_length") && typeof value === "number" && value > 0) {
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

