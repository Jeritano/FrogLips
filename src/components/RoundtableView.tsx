import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/tauri-api";
import { Button, Input, Spinner, Badge } from "./ui";
import { usePersistedState } from "../hooks/usePersistedState";
import { useRoundtableRun } from "../lib/roundtable/run-context";
import { parsePrice, formatUsd, type PriceTable, type SeatPrice } from "../lib/roundtable/cost";
import { renderMarkdown } from "../lib/markdown";
import type {
  RoundtableConfig,
  Seat,
  SeatBackend,
  MemoryMode,
  TurnControl,
} from "../lib/roundtable/types";
import "../styles/roundtable.css";

const SEAT_COLORS = ["#22c55e", "#3b82f6", "#a855f7", "#f59e0b", "#ef4444", "#14b8a6"];

/** A pickable model option, flattened across backends. */
interface ModelOption {
  key: string; // `${backend}::${model}`
  backend: SeatBackend;
  model: string;
  label: string;
  group: "OpenRouter" | "Custom backends" | "Ollama";
  price?: SeatPrice | null;
}

interface PersonaTemplate {
  name: string;
  system: string;
}
interface Preset {
  id: string;
  label: string;
  topic: string;
  personas: PersonaTemplate[];
  turnControl: TurnControl;
  maxRounds: number;
}

const PRESETS: Preset[] = [
  {
    id: "debate",
    label: "Debate",
    topic: "Should AGI development be paused? Argue your side.",
    turnControl: "round-robin",
    maxRounds: 4,
    personas: [
      { name: "The Optimist", system: "You argue the optimistic case. Push back hard on doom framing; cite upside and steerability." },
      { name: "The Skeptic", system: "You argue the cautious case. Stress-test every optimistic claim; demand evidence and name failure modes." },
    ],
  },
  {
    id: "brainstorm",
    label: "Brainstorm",
    topic: "Generate and refine ideas for: ",
    turnControl: "round-robin",
    maxRounds: 3,
    personas: [
      { name: "The Generator", system: "Throw out bold, divergent ideas. Quantity over polish. Build on others." },
      { name: "The Refiner", system: "Take the rawest idea on the table and sharpen it into something concrete and testable." },
    ],
  },
  {
    id: "interview",
    label: "Interview",
    topic: "Interview about: ",
    turnControl: "round-robin",
    maxRounds: 4,
    personas: [
      { name: "The Interviewer", system: "Ask one sharp, probing question per turn. Follow up on the last answer; never lecture." },
      { name: "The Expert", system: "Answer concisely and concretely from deep expertise. One claim, well-supported, per turn." },
    ],
  },
  {
    id: "devils",
    label: "Devil's advocate",
    topic: "Propose a plan, then have it torn apart: ",
    turnControl: "round-robin",
    maxRounds: 4,
    personas: [
      { name: "The Proposer", system: "Make the strongest case for your plan and defend it under fire." },
      { name: "The Adversary", system: "Find the fatal flaw. Attack assumptions, incentives, and second-order effects relentlessly." },
    ],
  },
];

/** A configurable seat in the setup form (model split out from Seat for the UI). */
interface DraftSeat {
  id: string;
  name: string;
  color: string;
  optionKey: string; // ModelOption.key, or "" if unset
  system: string;
  temperature: number;
}

let seatCounter = 0;
function newSeat(persona?: PersonaTemplate): DraftSeat {
  return {
    id: `s${seatCounter++}-${Date.now()}`,
    name: persona?.name ?? `Seat ${seatCounter}`,
    color: SEAT_COLORS[seatCounter % SEAT_COLORS.length],
    optionKey: "",
    system: persona?.system ?? "",
    temperature: 0.8,
  };
}

function isDraftSeatArray(v: unknown): v is DraftSeat[] {
  return Array.isArray(v) && v.every((s) => s && typeof s === "object" && "id" in s && "optionKey" in s);
}

// Module-level cache for the picker's model list. `api.settingsGet()` resolves
// each custom backend's API key from the macOS Keychain, which pops a keychain
// prompt — so calling it on every Table mount prompted repeatedly. Cache the
// resolved list across mounts (5-min TTL) so we hit settings/Keychain at most
// once per window.
let cachedOptions: ModelOption[] | null = null;
let cachedOptionsAt = 0;
const OPTIONS_TTL_MS = 5 * 60 * 1000;

export function RoundtableView() {
  const run = useRoundtableRun();
  const [options, setOptions] = useState<ModelOption[]>(() => cachedOptions ?? []);
  const [loadingModels, setLoadingModels] = useState(true);
  const [modelErr, setModelErr] = useState<string | null>(null);

  const [seats, setSeats] = usePersistedState<DraftSeat[]>(
    "roundtable.seats",
    [newSeat(PRESETS[0].personas[0]), newSeat(PRESETS[0].personas[1])],
    isDraftSeatArray,
  );
  const [topic, setTopic] = usePersistedState<string>("roundtable.topic", PRESETS[0].topic);
  const [turnControl] = useState<TurnControl>("round-robin");
  const [memoryMode, setMemoryMode] = usePersistedState<MemoryMode>("roundtable.memory", "recent");
  const [maxRounds, setMaxRounds] = usePersistedState<number>("roundtable.rounds", 4);
  const [maxUsd, setMaxUsd] = usePersistedState<number>("roundtable.maxusd", 0.5);
  const [setupErr, setSetupErr] = useState<string | null>(null);
  const [injectText, setInjectText] = useState("");

  // ── Load available models once (cloud-first: custom + OpenRouter + Ollama) ──
  useEffect(() => {
    // Reuse the cached list (avoids a Keychain prompt on every Table open).
    if (cachedOptions && Date.now() - cachedOptionsAt < OPTIONS_TTL_MS) {
      setOptions(cachedOptions);
      setLoadingModels(false);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoadingModels(true);
      const opts: ModelOption[] = [];
      try {
        const settings = await api.settingsGet().catch(() => null);
        for (const b of settings?.custom_backends ?? []) {
          opts.push({ key: `custom::${b.id}`, backend: "custom", model: b.id, label: `${b.name} (${b.model})`, group: "Custom backends" });
        }
        const hasOr = await api.openrouterHasKey().catch(() => false);
        if (hasOr) {
          const ors = await api.openrouterListModels().catch(() => []);
          for (const m of ors) {
            opts.push({
              key: `openrouter::${m.id}`,
              backend: "openrouter",
              model: m.id,
              label: m.name || m.id,
              group: "OpenRouter",
              price: { inPerToken: parsePrice(m.prompt_price), outPerToken: parsePrice(m.completion_price) },
            });
          }
        }
        const all = await api.listAllModels().catch(() => null);
        for (const e of all?.ollama ?? []) {
          opts.push({ key: `ollama::${e.id}`, backend: "ollama", model: e.id, label: e.id, group: "Ollama" });
        }
        if (!cancelled) {
          cachedOptions = opts;
          cachedOptionsAt = Date.now();
          setOptions(opts);
          if (opts.length === 0) setModelErr("No cloud or Ollama models found. Add a custom backend or an OpenRouter key in Settings.");
        }
      } catch (e) {
        if (!cancelled) setModelErr(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoadingModels(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const optionByKey = useMemo(() => {
    const m = new Map<string, ModelOption>();
    for (const o of options) m.set(o.key, o);
    return m;
  }, [options]);

  const groups = useMemo(() => {
    const g: Record<string, ModelOption[]> = {};
    for (const o of options) (g[o.group] ??= []).push(o);
    return g;
  }, [options]);

  const updateSeat = useCallback(
    (id: string, patch: Partial<DraftSeat>) => setSeats((s) => s.map((x) => (x.id === id ? { ...x, ...patch } : x))),
    [setSeats],
  );
  const removeSeat = useCallback((id: string) => setSeats((s) => (s.length <= 2 ? s : s.filter((x) => x.id !== id))), [setSeats]);
  const addSeat = useCallback(() => setSeats((s) => (s.length >= 6 ? s : [...s, newSeat()])), [setSeats]);

  const applyPreset = useCallback(
    (p: Preset) => {
      setTopic(p.topic);
      setMaxRounds(p.maxRounds);
      // Reset the first N seats to the preset's personas (keeping each seat's
      // existing id + model pick), and PRESERVE any extra seats the user added
      // beyond the preset's persona count. `newSeat()` is called at most once
      // per slot (the old code called it twice, double-advancing the counter).
      setSeats((cur) => {
        const mapped = p.personas.map((persona, i) => {
          const base = cur[i] ?? newSeat();
          return {
            ...base,
            name: persona.name,
            system: persona.system,
            color: SEAT_COLORS[i % SEAT_COLORS.length],
          };
        });
        return [...mapped, ...cur.slice(p.personas.length)];
      });
    },
    [setSeats, setTopic, setMaxRounds],
  );

  const localCount = seats.filter((s) => optionByKey.get(s.optionKey)?.backend === "ollama").length;

  const startRun = useCallback(() => {
    setSetupErr(null);
    if (!topic.trim()) return setSetupErr("Enter a topic.");
    const resolved = seats.map((d) => ({ d, opt: optionByKey.get(d.optionKey) }));
    const unset = resolved.find((r) => !r.opt);
    if (unset) return setSetupErr(`Pick a model for "${unset.d.name}".`);

    const builtSeats: Seat[] = resolved.map(({ d, opt }) => ({
      id: d.id,
      name: d.name.trim() || "Speaker",
      color: d.color,
      backend: opt!.backend,
      model: opt!.model,
      modelLabel: opt!.label,
      system: d.system,
      temperature: d.temperature,
      maxTokens: 512,
    }));
    const prices: PriceTable = {};
    for (const { d, opt } of resolved) prices[d.id] = opt!.price ?? null;

    const config: RoundtableConfig = {
      seats: builtSeats,
      topic: topic.trim(),
      turnControl,
      memoryMode,
      recentWindow: 6,
      stop: { maxRounds, maxTokens: null, maxUsd: maxUsd > 0 ? maxUsd : null },
    };
    if (!run.start(config, prices)) setSetupErr("A roundtable is already running.");
  }, [seats, topic, optionByKey, turnControl, memoryMode, maxRounds, maxUsd, run]);

  const exportTranscript = useCallback(() => {
    const md = run.turns
      .filter((t) => t.status === "done")
      .map((t) => `**${t.speaker}:** ${t.text}`)
      .join("\n\n");
    void navigator.clipboard.writeText(`# Roundtable — ${run.config?.topic ?? ""}\n\n${md}`);
  }, [run.turns, run.config]);

  const showLive = run.running || run.turns.length > 0;

  // ── Live view ──
  if (showLive) {
    return (
      <div className="rt-root" data-testid="roundtable-live">
        <div className="rt-live-head">
          <div className="rt-live-title">
            Roundtable {run.statusLabel && <span className="rt-status">· {run.statusLabel}</span>}
          </div>
          <div className="rt-meter">
            <span>{run.totals.turns} turns</span>
            <span>{(run.totals.tokensIn + run.totals.tokensOut).toLocaleString()} tok</span>
            <span title={run.totals.usdPartial ? "Some models have no published price — lower bound" : undefined}>
              {formatUsd(run.totals.usd)}{run.totals.usdPartial ? "+" : ""}
            </span>
          </div>
          <div className="rt-live-actions">
            {run.running ? (
              <Button size="sm" variant="danger" onClick={run.stop}>Stop</Button>
            ) : (
              <Button size="sm" variant="ghost" onClick={run.clear}>New table</Button>
            )}
          </div>
        </div>

        {run.config && (
          <div className="rt-roster">
            {run.config.seats.map((s) => (
              <span key={s.id} className="rt-chip" style={{ ["--seat" as string]: s.color }}>
                <span className="rt-dot" /> {s.name}
              </span>
            ))}
            {localCount >= 2 && <span className="rt-warn">⚠ 2+ local models reload each turn</span>}
          </div>
        )}

        <div className="rt-transcript">
          {run.turns.map((t) => (
            <div
              key={t.id}
              className={`rt-bubble rt-${t.kind}${t.status === "error" ? " rt-err" : ""}`}
              style={{ ["--seat" as string]: t.color }}
            >
              <div className="rt-bubble-head">
                <span className="rt-dot" /> {t.speaker}
                {t.status === "streaming" && <span className="rt-typing"> · typing…</span>}
                {t.status === "error" && <span className="rt-typing"> · {t.error ?? "failed"}</span>}
              </div>
              {t.status === "streaming" ? (
                <div className="rt-bubble-body rt-streaming">{t.text}<span className="rt-cursor">▍</span></div>
              ) : (
                <div className="rt-bubble-body markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(t.text) }} />
              )}
            </div>
          ))}
          {run.turns.length === 0 && <div className="rt-empty">Starting…</div>}
        </div>

        {run.endReason && !run.running && (
          <div className="rt-end" role="status">
            Ended — {run.endReason.replace("_", " ")} · {run.totals.turns} turns · {formatUsd(run.totals.usd)}
            <Button size="sm" variant="secondary" onClick={exportTranscript}>Copy transcript</Button>
          </div>
        )}

        {run.running && (
          <div className="rt-inject">
            <Input
              placeholder="Moderator: steer the conversation… (Enter to inject)"
              value={injectText}
              onChange={(e) => setInjectText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && injectText.trim()) {
                  run.inject(injectText);
                  setInjectText("");
                }
              }}
            />
          </div>
        )}
      </div>
    );
  }

  // ── Setup view ──
  return (
    <div className="rt-root" data-testid="roundtable-setup">
      <div className="rt-setup-head">
        <div className="rt-live-title">Roundtable</div>
        <div className="rt-presets">
          {PRESETS.map((p) => (
            <button key={p.id} className="rt-preset-btn" onClick={() => applyPreset(p)}>{p.label}</button>
          ))}
        </div>
      </div>

      {modelErr && <div className="rt-err-banner" role="alert">{modelErr}</div>}

      <div className="rt-section-label">Participants <span className="rt-hint">(order = turn order)</span></div>
      <div className="rt-seats">
        {seats.map((s) => (
          <div key={s.id} className="rt-seat" style={{ ["--seat" as string]: s.color }}>
            <div className="rt-seat-top">
              <span className="rt-dot" />
              <Input className="rt-seat-name" value={s.name} onChange={(e) => updateSeat(s.id, { name: e.target.value })} aria-label="Seat name" />
              <select
                className="rt-seat-model"
                value={s.optionKey}
                onChange={(e) => updateSeat(s.id, { optionKey: e.target.value })}
                aria-label="Model"
                disabled={loadingModels}
              >
                <option value="">{loadingModels ? "Loading models…" : "Pick a model…"}</option>
                {Object.entries(groups).map(([g, opts]) => (
                  <optgroup key={g} label={g}>
                    {opts.map((o) => (
                      <option key={o.key} value={o.key}>{o.label}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
              {seats.length > 2 && (
                <button className="rt-seat-x" onClick={() => removeSeat(s.id)} aria-label="Remove seat">✕</button>
              )}
            </div>
            <textarea
              className="rt-seat-persona"
              rows={2}
              placeholder="Persona / stance (system prompt for this seat)…"
              value={s.system}
              onChange={(e) => updateSeat(s.id, { system: e.target.value })}
            />
          </div>
        ))}
      </div>
      {seats.length < 6 && <Button size="sm" variant="secondary" onClick={addSeat}>+ Add participant</Button>}

      <div className="rt-section-label">Topic</div>
      <textarea
        className="rt-topic"
        rows={3}
        placeholder="What should they discuss?"
        value={topic}
        onChange={(e) => setTopic(e.target.value)}
      />

      <div className="rt-controls-grid">
        <label className="rt-ctl">
          <span>Memory</span>
          <select value={memoryMode} onChange={(e) => setMemoryMode(e.target.value as MemoryMode)}>
            <option value="recent">Recent (cheaper)</option>
            <option value="full">Full (best memory, costs more)</option>
          </select>
        </label>
        <label className="rt-ctl">
          <span>Max rounds</span>
          <Input type="number" min={1} max={30} value={maxRounds} onChange={(e) => setMaxRounds(Math.max(1, Number(e.target.value) || 1))} />
        </label>
        <label className="rt-ctl">
          <span>$ budget (0 = none)</span>
          <Input type="number" min={0} step={0.1} value={maxUsd} onChange={(e) => setMaxUsd(Math.max(0, Number(e.target.value) || 0))} />
        </label>
      </div>

      {setupErr && <div className="rt-err-banner" role="alert">{setupErr}</div>}
      {localCount >= 2 && (
        <div className="rt-warn-banner">⚠ Two local (Ollama) models reload on every turn — slow. Prefer cloud models, or one local at most.</div>
      )}

      <div className="rt-start-row">
        <Button variant="primary" onClick={startRun} disabled={loadingModels}>
          {loadingModels ? <Spinner label="Loading" /> : "▶ Start roundtable"}
        </Button>
        <Badge tone="neutral">{seats.length} seats · {maxRounds} rounds · cloud-first</Badge>
      </div>
    </div>
  );
}
