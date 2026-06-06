# Multi-Model Router — Architecture & Design

Status: **design + MVP** (2026-06). Owner: Froglips.

A chat layer that, per message, picks the best-fit configured model/role and runs
it — so a "web research" model, a "coding" model, and a "reasoning" model can all
live behind one chat and Froglips chooses automatically.

---

## 1. Verdict

A **tiered decision-router**:

```
override → keyword fast-path → semantic (embeddings) → small-LLM classifier → default
```

with **stickiness + hysteresis** per conversation. Zero training data, fully local,
<100 ms for most messages, transparent, overridable. ~70% of the plumbing already
exists in Froglips (Router workflow node, local embeddings, presets, the
`Message.model` column, model-change dividers in the transcript).

## 2. The constraint that shapes everything: load latency, not classify latency

From the codebase + research, the dominant cost is **swapping models**, not deciding:

- The agent (tool-calling) loop supports `ollama | mlx | native` only. The "cloud
  tier" inside routing is an Ollama `:cloud` tag, or an OpenRouter/custom backend on
  the **plain-chat** path (no tools).
- **native** (mistralrs) holds ONE model in-process; **MLX** similar → routing across
  them serially reloads (12-15 s for a 32B).
- **Ollama** can hold several resident (`OLLAMA_MAX_LOADED_MODELS`,
  `OLLAMA_NUM_PARALLEL`) → **Ollama is the only backend where multi-model routing is
  cheap.** Cold load ≈ 3-5 s (7B) / 12-15 s (32B).
- Classify cost is trivial by comparison: embedding 10-100 ms; a hot small LLM
  200-500 ms.

**Design rules that follow:**
1. Route primarily among **already-resident** Ollama models; tie-break toward what is
   loaded (`/api/ps`).
2. **Disclose** cold loads before they happen ("loading `<model>` ~N s") — research is
   unanimous: "the fix for cold starts is disclosure, not speed."
3. Keep the classifier model **hot**.
4. **Hysteresis**: bias against switching, because every switch can cost a multi-second
   reload + context re-ingestion.

## 3. Core abstraction: a route IS a Role

A route is not just a model. It is **model + backend + Role(preset)**. A preset already
carries `systemPromptOverride` + `allowedTools`. So "specialist" config and routing are
the same object, and routing composes with agent mode (the "Web researcher" route =
model X + `web_search` tool + researcher persona).

```ts
interface ChatRoute {
  id: string;
  label: string;              // "Coder"
  whenToUse: string;          // natural-language description → LLM classifier (Stage 3)
  utterances?: string[];      // 3-10 example queries → embeddings (Stage 2)
  keywords?: string[];        // regex/keywords → fast-path (Stage 1)
  model: string;
  backend: "ollama" | "mlx" | "native" | "custom" | "openrouter";
  preset?: string | null;     // Role: system prompt + tool allowlist
  prototypeEmbedding?: number[]; // precomputed at save (Stage 2)
  escalateTo?: string | null; // optional per-route cascade target
}
```

Storage: localStorage (`chat.routes`), mirroring custom presets (no Rust/DB change for
MVP). Per-conversation runtime state: `routingEnabled`, `stickyRouteId`.

## 4. Routing pipeline (per message)

| Stage | Mechanism | Latency | Reuses |
|---|---|---|---|
| 0 | **Override** — user pinned a model / "stick to this model" | 0 ms | model picker |
| 1 | **Keyword/regex** — code fences, math symbols, `/cmd`, language tags | ~0 ms | new |
| 2 | **Semantic** — embed query, cosine vs precomputed prototypes; accept if top ≥ threshold AND margin to 2nd ≥ 0.05 | 10-100 ms | `memory-client.embed()` (nomic-embed-text) |
| 3 | **LLM classifier** — only on Stage-2 ambiguity; hot small model, route descriptions → route number + 1-line reason | 200-500 ms | `runRouter` in `workflow/nodes.ts` (lifted) |
| 4 | **Default** — bias toward the MORE capable model; never silent-fail | — | new |

**Anti-thrash:** keep `stickyRouteId`; switch only if the new route beats the current by a
margin (≥0.1) or a hard intent-switch (Stage 1) fires. For the LLM classifier, pass the
current route as context: "currently using X; switch only if clearly better."

## 5. Integration points (exact)

1. `src/hooks/useChatSend.ts` (~L350, before the agent/stream branch): compute
   `effectiveModel/backend/preset` via `routeMessage()`. Fallback to `status.*` on any
   failure — current behavior fully preserved.
2. Stream dispatch (~L512-541): already branches by backend; feed it the effective
   model/backend.
3. Persist (~L618/644): `addMessage(..., effectiveModel)`. **`Message.model` exists
   (migration v2)** — no DB change.
4. `MessageList.tsx`: model-change **dividers already render**. Add an inline chip
   ("→ Coder · qwen3-coder · semantic 0.81") + click-to-override (sticky).
5. New: `src/lib/chat-router.ts` (pipeline + store), `RoutesSettings.tsx` (route editor,
   cloned from `CustomBackendsSettings.tsx`), an "Auto-route" chat toggle.

## 6. Hard problems → solutions

- **Cold-start reload** → check `/api/ps`; show "loading <model> ~N s"; hysteresis;
  prefer resident models.
- **Confidence without logprobs** → for the optional per-route cascade, use a
  critic/self-verify pass (already built: Cascade/Critic nodes). Do NOT ask the model
  "how confident are you" — research: unreliable.
- **Multi-intent** → hybrid coarse(semantic)→fine(LLM), which is exactly Stage 2→3.
- **native/MLX single-model** → documented: fast multi-model routing is an Ollama
  capability; native/MLX routes work but reload serially.

## 7. Phased build

1. **MVP** — keyword + LLM-classifier (Stages 0/1/3/4), reuse `runRouter`, route editor,
   live status + per-message model chip, sticky route per conversation. Plain-chat path
   first (agent mode keeps the active model in MVP).
2. **+ Semantic Stage 2** — precompute prototypes, embed query, threshold + margin. Cuts
   most decisions to ~50 ms.
3. **+ Hysteresis + cold-load disclosure** — the polish that stops it being annoying.
4. **+ Per-route cascade** — escalate local→cloud on low critic score (reuse Cascade
   node).
5. **+ Learned router (optional)** — log every decision (query, scores, route, override);
   later bootstrap a RouteLLM-style matrix-factorization/BERT router from real usage.
   This is the only path from cold-start heuristics to a trained router.

## 8. Calibration & evaluation

Ship defaults (cosine 0.5, margin 0.05). Log decisions. Offer a `fit()`-style threshold
sweep over a handful of labeled examples (semantic-router: 67 examples → 91% accuracy).
Offline metric = RouterArena "routing optimality" (did we pick the cheapest model that
was still correct?).

## 9. SOTA anchors

- **RouteLLM (LMSYS)** — matrix-factorization router hit 95% of GPT-4 quality at 14-26%
  of GPT-4 calls; >85% cost reduction; >40% cheaper than commercial routers.
  Calibrated by a **cost threshold** (fraction sent to the strong model), not an
  answer-confidence threshold.
- **FrugalGPT** — cheap→expensive cascade with a trained DistilBERT answer-scorer; up to
  98% cost reduction matching the best single model. Confidence without logprobs.
- **OpenRouter `auto`** (NotDiamond) — per-request; signals = prompt complexity, task
  type, model capabilities; exposes `cost_quality_tradeoff` (0-10); returns the model
  actually used.
- **semantic-router** (Aurelio) — per-route example utterances, cosine match, default
  threshold 0.5, per-route `fit()`.
- **Benchmarks** — RouterBench (405k inferences), RouterArena (8.4k queries, 9 domains,
  "routing optimality").

Sources: lmsys.org/blog/2024-07-01-routellm, arXiv:2406.18665, arXiv:2305.05176,
docs.aurelio.ai/semantic-router, openrouter.ai/docs (auto router), arXiv:2403.12031
(RouterBench), arXiv:2510.00202 (RouterArena).

## 10. What's missing in the codebase (to build)

- No per-model capability matrix (reasoning/code/tools flags). Fine — routes are
  user-defined `whenToUse`/utterances. Optionally seed route suggestions from
  ModelBrowser's curated tags.
- No keyword fast-path, no embedding-route matching, no decision log — all new, all small.
