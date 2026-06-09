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
import { embed } from "./memory-client";
import { logDiag } from "./diagnostics";

export interface ChatRoute {
  id: string;
  /** Short display label, e.g. "Coder". */
  label: string;
  /** Natural-language "when to use" — fed to the LLM classifier (Stage 3). */
  whenToUse: string;
  /** Optional keyword/substring fast-path triggers (case-insensitive, Stage 1). */
  keywords?: string[];
  /** Optional example queries → embedded into a prototype for semantic
   *  routing (Stage 2). 3-10 short, representative messages work best. */
  utterances?: string[];
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
  method: "keyword" | "semantic" | "classifier" | "sticky" | "default";
  /** Classifier's one-line reason or semantic score note (transparency). */
  reason?: string;
  /** Cosine similarity for a semantic decision (0-1), when applicable. */
  score?: number;
}

/**
 * A saved, named bundle of routes. Lets the user keep several setups
 * ("Hybrid cloud+local", "All-local private", "Coding-heavy") with notes and
 * switch between them in one click. Persisted in localStorage.
 */
export interface RouterConfig {
  id: string;
  label: string;
  notes?: string;
  routes: ChatRoute[];
  createdAt: number;
  updatedAt: number;
}

const LEGACY_ROUTES_LS = "chat.routes"; // pre-config flat list (migrated once)
const CONFIGS_LS = "chat.routeConfigs";
const ACTIVE_LS = "chat.activeConfigId";
const MAX_ROUTES = 24;
const MAX_CONFIGS = 24;

/** Validate + normalize one raw route. Returns null if required fields are
 *  missing/invalid so a malformed entry is dropped, not crash the chat. */
function normalizeRoute(r: unknown): ChatRoute | null {
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  if (typeof o.id !== "string" || typeof o.label !== "string") return null;
  if (typeof o.model !== "string" || typeof o.backend !== "string") return null;
  const backend = o.backend as ChatRoute["backend"];
  if (!["ollama", "mlx", "native", "custom", "openrouter"].includes(backend)) return null;
  const strList = (v: unknown, cap: number) =>
    Array.isArray(v) ? v.filter((k): k is string => typeof k === "string").slice(0, cap) : undefined;
  return {
    id: o.id,
    label: o.label.slice(0, 60),
    whenToUse: typeof o.whenToUse === "string" ? o.whenToUse.slice(0, 2000) : "",
    keywords: strList(o.keywords, 32),
    utterances: strList(o.utterances, 16),
    model: o.model,
    backend,
    preset: typeof o.preset === "string" ? o.preset : null,
    isDefault: o.isDefault === true,
  };
}

function normalizeConfig(c: unknown): RouterConfig | null {
  if (!c || typeof c !== "object") return null;
  const o = c as Record<string, unknown>;
  if (typeof o.id !== "string" || typeof o.label !== "string") return null;
  const routes = Array.isArray(o.routes)
    ? o.routes.map(normalizeRoute).filter((r): r is ChatRoute => r !== null).slice(0, MAX_ROUTES)
    : [];
  return {
    id: o.id,
    label: o.label.slice(0, 80),
    notes: typeof o.notes === "string" ? o.notes.slice(0, 4000) : undefined,
    routes,
    createdAt: typeof o.createdAt === "number" ? o.createdAt : Date.now(),
    updatedAt: typeof o.updatedAt === "number" ? o.updatedAt : Date.now(),
  };
}

/** Load all saved configurations. Migrates a pre-config flat `chat.routes`
 *  list into a single "Default" config on first run. */
export function loadConfigs(): RouterConfig[] {
  try {
    const raw = localStorage.getItem(CONFIGS_LS);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map(normalizeConfig).filter((c): c is RouterConfig => c !== null).slice(0, MAX_CONFIGS);
      }
    }
    // Migration: wrap a legacy flat route list into one Default config.
    const legacyRaw = localStorage.getItem(LEGACY_ROUTES_LS);
    if (legacyRaw) {
      const legacy = JSON.parse(legacyRaw);
      const routes = Array.isArray(legacy)
        ? legacy.map(normalizeRoute).filter((r): r is ChatRoute => r !== null)
        : [];
      if (routes.length > 0) {
        const cfg: RouterConfig = {
          id: `cfg-${crypto.randomUUID().slice(0, 8)}`,
          label: "Default",
          routes,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        saveConfigs([cfg]);
        return [cfg];
      }
    }
    return [];
  } catch (e) {
    logDiag({ level: "warn", source: "chat-router", message: "loadConfigs failed", detail: e });
    return [];
  }
}

export function saveConfigs(configs: RouterConfig[]): void {
  try {
    localStorage.setItem(CONFIGS_LS, JSON.stringify(configs.slice(0, MAX_CONFIGS)));
  } catch (e) {
    logDiag({ level: "warn", source: "chat-router", message: "saveConfigs failed", detail: e });
  }
}

export function getActiveConfigId(): string | null {
  const id = localStorage.getItem(ACTIVE_LS);
  if (id) return id;
  const first = loadConfigs()[0];
  return first ? first.id : null;
}

export function setActiveConfigId(id: string): void {
  try {
    localStorage.setItem(ACTIVE_LS, id);
  } catch {
    /* non-fatal */
  }
}

export function activeConfig(): RouterConfig | null {
  const configs = loadConfigs();
  if (configs.length === 0) return null;
  const id = getActiveConfigId();
  return configs.find((c) => c.id === id) ?? configs[0];
}

/** Create a config (and make it active). */
export function createConfig(label: string, routes: ChatRoute[] = [], notes?: string): RouterConfig {
  const cfg: RouterConfig = {
    id: `cfg-${crypto.randomUUID().slice(0, 8)}`,
    label: label.slice(0, 80) || "Untitled",
    notes,
    routes: routes.slice(0, MAX_ROUTES),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const configs = loadConfigs();
  configs.push(cfg);
  saveConfigs(configs);
  setActiveConfigId(cfg.id);
  return cfg;
}

export function updateConfig(id: string, patch: Partial<Omit<RouterConfig, "id" | "createdAt">>): void {
  const configs = loadConfigs();
  const i = configs.findIndex((c) => c.id === id);
  if (i < 0) return;
  configs[i] = { ...configs[i], ...patch, id, updatedAt: Date.now() };
  saveConfigs(configs);
}

export function duplicateConfig(id: string): RouterConfig | null {
  const src = loadConfigs().find((c) => c.id === id);
  if (!src) return null;
  return createConfig(`${src.label} copy`, src.routes, src.notes);
}

export function deleteConfig(id: string): void {
  const configs = loadConfigs().filter((c) => c.id !== id);
  saveConfigs(configs);
  if (getActiveConfigId() === id) {
    if (configs[0]) setActiveConfigId(configs[0].id);
    else localStorage.removeItem(ACTIVE_LS);
  }
}

/** Routes of the active config — the set the router actually uses. */
export function loadRoutes(): ChatRoute[] {
  return activeConfig()?.routes ?? [];
}

/** Strip reasoning-model thinking blocks so a number INSIDE the chain-of-thought
 *  ("option 2 seems...") isn't mistaken for the final route. Handles closed and
 *  trailing-unclosed <think>/<thinking> spans. */
function stripThinking(text: string): string {
  return text
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, " ")
    .replace(/<think(?:ing)?>[\s\S]*$/i, " ");
}

/** Parse a 1-based route number out of a classifier reply → 0-based index, or
 *  null when no in-range number is present. Thinking is stripped first; a
 *  leading number ("2", "2 — web") is preferred over a stray integer later in
 *  prose ("pick 2 unless it's about 2024…"). */
function parseIndex(text: string, n: number): number | null {
  const stripped = stripThinking(text);
  const m = stripped.match(/^\s*(\d+)/) ?? stripped.match(/(\d+)/);
  if (!m) return null;
  const i = parseInt(m[1], 10) - 1;
  return i >= 0 && i < n ? i : null;
}

/** True when any route's keyword fast-path matches — lets the caller skip the
 *  (possibly network-bound) prototype build before Stage 1 even runs. */
function hasKeywordMatch(text: string, routes: ChatRoute[]): boolean {
  const lc = text.trim().toLowerCase();
  return routes.some((r) => r.keywords?.some((k) => k.trim() && lc.includes(k.trim().toLowerCase())));
}

function decisionFrom(
  r: ChatRoute,
  method: RouteDecision["method"],
  reason?: string,
  score?: number,
): RouteDecision {
  return {
    routeId: r.id,
    label: r.label,
    model: r.model,
    backend: r.backend,
    preset: r.preset ?? null,
    method,
    reason,
    score,
  };
}

/* ── Semantic routing (Stage 2) ─────────────────────────────────────────── */

/** Cosine similarity of two equal-ish-length vectors. 0 when either is zero. */
export function cosineSim(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Component-wise mean of a set of vectors (the route prototype). */
function meanVec(vecs: number[][]): number[] | null {
  const valid = vecs.filter((v) => v && v.length > 0);
  if (valid.length === 0) return null;
  const dim = valid[0].length;
  const out = new Array(dim).fill(0);
  for (const v of valid) for (let i = 0; i < dim; i++) out[i] += v[i] ?? 0;
  for (let i = 0; i < dim; i++) out[i] /= valid.length;
  return out;
}

/** djb2 string hash → stable cache key for a route's utterance set. */
function hashStr(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// Prototype cache: routeId+utteranceHash → vector. Backed by localStorage so it
// survives reloads; a utterance edit changes the hash → recompute on next use.
const PROTO_LS = "chat.routePrototypes";
const protoMem = new Map<string, number[]>();
let protoDiskLoaded = false;

function protoKey(route: ChatRoute): string {
  return `${route.id}:${hashStr((route.utterances ?? []).join(""))}`;
}

function loadProtoDisk(): void {
  if (protoDiskLoaded) return;
  protoDiskLoaded = true;
  try {
    const raw = localStorage.getItem(PROTO_LS);
    if (!raw) return;
    const obj = JSON.parse(raw) as Record<string, number[]>;
    for (const [k, v] of Object.entries(obj)) if (Array.isArray(v)) protoMem.set(k, v);
  } catch {
    /* ignore corrupt cache */
  }
}

function saveProtoDisk(): void {
  try {
    // Cap persisted entries so the cache can't grow unbounded across many edits.
    const entries = [...protoMem.entries()].slice(-64);
    localStorage.setItem(PROTO_LS, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* non-fatal */
  }
}

/**
 * Build (or fetch from cache) a prototype embedding per route that has
 * utterances. `embedFn` embeds one text → vector (or null when no embedder).
 * Routes without utterances or without an available embedder are simply absent
 * from the returned map → Stage 2 skips them and the classifier handles them.
 */
async function buildPrototypes(
  routes: ChatRoute[],
  embedFn: (text: string) => Promise<number[] | null>,
): Promise<Map<string, number[]>> {
  loadProtoDisk();
  const map = new Map<string, number[]>();
  let dirty = false;
  for (const r of routes) {
    const utterances = (r.utterances ?? []).map((u) => u.trim()).filter(Boolean);
    if (utterances.length === 0) continue;
    const key = protoKey(r);
    const cached = protoMem.get(key);
    if (cached) {
      map.set(r.id, cached);
      continue;
    }
    try {
      const vecs = await Promise.all(utterances.map((u) => embedFn(u)));
      const proto = meanVec(vecs.filter((v): v is number[] => Array.isArray(v) && v.length > 0));
      if (proto) {
        protoMem.set(key, proto);
        map.set(r.id, proto);
        dirty = true;
      }
    } catch {
      /* embedder unavailable for this route → skip (classifier covers it) */
    }
  }
  if (dirty) saveProtoDisk();
  return map;
}

/**
 * Decide which route should handle `text`. Returns null when there are no
 * routes (caller keeps the current model).
 *
 * Pipeline: Stage 1 keyword → Stage 2 semantic (cosine vs prototypes) → Stage 3
 * LLM classifier → Stage 4 default. Stages 2 and 3 are skipped if their inputs
 * (`embedQuery`+`prototypes` / a working `classify`) aren't available, so the
 * function degrades gracefully. `classify` runs a one-shot completion and
 * returns its raw text; `embedQuery` embeds the message once.
 */
export async function routeMessage(
  text: string,
  routes: ChatRoute[],
  opts: {
    stickyRouteId?: string | null;
    classify: (prompt: string) => Promise<string>;
    /** Embed the user message for Stage 2 (omit to skip semantic routing). */
    embedQuery?: () => Promise<number[] | null>;
    /** routeId → prototype vector (from {@link buildPrototypes}). */
    prototypes?: Map<string, number[]>;
    /** Min cosine to accept a semantic pick. Default 0.5. */
    threshold?: number;
    /** Min lead over the runner-up to accept (anti-ambiguity). Default 0.05. */
    margin?: number;
  },
): Promise<RouteDecision | null> {
  if (routes.length === 0) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;

  const sticky = opts.stickyRouteId ? routes.find((r) => r.id === opts.stickyRouteId) ?? null : null;

  // Stage 1 — keyword/substring fast-path.
  const lc = trimmed.toLowerCase();
  for (const r of routes) {
    if (r.keywords?.some((k) => k.trim() && lc.includes(k.trim().toLowerCase()))) {
      return decisionFrom(r, "keyword");
    }
  }

  // Stage 2 — semantic (vector). Cheap + no model load; only fires when a query
  // embedding and at least one route prototype are available.
  if (opts.embedQuery && opts.prototypes && opts.prototypes.size > 0) {
    const protos = opts.prototypes;
    // Catch ONLY the embedding I/O — let synchronous defects (Type/RangeError)
    // in the scoring below escape instead of being masked as a "trying
    // classifier" fallback. (Review finding 2026-06.)
    let q: number[] | null = null;
    try {
      q = await opts.embedQuery();
    } catch (e) {
      logDiag({ level: "warn", source: "chat-router", message: "semantic embed failed; trying classifier", detail: e });
    }
    if (q && q.length) {
      const scored = routes
        .map((r) => ({ r, proto: protos.get(r.id) }))
        .filter((x): x is { r: ChatRoute; proto: number[] } => Array.isArray(x.proto))
        .map((x) => ({ r: x.r, score: cosineSim(q, x.proto) }))
        .sort((a, b) => b.score - a.score);
      if (scored.length > 0) {
        const threshold = opts.threshold ?? 0.5;
        const margin = opts.margin ?? 0.05;
        const top = scored[0];
        const second = scored[1]?.score ?? -1;
        if (top.score >= threshold && top.score - second >= margin) {
          const method: RouteDecision["method"] =
            sticky && top.r.id === sticky.id ? "sticky" : "semantic";
          return decisionFrom(top.r, method, `cosine ${top.score.toFixed(2)}`, top.score);
        }
      }
    }
  }

  // Stage 3 — LLM classifier (on the active/hot model).
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
      const reason = stripThinking(out).trim().replace(/^\d+[).\s-]*/, "").trim().slice(0, 200) || undefined;
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
 * Build a one-shot classifier fn from the active backend.
 *
 * CRITICAL — reasoning models: a small token budget makes thinking models
 * (qwen3.*, gemma4, deepseek-r1, …) return EMPTY — they spend the whole budget
 * on hidden <think> tokens and never reach the answer, and raising the budget
 * is unreliable (a longer prompt → more thinking). The robust fix is to DISABLE
 * thinking. Ollama's native `/api/chat` accepts `think:false` (the OpenAI-compat
 * `/v1` endpoint does not), so the Ollama path uses it directly: verified 6/6
 * correct + fast on local reasoning models, and harmless on non-thinking ones.
 *
 * Non-Ollama backends (cloud/custom, native mistralrs, mlx) keep the stream-
 * client path with a generous cap; the thinking text, if streamed inline, is
 * stripped by `stripThinking` before the number is parsed.
 */
const OLLAMA_BASE = "http://127.0.0.1:11434";

export function makeClassifier(
  status: ServerStatus,
  signal?: AbortSignal,
): (prompt: string) => Promise<string> {
  return async (prompt: string): Promise<string> => {
    // Ollama (and the default/unknown backend) → native /api/chat, thinking off.
    if (!status.backend || status.backend === "ollama") {
      try {
        const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: status.model,
            messages: [{ role: "user", content: prompt }],
            stream: false,
            think: false,
            options: { num_predict: 128, temperature: 0 },
          }),
          signal,
        });
        if (res.ok) {
          const data = await res.json();
          const c = data?.message?.content;
          if (typeof c === "string" && c.trim()) return c;
        }
      } catch {
        /* fall through to the stream-client path */
      }
    }
    // Cloud / custom / native / mlx → stream-client accumulation, generous cap.
    const CLASSIFY_MAX_TOKENS = 512;
    const msgs: Message[] = [{ conversation_id: 0, role: "user", content: prompt }];
    let stream: AsyncGenerator<{ delta: string; done: boolean }>;
    if (status.backend === "openrouter") {
      stream = streamCustomChat("openrouter", msgs, { model: status.model ?? undefined, maxTokens: CLASSIFY_MAX_TOKENS, signal });
    } else if (status.backend === "custom") {
      stream = streamCustomChat(status.model ?? "", msgs, { maxTokens: CLASSIFY_MAX_TOKENS, signal });
    } else if (status.backend === "native") {
      stream = streamNativeChat(msgs, { maxTokens: CLASSIFY_MAX_TOKENS, signal });
    } else {
      stream = streamChat(status, msgs, { maxTokens: CLASSIFY_MAX_TOKENS, signal });
    }
    let acc = "";
    for await (const chunk of stream) {
      if (chunk.done) break;
      acc += chunk.delta;
      if (acc.length > 16000) break; // safety bound; reasoning can be verbose
    }
    return acc;
  };
}

/**
 * Full router used by the chat send path: builds route prototypes (cached) +
 * a query embedder via the local embedding model, plus the LLM classifier from
 * the active backend, then runs the tiered pipeline. If embeddings aren't
 * available the semantic stage is silently skipped and routing falls back to
 * keyword + classifier (the MVP behavior).
 */
export async function routeChatMessage(
  text: string,
  routes: ChatRoute[],
  opts: { status: ServerStatus; stickyRouteId?: string | null; signal?: AbortSignal },
): Promise<RouteDecision | null> {
  if (routes.length === 0) return null;
  const embedFn = (t: string) => embed(t, opts.signal);
  let prototypes = new Map<string, number[]>();
  // Skip the prototype build (one embed RTT per route utterance) when a keyword
  // fast-path will match anyway — keep the cheap stage cheap.
  if (!hasKeywordMatch(text, routes)) {
    try {
      prototypes = await buildPrototypes(routes, embedFn);
    } catch {
      /* no embedder → semantic stage skipped */
    }
  }
  return routeMessage(text, routes, {
    stickyRouteId: opts.stickyRouteId,
    classify: makeClassifier(opts.status, opts.signal),
    embedQuery: () => embedFn(text),
    prototypes,
  });
}
