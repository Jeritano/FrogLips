/**
 * Model capability detection — currently scoped to vision support.
 *
 * Rather than fetching per-model metadata from every backend (Ollama's API
 * exposes it; MLX & mistralrs do not in a uniform way), we use a name-pattern
 * heuristic. This is intentionally a small hardcoded list — false positives
 * here are cheap (the backend just rejects the image) and a manual override
 * via the UI would be heavier-weight than warranted right now.
 */

const VISION_MODEL_PATTERNS: RegExp[] = [
  /llava/i,
  /vision/i,
  /qwen2[._-]?vl/i,
  /qwen-?vl/i,
  /gemma-?3/i,
  /minicpm-?v/i,
  /pixtral/i,
  /llama-?3\.2-vision/i,
  /moondream/i,
];

/** Returns true if the given model id matches a known vision-capable family. */
export function modelSupportsVision(modelId: string | null | undefined): boolean {
  if (!modelId) return false;
  return VISION_MODEL_PATTERNS.some((re) => re.test(modelId));
}

/** Per-message attachment caps. UX bound — not a backend limit. */
export const MAX_IMAGES_PER_MESSAGE = 4;
/** Per-image size cap before base64 expansion. 4 MiB matches the "useful for
 * a Tauri IPC payload without choking JSON" threshold. */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
