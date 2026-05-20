import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/tauri-api";

type Backend = "ollama" | "hf" | "rp" | "civitai";

interface CatalogEntry {
  id: string;
  label: string;
  size: string;
  tags: string[];
  desc: string;
}

interface HfModel {
  id: string;
  downloads: number;
  likes: number;
  tags?: string[];
  pipeline_tag?: string;
  library_name?: string;
  lastModified?: string;
  createdAt?: string;
  gated?: boolean | string;
  private?: boolean;
}

interface CivitaiImage {
  url: string;
}

interface CivitaiFile {
  sizeKB?: number;
  primary?: boolean;
  pickleScanResult?: string;
  virusScanResult?: string;
  metadata?: { format?: string; size?: string; fp?: string };
}

interface CivitaiVersion {
  name?: string;
  baseModel?: string;
  baseModelType?: string;
  files?: CivitaiFile[];
  images?: CivitaiImage[];
  publishedAt?: string;
  trainedWords?: string[];
}

interface CivitaiModel {
  id: number;
  name: string;
  description?: string;
  type: string;
  nsfw: boolean;
  tags?: string[];
  creator?: { username: string };
  stats?: {
    downloadCount?: number;
    thumbsUpCount?: number;
    ratingCount?: number;
    rating?: number;
  };
  modelVersions?: CivitaiVersion[];
  allowCommercialUse?: string | string[];
  allowDerivatives?: boolean;
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
}

function fmtSize(kb?: number): string | null {
  if (!kb) return null;
  if (kb >= 1024 * 1024) return `${(kb / 1024 / 1024).toFixed(1)} GB`;
  if (kb >= 1024) return `${(kb / 1024).toFixed(0)} MB`;
  return `${kb} KB`;
}

// Civitai CDN URLs embed sizing as a path segment ("original=true" or "width=N").
// Rewrite to a small thumbnail size so we don't pull multi-MB originals.
function civitaiThumbUrl(url: string, width = 144): string {
  return url.replace(/\/(original=true|width=\d+|height=\d+|fit=[\w-]+)\//, `/width=${width}/`);
}

function relativeTime(iso?: string): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  const diff = Date.now() - then;
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  const yr = Math.floor(day / 365);
  return `${yr}y ago`;
}

interface HfTagInfo {
  baseModel: string | null;
  license: string | null;
  language: string | null;
  pipeline: string | null;
  quant: string | null;
}

function parseHfTags(tags: string[] | undefined, pipeline_tag?: string): HfTagInfo {
  const info: HfTagInfo = {
    baseModel: null,
    license: null,
    language: null,
    pipeline: pipeline_tag && pipeline_tag !== "text-generation" ? pipeline_tag : null,
    quant: null,
  };
  if (!tags) return info;
  for (const t of tags) {
    if (t.startsWith("base_model:") && !t.includes(":finetune:") && !t.includes(":quantized:") && !info.baseModel) {
      info.baseModel = t.slice("base_model:".length);
    } else if (t.startsWith("license:") && !info.license) {
      info.license = t.slice("license:".length);
    }
  }
  return info;
}

function pipelineShort(p: string): string {
  return p
    .replace("automatic-speech-recognition", "ASR")
    .replace("text-to-image", "T2I")
    .replace("image-to-text", "I2T")
    .replace("feature-extraction", "embed")
    .replace("sentence-similarity", "embed")
    .replace("text-classification", "classify")
    .replace("question-answering", "QA");
}

function parseCommercialUse(v: string | string[] | undefined): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  // Civitai returns Postgres array literal: "{Image,RentCivit,Rent}"
  return v.replace(/^\{|\}$/g, "").split(",").map((s) => s.trim()).filter(Boolean);
}

function filterCatalog(list: CatalogEntry[], query: string): CatalogEntry[] {
  if (!query.trim()) return list;
  const q = query.toLowerCase();
  return list.filter((e) =>
    e.label.toLowerCase().includes(q) ||
    e.id.toLowerCase().includes(q) ||
    e.desc.toLowerCase().includes(q) ||
    e.tags.some((t) => t.includes(q))
  );
}

function civitaiLicenseShort(m: CivitaiModel): string {
  const commercial = parseCommercialUse(m.allowCommercialUse).length > 0;
  if (commercial && m.allowDerivatives) return "permissive";
  if (commercial && !m.allowDerivatives) return "comm-only";
  if (!commercial && m.allowDerivatives) return "non-comm";
  return "restricted";
}

/* ───────────────────────────────────────────────────────────────────────────
   Curated Ollama catalog. Sourced from ollama.com/library — popular models.
   ─────────────────────────────────────────────────────────────────────── */
const OLLAMA: CatalogEntry[] = [
  // ── Ollama Cloud (hosted by Ollama, no local VRAM) ──
  { id: "kimi-k2.6:cloud",            label: "Kimi K2.6",                  size: "cloud", tags: ["cloud", "chat"],      desc: "Moonshot's 1T-param flagship, hosted" },
  { id: "kimi-k2.5:cloud",            label: "Kimi K2.5",                  size: "cloud", tags: ["cloud", "chat"],      desc: "Previous Kimi K2, hosted" },
  { id: "deepseek-v4-pro:cloud",      label: "DeepSeek V4 Pro",            size: "cloud", tags: ["cloud", "chat"],      desc: "Latest DeepSeek flagship, hosted" },
  { id: "deepseek-v3.1:671b-cloud",   label: "DeepSeek V3.1 671B",         size: "cloud", tags: ["cloud", "chat"],      desc: "Full DeepSeek V3.1 MoE, hosted" },
  { id: "deepseek-r1:cloud",          label: "DeepSeek R1",                size: "cloud", tags: ["cloud", "reasoning"], desc: "Full R1 reasoning, hosted" },
  { id: "qwen3-coder:480b-cloud",     label: "Qwen3 Coder 480B",           size: "cloud", tags: ["cloud", "code"],      desc: "Full Qwen3 Coder MoE, hosted" },
  { id: "qwen3-max:cloud",            label: "Qwen3 Max",                  size: "cloud", tags: ["cloud", "chat"],      desc: "Alibaba flagship, hosted" },
  { id: "gpt-oss:120b-cloud",         label: "GPT-OSS 120B",               size: "cloud", tags: ["cloud", "chat"],      desc: "OpenAI's open model, hosted" },
  { id: "glm-4.6:cloud",              label: "GLM 4.6",                    size: "cloud", tags: ["cloud", "chat"],      desc: "Zhipu AI flagship, hosted" },
  { id: "minimax-m2:cloud",           label: "MiniMax M2",                 size: "cloud", tags: ["cloud", "chat"],      desc: "MiniMax flagship, hosted" },

  // Qwen
  { id: "qwen3-coder:30b",         label: "Qwen3 Coder 30B",       size: "18 GB",  tags: ["code"],       desc: "Alibaba's top coding model with thinking mode" },
  { id: "qwen3-coder:7b",          label: "Qwen3 Coder 7B",        size: "4.5 GB", tags: ["code"],       desc: "Fast Qwen3 coder, mid-size" },
  { id: "qwen3:30b-a3b",           label: "Qwen3 30B MoE",         size: "18 GB",  tags: ["chat"],       desc: "Efficient MoE, strong reasoning" },
  { id: "qwen3:32b",               label: "Qwen3 32B",             size: "20 GB",  tags: ["chat"],       desc: "Dense Qwen3 flagship" },
  { id: "qwen3:14b",               label: "Qwen3 14B",             size: "9 GB",   tags: ["chat"],       desc: "Capable mid-size Qwen3" },
  { id: "qwen3:8b",                label: "Qwen3 8B",              size: "5 GB",   tags: ["chat"],       desc: "Fast everyday Qwen3" },
  { id: "qwen3:4b",                label: "Qwen3 4B",              size: "2.6 GB", tags: ["chat"],       desc: "Compact Qwen3" },
  { id: "qwen2.5:72b",             label: "Qwen2.5 72B",           size: "47 GB",  tags: ["chat"],       desc: "Previous-gen Qwen flagship" },
  { id: "qwen2.5:32b",             label: "Qwen2.5 32B",           size: "20 GB",  tags: ["chat"],       desc: "Dense Qwen2.5" },
  { id: "qwen2.5-coder:32b",       label: "Qwen2.5 Coder 32B",     size: "20 GB",  tags: ["code"],       desc: "Strong code-focused Qwen2.5" },
  { id: "qwen2.5-coder:14b",       label: "Qwen2.5 Coder 14B",     size: "9 GB",   tags: ["code"],       desc: "Mid-size coder" },
  { id: "qwen2.5-coder:7b",        label: "Qwen2.5 Coder 7B",      size: "4.7 GB", tags: ["code"],       desc: "Fast coder, great for IDE use" },
  { id: "qwen2-math:7b",           label: "Qwen2 Math 7B",         size: "4.4 GB", tags: ["math"],       desc: "Math-specialized Qwen2" },

  // DeepSeek
  { id: "deepseek-r1:671b",        label: "DeepSeek R1 671B",      size: "404 GB", tags: ["reasoning"],  desc: "Full R1 — needs 512+ GB unified memory" },
  { id: "deepseek-r1:70b",         label: "DeepSeek R1 70B",       size: "43 GB",  tags: ["reasoning"],  desc: "Distilled R1, rivals o1" },
  { id: "deepseek-r1:32b",         label: "DeepSeek R1 32B",       size: "20 GB",  tags: ["reasoning"],  desc: "Mid-size R1 distill" },
  { id: "deepseek-r1:14b",         label: "DeepSeek R1 14B",       size: "9 GB",   tags: ["reasoning"],  desc: "R1 distill for smaller machines" },
  { id: "deepseek-r1:8b",          label: "DeepSeek R1 8B",        size: "5 GB",   tags: ["reasoning"],  desc: "Compact R1 distill" },
  { id: "deepseek-v3:671b",        label: "DeepSeek V3 671B",      size: "404 GB", tags: ["chat"],       desc: "DeepSeek V3 base, MoE" },
  { id: "deepseek-coder-v2:236b",  label: "DeepSeek Coder V2 236B",size: "133 GB", tags: ["code"],       desc: "Coder V2 flagship MoE" },
  { id: "deepseek-coder-v2:16b",   label: "DeepSeek Coder V2 16B", size: "10 GB",  tags: ["code"],       desc: "Strong mid-size coder" },
  { id: "deepseek-coder:33b",      label: "DeepSeek Coder 33B",    size: "19 GB",  tags: ["code"],       desc: "Classic DeepSeek coder" },
  { id: "deepseek-coder:6.7b",     label: "DeepSeek Coder 6.7B",   size: "3.8 GB", tags: ["code"],       desc: "Compact coder" },

  // Llama
  { id: "llama3.3:70b",            label: "Llama 3.3 70B",         size: "43 GB",  tags: ["chat"],       desc: "Meta's best open chat model" },
  { id: "llama3.2:3b",             label: "Llama 3.2 3B",          size: "2 GB",   tags: ["chat"],       desc: "Tiny, fast, runs anywhere" },
  { id: "llama3.2:1b",             label: "Llama 3.2 1B",          size: "1.3 GB", tags: ["chat"],       desc: "Smallest Llama for edge use" },
  { id: "llama3.2-vision:11b",     label: "Llama 3.2 Vision 11B",  size: "8 GB",   tags: ["vision"],     desc: "Multimodal Llama" },
  { id: "llama3.2-vision:90b",     label: "Llama 3.2 Vision 90B",  size: "55 GB",  tags: ["vision"],     desc: "Large multimodal Llama" },
  { id: "llama3.1:70b",            label: "Llama 3.1 70B",         size: "43 GB",  tags: ["chat"],       desc: "Previous gen Llama flagship" },
  { id: "llama3.1:8b",             label: "Llama 3.1 8B",          size: "4.7 GB", tags: ["chat"],       desc: "Reliable mid-size Llama" },
  { id: "codellama:70b",           label: "Code Llama 70B",        size: "40 GB",  tags: ["code"],       desc: "Meta's largest code model" },
  { id: "codellama:34b",           label: "Code Llama 34B",        size: "19 GB",  tags: ["code"],       desc: "Mid-size code Llama" },
  { id: "codellama:13b",           label: "Code Llama 13B",        size: "7.4 GB", tags: ["code"],       desc: "Compact code Llama" },
  { id: "codellama:7b",            label: "Code Llama 7B",         size: "3.8 GB", tags: ["code"],       desc: "Fast code Llama" },

  // Gemma
  { id: "gemma3:27b",              label: "Gemma 3 27B",           size: "16 GB",  tags: ["chat"],       desc: "Google's flagship open model" },
  { id: "gemma3:12b",              label: "Gemma 3 12B",           size: "8 GB",   tags: ["chat"],       desc: "Strong mid-size Google model" },
  { id: "gemma3:4b",               label: "Gemma 3 4B",            size: "3 GB",   tags: ["chat"],       desc: "Compact Gemma 3" },
  { id: "gemma3:1b",               label: "Gemma 3 1B",            size: "815 MB", tags: ["chat"],       desc: "Tiny Gemma 3" },
  { id: "gemma2:27b",              label: "Gemma 2 27B",           size: "16 GB",  tags: ["chat"],       desc: "Previous gen Gemma flagship" },
  { id: "gemma2:9b",               label: "Gemma 2 9B",            size: "5.4 GB", tags: ["chat"],       desc: "Reliable mid-size Gemma" },
  { id: "codegemma:7b",            label: "CodeGemma 7B",          size: "5 GB",   tags: ["code"],       desc: "Google's code-specialized Gemma" },

  // Microsoft
  { id: "phi4:14b",                label: "Phi-4 14B",             size: "9 GB",   tags: ["chat", "reasoning"], desc: "Microsoft's dense reasoning model" },
  { id: "phi4-mini:3.8b",          label: "Phi-4 Mini 3.8B",       size: "2.5 GB", tags: ["chat"],       desc: "Tiny Phi-4, punches above weight" },
  { id: "phi3.5:3.8b",             label: "Phi-3.5 Mini 3.8B",     size: "2.2 GB", tags: ["chat"],       desc: "Earlier Phi compact" },
  { id: "phi3:14b",                label: "Phi-3 Medium 14B",      size: "7.9 GB", tags: ["chat"],       desc: "Phi-3 medium" },
  { id: "phi3:3.8b",               label: "Phi-3 Mini 3.8B",       size: "2.3 GB", tags: ["chat"],       desc: "Original Phi-3 mini" },

  // Mistral
  { id: "mistral-large:123b",      label: "Mistral Large 123B",    size: "73 GB",  tags: ["chat"],       desc: "Mistral's flagship dense model" },
  { id: "mistral-small:24b",       label: "Mistral Small 24B",     size: "14 GB",  tags: ["chat"],       desc: "Mid-size Mistral" },
  { id: "mistral-nemo:12b",        label: "Mistral Nemo 12B",      size: "7.1 GB", tags: ["chat"],       desc: "Nvidia-Mistral collab" },
  { id: "mistral:7b",              label: "Mistral 7B",            size: "4.1 GB", tags: ["chat"],       desc: "Classic fast chat model" },
  { id: "mixtral:8x22b",           label: "Mixtral 8x22B",         size: "80 GB",  tags: ["chat"],       desc: "Largest Mistral MoE" },
  { id: "mixtral:8x7b",            label: "Mixtral 8x7B",          size: "26 GB",  tags: ["chat"],       desc: "Mistral MoE, fast for size" },
  { id: "codestral:22b",           label: "Codestral 22B",         size: "13 GB",  tags: ["code"],       desc: "Mistral's code-specialized model" },
  { id: "mathstral:7b",            label: "Mathstral 7B",          size: "4.1 GB", tags: ["math"],       desc: "Math-tuned Mistral" },

  // NVIDIA
  { id: "nemotron:70b",            label: "Nemotron 70B",          size: "43 GB",  tags: ["chat"],       desc: "Nvidia's Llama 3.1 fine-tune" },
  { id: "nemotron-mini:4b",        label: "Nemotron Mini 4B",      size: "2.7 GB", tags: ["chat"],       desc: "Small Nemotron" },

  // Cohere
  { id: "command-r-plus:104b",     label: "Command R+ 104B",       size: "59 GB",  tags: ["chat", "rag"], desc: "Cohere's flagship RAG model" },
  { id: "command-r:35b",           label: "Command R 35B",         size: "20 GB",  tags: ["chat", "rag"], desc: "Cohere RAG-optimized" },

  // Yi (01.AI)
  { id: "yi:34b",                  label: "Yi 34B",                size: "19 GB",  tags: ["chat"],       desc: "01.AI's strong English/Chinese model" },
  { id: "yi:9b",                   label: "Yi 9B",                 size: "5 GB",   tags: ["chat"],       desc: "Mid-size Yi" },
  { id: "yi-coder:9b",             label: "Yi Coder 9B",           size: "5 GB",   tags: ["code"],       desc: "Yi code-specialized" },
  { id: "yi-coder:1.5b",           label: "Yi Coder 1.5B",         size: "866 MB", tags: ["code"],       desc: "Tiny Yi coder" },

  // Vision
  { id: "llava:34b",               label: "LLaVA 34B",             size: "19 GB",  tags: ["vision"],     desc: "Large multimodal LLaVA" },
  { id: "llava:13b",               label: "LLaVA 13B",             size: "7.4 GB", tags: ["vision"],     desc: "Mid-size LLaVA" },
  { id: "llava:7b",                label: "LLaVA 7B",              size: "4.5 GB", tags: ["vision"],     desc: "Compact LLaVA" },
  { id: "llava-llama3:8b",         label: "LLaVA-Llama3 8B",       size: "5.5 GB", tags: ["vision"],     desc: "LLaVA on Llama 3" },
  { id: "llava-phi3:3.8b",         label: "LLaVA-Phi3 3.8B",       size: "2.9 GB", tags: ["vision"],     desc: "Tiny multimodal" },
  { id: "moondream:1.8b",          label: "Moondream 1.8B",        size: "1.7 GB", tags: ["vision"],     desc: "Compact vision model" },
  { id: "minicpm-v:8b",            label: "MiniCPM-V 8B",          size: "5.5 GB", tags: ["vision"],     desc: "Efficient vision-language model" },

  // Tool use
  { id: "hermes3:8b",              label: "Hermes 3 8B",           size: "4.7 GB", tags: ["tools"],      desc: "NousResearch tool-use model" },
  { id: "hermes3:70b",             label: "Hermes 3 70B",          size: "43 GB",  tags: ["tools"],      desc: "Large tool-use model" },
  { id: "llama3-groq-tool-use:8b", label: "Groq Tool Use 8B",      size: "4.7 GB", tags: ["tools"],      desc: "Groq-tuned for tool calls" },

  // Uncensored / abliterated
  { id: "dolphin-llama3:8b",       label: "Dolphin Llama3 8B",     size: "4.7 GB", tags: ["chat"],       desc: "Uncensored Llama3 fine-tune" },
  { id: "dolphin-mistral:7b",      label: "Dolphin Mistral 7B",    size: "4.1 GB", tags: ["chat"],       desc: "Uncensored Mistral fine-tune" },
  { id: "dolphin-mixtral:8x7b",    label: "Dolphin Mixtral 8x7B",  size: "26 GB",  tags: ["chat"],       desc: "Uncensored Mixtral fine-tune" },
  { id: "wizardlm-uncensored:13b", label: "WizardLM Uncensored",   size: "7.4 GB", tags: ["chat"],       desc: "Classic uncensored model" },

  // IBM Granite
  { id: "granite3.1-dense:8b",     label: "Granite 3.1 Dense 8B",  size: "5 GB",   tags: ["chat"],       desc: "IBM's enterprise model" },
  { id: "granite-code:34b",        label: "Granite Code 34B",      size: "20 GB",  tags: ["code"],       desc: "IBM's code model" },
  { id: "granite-code:8b",         label: "Granite Code 8B",       size: "4.6 GB", tags: ["code"],       desc: "Compact IBM coder" },

  // Tiny / edge
  { id: "smollm2:1.7b",            label: "SmolLM2 1.7B",          size: "1.1 GB", tags: ["chat"],       desc: "Tiny capable model" },
  { id: "smollm2:360m",            label: "SmolLM2 360M",          size: "270 MB", tags: ["chat"],       desc: "Tiny model for edge" },
  { id: "tinyllama:1.1b",          label: "TinyLlama 1.1B",        size: "638 MB", tags: ["chat"],       desc: "Smallest Llama-arch model" },

  // Specialty
  { id: "starcoder2:15b",          label: "StarCoder2 15B",        size: "9 GB",   tags: ["code"],       desc: "BigCode's coder" },
  { id: "starcoder2:7b",           label: "StarCoder2 7B",         size: "4 GB",   tags: ["code"],       desc: "Compact StarCoder2" },
  { id: "sqlcoder:15b",            label: "SQLCoder 15B",          size: "9 GB",   tags: ["code"],       desc: "SQL-specialized" },
  { id: "neural-chat:7b",          label: "Neural Chat 7B",        size: "4.1 GB", tags: ["chat"],       desc: "Intel-tuned chat model" },
  { id: "starling-lm:7b",          label: "Starling LM 7B",        size: "4.1 GB", tags: ["chat"],       desc: "Berkeley RLAIF-trained" },
  { id: "openhermes:7b",           label: "OpenHermes 7B",         size: "4.1 GB", tags: ["chat"],       desc: "NousResearch classic" },
  { id: "llama-guard3:8b",         label: "Llama Guard 3 8B",      size: "4.9 GB", tags: ["safety"],     desc: "Content safety classifier" },
  { id: "shieldgemma:9b",          label: "ShieldGemma 9B",        size: "5.4 GB", tags: ["safety"],     desc: "Google's safety classifier" },

  // Embeddings
  { id: "nomic-embed-text:latest",  label: "Nomic Embed Text",      size: "274 MB", tags: ["embed"],     desc: "Fast local text embeddings" },
  { id: "mxbai-embed-large:latest", label: "MixedBread Embed Large",size: "670 MB", tags: ["embed"],     desc: "High-quality embeddings" },
  { id: "snowflake-arctic-embed:latest", label: "Arctic Embed",     size: "669 MB", tags: ["embed"],     desc: "Snowflake's embeddings" },
  { id: "bge-m3:latest",            label: "BGE M3",                size: "1.2 GB", tags: ["embed"],     desc: "BAAI multilingual embeddings" },
  { id: "all-minilm:latest",        label: "All-MiniLM",            size: "46 MB",  tags: ["embed"],     desc: "Tiny fast embeddings" },

  // Falcon
  { id: "falcon3:10b",              label: "Falcon 3 10B",         size: "6.3 GB", tags: ["chat"],       desc: "TII's latest Falcon" },
  { id: "falcon3:7b",               label: "Falcon 3 7B",          size: "4.6 GB", tags: ["chat"],       desc: "Compact Falcon 3" },

  // Abliterated / Uncensored (huihui_ai — refusal direction removed)
  { id: "huihui_ai/qwen3-coder-abliterated:30b",       label: "Qwen3 Coder 30B (abliterated)",        size: "18 GB",  tags: ["code", "uncensored"],      desc: "Refusal-removed Qwen3 coder" },
  { id: "huihui_ai/qwen3-coder-next-abliterated:q4_K", label: "Qwen3 Coder Next 80B (abliterated)",   size: "51 GB",  tags: ["code", "uncensored"],      desc: "Refusal-removed Qwen3 Coder Next" },
  { id: "huihui_ai/qwen3-coder-next-abliterated:q8_0", label: "Qwen3 Coder Next 80B q8 (abliterated)",size: "85 GB",  tags: ["code", "uncensored"],      desc: "q8 quant of Coder Next abliterated" },
  { id: "huihui_ai/qwen3-abliterated:32b",             label: "Qwen3 32B (abliterated)",              size: "20 GB",  tags: ["chat", "uncensored"],      desc: "Refusal-removed Qwen3" },
  { id: "huihui_ai/qwen3-abliterated:14b",             label: "Qwen3 14B (abliterated)",              size: "9 GB",   tags: ["chat", "uncensored"],      desc: "Refusal-removed Qwen3 mid-size" },
  { id: "huihui_ai/qwen3-abliterated:8b",              label: "Qwen3 8B (abliterated)",               size: "5 GB",   tags: ["chat", "uncensored"],      desc: "Refusal-removed Qwen3 compact" },
  { id: "huihui_ai/qwen3-abliterated:4b",              label: "Qwen3 4B (abliterated)",               size: "2.6 GB", tags: ["chat", "uncensored"],      desc: "Refusal-removed tiny Qwen3" },
  { id: "huihui_ai/qwen2.5-abliterated:72b",           label: "Qwen2.5 72B (abliterated)",            size: "47 GB",  tags: ["chat", "uncensored"],      desc: "Refusal-removed Qwen2.5 flagship" },
  { id: "huihui_ai/qwen2.5-abliterated:32b",           label: "Qwen2.5 32B (abliterated)",            size: "20 GB",  tags: ["chat", "uncensored"],      desc: "Refusal-removed Qwen2.5" },
  { id: "huihui_ai/qwen2.5-coder-abliterated:32b",     label: "Qwen2.5 Coder 32B (abliterated)",      size: "20 GB",  tags: ["code", "uncensored"],      desc: "Refusal-removed Qwen2.5 coder" },
  { id: "huihui_ai/qwen2.5-coder-abliterated:14b",     label: "Qwen2.5 Coder 14B (abliterated)",      size: "9 GB",   tags: ["code", "uncensored"],      desc: "Mid-size abliterated coder" },
  { id: "huihui_ai/qwen2.5-coder-abliterated:7b",      label: "Qwen2.5 Coder 7B (abliterated)",       size: "4.7 GB", tags: ["code", "uncensored"],      desc: "Compact abliterated coder" },
  { id: "huihui_ai/llama3.3-70b-abliterated",          label: "Llama 3.3 70B (abliterated)",          size: "43 GB",  tags: ["chat", "uncensored"],      desc: "Refusal-removed Llama 3.3" },
  { id: "huihui_ai/llama3.2-abliterated:3b",           label: "Llama 3.2 3B (abliterated)",           size: "2 GB",   tags: ["chat", "uncensored"],      desc: "Tiny abliterated Llama" },
  { id: "huihui_ai/llama3.1-abliterated:8b",           label: "Llama 3.1 8B (abliterated)",           size: "4.7 GB", tags: ["chat", "uncensored"],      desc: "Refusal-removed Llama 3.1" },
  { id: "huihui_ai/deepseek-r1-abliterated:70b",       label: "DeepSeek R1 70B (abliterated)",        size: "43 GB",  tags: ["reasoning", "uncensored"], desc: "Refusal-removed R1 distill" },
  { id: "huihui_ai/deepseek-r1-abliterated:32b",       label: "DeepSeek R1 32B (abliterated)",        size: "20 GB",  tags: ["reasoning", "uncensored"], desc: "Mid-size abliterated R1" },
  { id: "huihui_ai/deepseek-r1-abliterated:14b",       label: "DeepSeek R1 14B (abliterated)",        size: "9 GB",   tags: ["reasoning", "uncensored"], desc: "Compact abliterated R1" },
  { id: "huihui_ai/deepseek-r1-abliterated:8b",        label: "DeepSeek R1 8B (abliterated)",         size: "5 GB",   tags: ["reasoning", "uncensored"], desc: "Tiny abliterated R1" },
  { id: "huihui_ai/gemma3-abliterated:27b",            label: "Gemma 3 27B (abliterated)",            size: "16 GB",  tags: ["chat", "uncensored"],      desc: "Refusal-removed Gemma 3" },
  { id: "huihui_ai/gemma3-abliterated:12b",            label: "Gemma 3 12B (abliterated)",            size: "8 GB",   tags: ["chat", "uncensored"],      desc: "Mid-size abliterated Gemma" },
  { id: "huihui_ai/gemma3-abliterated:4b",             label: "Gemma 3 4B (abliterated)",             size: "3 GB",   tags: ["chat", "uncensored"],      desc: "Compact abliterated Gemma" },
  { id: "huihui_ai/phi4-abliterated:14b",              label: "Phi-4 14B (abliterated)",              size: "9 GB",   tags: ["chat", "uncensored"],      desc: "Refusal-removed Phi-4" },
  { id: "huihui_ai/mistral-small-abliterated:24b",     label: "Mistral Small 24B (abliterated)",      size: "14 GB",  tags: ["chat", "uncensored"],      desc: "Refusal-removed Mistral" },
];

/* ───────────────────────────────────────────────────────────────────────────
   RP / Kobold / SillyTavern curated finetunes. All live on HuggingFace.
   ─────────────────────────────────────────────────────────────────────── */
const RP_CATALOG: CatalogEntry[] = [
  // TheDrummer — top RP author
  { id: "TheDrummer/Anubis-70B-v1",             label: "Anubis 70B v1",            size: "~43 GB", tags: ["rp"],               desc: "TheDrummer's flagship Llama 3.3 RP tune" },
  { id: "TheDrummer/Skyfall-36B-v2",            label: "Skyfall 36B v2",           size: "~22 GB", tags: ["rp"],               desc: "Solar-arch RP, balanced creativity" },
  { id: "TheDrummer/Cydonia-24B-v2.1",          label: "Cydonia 24B v2.1",         size: "~14 GB", tags: ["rp"],               desc: "Mistral Small RP tune, very popular" },
  { id: "TheDrummer/Big-Tiger-Gemma-27B-v1",    label: "Big Tiger Gemma 27B",      size: "~16 GB", tags: ["rp"],               desc: "Gemma 2 27B RP tune" },
  { id: "TheDrummer/Rocinante-12B-v1.1",        label: "Rocinante 12B v1.1",       size: "~7 GB",  tags: ["rp"],               desc: "Nemo-12B compact RP model" },
  { id: "TheDrummer/UnslopNemo-12B-v4",         label: "UnslopNemo 12B v4",        size: "~7 GB",  tags: ["rp"],               desc: "Nemo finetune, removes GPT-isms" },
  { id: "TheDrummer/Tiger-Gemma-9B-v3",         label: "Tiger Gemma 9B v3",        size: "~5 GB",  tags: ["rp"],               desc: "Compact Gemma 2 RP tune" },

  // Sao10K — classic finetuner
  { id: "Sao10K/L3.3-70B-Euryale-v2.3",         label: "Euryale v2.3 70B",         size: "~43 GB", tags: ["rp"],               desc: "Llama 3.3 RP, top-tier" },
  { id: "Sao10K/L3-8B-Stheno-v3.2",             label: "Stheno v3.2 8B",           size: "~5 GB",  tags: ["rp"],               desc: "Llama 3 RP classic, fast" },
  { id: "Sao10K/L3-8B-Lunaris-v1",              label: "Lunaris v1 8B",            size: "~5 GB",  tags: ["rp"],               desc: "Llama 3 RP, balanced" },
  { id: "Sao10K/Fimbulvetr-11B-v2",             label: "Fimbulvetr 11B v2",        size: "~6 GB",  tags: ["rp"],               desc: "Solar 11B classic RP tune" },
  { id: "Sao10K/72B-Qwen2.5-Kunou-v1",          label: "Kunou 72B v1",             size: "~47 GB", tags: ["rp"],               desc: "Qwen2.5 72B RP tune" },

  // Anthracite (Magnum series)
  { id: "anthracite-org/magnum-v4-72b",         label: "Magnum v4 72B",            size: "~47 GB", tags: ["rp"],               desc: "Claude-style prose Qwen2.5 tune" },
  { id: "anthracite-org/magnum-v4-22b",         label: "Magnum v4 22B",            size: "~14 GB", tags: ["rp"],               desc: "Mistral Small Magnum" },
  { id: "anthracite-org/magnum-v4-12b",         label: "Magnum v4 12B",            size: "~7 GB",  tags: ["rp"],               desc: "Nemo Magnum, compact" },

  // ReadyArt — uncensored RP
  { id: "ReadyArt/Forgotten-Safeword-70B-v5.0", label: "Forgotten Safeword 70B",   size: "~43 GB", tags: ["rp", "uncensored"], desc: "Heavy uncensored Llama 3.3 RP" },
  { id: "ReadyArt/Forgotten-Abomination-70B-v5.0", label: "Forgotten Abomination 70B", size: "~43 GB", tags: ["rp", "uncensored"], desc: "Sister tune of Safeword, edgier" },

  // Community favorites
  { id: "LatitudeGames/Wayfarer-12B",           label: "Wayfarer 12B",             size: "~7 GB",  tags: ["rp"],               desc: "AI Dungeon's open RP model" },
  { id: "inflatebot/MN-12B-Mag-Mell-R1",        label: "Mag-Mell 12B R1",          size: "~7 GB",  tags: ["rp"],               desc: "Strong Nemo RP merge" },
  { id: "nbeerbower/Mistral-Nemo-Gutenberg-Doppel-12B", label: "Gutenberg Doppel 12B", size: "~7 GB", tags: ["rp"],          desc: "Literary-tuned Nemo" },
  { id: "crestf411/MS-sunfall-v0.5.0",          label: "Sunfall MS v0.5",          size: "~14 GB", tags: ["rp"],               desc: "Mistral Small sunfall series" },
  { id: "aetherwiing/MN-12B-Starcannon-v3",     label: "Starcannon 12B v3",        size: "~7 GB",  tags: ["rp"],               desc: "Nemo merge for creative RP" },
  { id: "KatyTheCutie/EstopianMaid-13B",        label: "EstopianMaid 13B",         size: "~7 GB",  tags: ["rp"],               desc: "Classic Llama 2 13B RP" },
  { id: "Doctor-Shotgun/L3.3-70B-Magnum-v5-Twilight", label: "Magnum v5 Twilight 70B", size: "~43 GB", tags: ["rp"],         desc: "Magnum + Twilight merge" },
  { id: "SicariusSicariiStuff/Negative_LLAMA_70B", label: "Negative LLAMA 70B",    size: "~43 GB", tags: ["rp", "uncensored"], desc: "Heavy debias Llama 3 70B" },
  { id: "mlabonne/NeuralDaredevil-8B-abliterated", label: "NeuralDaredevil 8B",    size: "~5 GB",  tags: ["uncensored"],       desc: "mlabonne abliterated DPO tune" },
];

const TAG_COLORS: Record<string, string> = {
  chat:       "#3b82f6",
  code:       "#22c55e",
  reasoning:  "#a855f7",
  vision:     "#f59e0b",
  embed:      "#6b7280",
  tools:      "#ec4899",
  math:       "#06b6d4",
  rag:        "#10b981",
  safety:     "#f97316",
  uncensored: "#ef4444",
  cloud:      "#0ea5e9",
  rp:         "#d946ef",
  nsfw:       "#dc2626",
};

function abbrev(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return String(n);
}

function inferTags(m: HfModel): string[] {
  const tags: string[] = [];
  const id = m.id.toLowerCase();
  if (/coder|code/.test(id)) tags.push("code");
  else if (/r1|reason|qwq/.test(id)) tags.push("reasoning");
  else if (/vision|llava|vlm/.test(id)) tags.push("vision");
  else if (/embed/.test(id)) tags.push("embed");
  else if (/math/.test(id)) tags.push("math");
  else tags.push("chat");
  return tags;
}

interface Props {
  onClose: () => void;
  onPulled: () => void;
}

export function ModelBrowser({ onClose, onPulled }: Props) {
  const [tab, setTab] = useState<Backend>("ollama");
  const [query, setQuery] = useState("");
  const [pulling, setPulling] = useState<string | null>(null);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [errors, setErrors] = useState<Map<string, string>>(new Map());

  const [hfModels, setHfModels] = useState<HfModel[]>([]);
  const [hfLoading, setHfLoading] = useState(false);
  const [hfErr, setHfErr] = useState<string | null>(null);

  const [civitaiModels, setCivitaiModels] = useState<CivitaiModel[]>([]);
  const [civitaiLoading, setCivitaiLoading] = useState(false);
  const [civitaiErr, setCivitaiErr] = useState<string | null>(null);
  const [civitaiVisible, setCivitaiVisible] = useState(20);

  const debounceRef = useRef<number | null>(null);
  const fetchAbortRef = useRef<AbortController | null>(null);

  // Debounced fetch when query or tab changes
  useEffect(() => {
    if (tab === "hf") {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(() => loadHf(query), 250);
    } else if (tab === "civitai") {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
      debounceRef.current = window.setTimeout(() => loadCivitai(query), 250);
    }
    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
      fetchAbortRef.current?.abort();
    };
  }, [tab, query]);

  async function loadHf(q: string) {
    fetchAbortRef.current?.abort();
    const ctrl = new AbortController();
    fetchAbortRef.current = ctrl;
    setHfLoading(true);
    setHfErr(null);
    try {
      const params = new URLSearchParams({
        sort: "downloads",
        direction: "-1",
        limit: "100",
      });
      if (q.trim()) {
        params.set("search", q.trim());
        params.set("library", "mlx");
      } else {
        params.set("author", "mlx-community");
      }
      const url = `https://huggingface.co/api/models?${params.toString()}`;
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HF API ${res.status}`);
      const data: HfModel[] = await res.json();
      if (ctrl.signal.aborted) return;
      const capped = Array.isArray(data) ? data.slice(0, 200) : [];
      setHfModels(capped);
    } catch (e: any) {
      if (e?.name === "AbortError") return;
      setHfErr(String(e?.message || e));
    } finally {
      // Always clear loading; only clear ref if it's still ours
      if (fetchAbortRef.current === ctrl) fetchAbortRef.current = null;
      setHfLoading(false);
    }
  }

  async function loadCivitai(q: string) {
    fetchAbortRef.current?.abort();
    const ctrl = new AbortController();
    fetchAbortRef.current = ctrl;
    setCivitaiLoading(true);
    setCivitaiErr(null);
    try {
      const params = new URLSearchParams({
        limit: "100",
        sort: "Highest Rated",
        types: "Checkpoint",
      });
      if (q.trim()) params.set("query", q.trim());
      const url = `https://civitai.com/api/v1/models?${params.toString()}`;
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`Civitai API ${res.status}`);
      const data = await res.json();
      if (ctrl.signal.aborted) return;
      const items = Array.isArray(data?.items) ? data.items.slice(0, 200) : [];
      setCivitaiModels(items);
    } catch (e: any) {
      if (e?.name === "AbortError") return;
      setCivitaiErr(String(e?.message || e));
    } finally {
      if (fetchAbortRef.current === ctrl) fetchAbortRef.current = null;
      setCivitaiLoading(false);
    }
  }

  const filteredOllama = useMemo(() => filterCatalog(OLLAMA, query), [query]);
  const filteredRp = useMemo(() => filterCatalog(RP_CATALOG, query), [query]);

  // Reset pagination when results change (new search)
  useEffect(() => { setCivitaiVisible(20); }, [civitaiModels]);

  // Precompute resized thumbnail URLs once per fetch, not per render
  const civitaiCards = useMemo(
    () => civitaiModels.slice(0, civitaiVisible).map((m) => {
      const url = m.modelVersions?.[0]?.images?.find((i) => i.url)?.url;
      return { m, thumbResized: url ? civitaiThumbUrl(url, 144) : null };
    }),
    [civitaiModels, civitaiVisible],
  );

  async function pull(id: string, backend: Backend) {
    setPulling(id);
    setErrors((m) => { const n = new Map(m); n.delete(id); return n; });
    try {
      if (backend === "ollama") {
        await api.pullOllamaModel(id);
      } else {
        await api.pullHfModel(id);
      }
      setDone((s) => new Set([...s, id]));
      onPulled();
    } catch (e) {
      setErrors((m) => new Map([...m, [id, String(e)]]));
    } finally {
      setPulling(null);
    }
  }

  return (
    <div className="mb-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="mb-panel">

        {/* Header */}
        <div className="mb-header">
          <div className="mb-title">Model Library</div>
          <input
            className="mb-search"
            placeholder={
              tab === "ollama" ? "Filter Ollama models…" :
              tab === "hf"     ? "Search HuggingFace MLX…" :
              tab === "rp"     ? "Filter RP / Kobold models…" :
                                 "Search Civitai…"
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          <button className="mb-close" onClick={onClose}>✕</button>
        </div>

        {/* Tabs */}
        <div className="mb-tabs">
          <button className={`mb-tab ${tab === "ollama" ? "active" : ""}`} onClick={() => { setTab("ollama"); setQuery(""); }}>
            Ollama <span className="mb-tab-count">{OLLAMA.length}</span>
          </button>
          <button className={`mb-tab ${tab === "hf" ? "active" : ""}`} onClick={() => { setTab("hf"); setQuery(""); }}>
            HuggingFace MLX <span className="mb-tab-count">{hfModels.length || "live"}</span>
          </button>
          <button className={`mb-tab ${tab === "rp" ? "active" : ""}`} onClick={() => { setTab("rp"); setQuery(""); }}>
            RP / Kobold <span className="mb-tab-count">{RP_CATALOG.length}</span>
          </button>
          <button className={`mb-tab ${tab === "civitai" ? "active" : ""}`} onClick={() => { setTab("civitai"); setQuery(""); }}>
            Civitai <span className="mb-tab-count">{civitaiModels.length || "live"}</span>
          </button>
        </div>

        {/* List */}
        <div className="mb-list">
          {tab === "ollama" && (
            <>
              {filteredOllama.length === 0 && (
                <div className="mb-empty">No models match "{query}"</div>
              )}
              {filteredOllama.map((entry) => {
                const isPulling = pulling === entry.id;
                const isDone = done.has(entry.id);
                const err = errors.get(entry.id);
                return (
                  <div key={entry.id} className="mb-card">
                    <div className="mb-card-info">
                      <div className="mb-card-top">
                        <span className="mb-card-label">{entry.label}</span>
                        <div className="mb-tags">
                          {entry.tags.map((t) => (
                            <span key={t} className="mb-tag" style={{ background: (TAG_COLORS[t] ?? "#6b7280") + "22", color: TAG_COLORS[t] ?? "#9ca3af" }}>
                              {t}
                            </span>
                          ))}
                        </div>
                      </div>
                      <div className="mb-card-desc">{entry.desc}</div>
                      {err && <div className="mb-card-err">{err}</div>}
                    </div>
                    <div className="mb-card-actions">
                      <span className="mb-card-size">{entry.size}</span>
                      <button
                        className={`mb-pull-btn ${isDone ? "done" : ""}`}
                        onClick={() => pull(entry.id, "ollama")}
                        disabled={isPulling || !!pulling}
                      >
                        {isPulling ? <span className="mb-spinner" /> : isDone ? "✓ Done" : "Pull"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </>
          )}

          {tab === "hf" && (
            <>
              {hfLoading && hfModels.length === 0 && (
                <div className="mb-empty"><span className="mb-spinner mb-spinner-lg" /> Loading from HuggingFace…</div>
              )}
              {hfErr && <div className="mb-empty mb-empty-err">Failed to load: {hfErr}</div>}
              {!hfLoading && !hfErr && hfModels.length === 0 && (
                <div className="mb-empty">No MLX models match "{query}"</div>
              )}
              {hfModels.map((m) => {
                const isPulling = pulling === m.id;
                const isDone = done.has(m.id);
                const err = errors.get(m.id);
                const label = m.id.replace("mlx-community/", "");
                const tags = inferTags(m);
                const info = parseHfTags(m.tags, m.pipeline_tag);
                const updated = relativeTime(m.lastModified);
                const author = m.id.includes("/") ? m.id.split("/")[0] : "mlx-community";
                return (
                  <div key={m.id} className="mb-card">
                    <div className="mb-card-info">
                      <div className="mb-card-top">
                        <span className="mb-card-label">{label}</span>
                        <div className="mb-tags">
                          {info.pipeline && (
                            <span className="mb-tag" style={{ background: "#f59e0b22", color: "#f59e0b" }}>
                              {pipelineShort(info.pipeline)}
                            </span>
                          )}
                          {tags.map((t) => (
                            <span key={t} className="mb-tag" style={{ background: (TAG_COLORS[t] ?? "#6b7280") + "22", color: TAG_COLORS[t] ?? "#9ca3af" }}>
                              {t}
                            </span>
                          ))}
                          {info.license && (
                            <span className="mb-tag civitai-soft" title="License">{info.license}</span>
                          )}
                          {m.gated && (
                            <span className="mb-tag" style={{ background: "#ef444422", color: "#ef4444" }} title="Requires HF auth">
                              gated
                            </span>
                          )}
                        </div>
                      </div>
                      {info.baseModel && (
                        <div className="mb-card-desc" style={{ fontSize: 11, opacity: 0.7 }}>
                          base: <code style={{ fontFamily: "SF Mono, Menlo, monospace" }}>{info.baseModel}</code>
                        </div>
                      )}
                      <div className="mb-card-desc">
                        ↓ {abbrev(m.downloads)} · ♥ {abbrev(m.likes)}
                        {updated && <> · {updated}</>}
                      </div>
                      {err && <div className="mb-card-err">{err}</div>}
                    </div>
                    <div className="mb-card-actions">
                      <span className="mb-card-size">{author}</span>
                      <button
                        className={`mb-pull-btn ${isDone ? "done" : ""}`}
                        onClick={() => pull(m.id, "hf")}
                        disabled={isPulling || !!pulling}
                      >
                        {isPulling ? <span className="mb-spinner" /> : isDone ? "✓ Done" : "Pull"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </>
          )}

          {/* RP / Kobold tab */}
          {tab === "rp" && (
            <>
              {filteredRp.length === 0 && (
                <div className="mb-empty">No RP models match "{query}"</div>
              )}
              {filteredRp.map((entry) => {
                const isPulling = pulling === entry.id;
                const isDone = done.has(entry.id);
                const err = errors.get(entry.id);
                return (
                  <div key={entry.id} className="mb-card">
                    <div className="mb-card-info">
                      <div className="mb-card-top">
                        <span className="mb-card-label">{entry.label}</span>
                        <div className="mb-tags">
                          {entry.tags.map((t) => (
                            <span key={t} className="mb-tag" style={{ background: (TAG_COLORS[t] ?? "#6b7280") + "22", color: TAG_COLORS[t] ?? "#9ca3af" }}>
                              {t}
                            </span>
                          ))}
                        </div>
                      </div>
                      <div className="mb-card-desc">{entry.desc}</div>
                      <div className="mb-card-desc" style={{ opacity: 0.6, fontSize: 11 }}>{entry.id}</div>
                      {err && <div className="mb-card-err">{err}</div>}
                    </div>
                    <div className="mb-card-actions">
                      <span className="mb-card-size">{entry.size}</span>
                      <button
                        className={`mb-pull-btn ${isDone ? "done" : ""}`}
                        onClick={() => pull(entry.id, "hf")}
                        disabled={isPulling || !!pulling}
                      >
                        {isPulling ? <span className="mb-spinner" /> : isDone ? "✓ Done" : "Pull"}
                      </button>
                    </div>
                  </div>
                );
              })}
            </>
          )}

          {/* Civitai tab */}
          {tab === "civitai" && (
            <>
              {civitaiLoading && civitaiModels.length === 0 && (
                <div className="mb-empty"><span className="mb-spinner mb-spinner-lg" /> Loading from Civitai…</div>
              )}
              {civitaiErr && <div className="mb-empty mb-empty-err">Failed to load: {civitaiErr}</div>}
              {!civitaiLoading && !civitaiErr && civitaiModels.length === 0 && (
                <div className="mb-empty">No Civitai models match "{query}"</div>
              )}
              {civitaiModels.length > 0 && (
                <div className="mb-empty" style={{ padding: "8px 0 12px", textAlign: "left", fontSize: 11 }}>
                  Note: Civitai is mostly diffusion (image gen). Click "Open ↗" to view in browser — direct MLX loading not supported.
                </div>
              )}
              {civitaiCards.map(({ m, thumbResized }) => {
                const v0 = m.modelVersions?.[0];
                const baseModel = v0?.baseModel;
                const baseModelType = v0?.baseModelType;
                const primaryFile = v0?.files?.find((f) => f.primary) ?? v0?.files?.[0];
                const fileSize = fmtSize(primaryFile?.sizeKB);
                const fileFormat = primaryFile?.metadata?.format;
                const fileFp = primaryFile?.metadata?.fp;
                const fileQuant = primaryFile?.metadata?.size;
                const pickleOk = primaryFile?.pickleScanResult === "Success";
                const virusOk = primaryFile?.virusScanResult === "Success";
                const versionName = v0?.name;
                const triggerWords = (v0?.trainedWords ?? []).slice(0, 4);
                const desc = m.description ? stripHtml(m.description) : "";
                const descShort = desc.length > 140 ? desc.slice(0, 140).trim() + "…" : desc;
                const topTags = (m.tags ?? []).slice(0, 3);
                const tags: string[] = [m.type.toLowerCase()];
                if (m.nsfw) tags.push("nsfw");
                const licenseShort = civitaiLicenseShort(m);
                const published = relativeTime(v0?.publishedAt);
                const versionCount = m.modelVersions?.length ?? 0;

                return (
                  <div key={m.id} className="mb-card civitai-card">
                    {thumbResized && (
                      <img
                        className="civitai-thumb"
                        src={thumbResized}
                        alt=""
                        loading="lazy"
                        referrerPolicy="no-referrer"
                      />
                    )}
                    <div className="mb-card-info">
                      <div className="mb-card-top">
                        <span className="mb-card-label">
                          {m.name}
                          {versionName && <span className="civitai-version"> · {versionName}</span>}
                        </span>
                        <div className="mb-tags">
                          {baseModel && (
                            <span className="mb-tag civitai-base">
                              {baseModel}{baseModelType && baseModelType !== "Standard" ? ` ${baseModelType}` : ""}
                            </span>
                          )}
                          {tags.map((t) => (
                            <span key={t} className="mb-tag" style={{ background: (TAG_COLORS[t] ?? "#6b7280") + "22", color: TAG_COLORS[t] ?? "#9ca3af" }}>
                              {t}
                            </span>
                          ))}
                          {fileFormat && (
                            <span
                              className="mb-tag"
                              title="File format"
                              style={{
                                background: fileFormat === "SafeTensor" ? "#22c55e22" : "#ef444422",
                                color: fileFormat === "SafeTensor" ? "#22c55e" : "#ef4444",
                              }}
                            >
                              {fileFormat}
                            </span>
                          )}
                          {topTags.map((t) => (
                            <span key={t} className="mb-tag civitai-soft">{t}</span>
                          ))}
                        </div>
                      </div>
                      {descShort && <div className="mb-card-desc civitai-desc">{descShort}</div>}
                      {triggerWords.length > 0 && (
                        <div className="mb-card-desc" style={{ fontSize: 11 }}>
                          triggers: {triggerWords.map((w) => (
                            <code key={w} style={{
                              background: "var(--surface-hover)",
                              padding: "1px 5px",
                              borderRadius: 3,
                              marginRight: 4,
                              fontFamily: "SF Mono, Menlo, monospace",
                              fontSize: 10,
                            }}>{w}</code>
                          ))}
                        </div>
                      )}
                      <div className="mb-card-desc civitai-stats">
                        by <strong>{m.creator?.username ?? "unknown"}</strong>
                        {m.stats?.downloadCount != null && <> · ↓ {abbrev(m.stats.downloadCount)}</>}
                        {m.stats?.thumbsUpCount != null && <> · 👍 {abbrev(m.stats.thumbsUpCount)}</>}
                        {m.stats?.rating != null && m.stats.ratingCount != null && m.stats.ratingCount > 0 && (
                          <> · ★ {m.stats.rating.toFixed(2)} ({abbrev(m.stats.ratingCount)})</>
                        )}
                        {published && <> · {published}</>}
                        {versionCount > 1 && <> · {versionCount} versions</>}
                        {" · license: "}<span title={`commercial: ${parseCommercialUse(m.allowCommercialUse).join(", ") || "no"}; derivatives: ${m.allowDerivatives ? "yes" : "no"}`}>{licenseShort}</span>
                        {(!pickleOk || !virusOk) && (
                          <span style={{ color: "#ef4444", marginLeft: 6 }} title={`pickle: ${primaryFile?.pickleScanResult}, virus: ${primaryFile?.virusScanResult}`}>⚠ scan</span>
                        )}
                      </div>
                    </div>
                    <div className="mb-card-actions">
                      {fileSize && (
                        <span className="mb-card-size">
                          {fileSize}
                          {(fileQuant || fileFp) && <span style={{ display: "block", fontSize: 10, opacity: 0.7 }}>
                            {[fileQuant, fileFp].filter(Boolean).join(" · ")}
                          </span>}
                        </span>
                      )}
                      <button
                        className="mb-pull-btn"
                        onClick={() => api.openExternal(`https://civitai.com/models/${m.id}`).catch(() => {})}
                      >
                        Open ↗
                      </button>
                    </div>
                  </div>
                );
              })}
              {civitaiVisible < civitaiModels.length && (
                <div style={{ textAlign: "center", padding: "12px 0" }}>
                  <button className="mb-pull-btn" onClick={() => setCivitaiVisible((n) => n + 20)}>
                    Show more ({civitaiModels.length - civitaiVisible} remaining)
                  </button>
                </div>
              )}
            </>
          )}
        </div>

      </div>
    </div>
  );
}
