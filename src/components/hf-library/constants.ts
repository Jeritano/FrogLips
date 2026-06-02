/**
 * Static configuration for the HuggingFace library view.
 *
 * Lists below mirror the top-of-list entries on https://huggingface.co/models.
 * The "+ N" counts at the end of each section are advisory — the popover
 * expander just shows the same list as `_more` (HF doesn't expose a public
 * "all known libraries" endpoint, so we approximate it here).
 *
 * All slugs are lowercase to match HF's filter slugs (e.g. `pipeline_tag`
 * uses `text-generation`, `library` uses `mlx` / `gguf`).
 */

export interface FilterEntry {
  /** Slug passed to HF as a filter value. */
  slug: string;
  /** Human-readable label shown in the sidebar. */
  label: string;
}

/* ── Tasks ───────────────────────────────────────────────────────────────── */
// Top 8 visible by default, the next chunk under "+ N more".
export const TASKS_TOP: FilterEntry[] = [
  { slug: "text-generation",     label: "Text Generation" },
  { slug: "any-to-any",          label: "Any-to-Any" },
  { slug: "image-text-to-text",  label: "Image-Text-to-Text" },
  { slug: "image-to-text",       label: "Image-to-Text" },
  { slug: "image-to-image",      label: "Image-to-Image" },
  { slug: "text-to-image",       label: "Text-to-Image" },
  { slug: "text-to-video",       label: "Text-to-Video" },
  { slug: "text-to-speech",      label: "Text-to-Speech" },
];
export const TASKS_MORE: FilterEntry[] = [
  { slug: "automatic-speech-recognition", label: "Speech Recognition" },
  { slug: "audio-to-audio",               label: "Audio-to-Audio" },
  { slug: "audio-classification",         label: "Audio Classification" },
  { slug: "voice-activity-detection",     label: "Voice Activity Detection" },
  { slug: "depth-estimation",             label: "Depth Estimation" },
  { slug: "image-classification",         label: "Image Classification" },
  { slug: "object-detection",             label: "Object Detection" },
  { slug: "image-segmentation",           label: "Image Segmentation" },
  { slug: "video-classification",         label: "Video Classification" },
  { slug: "zero-shot-image-classification",     label: "Zero-Shot Image Class." },
  { slug: "mask-generation",              label: "Mask Generation" },
  { slug: "visual-question-answering",    label: "Visual Q&A" },
  { slug: "document-question-answering",  label: "Document Q&A" },
  { slug: "image-to-3d",                  label: "Image-to-3D" },
  { slug: "text-to-3d",                   label: "Text-to-3D" },
  { slug: "text-classification",          label: "Text Classification" },
  { slug: "token-classification",         label: "Token Classification" },
  { slug: "table-question-answering",     label: "Table Q&A" },
  { slug: "question-answering",           label: "Question Answering" },
  { slug: "zero-shot-classification",     label: "Zero-Shot Classification" },
  { slug: "translation",                  label: "Translation" },
  { slug: "summarization",                label: "Summarization" },
  { slug: "feature-extraction",           label: "Feature Extraction" },
  { slug: "text-to-audio",                label: "Text-to-Audio" },
  { slug: "sentence-similarity",          label: "Sentence Similarity" },
  { slug: "fill-mask",                    label: "Fill-Mask" },
  { slug: "robotics",                     label: "Robotics" },
  { slug: "reinforcement-learning",       label: "Reinforcement Learning" },
  { slug: "text-to-video",                label: "Text-to-Video" },
  { slug: "video-text-to-text",           label: "Video-Text-to-Text" },
  { slug: "image-feature-extraction",     label: "Image Feature Extraction" },
  { slug: "keypoint-detection",           label: "Keypoint Detection" },
  { slug: "graph-ml",                     label: "Graph ML" },
  { slug: "tabular-classification",       label: "Tabular Classification" },
  { slug: "tabular-regression",           label: "Tabular Regression" },
  { slug: "time-series-forecasting",      label: "Time-Series Forecasting" },
  { slug: "any-to-any",                   label: "Any-to-Any (duplicate)" },
];

/* ── Libraries ───────────────────────────────────────────────────────────── */
export const LIBRARIES_TOP: FilterEntry[] = [
  { slug: "pytorch",                label: "PyTorch" },
  { slug: "tensorflow",             label: "TensorFlow" },
  { slug: "jax",                    label: "JAX" },
  { slug: "transformers",           label: "Transformers" },
  { slug: "diffusers",              label: "Diffusers" },
  { slug: "gguf",                   label: "GGUF" },
  { slug: "mlx",                    label: "MLX" },
  { slug: "transformers.js",        label: "Transformers.js" },
  { slug: "safetensors",            label: "Safetensors" },
  { slug: "sentence-transformers",  label: "sentence-transformers" },
  { slug: "onnx",                   label: "ONNX" },
];
export const LIBRARIES_MORE: FilterEntry[] = [
  { slug: "peft",                label: "PEFT" },
  { slug: "openvino",            label: "OpenVINO" },
  { slug: "tensorboard",         label: "TensorBoard" },
  { slug: "candle",              label: "Candle" },
  { slug: "keras",               label: "Keras" },
  { slug: "espnet",              label: "ESPnet" },
  { slug: "stable-baselines3",   label: "Stable-Baselines3" },
  { slug: "asteroid",            label: "Asteroid" },
  { slug: "fastai",              label: "fastai" },
  { slug: "speechbrain",         label: "speechbrain" },
  { slug: "spacy",               label: "spaCy" },
  { slug: "fasttext",            label: "fastText" },
  { slug: "rust",                label: "Rust" },
  { slug: "litgpt",              label: "LitGPT" },
  { slug: "ml-agents",           label: "ML-Agents" },
  { slug: "flair",               label: "Flair" },
  { slug: "txtai",               label: "txtai" },
  { slug: "nemo",                label: "NeMo" },
  { slug: "joblib",              label: "joblib" },
  { slug: "scikit-learn",        label: "scikit-learn" },
  { slug: "tflite",              label: "TFLite" },
  { slug: "coreml",              label: "Core ML" },
  { slug: "mlx-lm",              label: "MLX-LM" },
  { slug: "exllamav2",           label: "ExLlamaV2" },
  { slug: "exllama",             label: "ExLlama" },
  { slug: "vllm",                label: "vLLM (library)" },
];

/* ── Apps (HF-side: these are inference apps, mostly client-side filter) ─── */
export const APPS_TOP: FilterEntry[] = [
  { slug: "vllm",          label: "vLLM" },
  { slug: "llama.cpp",     label: "llama.cpp" },
  { slug: "mlx-lm",        label: "MLX LM" },
  { slug: "lm-studio",     label: "LM Studio" },
  { slug: "ollama",        label: "Ollama" },
  { slug: "jan",           label: "Jan" },
  { slug: "draw-things",   label: "Draw Things" },
];
export const APPS_MORE: FilterEntry[] = [
  { slug: "text-generation-inference", label: "TGI" },
  { slug: "candle",                    label: "Candle (App)" },
  { slug: "exllamav2",                 label: "ExLlamaV2" },
  { slug: "koboldcpp",                 label: "KoboldCpp" },
  { slug: "tabby",                     label: "Tabby" },
  { slug: "open-webui",                label: "OpenWebUI" },
  { slug: "msty",                      label: "Msty" },
  { slug: "anything-llm",              label: "AnythingLLM" },
];

/* ── Inference Providers ─────────────────────────────────────────────────── */
export const PROVIDERS_TOP: FilterEntry[] = [
  { slug: "groq",        label: "Groq" },
  { slug: "novita",      label: "Novita" },
  { slug: "cerebras",    label: "Cerebras" },
  { slug: "sambanova",   label: "SambaNova" },
  { slug: "nscale",      label: "Nscale" },
  { slug: "fal",         label: "fal" },
  { slug: "hyperbolic",  label: "Hyperbolic" },
  { slug: "together",    label: "Together AI" },
];
export const PROVIDERS_MORE: FilterEntry[] = [
  { slug: "replicate",         label: "Replicate" },
  { slug: "fireworks-ai",      label: "Fireworks AI" },
  { slug: "deepinfra",         label: "DeepInfra" },
  { slug: "anyscale",          label: "Anyscale" },
  { slug: "perplexity",        label: "Perplexity" },
  { slug: "mistral",           label: "Mistral" },
  { slug: "openrouter",        label: "OpenRouter" },
  { slug: "huggingface",       label: "Hugging Face" },
  { slug: "modal",             label: "Modal" },
  { slug: "runpod",            label: "RunPod" },
  { slug: "azure",             label: "Azure" },
];

/* ── Parameter slider tick marks ─────────────────────────────────────────── */
// The slider lets the user pick min/max parameter buckets. The tick array
// drives both the rendered marks and the value→bucket mapping.
export const PARAM_TICKS = [
  { label: "<1B",   value: 0,      max: 1_000_000_000 },
  { label: "6B",    value: 1,      max: 6_000_000_000 },
  { label: "12B",   value: 2,      max: 12_000_000_000 },
  { label: "32B",   value: 3,      max: 32_000_000_000 },
  { label: "128B",  value: 4,      max: 128_000_000_000 },
  { label: ">500B", value: 5,      max: Infinity },
] as const;

/* ── Pipeline tag → chip colour ──────────────────────────────────────────── */
// Loose palette inspired by HF's pipeline badges. Anything not listed falls
// back to a neutral grey via the consumer.
export const PIPELINE_COLOR: Record<string, string> = {
  "text-generation":         "#3b82f6",
  "any-to-any":              "#a855f7",
  "image-text-to-text":      "#ec4899",
  "image-to-text":           "#f97316",
  "image-to-image":          "#06b6d4",
  "text-to-image":           "#ef4444",
  "text-to-video":           "#d946ef",
  "text-to-speech":          "#22c55e",
  "automatic-speech-recognition": "#f59e0b",
  "audio-classification":    "#10b981",
  "feature-extraction":      "#6b7280",
  "sentence-similarity":     "#6b7280",
  "image-classification":    "#0ea5e9",
  "object-detection":        "#84cc16",
  "image-segmentation":      "#eab308",
  "depth-estimation":        "#14b8a6",
  "visual-question-answering": "#a78bfa",
  "video-text-to-text":      "#f472b6",
  "translation":             "#60a5fa",
  "summarization":           "#34d399",
  "text-classification":     "#fbbf24",
};

export const SORT_OPTIONS: { value: string; label: string }[] = [
  { value: "trending",     label: "Trending" },
  { value: "createdAt",    label: "Recently Created" },
  { value: "lastModified", label: "Recently Updated" },
  { value: "downloads",    label: "Most Downloads" },
  { value: "likes",        label: "Most Likes" },
];
