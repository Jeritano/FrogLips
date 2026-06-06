/**
 * Multi-model chat router (MVP).
 *
 * Picks the best-fit configured route (model + backend + role) for a chat
 * message. See docs/ROUTER_DESIGN.md for the full design. This MVP implements
 * the tiered pipeline minus the semantic stage:
 *
 *   Stage 1  keyword/substring fast-path        (~0 ms)
 *   Stage 3  small-LLM classifier on the active model  (~200-500 ms)
 *   Stage 4  default route (never silent-fail)
 *
 * Stickiness: the current conversation's route is passed to the classifier as
 * a hint so it doesn't flip models turn-to-turn (a switch can cost a multi-
 * second model reload). Stage 2 (embeddings) and per-route cascade are phased
 * follow-ups.
 *
 * `routeMessage` is pure given an injected `classify` fn → trivially testable.
 * `makeClassifier` builds that fn from the active ServerStatus by reusing the
 * exact same stream clients the chat already uses (so the classifier runs on
 * the already-hot active model — no extra model load).
 */

import type { Message, ServerStatus } from "../types";
import { streamCustomChat } from "./custom-client";
import { streamChat } from "./mlx-client";
import { streamNativeChat } from "./native-client";
import { logDiag } from "./diagnostics";

export interface ChatRoute {
  id: string;
  /** Short display label, e.g. "Coder". */
  label: string;
  /** Natural-language "when to use" — fed to the LLM classifier. */
  whenToUse: string;
  /** Optional keyword/substring fast-path triggers (case-insensitive). */
  keywords?: string[];
  /** Target model id. */
  model: string;
  /** Target backend. */
  backend: "ollama" | "mlx" | "native" | "custom" | "openrouter";
  /** Optional Role/preset id (system prompt + tool allowlist). */
  preset?: string | null;
  /** Marks the fallback route used when the classifier is unsure. */
  isDefault?: boolean;
}

export interface RouteDecision {
  routeId: string | null;
  label: string;
  model: string;
  backend: ChatRoute["backend"];
  preset: string | null;
  method: "keyword" | "classifier" | "sticky" | "default";
  /** Classifier's one-line reason, when available (transparency). */
  reason?: string;
}

const LS_KEY = "chat.routes";
const MAX_ROUTES = 24;

/** Validate + load the user's saved routes from localStorage. Malformed
 *  entries are dropped rather than crashing the chat. */
export function loadRoutes(): ChatRoute[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: ChatRoute[] = [];
    for (const r of parsed.slice(0, MAX_ROUTES)) {
      if (!r || typeof r !== "object") continue;
      const o = r as Record<string, unknown>;
      if (typeof o.id !== "string" || typeof o.label !== "string") continue;
      if (typeof o.model !== "string" || typeof o.backend !== "string") continue;
      const backend = o.backend as ChatRoute["backend"];
      if (!["ollama", "mlx", "native", "custom", "openrouter"].includes(backend)) continue;
      out.push({
        id: o.id,
        label: o.label.slice(0, 60),
        whenToUse: typeof o.whenToUse === "string" ? o.whenToUse.slice(0, 2000) : "",
        keywords: Array.isArray(o.keywords)
          ? o.keywords.filter((k): k is string => typeof k === "string").slice(0, 32)
          : undefined,
        model: o.model,
        backend,
        preset: typeof o.preset === "string" ? o.preset : null,
        isDefault: o.isDefault === true,
      });
    }
    return out;
  } catch (e) {
    logDiag({ level: "warn", source: "chat-router", message: "loadRoutes failed", detail: e });
    return [];
  }
}

export function saveRoutes(routes: ChatRoute[]): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(routes.slice(0, MAX_ROUTES)));
  } catch (e) {
    logDiag({ level: "warn", source: "chat-router", message: "saveRoutes failed", detail: e });
  }
}

/** Parse a 1-based route number out of a classifier reply → 0-based index, or
 *  null when no in-range number is present. */
function parseIndex(text: string, n: number): number | null {
  const m = text.match(/\d+/);
  if (!m) return null;
  const i = parseInt(m[0], 10) - 1;
  return i >= 0 && i < n ? i : null;
}

function decisionFrom(
  r: ChatRoute,
  method: RouteDecision["method"],
  reason?: string,
): RouteDecision {
  return {
    routeId: r.id,
    label: r.label,
    model: r.model,
    backend: r.backend,
    preset: r.preset ?? null,
    method,
    reason,
  };
}

/**
 * Decide which route should handle `text`. Returns null when there are no
 * routes (caller keeps the current model). `classify` runs a one-shot
 * completion and returns its raw text.
 */
export async function routeMessage(
  text: string,
  routes: ChatRoute[],
  opts: {
    stickyRouteId?: string | null;
    classify: (prompt: string) => Promise<string>;
  },
): Promise<RouteDecision | null> {
  if (routes.length === 0) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Stage 1 — keyword/substring fast-path.
  const lc = trimmed.toLowerCase();
  for (const r of routes) {
    if (r.keywords?.some((k) => k.trim() && lc.includes(k.trim().toLowerCase()))) {
      return decisionFrom(r, "keyword");
    }
  }

  // Stage 3 — LLM classifier (on the active/hot model).
  const sticky = opts.stickyRouteId ? routes.find((r) => r.id === opts.stickyRouteId) ?? null : null;
  const list = routes.map((r, i) => `${i + 1}. [${r.label}] ${r.whenToUse}`).join("\n");
  const stickyHint = sticky
    ? `\nThe conversation is currently using route [${sticky.label}]. Keep using it UNLESS another route clearly fits this message better (avoid needless model switches).`
    : "";
  const prompt =
    `You are a routing classifier for a chat assistant. Choose the single best-fit route for the user's message. ` +
    `Reply with ONLY the route number (optionally followed by a short reason).${stickyHint}\n\n` +
    `## User message\n${trimmed}\n\n## Routes\n${list}\n\n## Best route number:`;
  try {
    const out = await opts.classify(prompt);
    const idx = parseIndex(out, routes.length);
    if (idx != null) {
      const r = routes[idx];
      const method: RouteDecision["method"] = sticky && r.id === sticky.id ? "sticky" : "classifier";
      const reason = out.trim().replace(/^\d+[).\s-]*/, "").trim().slice(0, 200) || undefined;
      return decisionFrom(r, method, reason);
    }
  } catch (e) {
    logDiag({ level: "warn", source: "chat-router", message: "classifier failed, using default", detail: e });
  }

  // Stage 4 — default (bias to the explicit default route, else sticky, else first).
  const def = routes.find((r) => r.isDefault) ?? sticky ?? routes[0];
  return decisionFrom(def, "default");
}

/**
 * Build a one-shot classifier fn from the active backend. Reuses the chat's
 * own stream clients so the classifier runs on the already-loaded model (no
 * extra load). Caps output — the classifier only needs a number + short reason.
 */
export function makeClassifier(
  status: ServerStatus,
  signal?: AbortSignal,
): (prompt: string) => Promise<string> {
  return async (prompt: string): Promise<string> => {
    const msgs: Message[] = [{ conversation_id: 0, role: "user", content: prompt }];
    let stream: AsyncGenerator<{ delta: string; done: boolean }>;
    if (status.backend === "openrouter") {
      stream = streamCustomChat("openrouter", msgs, { model: status.model ?? undefined, maxTokens: 64, signal });
    } else if (status.backend === "custom") {
      stream = streamCustomChat(status.model ?? "", msgs, { maxTokens: 64, signal });
    } else if (status.backend === "native") {
      stream = streamNativeChat(msgs, { maxTokens: 64, signal });
    } else {
      stream = streamChat(status, msgs, { maxTokens: 64, signal });
    }
    let acc = "";
    for await (const chunk of stream) {
      if (chunk.done) break;
      acc += chunk.delta;
      if (acc.length > 2000) break; // classifier replies are tiny
    }
    return acc;
  };
}
