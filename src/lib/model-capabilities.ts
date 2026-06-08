/**
 * Model capability detection — currently scoped to vision support.
 *
 * Rather than fetching per-model metadata from every backend (Ollama's API
 * exposes it; MLX & mistralrs do not in a uniform way), we use a name-pattern
 * heuristic. False positives here are cheap (the backend just rejects the
 * image); false negatives hide the image-attach button on a capable model.
 *
 * The list is the authoritative fallback. A future maturity step (audit
 * MED, 2026-05-28) is to consult Ollama's `/api/show` `capabilities`
 * array (it lists "vision" for multimodal models) and treat this regex
 * set as the default only when the backend doesn't report. Until that
 * lands, keeping the family list current is the cheapest way to stay
 * correct — see the test suite which pins each family so a regression
 * (or a new family addition) is deliberate.
 */

const VISION_MODEL_PATTERNS: RegExp[] = [
  /llava/i,
  /vision/i,
  /qwen2\.?5?[._-]?vl/i, // qwen2-vl, qwen2.5-vl
  /qwen-?vl/i,
  /qwen3[._-]?vl/i,
  /gemma-?3/i,
  /gemma-?4/i,
  /minicpm-?v/i,
  /pixtral/i,
  /llama-?3\.2-vision/i,
  /llama-?4/i, // Llama 4 Scout/Maverick are natively multimodal
  /moondream/i,
  /internvl/i,
  /cogvlm/i,
  /phi-?3\.5?-vision/i,
  /phi-?4.*multimodal/i,
  /mistral-small.*3\.[12]/i, // Mistral Small 3.1/3.2 are vision-capable
  /smolvlm/i,
  /idefics/i,
  /molmo/i,
  /aya-?vision/i,
];

/** Returns true if the given model id matches a known vision-capable family. */
export function modelSupportsVision(modelId: string | null | undefined): boolean {
  if (!modelId) return false;
  return VISION_MODEL_PATTERNS.some((re) => re.test(modelId));
}

/* ── Tool-calling fitness ────────────────────────────────────────────────────
 *
 * Agent mode + Flows only work if the model reliably emits OpenAI-style tool
 * calls. Small base models, abliterated/uncensored variants, and some chat-only
 * families narrate ("I would run `ls`…") or mangle the call instead — burning
 * the iteration budget. This heuristic lets the UI gently steer the user to a
 * model that will succeed BEFORE they hit a wall. A backend capability probe
 * (Ollama `/api/show`) can override it; this is the authoritative fallback.
 * Pinned per-family in the test suite so a regression is deliberate.
 */
export type ToolFitness = "good" | "weak" | "untested";

/** Families that reliably tool-call (local + cloud). */
const TOOL_GOOD_PATTERNS: RegExp[] = [
  /qwen-?2\.?5/i,
  /qwen-?3/i,
  /hermes-?3/i,
  /mistral-?nemo/i,
  /mistral-?small/i,
  /mistral-?large/i,
  /\bmixtral/i,
  /llama-?3\.[13]/i, // 3.1 / 3.3 — strong tool callers
  /command-?r/i,
  /firefunction/i,
  /functionary/i,
  // Cloud / frontier (via :cloud tags or custom backends).
  /gpt-?[45]/i,
  /\bo[1-9]\b/i,
  /claude/i,
  /gemini/i,
  /deepseek/i,
  /glm-?[45]/i,
  /\bkimi/i,
];

/** Families that mangle or skip tool calls — weak wins over good on conflict. */
const TOOL_WEAK_PATTERNS: RegExp[] = [
  /abliterated/i,
  /uncensored/i,
  /dolphin/i,
  /gemma/i, // gemma 2/3/4 hedge/narrate instead of calling
  /phi-?[234]/i, // small phi narrates
  /tinyllama/i,
  /\b0\.5b\b/i,
  /\b1b\b/i, // 1B-class too small for reliable tool use
  /llama-?2\b/i,
  /codellama/i,
];

/**
 * Classify a model's tool-calling fitness from its id. "weak" is checked first
 * so an abliterated build of an otherwise-good family (e.g. an abliterated
 * qwen) is correctly flagged weak. Unknown families → "untested" (no warning,
 * no false confidence).
 */
export function classifyToolFitness(modelId: string | null | undefined): ToolFitness {
  if (!modelId) return "untested";
  if (TOOL_WEAK_PATTERNS.some((re) => re.test(modelId))) return "weak";
  if (TOOL_GOOD_PATTERNS.some((re) => re.test(modelId))) return "good";
  return "untested";
}

/** Per-message attachment caps. UX bound — not a backend limit. */
export const MAX_IMAGES_PER_MESSAGE = 4;
/** Per-image size cap before base64 expansion. 4 MiB matches the "useful for
 * a Tauri IPC payload without choking JSON" threshold. */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
