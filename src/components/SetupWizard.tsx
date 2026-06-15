import { useCallback, useEffect, useState } from "react";
import { useRef } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { OllamaPullProgress } from "../types";
import { Check } from "lucide-react";
import { api } from "../lib/tauri-api";
import { useModalA11y } from "../lib/use-modal-a11y";
import { recommendStarter } from "../lib/hardware-recommend";
import { classify, fmtGb, type Headroom } from "../lib/hardware-profile";
import { HardwareWarningBanner } from "./HardwareWarningBanner";
import { logDiag } from "../lib/diagnostics";

// Bytes-per-GiB for synthesizing a `size_bytes` from a starter's approxGb so
// the shared `classify()` (and thus HardwareWarningBanner) agrees with the
// model picker's verdict.
const GIB = 1024 * 1024 * 1024;

/**
 * First-run setup wizard.
 *
 * Three steps:
 *  1. Diagnostic — probe native / MLX / Ollama backends and show the user
 *     which are installed, with install affordances for missing ones.
 *  2. Starter model — let the user pick a small recommended model per
 *     backend and kick off the download via the existing pull command.
 *  3. Sample chat — close the wizard with a pre-filled starter prompt so
 *     the user lands in a productive starting state instead of empty space.
 *
 * Mount logic lives in `App.tsx`; this component is purely presentational +
 * orchestrates the probe/download IPC calls.
 *
 * NOTE: keep model recommendations in this file (not Rust) so non-rebuild
 * tweaks to the list are possible.
 */

type BackendKey = "native" | "mlx" | "ollama";

interface BackendProbe {
  key: BackendKey;
  label: string;
  /** undefined = probing; true/false = result. */
  available: boolean | undefined;
  /** Hint shown under the row name (one line). */
  hint: string;
  /** What the install button does. null = no install action (already shipped). */
  installAction:
    | { kind: "url"; url: string }
    | { kind: "inline"; text: string }
    | null;
  /**
   * The recommended zero-install starting point. Renders a "Start here — no
   * install" badge so a brand-new user reaches for the backend that needs no
   * setup (native) before the ones that require pip/daemons.
   */
  lead?: boolean;
}

/** RAM bucket a starter is sized for — drives which group leads on this Mac. */
type RamTier = "small" | "mid" | "large" | "flagship";

/** Map detected total RAM (GiB) to the starter tier this machine should lead with. */
function ramTier(totalGb: number): RamTier {
  if (totalGb <= 16) return "small";
  if (totalGb <= 36) return "mid";
  if (totalGb <= 64) return "large";
  return "flagship";
}

interface StarterModel {
  id: string;
  label: string;
  size: string;
  /** Approximate resident size in GiB — drives the hardware-fit recommendation. */
  approxGb: number;
  description: string;
  /** Which Tauri pull command to invoke. */
  pull: "ollama" | "hf";
  /** Which backend this model is intended for (used to set last_backend on download). */
  backend: BackendKey;
  /** RAM bucket this starter is sized for (see `ramTier`). */
  tier: RamTier;
}

// Tweakable recommendations — bundling here (not in Rust) avoids a recompile
// when we want to refresh the starter list (per spec).
//
// RAM tiers (2026-06-11): a 128 GB Mac used to get the same 3B starter as an
// 8 GB Air. Each entry now carries a `tier` and step 2 leads with the tier
// that matches the detected RAM. Ids are reused verbatim from the ModelBrowser
// curated catalog — never invent ids here.
const STARTER_MODELS_BY_BACKEND: Record<BackendKey, StarterModel[]> = {
  native: [
    {
      // SHIP-BLOCKER FIX (2026-06-15): the native backend is mistralrs +
      // candle, which loads STANDARD HF transformers checkpoints
      // (safetensors + config.json). An `mlx-community/*-4bit` id is
      // MLX-format — candle can't load it and the loader may panic
      // (`todo!()` on an unsupported quant). Use a small, ungated,
      // standard-format instruct repo the loader actually handles. Qwen2.5
      // 1.5B Instruct: ~3 GB fp16, no HF login required, Qwen2 arch is
      // first-class in mistralrs. Downloads + warms IN-PROCESS via
      // nativeLoadModel — no `hf` CLI needed (a zero-install Mac has none).
      id: "Qwen/Qwen2.5-1.5B-Instruct",
      label: "Qwen2.5 1.5B Instruct",
      size: "~3 GB",
      approxGb: 3,
      description: "Small, fast, general-purpose. Runs fully in-app — no install.",
      pull: "hf",
      backend: "native",
      tier: "small",
    },
  ],
  mlx: [
    {
      id: "mlx-community/Llama-3.2-3B-Instruct-4bit",
      label: "Llama 3.2 3B (4-bit)",
      size: "~2 GB",
      approxGb: 2,
      description: "Small, fast, general-purpose. Default starter pick.",
      pull: "hf",
      backend: "mlx",
      tier: "small",
    },
  ],
  ollama: [
    {
      id: "llama3.2:3b",
      label: "Llama 3.2 3B",
      size: "~2 GB",
      approxGb: 2,
      description: "Small, fast, general-purpose. Default starter pick.",
      pull: "ollama",
      backend: "ollama",
      tier: "small",
    },
    {
      id: "qwen2.5-coder:7b",
      label: "Qwen2.5 Coder 7B",
      size: "~4 GB",
      approxGb: 4.7,
      description: "Larger, code-tuned. Pick this for programming help.",
      pull: "ollama",
      backend: "ollama",
      tier: "small",
    },
    {
      id: "qwen3:14b",
      label: "Qwen3 14B",
      size: "~9 GB",
      approxGb: 9,
      description: "Capable mid-size Qwen3, strong all-rounder.",
      pull: "ollama",
      backend: "ollama",
      tier: "mid",
    },
    {
      id: "qwen2.5-coder:14b",
      label: "Qwen2.5 Coder 14B",
      size: "~9 GB",
      approxGb: 9,
      description: "Mid-size coder. Pick this for programming help.",
      pull: "ollama",
      backend: "ollama",
      tier: "mid",
    },
    {
      id: "qwen3:32b",
      label: "Qwen3 32B",
      size: "~20 GB",
      approxGb: 20,
      description: "Dense Qwen3 flagship, excellent reasoning.",
      pull: "ollama",
      backend: "ollama",
      tier: "large",
    },
    {
      id: "qwen2.5-coder:32b",
      label: "Qwen2.5 Coder 32B",
      size: "~20 GB",
      approxGb: 20,
      description:
        "Strong code-focused Qwen2.5. Pick this for programming help.",
      pull: "ollama",
      backend: "ollama",
      tier: "large",
    },
    {
      id: "llama3.3:70b",
      label: "Llama 3.3 70B",
      size: "~43 GB",
      approxGb: 43,
      description: "Meta's best open chat model. Needs serious headroom.",
      pull: "ollama",
      backend: "ollama",
      tier: "flagship",
    },
    {
      id: "qwen3-coder:30b",
      label: "Qwen3 Coder 30B",
      size: "~18 GB",
      approxGb: 18,
      description: "Alibaba's top coding model with thinking mode.",
      pull: "ollama",
      backend: "ollama",
      tier: "flagship",
    },
  ],
};

// Step-3 sample prompts, branched by what was actually downloaded.
//
// The agent-TOOL prompts assume App will arm agent mode on send — and App
// only does that for ollama/mlx (see onDone in App.tsx). The native backend
// can't run agent tools, so handing a fresh native user "What's in my current
// directory?" made the model HALLUCINATE a directory listing as the literal
// first reply (product review 2026-06-11). Native — and the skipped-download
// path, where the backend is unknown — get pure-chat prompts instead.
const AGENT_SAMPLE_PROMPTS: { title: string; text: string }[] = [
  {
    title: "Summarize the README",
    text: "Summarize the README in this repo.",
  },
  {
    title: "List current directory",
    text: "What's in my current directory?",
  },
  {
    title: "Show recent git history",
    text: "Show me the latest git log.",
  },
];

const CHAT_SAMPLE_PROMPTS: { title: string; text: string }[] = [
  {
    title: "Explain a concept",
    text: "Explain how async/await works in JavaScript, with a small example.",
  },
  {
    title: "Draft something",
    text: "Draft a concise commit message for a bug fix in the login flow.",
  },
  {
    title: "Debug an error",
    text: "Help me debug this error: ",
  },
];

/** What the wizard hands back to App on completion. */
export interface SetupWizardResult {
  /** Chosen sample prompt — prefilled in the composer, NOT auto-sent. */
  samplePrompt: string | null;
  /** Model downloaded in step 2 (null when the user skipped). */
  modelId: string | null;
  /** Backend of the downloaded model ("ollama" | "mlx" | "native"). */
  backend: string | null;
}

interface Props {
  /**
   * Called when the user finishes (or skips through) the wizard. The parent
   * is responsible for persisting `setup_complete=true` and unmounting.
   * Product review 2026-06-10 (onboarding #1): the wizard now also reports
   * WHAT was downloaded so App can hand a tool-prompt off to agent mode —
   * previously the sample agent prompts ran in plain chat against a model
   * that wasn't even started, and the model hallucinated a directory listing
   * as the user's very first impression.
   */
  onDone: (result: SetupWizardResult) => void;
}

export function SetupWizard({ onDone }: Props) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [probes, setProbes] = useState<BackendProbe[]>([
    {
      key: "native",
      label: "Native (built-in)",
      available: undefined,
      hint: "Ships with the app on Apple Silicon. No install needed.",
      installAction: null,
      lead: true,
    },
    {
      key: "mlx",
      label: "MLX (Python)",
      available: undefined,
      hint: "Apple's MLX framework, installed via pip.",
      installAction: {
        kind: "inline",
        text: "Run: python3 -m pip install mlx-lm — then re-run setup.",
      },
    },
    {
      key: "ollama",
      label: "Ollama",
      available: undefined,
      hint: "Daemon at localhost:11434. Standalone install.",
      installAction: { kind: "url", url: "https://ollama.com/download" },
    },
  ]);

  // Ref mirror of probe state for the re-poll interval (registered with
  // stable deps; needs latest without re-subscribing).
  const probesRef = useRef(probes);
  useEffect(() => {
    probesRef.current = probes;
  }, [probes]);

  // Track the user-selected starter model and its download lifecycle so the
  // step-2 UI can switch between "pick" and "downloading…" / "done" states
  // without losing context if the wizard re-renders.
  const [downloading, setDownloading] = useState<StarterModel | null>(null);
  const [downloadErr, setDownloadErr] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState<StarterModel | null>(null);
  // UI review U-H1: count of models already installed (any backend). If
  // the user already has at least one, Next is enabled regardless of
  // download state — they don't need to fetch a starter to proceed.
  const [existingModelsCount, setExistingModelsCount] = useState(0);
  // Detected RAM (GiB) for the hardware-fit recommendation; null until probed.
  const [ramGb, setRamGb] = useState<number | null>(null);
  useEffect(() => {
    void api
      .systemInfo()
      .then((s) => setRamGb(s.total_ram_gb))
      .catch(() => setRamGb(null));
  }, []);
  useEffect(() => {
    let cancelled = false;
    api
      .listAllModels()
      .then((m) => {
        if (cancelled) return;
        setExistingModelsCount((m.mlx?.length ?? 0) + (m.ollama?.length ?? 0));
      })
      .catch(() => {
        // Probe failure → keep count at 0; user just sees the original
        // behaviour (Next gated on download success).
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Probe runner — reusable: mount, the "Check again" button, and a passive
  // 3s re-poll while step 1 is visible (product review onboarding #6: the
  // most common new-user path — install Ollama in another window, come back
  // — used to dead-end on a stale "Not detected" with no refresh).
  const runProbes = useCallback((cancelledRef: { current: boolean }) => {
    const cancelled = () => cancelledRef.current;
    const tasks: Array<Promise<void>> = [
      api
        .nativeSupported()
        .then((v) => {
          if (!cancelled()) updateProbe("native", v);
        })
        .catch((err) => {
          logDiag({
            level: "info",
            source: "setup-wizard",
            message: "native_supported probe failed — treating as unavailable",
            detail: err,
          });
          if (!cancelled()) updateProbe("native", false);
        }),
      api
        .mlxProbe()
        .then((v) => {
          if (!cancelled()) updateProbe("mlx", v);
        })
        .catch((err) => {
          logDiag({
            level: "info",
            source: "setup-wizard",
            message: "mlx_probe failed — treating as unavailable",
            detail: err,
          });
          if (!cancelled()) updateProbe("mlx", false);
        }),
      api
        .ollamaStatus()
        .then((s) => {
          if (cancelled()) return;
          if (s === "stopped") {
            // Installed but daemon not running — tell the user to START it, not
            // re-download it (the most common Ollama cold state).
            setProbes((prev) =>
              prev.map((p) =>
                p.key === "ollama"
                  ? {
                      ...p,
                      available: false,
                      hint: "Installed, but the daemon isn't running.",
                      installAction: {
                        kind: "inline",
                        text: "Run: ollama serve — then re-run setup.",
                      },
                    }
                  : p,
              ),
            );
          } else {
            updateProbe("ollama", s === "running");
          }
        })
        .catch((err) => {
          logDiag({
            level: "info",
            source: "setup-wizard",
            message: "ollama_status failed — treating as unavailable",
            detail: err,
          });
          if (!cancelled()) updateProbe("ollama", false);
        }),
    ];
    return Promise.all(tasks);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const ref = { current: false };
    void runProbes(ref);
    return () => {
      ref.current = true;
    };
  }, [runProbes]);

  // Passive re-poll while the user is looking at step 1 — the status flips
  // to Available the moment a just-installed backend comes up.
  useEffect(() => {
    if (step !== 1) return;
    const ref = { current: false };
    const t = setInterval(() => {
      // Perf N6 (2026-06-11): each probe round spawns `mlx_lm.server --help`
      // (a Python interpreter) — don't do that while the window is hidden,
      // and stop entirely once every backend reads Available (nothing left
      // to flip).
      if (document.visibilityState !== "visible") return;
      if (probesRef.current.every((p) => p.available === true)) return;
      void runProbes(ref);
    }, 3000);
    return () => {
      ref.current = true;
      clearInterval(t);
    };
  }, [step, runProbes]);

  // Live ollama-pull progress for the step-2 download card (the old UI was a
  // frozen "Downloading…" label for a multi-GB pull).
  const [pullProgress, setPullProgress] = useState<OllamaPullProgress | null>(
    null,
  );
  useEffect(() => {
    let off: UnlistenFn | undefined;
    let stop = false;
    (async () => {
      try {
        off = await listen<OllamaPullProgress>("ollama-pull-progress", (e) => {
          if (!stop) setPullProgress(e.payload);
        });
      } catch {
        // non-Tauri test env — label just stays static
      }
    })();
    return () => {
      stop = true;
      off?.();
    };
  }, []);

  function updateProbe(key: BackendKey, available: boolean) {
    setProbes((prev) =>
      prev.map((p) => (p.key === key ? { ...p, available } : p)),
    );
  }

  // Compose the set of starter models that are reachable given the current
  // probe results. If multiple backends are available we show their models
  // grouped — but in practice only one or two will be live and the list
  // stays short.
  function availableStarters(): StarterModel[] {
    const out: StarterModel[] = [];
    for (const p of probes) {
      if (p.available) {
        out.push(...STARTER_MODELS_BY_BACKEND[p.key]);
      }
    }
    return out;
  }

  async function handleInstall(action: BackendProbe["installAction"]) {
    if (!action) return;
    if (action.kind === "url") {
      try {
        await api.openExternal(action.url);
      } catch (err) {
        logDiag({
          level: "warn",
          source: "setup-wizard",
          message: "openExternal failed in install button",
          detail: err,
        });
      }
    }
    // Inline install: nothing to launch — the text instructions are
    // already visible to the user. No-op intentional.
  }

  async function downloadModel(m: StarterModel) {
    setDownloading(m);
    setDownloadErr(null);
    try {
      if (m.backend === "native") {
        // SHIP-BLOCKER FIX (2026-06-15): the native backend has NO external
        // tooling. `pullHfModel` shells out to the `hf`/`huggingface-cli`
        // binary, which a zero-install Mac does not have → the headline
        // "install nothing" path hard-failed on step 2 with "no huggingface
        // CLI found". `nativeLoadModel` downloads the weights IN-PROCESS via
        // candle's hf-hub path AND warms the model — so this single call is
        // both the download and the auto-start for native. Awaited (not
        // fire-and-forget) so a real download/load failure surfaces inline
        // instead of silently leaving the user on the manual Start path.
        await api.nativeLoadModel(m.id);
      } else if (m.pull === "ollama") {
        await api.pullOllamaModel(m.id);
      } else {
        await api.pullHfModel(m.id);
      }
      // Persist as last-selected so the model picker picks it up after
      // wizard closes.
      await api
        .settingsSet({ last_model: m.id, last_backend: m.backend })
        .catch((err) => {
          logDiag({
            level: "info",
            source: "setup-wizard",
            message:
              "settingsSet(last_model) failed after download — not fatal",
            detail: err,
          });
        });
      // Auto-start the model NOW (product review 2026-06-10, onboarding #1):
      // the wizard used to leave the server stopped, so the user's very
      // first send hit "pick a model and press Start". Native already loaded
      // above (the load IS the warm), so only ollama/mlx need a start here.
      // Fire-and-forget — the server-status event stream updates the
      // picker/header as it comes up, and a failure here just lands the user
      // on the old manual Start path.
      if (m.backend !== "native") {
        void Promise.resolve(api.startServer(m.id, m.backend)).catch((err) => {
          logDiag({
            level: "warn",
            source: "setup-wizard",
            message: `auto-start after wizard download failed for ${m.id} (${m.backend}) — user can press Start manually`,
            detail: err,
          });
        });
      }
      setDownloaded(m);
    } catch (err) {
      setDownloadErr(String(err));
    } finally {
      setDownloading(null);
    }
  }

  function skipModel() {
    setStep(3);
  }

  function finish(samplePrompt: string | null) {
    onDone({
      samplePrompt,
      modelId: downloaded?.id ?? null,
      backend: downloaded?.backend ?? null,
    });
  }

  // ── Rendering ────────────────────────────────────────────────────────────

  return (
    <WizardOverlay>
      <div className="setup-wizard-modal">
        <div
          className="setup-wizard-stepper"
          data-testid="setup-wizard-stepper"
        >
          {[1, 2, 3].map((n) => (
            <div
              key={n}
              className={`setup-wizard-step-dot ${step === n ? "active" : ""} ${
                step > n ? "done" : ""
              }`}
            >
              {n}
            </div>
          ))}
        </div>

        {step === 1 && (
          <div className="setup-wizard-step" data-testid="setup-wizard-step-1">
            <h2>Welcome to Froglips</h2>
            <p className="setup-wizard-pitch">
              A fast local-LLM chat with file, shell, and web tools — runs
              entirely on your Mac, no cloud calls.
            </p>
            <p className="setup-wizard-pitch">
              First, let's check which backends are already installed.
            </p>

            <table
              className="setup-wizard-table"
              data-testid="setup-wizard-probe-table"
            >
              <thead>
                <tr>
                  <th>Backend</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {probes.map((p) => (
                  <tr key={p.key} data-testid={`setup-wizard-probe-${p.key}`}>
                    <td>
                      <div className="setup-wizard-backend-name">
                        {p.label}
                        {p.lead && (
                          <span
                            className="setup-wizard-lead-badge"
                            data-testid={`setup-wizard-lead-${p.key}`}
                          >
                            Start here — no install
                          </span>
                        )}
                      </div>
                      <div className="setup-wizard-backend-hint">{p.hint}</div>
                    </td>
                    <td>
                      {p.available === undefined && (
                        <span
                          className="setup-wizard-status checking"
                          data-testid={`setup-wizard-status-${p.key}`}
                        >
                          Checking…
                        </span>
                      )}
                      {p.available === true && (
                        <span
                          className="setup-wizard-status available"
                          data-testid={`setup-wizard-status-${p.key}`}
                        >
                          Available
                        </span>
                      )}
                      {p.available === false && (
                        <span
                          className="setup-wizard-status unavailable"
                          data-testid={`setup-wizard-status-${p.key}`}
                        >
                          Not detected
                        </span>
                      )}
                    </td>
                    <td>
                      {p.installAction === null && (
                        <span className="setup-wizard-action-none">
                          Already available
                        </span>
                      )}
                      {p.installAction?.kind === "url" && (
                        <button
                          className="setup-wizard-install-btn"
                          onClick={() => handleInstall(p.installAction)}
                          disabled={p.available === true}
                        >
                          Install…
                        </button>
                      )}
                      {p.installAction?.kind === "inline" && (
                        <code
                          className="setup-wizard-install-inline"
                          title={p.installAction.text}
                        >
                          {p.installAction.text}
                        </code>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="setup-wizard-nav">
              <button
                className="setup-wizard-skip"
                onClick={() => finish(null)}
                data-testid="setup-wizard-skip-all"
                data-setup-wizard-escape="true"
              >
                Skip setup
              </button>
              <button
                className="setup-wizard-skip"
                onClick={() => {
                  const ref = { current: false };
                  void runProbes(ref);
                }}
                data-testid="setup-wizard-recheck"
              >
                Check again
              </button>
              <button
                className="setup-wizard-primary"
                onClick={() => setStep(2)}
                data-testid="setup-wizard-next-1"
              >
                Next: pick a model
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="setup-wizard-step" data-testid="setup-wizard-step-2">
            <h2>Pick a starter model</h2>
            <p className="setup-wizard-pitch">
              Choose one to download now. You can add more later from the model
              browser.
            </p>
            <p
              className="setup-wizard-pitch setup-wizard-coldload-note"
              data-testid="setup-wizard-coldload-note"
            >
              The first load downloads the weights (a small starter is a few GB)
              and warms the model — this can take a minute. Every load after
              that is instant.
            </p>

            {/* Fast path (UI review): a user who already has a model on disk
                shouldn't be forced through a download just to reach chat.
                Surfaces only when we positively counted ≥1 installed model.
                Uses the wizard's own finish handler so we never touch App. */}
            {existingModelsCount > 0 && (
              <button
                className="setup-wizard-fastpath"
                data-testid="setup-wizard-fastpath"
                onClick={() => finish(null)}
                title="You already have a model installed — skip straight to chat"
              >
                I already have a model → start chatting
              </button>
            )}

            {availableStarters().length === 0 && (
              <div
                className="setup-wizard-empty"
                data-testid="setup-wizard-no-backend"
              >
                No backend available — go back and install one, or skip and
                configure manually.
              </div>
            )}

            {(() => {
              const starters = availableStarters();
              // Lead with the tier sized for this machine's RAM (small ≤16,
              // mid ≤36, large ≤64, flagship above); everything else follows
              // so power users can still go bigger/smaller. If no available
              // starter matches the tier (e.g. native-only lists), fall back
              // to the plain catalog order.
              const machineTier = ramTier(ramGb ?? 16);
              const lead = starters.filter((m) => m.tier === machineTier);
              const ordered =
                lead.length > 0
                  ? [...lead, ...starters.filter((m) => m.tier !== machineTier)]
                  : starters;
              const { recommended, fit } = recommendStarter(
                ordered,
                ramGb ?? 16,
              );
              return (
                <>
                  {ramGb != null && lead.length > 0 && (
                    <p
                      className="setup-wizard-pitch"
                      data-testid="setup-wizard-tier-label"
                    >
                      Fits your {fmtGb(ramGb)} Mac:
                    </p>
                  )}
                  <div className="setup-wizard-cards">
                    {ordered.map((m) => {
                      const isDownloading = downloading?.id === m.id;
                      const isDone = downloaded?.id === m.id;
                      const isRecommended = recommended?.id === m.id;
                      const tier = fit.get(m.id);
                      return (
                        <button
                          key={`${m.backend}:${m.id}`}
                          className={`setup-wizard-card ${isDone ? "done" : ""}${isRecommended ? " is-recommended" : ""}`}
                          data-testid={`setup-wizard-card-${m.id}`}
                          onClick={() => {
                            if (!isDownloading && !isDone)
                              void downloadModel(m);
                          }}
                          disabled={isDownloading || downloading !== null}
                        >
                          {isRecommended && (
                            <div className="setup-wizard-rec-ribbon">
                              {ramGb
                                ? `Recommended for your ${fmtGb(ramGb)} Mac`
                                : "Recommended"}
                            </div>
                          )}
                          <div className="setup-wizard-card-label">
                            {m.label}
                          </div>
                          <div className="setup-wizard-card-meta">
                            {m.size} · {m.backend}
                            {tier && (
                              <span className="headroom-badge" data-tier={tier}>
                                {tier === "comfortable"
                                  ? "Fits"
                                  : tier === "tight"
                                    ? "Tight"
                                    : tier === "thrash"
                                      ? "Heavy"
                                      : "Too big"}
                              </span>
                            )}
                          </div>
                          <div className="setup-wizard-card-desc">
                            {m.description}
                          </div>
                          {isDownloading && (
                            <div className="setup-wizard-card-state">
                              {pullProgress && pullProgress.name === m.id ? (
                                <>
                                  <span className="setup-wizard-dl-status">
                                    {pullProgress.status}
                                  </span>
                                  {pullProgress.percent != null && (
                                    <span
                                      className="setup-wizard-dl-bar"
                                      role="progressbar"
                                      aria-valuenow={Math.round(
                                        pullProgress.percent,
                                      )}
                                    >
                                      <span
                                        className="setup-wizard-dl-fill"
                                        style={{
                                          width: `${pullProgress.percent}%`,
                                        }}
                                      />
                                    </span>
                                  )}
                                </>
                              ) : (
                                "Downloading…"
                              )}
                            </div>
                          )}
                          {isDone && (
                            <div className="setup-wizard-card-state done">
                              Downloaded <Check size={14} />
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                  {/* Honest hardware-fit interrupt (UI review): the inline
                      per-card badge covers comfortable/tight, but when the
                      recommended starter would thrash or not fit at all, say
                      so plainly via the same banner the model picker uses.
                      Not a blocker — the user can still download. */}
                  {ramGb != null &&
                    recommended &&
                    (() => {
                      const hr: Headroom = classify(
                        { size_bytes: recommended.approxGb * GIB },
                        { total_ram_gb: ramGb },
                      );
                      return <HardwareWarningBanner headroom={hr} />;
                    })()}
                </>
              );
            })()}

            {downloadErr && (
              <div
                className="setup-wizard-error"
                data-testid="setup-wizard-dl-err"
              >
                Download failed: {downloadErr}
              </div>
            )}

            <div className="setup-wizard-nav">
              <button className="setup-wizard-skip" onClick={() => setStep(1)}>
                Back
              </button>
              <button
                className="setup-wizard-skip"
                onClick={skipModel}
                data-testid="setup-wizard-skip-model"
                data-setup-wizard-escape="true"
                title="Skip — add a model later from the model picker"
              >
                Skip setup
              </button>
              {/* UI review U-H1: Next was hard-disabled until a starter
                  finished downloading, which penalised users who had
                  already installed a model via CLI or who wanted to pick
                  a non-starter from the browser later. Now: Next is
                  enabled when ANY of {a starter finished, no starters
                  exist, the user already has at least one ollama/mlx
                  model on disk}. Skip stays as the explicit "I'll do
                  nothing now" path. */}
              <button
                className="setup-wizard-primary"
                onClick={() => setStep(3)}
                disabled={
                  downloaded === null &&
                  availableStarters().length > 0 &&
                  existingModelsCount === 0
                }
                data-testid="setup-wizard-next-2"
              >
                Next
              </button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="setup-wizard-step" data-testid="setup-wizard-step-3">
            <h2>All set — try a prompt</h2>
            <p className="setup-wizard-pitch">
              Click one of these to drop it into the composer (you can edit
              before sending).
            </p>

            <div className="setup-wizard-cards">
              {/* Tool prompts only when App will actually arm agent mode
                  (ollama/mlx download). Native / skipped → chat prompts,
                  so the first reply is never a hallucinated tool result. */}
              {(downloaded?.backend === "ollama" ||
              downloaded?.backend === "mlx"
                ? AGENT_SAMPLE_PROMPTS
                : CHAT_SAMPLE_PROMPTS
              ).map((p) => (
                <button
                  key={p.title}
                  className="setup-wizard-card"
                  data-testid={`setup-wizard-prompt-${p.title.replace(/\s+/g, "-").toLowerCase()}`}
                  onClick={() => finish(p.text)}
                >
                  <div className="setup-wizard-card-label">{p.title}</div>
                  <div className="setup-wizard-card-desc">{p.text}</div>
                </button>
              ))}
            </div>

            <div className="setup-wizard-nav">
              <button className="setup-wizard-skip" onClick={() => setStep(2)}>
                Back
              </button>
              <button
                className="setup-wizard-primary"
                onClick={() => finish(null)}
                data-testid="setup-wizard-done"
              >
                Done
              </button>
            </div>
          </div>
        )}
      </div>
    </WizardOverlay>
  );
}

/**
 * Wizard overlay wrapper — adds focus trap + ESC + autofocus.
 *
 * UI review U-H2: previously Esc was a no-op and there was no backdrop
 * close, so new users hitting Esc out of habit got no response. We now
 * use Esc as a soft hint — it doesn't dismiss outright (we still don't
 * want a stray key to dump first-run) but it focuses the "Skip setup"
 * button so the user discovers the escape hatch. Optionally accepts an
 * `onEscapeHint` callback to surface the same behaviour from elsewhere.
 */
function WizardOverlay({
  children,
  onEscapeHint,
}: {
  children: React.ReactNode;
  onEscapeHint?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useModalA11y({
    open: true,
    onClose: () => {
      if (onEscapeHint) {
        onEscapeHint();
        return;
      }
      // Fallback: focus the wizard's "Skip setup" exit button. UX
      // re-review caught the first `.setup-wizard-skip` selector
      // grabbing the "Back" button (which shares the class) on Steps
      // 2 + 3. Now we query a stable data-attribute that ONLY the
      // skip-all-of-setup buttons carry; on Step 3 we fall back to
      // the Done button.
      const skip = ref.current?.querySelector<HTMLButtonElement>(
        '[data-setup-wizard-escape="true"]',
      );
      if (skip) {
        skip.focus();
        return;
      }
      const done = ref.current?.querySelector<HTMLButtonElement>(
        '[data-testid="setup-wizard-done"]',
      );
      done?.focus();
    },
    containerRef: ref,
  });
  return (
    <div
      className="setup-wizard-overlay"
      data-testid="setup-wizard"
      role="dialog"
      aria-modal="true"
      aria-label="Setup wizard"
      ref={ref}
    >
      {children}
    </div>
  );
}
