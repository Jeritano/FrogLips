import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api } from "../lib/tauri-api";
import { useModalA11y } from "../lib/use-modal-a11y";
import { useTwoClickConfirm } from "../lib/use-two-click-confirm";
import type {
  GgufDownloadProgress,
  GgufFile,
  ModelEntry,
  OllamaPullProgress,
} from "../types";
import { OllamaLibraryView } from "./OllamaLibraryView";
import { InstalledModelsTab } from "./model-browser/InstalledModelsTab";
import { CatalogTab } from "./model-browser/CatalogTab";
import type { CatalogEntry } from "./model-browser/catalog";
import { OpenRouterBrowserTab } from "./model-browser/OpenRouterBrowserTab";
import { LlmpmPanel } from "./LlmpmPanel";
import { ModelScopeBrowserTab } from "./model-browser/ModelScopeBrowserTab";
import { useHardwareProfile } from "../hooks/useHardwareProfile";
import { X } from "lucide-react";
/** Type-only re-import for the GGUF tree shape — HuggingFaceLibraryView owns
 *  it now; this stays a type-level import so the lazy() chunk boundary holds. */
import type { HfTreeEntry } from "./HuggingFaceLibraryView";

// Lazy-loaded HF library view. Pulls in ~600 LOC + its constants/sidebar/card
// chunks; we keep it out of the initial bundle so first-paint of the rest
// of ModelBrowser stays small.
const HuggingFaceLibraryView = lazy(() =>
  import("./HuggingFaceLibraryView").then((m) => ({
    default: m.HuggingFaceLibraryView,
  })),
);

type Backend =
  | "ollama"
  | "hf"
  | "installed"
  | "catalog"
  | "openrouter"
  | "llmpm"
  | "modelscope";

/* GGUF tree shape lives inside HuggingFaceLibraryView now (the GGUF tab
 * routes through that component in `ggufMode`). ModelBrowser keeps
 * ownership of the per-file download/install/progress state so a download
 * started here keeps progressing if the user wanders to another tab —
 * it's passed in through `ggufContext`. */

/* ───────────────────────────────────────────────────────────────────────────
   Curated Ollama catalog. Sourced from ollama.com/library — popular models.
   Single source of truth for BOTH the Ollama-library fallback AND the curated
   "Catalog" tab (model-browser/CatalogTab). `CatalogEntry` is the shared shape
   from model-browser/catalog.ts.
   ─────────────────────────────────────────────────────────────────────── */
export const OLLAMA: CatalogEntry[] = [
  // ── Ollama Cloud (hosted by Ollama, no local VRAM) ──
  {
    id: "kimi-k2-thinking:cloud",
    label: "Kimi K2 Thinking",
    size: "cloud",
    tags: ["cloud", "reasoning"],
    desc: "Moonshot Kimi K2 reasoning variant, hosted",
  },
  {
    id: "kimi-k2.6:cloud",
    label: "Kimi K2.6",
    size: "cloud",
    tags: ["cloud", "chat"],
    desc: "Moonshot's 1T-param flagship, hosted",
  },
  {
    id: "kimi-k2.5:cloud",
    label: "Kimi K2.5",
    size: "cloud",
    tags: ["cloud", "chat"],
    desc: "Previous Kimi K2, hosted",
  },
  {
    id: "deepseek-v4-pro:cloud",
    label: "DeepSeek V4 Pro",
    size: "cloud",
    tags: ["cloud", "chat"],
    desc: "Latest DeepSeek flagship, hosted",
  },
  {
    id: "deepseek-v3.1:671b-cloud",
    label: "DeepSeek V3.1 671B",
    size: "cloud",
    tags: ["cloud", "chat"],
    desc: "Full DeepSeek V3.1 MoE, hosted",
  },
  {
    id: "deepseek-r1:cloud",
    label: "DeepSeek R1",
    size: "cloud",
    tags: ["cloud", "reasoning"],
    desc: "Full R1 reasoning, hosted",
  },
  {
    id: "qwen3-coder:480b-cloud",
    label: "Qwen3 Coder 480B",
    size: "cloud",
    tags: ["cloud", "code"],
    desc: "Full Qwen3 Coder MoE, hosted",
  },
  {
    id: "qwen3-max:cloud",
    label: "Qwen3 Max",
    size: "cloud",
    tags: ["cloud", "chat"],
    desc: "Alibaba flagship, hosted",
  },
  {
    id: "gpt-oss:120b-cloud",
    label: "GPT-OSS 120B",
    size: "cloud",
    tags: ["cloud", "chat"],
    desc: "OpenAI's open model, hosted",
  },
  {
    id: "glm-4.6:cloud",
    label: "GLM 4.6",
    size: "cloud",
    tags: ["cloud", "chat"],
    desc: "Zhipu AI flagship, hosted",
  },
  {
    id: "minimax-m2:cloud",
    label: "MiniMax M2",
    size: "cloud",
    tags: ["cloud", "chat"],
    desc: "MiniMax flagship, hosted",
  },

  // Qwen
  {
    id: "qwen3-coder:30b",
    label: "Qwen3 Coder 30B",
    size: "18 GB",
    tags: ["code"],
    desc: "Alibaba's top coding model with thinking mode",
  },
  {
    id: "qwen3-coder:7b",
    label: "Qwen3 Coder 7B",
    size: "4.5 GB",
    tags: ["code"],
    desc: "Fast Qwen3 coder, mid-size",
  },
  {
    id: "qwen3:30b-a3b",
    label: "Qwen3 30B MoE",
    size: "18 GB",
    tags: ["chat"],
    desc: "Efficient MoE, strong reasoning",
  },
  {
    id: "qwen3:32b",
    label: "Qwen3 32B",
    size: "20 GB",
    tags: ["chat"],
    desc: "Dense Qwen3 flagship",
  },
  {
    id: "qwen3:14b",
    label: "Qwen3 14B",
    size: "9 GB",
    tags: ["chat"],
    desc: "Capable mid-size Qwen3",
  },
  {
    id: "qwen3:8b",
    label: "Qwen3 8B",
    size: "5 GB",
    tags: ["chat"],
    desc: "Fast everyday Qwen3",
  },
  {
    id: "qwen3:4b",
    label: "Qwen3 4B",
    size: "2.6 GB",
    tags: ["chat"],
    desc: "Compact Qwen3",
  },
  {
    id: "qwen2.5:72b",
    label: "Qwen2.5 72B",
    size: "47 GB",
    tags: ["chat"],
    desc: "Previous-gen Qwen flagship",
  },
  {
    id: "qwen2.5:32b",
    label: "Qwen2.5 32B",
    size: "20 GB",
    tags: ["chat"],
    desc: "Dense Qwen2.5",
  },
  {
    id: "qwen2.5-coder:32b",
    label: "Qwen2.5 Coder 32B",
    size: "20 GB",
    tags: ["code"],
    desc: "Strong code-focused Qwen2.5",
  },
  {
    id: "qwen2.5-coder:14b",
    label: "Qwen2.5 Coder 14B",
    size: "9 GB",
    tags: ["code"],
    desc: "Mid-size coder",
  },
  {
    id: "qwen2.5-coder:7b",
    label: "Qwen2.5 Coder 7B",
    size: "4.7 GB",
    tags: ["code"],
    desc: "Fast coder, great for IDE use",
  },
  {
    id: "qwen2-math:7b",
    label: "Qwen2 Math 7B",
    size: "4.4 GB",
    tags: ["math"],
    desc: "Math-specialized Qwen2",
  },

  // DeepSeek
  {
    id: "deepseek-r1:671b",
    label: "DeepSeek R1 671B",
    size: "404 GB",
    tags: ["reasoning"],
    desc: "Full R1 — needs 512+ GB unified memory",
  },
  {
    id: "deepseek-r1:70b",
    label: "DeepSeek R1 70B",
    size: "43 GB",
    tags: ["reasoning"],
    desc: "Distilled R1, rivals o1",
  },
  {
    id: "deepseek-r1:32b",
    label: "DeepSeek R1 32B",
    size: "20 GB",
    tags: ["reasoning"],
    desc: "Mid-size R1 distill",
  },
  {
    id: "deepseek-r1:14b",
    label: "DeepSeek R1 14B",
    size: "9 GB",
    tags: ["reasoning"],
    desc: "R1 distill for smaller machines",
  },
  {
    id: "deepseek-r1:8b",
    label: "DeepSeek R1 8B",
    size: "5 GB",
    tags: ["reasoning"],
    desc: "Compact R1 distill",
  },
  {
    id: "deepseek-v3:671b",
    label: "DeepSeek V3 671B",
    size: "404 GB",
    tags: ["chat"],
    desc: "DeepSeek V3 base, MoE",
  },
  {
    id: "deepseek-coder-v2:236b",
    label: "DeepSeek Coder V2 236B",
    size: "133 GB",
    tags: ["code"],
    desc: "Coder V2 flagship MoE",
  },
  {
    id: "deepseek-coder-v2:16b",
    label: "DeepSeek Coder V2 16B",
    size: "10 GB",
    tags: ["code"],
    desc: "Strong mid-size coder",
  },
  {
    id: "deepseek-coder:33b",
    label: "DeepSeek Coder 33B",
    size: "19 GB",
    tags: ["code"],
    desc: "Classic DeepSeek coder",
  },
  {
    id: "deepseek-coder:6.7b",
    label: "DeepSeek Coder 6.7B",
    size: "3.8 GB",
    tags: ["code"],
    desc: "Compact coder",
  },

  // Llama
  {
    id: "llama3.3:70b",
    label: "Llama 3.3 70B",
    size: "43 GB",
    tags: ["chat"],
    desc: "Meta's best open chat model",
  },
  {
    id: "llama3.2:3b",
    label: "Llama 3.2 3B",
    size: "2 GB",
    tags: ["chat"],
    desc: "Tiny, fast, runs anywhere",
  },
  {
    id: "llama3.2:1b",
    label: "Llama 3.2 1B",
    size: "1.3 GB",
    tags: ["chat"],
    desc: "Smallest Llama for edge use",
  },
  {
    id: "llama3.2-vision:11b",
    label: "Llama 3.2 Vision 11B",
    size: "8 GB",
    tags: ["vision"],
    desc: "Multimodal Llama",
  },
  {
    id: "llama3.2-vision:90b",
    label: "Llama 3.2 Vision 90B",
    size: "55 GB",
    tags: ["vision"],
    desc: "Large multimodal Llama",
  },
  {
    id: "llama3.1:70b",
    label: "Llama 3.1 70B",
    size: "43 GB",
    tags: ["chat"],
    desc: "Previous gen Llama flagship",
  },
  {
    id: "llama3.1:8b",
    label: "Llama 3.1 8B",
    size: "4.7 GB",
    tags: ["chat"],
    desc: "Reliable mid-size Llama",
  },
  {
    id: "codellama:70b",
    label: "Code Llama 70B",
    size: "40 GB",
    tags: ["code"],
    desc: "Meta's largest code model",
  },
  {
    id: "codellama:34b",
    label: "Code Llama 34B",
    size: "19 GB",
    tags: ["code"],
    desc: "Mid-size code Llama",
  },
  {
    id: "codellama:13b",
    label: "Code Llama 13B",
    size: "7.4 GB",
    tags: ["code"],
    desc: "Compact code Llama",
  },
  {
    id: "codellama:7b",
    label: "Code Llama 7B",
    size: "3.8 GB",
    tags: ["code"],
    desc: "Fast code Llama",
  },

  // Gemma
  {
    id: "gemma3:27b",
    label: "Gemma 3 27B",
    size: "16 GB",
    tags: ["chat"],
    desc: "Google's flagship open model",
  },
  {
    id: "gemma3:12b",
    label: "Gemma 3 12B",
    size: "8 GB",
    tags: ["chat"],
    desc: "Strong mid-size Google model",
  },
  {
    id: "gemma3:4b",
    label: "Gemma 3 4B",
    size: "3 GB",
    tags: ["chat"],
    desc: "Compact Gemma 3",
  },
  {
    id: "gemma3:1b",
    label: "Gemma 3 1B",
    size: "815 MB",
    tags: ["chat"],
    desc: "Tiny Gemma 3",
  },
  {
    id: "gemma2:27b",
    label: "Gemma 2 27B",
    size: "16 GB",
    tags: ["chat"],
    desc: "Previous gen Gemma flagship",
  },
  {
    id: "gemma2:9b",
    label: "Gemma 2 9B",
    size: "5.4 GB",
    tags: ["chat"],
    desc: "Reliable mid-size Gemma",
  },
  {
    id: "codegemma:7b",
    label: "CodeGemma 7B",
    size: "5 GB",
    tags: ["code"],
    desc: "Google's code-specialized Gemma",
  },

  // Microsoft
  {
    id: "phi4:14b",
    label: "Phi-4 14B",
    size: "9 GB",
    tags: ["chat", "reasoning"],
    desc: "Microsoft's dense reasoning model",
  },
  {
    id: "phi4-mini:3.8b",
    label: "Phi-4 Mini 3.8B",
    size: "2.5 GB",
    tags: ["chat"],
    desc: "Tiny Phi-4, punches above weight",
  },
  {
    id: "phi3.5:3.8b",
    label: "Phi-3.5 Mini 3.8B",
    size: "2.2 GB",
    tags: ["chat"],
    desc: "Earlier Phi compact",
  },
  {
    id: "phi3:14b",
    label: "Phi-3 Medium 14B",
    size: "7.9 GB",
    tags: ["chat"],
    desc: "Phi-3 medium",
  },
  {
    id: "phi3:3.8b",
    label: "Phi-3 Mini 3.8B",
    size: "2.3 GB",
    tags: ["chat"],
    desc: "Original Phi-3 mini",
  },

  // Mistral
  {
    id: "mistral-large:123b",
    label: "Mistral Large 123B",
    size: "73 GB",
    tags: ["chat"],
    desc: "Mistral's flagship dense model",
  },
  {
    id: "mistral-small:24b",
    label: "Mistral Small 24B",
    size: "14 GB",
    tags: ["chat"],
    desc: "Mid-size Mistral",
  },
  {
    id: "mistral-nemo:12b",
    label: "Mistral Nemo 12B",
    size: "7.1 GB",
    tags: ["chat"],
    desc: "Nvidia-Mistral collab",
  },
  {
    id: "mistral:7b",
    label: "Mistral 7B",
    size: "4.1 GB",
    tags: ["chat"],
    desc: "Classic fast chat model",
  },
  {
    id: "mixtral:8x22b",
    label: "Mixtral 8x22B",
    size: "80 GB",
    tags: ["chat"],
    desc: "Largest Mistral MoE",
  },
  {
    id: "mixtral:8x7b",
    label: "Mixtral 8x7B",
    size: "26 GB",
    tags: ["chat"],
    desc: "Mistral MoE, fast for size",
  },
  {
    id: "codestral:22b",
    label: "Codestral 22B",
    size: "13 GB",
    tags: ["code"],
    desc: "Mistral's code-specialized model",
  },
  {
    id: "mathstral:7b",
    label: "Mathstral 7B",
    size: "4.1 GB",
    tags: ["math"],
    desc: "Math-tuned Mistral",
  },

  // NVIDIA
  {
    id: "nemotron:70b",
    label: "Nemotron 70B",
    size: "43 GB",
    tags: ["chat"],
    desc: "Nvidia's Llama 3.1 fine-tune",
  },
  {
    id: "nemotron-mini:4b",
    label: "Nemotron Mini 4B",
    size: "2.7 GB",
    tags: ["chat"],
    desc: "Small Nemotron",
  },

  // Cohere
  {
    id: "command-r-plus:104b",
    label: "Command R+ 104B",
    size: "59 GB",
    tags: ["chat", "rag"],
    desc: "Cohere's flagship RAG model",
  },
  {
    id: "command-r:35b",
    label: "Command R 35B",
    size: "20 GB",
    tags: ["chat", "rag"],
    desc: "Cohere RAG-optimized",
  },

  // Yi (01.AI)
  {
    id: "yi:34b",
    label: "Yi 34B",
    size: "19 GB",
    tags: ["chat"],
    desc: "01.AI's strong English/Chinese model",
  },
  {
    id: "yi:9b",
    label: "Yi 9B",
    size: "5 GB",
    tags: ["chat"],
    desc: "Mid-size Yi",
  },
  {
    id: "yi-coder:9b",
    label: "Yi Coder 9B",
    size: "5 GB",
    tags: ["code"],
    desc: "Yi code-specialized",
  },
  {
    id: "yi-coder:1.5b",
    label: "Yi Coder 1.5B",
    size: "866 MB",
    tags: ["code"],
    desc: "Tiny Yi coder",
  },

  // Vision
  {
    id: "llava:34b",
    label: "LLaVA 34B",
    size: "19 GB",
    tags: ["vision"],
    desc: "Large multimodal LLaVA",
  },
  {
    id: "llava:13b",
    label: "LLaVA 13B",
    size: "7.4 GB",
    tags: ["vision"],
    desc: "Mid-size LLaVA",
  },
  {
    id: "llava:7b",
    label: "LLaVA 7B",
    size: "4.5 GB",
    tags: ["vision"],
    desc: "Compact LLaVA",
  },
  {
    id: "llava-llama3:8b",
    label: "LLaVA-Llama3 8B",
    size: "5.5 GB",
    tags: ["vision"],
    desc: "LLaVA on Llama 3",
  },
  {
    id: "llava-phi3:3.8b",
    label: "LLaVA-Phi3 3.8B",
    size: "2.9 GB",
    tags: ["vision"],
    desc: "Tiny multimodal",
  },
  {
    id: "moondream:1.8b",
    label: "Moondream 1.8B",
    size: "1.7 GB",
    tags: ["vision"],
    desc: "Compact vision model",
  },
  {
    id: "minicpm-v:8b",
    label: "MiniCPM-V 8B",
    size: "5.5 GB",
    tags: ["vision"],
    desc: "Efficient vision-language model",
  },

  // Tool use
  {
    id: "hermes3:8b",
    label: "Hermes 3 8B",
    size: "4.7 GB",
    tags: ["tools"],
    desc: "NousResearch tool-use model",
  },
  {
    id: "hermes3:70b",
    label: "Hermes 3 70B",
    size: "43 GB",
    tags: ["tools"],
    desc: "Large tool-use model",
  },
  {
    id: "llama3-groq-tool-use:8b",
    label: "Groq Tool Use 8B",
    size: "4.7 GB",
    tags: ["tools"],
    desc: "Groq-tuned for tool calls",
  },

  // IBM Granite
  {
    id: "granite3.1-dense:8b",
    label: "Granite 3.1 Dense 8B",
    size: "5 GB",
    tags: ["chat"],
    desc: "IBM's enterprise model",
  },
  {
    id: "granite-code:34b",
    label: "Granite Code 34B",
    size: "20 GB",
    tags: ["code"],
    desc: "IBM's code model",
  },
  {
    id: "granite-code:8b",
    label: "Granite Code 8B",
    size: "4.6 GB",
    tags: ["code"],
    desc: "Compact IBM coder",
  },

  // Tiny / edge
  {
    id: "smollm2:1.7b",
    label: "SmolLM2 1.7B",
    size: "1.1 GB",
    tags: ["chat"],
    desc: "Tiny capable model",
  },
  {
    id: "smollm2:360m",
    label: "SmolLM2 360M",
    size: "270 MB",
    tags: ["chat"],
    desc: "Tiny model for edge",
  },
  {
    id: "tinyllama:1.1b",
    label: "TinyLlama 1.1B",
    size: "638 MB",
    tags: ["chat"],
    desc: "Smallest Llama-arch model",
  },

  // Specialty
  {
    id: "starcoder2:15b",
    label: "StarCoder2 15B",
    size: "9 GB",
    tags: ["code"],
    desc: "BigCode's coder",
  },
  {
    id: "starcoder2:7b",
    label: "StarCoder2 7B",
    size: "4 GB",
    tags: ["code"],
    desc: "Compact StarCoder2",
  },
  {
    id: "sqlcoder:15b",
    label: "SQLCoder 15B",
    size: "9 GB",
    tags: ["code"],
    desc: "SQL-specialized",
  },
  {
    id: "neural-chat:7b",
    label: "Neural Chat 7B",
    size: "4.1 GB",
    tags: ["chat"],
    desc: "Intel-tuned chat model",
  },
  {
    id: "starling-lm:7b",
    label: "Starling LM 7B",
    size: "4.1 GB",
    tags: ["chat"],
    desc: "Berkeley RLAIF-trained",
  },
  {
    id: "openhermes:7b",
    label: "OpenHermes 7B",
    size: "4.1 GB",
    tags: ["chat"],
    desc: "NousResearch classic",
  },
  {
    id: "llama-guard3:8b",
    label: "Llama Guard 3 8B",
    size: "4.9 GB",
    tags: ["safety"],
    desc: "Content safety classifier",
  },
  {
    id: "shieldgemma:9b",
    label: "ShieldGemma 9B",
    size: "5.4 GB",
    tags: ["safety"],
    desc: "Google's safety classifier",
  },

  // Embeddings
  {
    id: "nomic-embed-text:latest",
    label: "Nomic Embed Text",
    size: "274 MB",
    tags: ["embed"],
    desc: "Fast local text embeddings",
  },
  {
    id: "mxbai-embed-large:latest",
    label: "MixedBread Embed Large",
    size: "670 MB",
    tags: ["embed"],
    desc: "High-quality embeddings",
  },
  {
    id: "snowflake-arctic-embed:latest",
    label: "Arctic Embed",
    size: "669 MB",
    tags: ["embed"],
    desc: "Snowflake's embeddings",
  },
  {
    id: "bge-m3:latest",
    label: "BGE M3",
    size: "1.2 GB",
    tags: ["embed"],
    desc: "BAAI multilingual embeddings",
  },
  {
    id: "all-minilm:latest",
    label: "All-MiniLM",
    size: "46 MB",
    tags: ["embed"],
    desc: "Tiny fast embeddings",
  },

  // Falcon
  {
    id: "falcon3:10b",
    label: "Falcon 3 10B",
    size: "6.3 GB",
    tags: ["chat"],
    desc: "TII's latest Falcon",
  },
  {
    id: "falcon3:7b",
    label: "Falcon 3 7B",
    size: "4.6 GB",
    tags: ["chat"],
    desc: "Compact Falcon 3",
  },
];

/* Stable fallback array for OllamaLibraryView. OLLAMA is a module constant
 * whose projected shape never changes, so we compute this once instead of
 * re-mapping ~100 objects on every ModelBrowser render (perf: low). */
const OLLAMA_FALLBACK = OLLAMA.map((c) => ({
  id: c.id,
  label: c.label,
  desc: c.desc,
  tags: c.tags,
  size: c.size,
}));

interface Props {
  onClose: () => void;
  onPulled: () => void;
  /** Chosen OpenRouter model id → parent activates it (cloud, no
   *  download) + closes the library. */
  onSelectOpenRouter?: (modelId: string) => void;
}

export function ModelBrowser({ onClose, onPulled, onSelectOpenRouter }: Props) {
  const [tab, setTab] = useState<Backend>("installed");
  const [query, setQuery] = useState("");
  // Detected machine RAM for the Catalog tab's fit badges. Same module-deduped
  // hook the model picker uses, so the verdict is identical across surfaces.
  const { profile } = useHardwareProfile();
  const [pulling, setPulling] = useState<string | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Map<string, string>>(new Map());
  const [installedOllama, setInstalledOllama] = useState<ModelEntry[]>([]);
  const [installedMlx, setInstalledMlx] = useState<ModelEntry[]>([]);
  const [installedErr, setInstalledErr] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  // Two-click confirm for delete (window.confirm() is disabled in Tauri 2
  // webview). `armed` is the id currently armed; passed to child views as
  // the `confirmDelete` prop.
  const removeConfirm = useTwoClickConfirm();
  const confirmDelete = removeConfirm.armed;

  async function refreshInstalled() {
    try {
      const all = await api.listAllModels();
      setInstalledOllama(all.ollama);
      setInstalledMlx(all.mlx);
      setInstalledErr(all.ollama_error ?? all.mlx_error ?? null);
    } catch (e) {
      setInstalledErr(String(e));
    }
  }

  useEffect(() => {
    refreshInstalled();
  }, []);

  const installedMlxIds = useMemo(
    () => new Set(installedMlx.map((m) => m.id)),
    [installedMlx],
  );

  function requestRemove(id: string, backend: "ollama" | "mlx") {
    // First click arms; second click within the window confirms. Tauri 2
    // webview disables synchronous window.confirm, so we use an inline pattern.
    removeConfirm.request(id, () => void remove(id, backend));
  }

  async function remove(id: string, backend: "ollama" | "mlx") {
    setDeleting(id);
    setErrors((m) => {
      const n = new Map(m);
      n.delete(id);
      return n;
    });
    try {
      if (backend === "ollama") {
        await api.deleteOllamaModel(id);
      } else {
        await api.deleteMlxModel(id);
      }
      await refreshInstalled();
      onPulled(); // refresh ModelPicker
      setDone((s) => {
        const n = new Set(s);
        n.delete(id);
        return n;
      });
    } catch (e) {
      setErrors((m) => new Map([...m, [id, String(e)]]));
    } finally {
      setDeleting(null);
    }
  }

  /* GGUF tab state. HuggingFaceLibraryView (with `ggufMode`) does the
     server-side repo search itself; ModelBrowser only owns the long-lived
     per-file state (file trees, install list, downloads, progress) so a
     download started here keeps progressing if the user switches tabs. */
  /** Expanded repo id → file tree (or `null` while loading, `string` error). */
  const [ggufTrees, setGgufTrees] = useState<
    Map<string, HfTreeEntry[] | "loading" | { error: string }>
  >(new Map());
  /** Live download progress, keyed by `${repo}/${filename}`. */
  const [ggufProgress, setGgufProgress] = useState<
    Map<string, GgufDownloadProgress>
  >(new Map());
  /** Live progress for the in-flight ollama pull (one at a time). */
  const [ollamaProgress, setOllamaProgress] =
    useState<OllamaPullProgress | null>(null);
  /** Locally-cached `.gguf` files, populated from `nativeListGgufFiles`. */
  const [ggufInstalled, setGgufInstalled] = useState<GgufFile[]>([]);
  const [ggufInstalledErr, setGgufInstalledErr] = useState<string | null>(null);
  /** Set of `${repo}/${filename}` currently being downloaded. */
  const [ggufDownloading, setGgufDownloading] = useState<Set<string>>(
    new Set(),
  );
  /** True once the user clicks "View files" on a GGUF repo in the HF tab —
   *  flips the HF library view into GGUF mode (inline per-file expanders).
   *  Reset when the source selector changes. */
  const [hfGgufMode, setHfGgufMode] = useState(false);

  // Wire up the per-download progress event ONCE per browser open. Stays
  // mounted across tab switches so a download started on the GGUF tab keeps
  // updating its row even if the user wanders to "Installed".
  useEffect(() => {
    let off: UnlistenFn | undefined;
    let cancelled = false;
    (async () => {
      try {
        off = await listen<GgufDownloadProgress>(
          "gguf-download-progress",
          (e) => {
            if (cancelled) return;
            const p = e.payload;
            setGgufProgress((m) => {
              const key = `${p.repo}/${p.filename}`;
              const next = new Map(m);
              next.set(key, p);
              return next;
            });
          },
        );
      } catch {
        // listen() can fail in non-Tauri test environments — that's fine,
        // the progress display just stays at 0 in that case.
      }
    })();
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  // Live ollama-pull progress. One pull runs at a time, so a single latest
  // payload is enough; the active card matches it by `name`.
  useEffect(() => {
    let off: UnlistenFn | undefined;
    let cancelled = false;
    (async () => {
      try {
        off = await listen<OllamaPullProgress>("ollama-pull-progress", (e) => {
          if (cancelled) return;
          setOllamaProgress(e.payload);
        });
      } catch {
        // listen() unavailable in non-Tauri test env — bar just stays hidden.
      }
    })();
    return () => {
      cancelled = true;
      off?.();
    };
  }, []);

  async function refreshGgufInstalled() {
    try {
      const list = await api.nativeListGgufFiles();
      setGgufInstalled(Array.isArray(list) ? list : []);
      setGgufInstalledErr(null);
    } catch (e) {
      setGgufInstalledErr(String(e));
    }
  }
  // Load installed GGUF once on mount + whenever the GGUF tab is opened.
  useEffect(() => {
    void refreshGgufInstalled();
  }, []);
  useEffect(() => {
    if (tab === "hf" || tab === "installed") void refreshGgufInstalled();
  }, [tab]);

  // Audit L-F5 (2026-05-28): HF tree fetch had no AbortSignal. Closing
  // the browser mid-fetch let the request complete and call setGgufTrees
  // on an unmounted component (React 18 warns; setState was a no-op).
  // Single AbortController scoped to the component lifetime; loadGgufTree
  // ties each fetch to it and the cleanup aborts everything in flight.
  const hfFetchAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    return () => {
      hfFetchAbortRef.current?.abort();
      hfFetchAbortRef.current = null;
    };
  }, []);

  /* The HF tab owns its own debounced fetch / abort / state inside its
     sibling component (HuggingFaceLibraryView). ModelBrowser no longer
     drives those requests. */

  /** Lazy-load the file tree for a GGUF repo when the user clicks its row. */
  async function loadGgufTree(repoId: string) {
    setGgufTrees((m) => new Map([...m, [repoId, "loading"]]));
    // Lazy-init the AbortController so we don't pay for it until the user
    // actually issues an HF fetch.
    if (!hfFetchAbortRef.current) {
      hfFetchAbortRef.current = new AbortController();
    }
    const signal = hfFetchAbortRef.current.signal;
    try {
      // Encode each path SEGMENT but keep the org/name slash literal — HF's
      // tree route is /api/models/{org}/{name}/tree/main, so encoding the slash
      // to %2F collapses it into one segment and the API 400s.
      const safeRepo = repoId.split("/").map(encodeURIComponent).join("/");
      const url = `https://huggingface.co/api/models/${safeRepo}/tree/main`;
      const res = await fetch(url, { signal });
      if (!res.ok) throw new Error(`HF tree API ${res.status}`);
      const data: HfTreeEntry[] = await res.json();
      // Filter to GGUF leaves only — directories and sidecar files (README.md,
      // config.json, tokenizer.json) just clutter the row.
      const ggufs = (Array.isArray(data) ? data : []).filter(
        (e) => e.type === "file" && /\.gguf$/i.test(e.path),
      );
      setGgufTrees((m) => new Map([...m, [repoId, ggufs]]));
    } catch (e) {
      // Abort during unmount: swallow silently — setState would be a
      // no-op anyway and we don't want to surface a faux error toast.
      if (signal.aborted) return;
      const msg = e instanceof Error ? e.message : String(e);
      setGgufTrees((m) => new Map([...m, [repoId, { error: msg }]]));
    }
  }

  /** Kick off a single-file GGUF download. Progress is wired through the
   *  `gguf-download-progress` event listener mounted at the top of this
   *  component; this handler just toggles the inflight flag + clears it
   *  on success/failure. */
  async function downloadGguf(repoId: string, filename: string) {
    const key = `${repoId}/${filename}`;
    setGgufDownloading((s) => new Set([...s, key]));
    setErrors((m) => {
      const n = new Map(m);
      n.delete(key);
      return n;
    });
    try {
      await api.agentNativeDownloadGguf(repoId, filename);
      await refreshGgufInstalled();
      onPulled();
    } catch (e) {
      setErrors((m) => new Map([...m, [key, String(e)]]));
    } finally {
      setGgufDownloading((s) => {
        const n = new Set(s);
        n.delete(key);
        return n;
      });
    }
  }

  /** Remove a cached GGUF. Uses the same two-click confirm pattern as the
   *  other Remove buttons; the GGUF-specific key is `gguf:${repo}/${file}`
   *  so it can't collide with the MLX/Ollama confirm keys. */
  function requestRemoveGguf(repo: string, filename: string) {
    const id = `gguf:${repo}/${filename}`;
    removeConfirm.request(id, () => void removeGguf(repo, filename));
  }

  async function removeGguf(repo: string, filename: string) {
    const id = `gguf:${repo}/${filename}`;
    setDeleting(id);
    setErrors((m) => {
      const n = new Map(m);
      n.delete(id);
      return n;
    });
    try {
      await api.nativeDeleteGguf(repo, filename);
      await refreshGgufInstalled();
      onPulled();
    } catch (e) {
      setErrors((m) => new Map([...m, [id, String(e)]]));
    } finally {
      setDeleting(null);
    }
  }

  async function pull(id: string, backend: Backend) {
    setPulling(id);
    setErrors((m) => {
      const n = new Map(m);
      n.delete(id);
      return n;
    });
    try {
      if (backend === "ollama") {
        await api.pullOllamaModel(id);
      } else {
        await api.pullHfModel(id);
      }
      setDone((s) => new Set([...s, id]));
      onPulled();
      refreshInstalled();
    } catch (e) {
      setErrors((m) => new Map([...m, [id, String(e)]]));
    } finally {
      setPulling(null);
      setOllamaProgress(null);
    }
  }

  return (
    <ModelBrowserOverlay onClose={onClose}>
      <div className="mb-panel">
        {/* Header */}
        <div className="mb-header">
          <div className="mb-title">Model Library</div>
          {/* The new HuggingFaceLibraryView ships its own filter-by-name input,
              so we hide the global one in those two tabs to avoid double UI. */}
          {tab !== "hf" && (
            <input
              data-testid="model-search"
              className="mb-search"
              placeholder={
                tab === "ollama"
                  ? "Filter Ollama models…"
                  : tab === "catalog"
                    ? "Filter curated catalog…"
                    : tab === "openrouter"
                      ? "Filter OpenRouter models…"
                      : "Filter installed models…"
              }
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
          )}
          {tab === "hf" && <div style={{ flex: 1 }} />}
          <button
            className="mb-close"
            onClick={onClose}
            aria-label="Close model library"
          >
            <X size={16} />
          </button>
        </div>

        {/* Source selector */}
        <div className="mb-tabs">
          <label className="mb-source-label" htmlFor="mb-source-select">
            Source:
          </label>
          <select
            id="mb-source-select"
            className="mb-source-select"
            value={tab}
            onChange={(e) => {
              const next = e.target.value as Backend;
              setTab(next);
              setQuery("");
              setHfGgufMode(false);
              if (next === "installed") refreshInstalled();
            }}
          >
            <option value="installed">
              Installed (
              {installedOllama.length +
                installedMlx.length +
                ggufInstalled.length}
              )
            </option>
            <option value="catalog">Catalog ({OLLAMA.length})</option>
            <option value="ollama">Ollama ({OLLAMA.length})</option>
            <option value="hf">HuggingFace (live)</option>
            <option value="openrouter">OpenRouter (cloud)</option>
            <option value="llmpm">llmpm (local serve)</option>
            <option value="modelscope">ModelScope (live)</option>
          </select>
        </div>

        {/* List */}
        <div className={`mb-list ${tab === "hf" ? "mb-list-hfl" : ""}`}>
          {tab === "installed" && (
            <InstalledModelsTab
              installedOllama={installedOllama}
              installedMlx={installedMlx}
              ggufInstalled={ggufInstalled}
              installedErr={installedErr}
              ggufInstalledErr={ggufInstalledErr}
              deleting={deleting}
              errors={errors}
              confirmDelete={confirmDelete}
              query={query}
              requestRemove={requestRemove}
              requestRemoveGguf={requestRemoveGguf}
              onRetry={() => {
                void refreshInstalled();
                void refreshGgufInstalled();
              }}
            />
          )}

          {tab === "catalog" && (
            <CatalogTab
              catalog={OLLAMA}
              installedOllama={installedOllama}
              machine={profile}
              query={query}
              pull={(name) => void pull(name, "ollama")}
              requestRemove={(name) => requestRemove(name, "ollama")}
              pulling={pulling}
              pullProgress={ollamaProgress}
              deleting={deleting}
              done={done}
              errors={errors}
              confirmDelete={confirmDelete}
            />
          )}

          {tab === "ollama" && (
            <OllamaLibraryView
              installedOllama={installedOllama}
              pull={(name) => void pull(name, "ollama")}
              requestRemove={(name) => requestRemove(name, "ollama")}
              pulling={pulling}
              pullProgress={ollamaProgress}
              deleting={deleting}
              done={done}
              errors={errors}
              confirmDelete={confirmDelete}
              fallback={OLLAMA_FALLBACK}
              query={query}
            />
          )}

          {tab === "hf" && (
            <Suspense
              fallback={
                <div className="mb-empty">
                  <span className="mb-spinner mb-spinner-lg" /> Loading library
                  view…
                </div>
              }
            >
              <HuggingFaceLibraryView
                key={hfGgufMode ? "hfl-gguf" : "hfl"}
                ggufMode={hfGgufMode}
                installedMlxIds={installedMlxIds}
                onPull={(id) => void pull(id, "hf")}
                onRequestRemove={(id) => requestRemove(id, "mlx")}
                onViewGguf={(id) => {
                  setHfGgufMode(true);
                  void loadGgufTree(id);
                }}
                onOpenHf={(id) => {
                  api.openExternal(`https://huggingface.co/${id}`).catch(() => {
                    window.open(
                      `https://huggingface.co/${id}`,
                      "_blank",
                      "noreferrer",
                    );
                  });
                }}
                pulling={pulling}
                done={done}
                errors={errors}
                confirmDelete={confirmDelete}
                ggufContext={{
                  installed: ggufInstalled,
                  trees: ggufTrees,
                  downloads: ggufDownloading,
                  progress: ggufProgress,
                  errors,
                  confirmDelete,
                  deleting,
                  onExpandRepo: (repoId) => void loadGgufTree(repoId),
                  onCollapseRepo: (repoId) =>
                    setGgufTrees((mp) => {
                      const n = new Map(mp);
                      n.delete(repoId);
                      return n;
                    }),
                  onDownloadFile: (repo, filename) =>
                    void downloadGguf(repo, filename),
                  onDeleteFile: (repo, filename) =>
                    requestRemoveGguf(repo, filename),
                }}
              />
            </Suspense>
          )}

          {tab === "openrouter" && (
            <OpenRouterBrowserTab
              query={query}
              onSelect={(modelId) => {
                onSelectOpenRouter?.(modelId);
                onClose();
              }}
            />
          )}
          {tab === "llmpm" && <LlmpmPanel />}
          {tab === "modelscope" && <ModelScopeBrowserTab query={query} />}
        </div>
      </div>
    </ModelBrowserOverlay>
  );
}

/**
 * Modal a11y wrapper for the model browser. Owns the container ref + the
 * Escape / focus-trap behaviour so they don't muddy the (already huge) main
 * component body.
 */
function ModelBrowserOverlay({
  onClose,
  children,
}: {
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useModalA11y({ open: true, onClose, containerRef: ref });
  // Deterministically hide the top chrome (hamburger / collapse / view-
  // tabs / drag strip) while the library is open. z-index alone wasn't
  // enough — the chrome's fixed/absolute elements live in a stacking
  // context that paints above the modal regardless of z values
  // (2026-05-29). Toggling a root class + `visibility:hidden` in CSS
  // sidesteps the stacking quirk entirely.
  useEffect(() => {
    document.documentElement.classList.add("chrome-hidden");
    return () => document.documentElement.classList.remove("chrome-hidden");
  }, []);
  return (
    <div
      className="mb-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Model library"
      ref={ref}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {children}
    </div>
  );
}
