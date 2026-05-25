import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ReactFlowProvider } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { api } from "../../lib/tauri-api";
import { runWorkflow, validateGraph, handleWorkflowTrigger } from "../../lib/workflow";
import type { WorkflowHooks, RunWorkflowOptions } from "../../lib/workflow";
import { logDiag } from "../../lib/diagnostics";
import { announce } from "../../lib/announce";
import { useTauriEvent } from "../../hooks/useTauriEvent";
import { BUILTIN_PRESETS } from "../../lib/agent-presets";
import { EmptyState } from "../EmptyState";
import {
  parseWorkflow,
  serializeWorkflowGraph,
  type ServerStatus,
  type Workflow,
  type WorkflowCard,
  type WorkflowEdge,
  type WorkflowGraph,
} from "../../types";
import { WorkflowCanvas } from "./WorkflowCanvas";
import { CardForm, type FormOrigin } from "./CardForm";
import { RunPanel, type CardRunInfo } from "./RunPanel";
import { generateAgentName } from "../../lib/agent-name";
import { formatUserProfile } from "../../lib/user-profile";
import type { CardRunState } from "./AgentCardNode";

interface Props {
  /** Current backend status — supplies the model the runner needs. */
  status: ServerStatus | null;
}

let cardSeq = 0;
function newCardId() {
  return `card-${Date.now().toString(36)}-${(cardSeq++).toString(36)}`;
}

export function WorkflowsPage({ status }: Props) {
  const [list, setList] = useState<Workflow[]>([]);
  const [selected, setSelected] = useState<Workflow | null>(null);
  const [cards, setCards] = useState<WorkflowCard[]>([]);
  const [edges, setEdges] = useState<WorkflowEdge[]>([]);
  // Local workflow-name state — the input writes here, and the debounced save
  // threads this into `pendingSave`. Keeping the name separate from
  // `selected.name` prevents `refreshList()` from racing the input and
  // clobbering an in-flight rename.
  const [name, setName] = useState<string>("");
  // The card currently open in the centered form. `formIsNew` distinguishes a
  // freshly created (not-yet-saved) draft from editing an existing card.
  const [formCard, setFormCard] = useState<WorkflowCard | null>(null);
  const [formIsNew, setFormIsNew] = useState(false);
  const [formOrigin, setFormOrigin] = useState<FormOrigin | null>(null);
  const [cardStates, setCardStates] = useState<Record<string, CardRunState>>({});
  const [outputs, setOutputs] = useState<Record<string, { output: string; error?: string }>>({});
  const [running, setRunning] = useState(false);
  // `running` is React state — captured by closures and only updated on the
  // next render. The three entry points into a workflow run (Run, Run-card,
  // and the workflow-trigger event handler) all gate on `running`, but in a
  // single event-loop tick two of them may see the same `false` and both
  // start a run. `runningRef` mirrors the state synchronously so every
  // entry point reads the same source of truth and the second caller is
  // refused without racing on React's batching.
  const runningRef = useRef(false);
  const [err, setErr] = useState<string | null>(null);
  // Approval policy: per-card `unattended` checkbox is the SOLE approval
  // surface. Cards with the box checked auto-approve every tool call.
  // Cards without it use the runner's default deny-all gate. Either way
  // no modal opens during a workflow run — the user already declared
  // their intent at card-edit time.
  //
  // Unmount safety: a navigate-away mid-run aborts the in-flight controller
  // so the agent loop exits at its next iteration boundary. There is no
  // pending approval Promise to resolve any more (no modal exists), so the
  // single concern is: kill the run cleanly.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);
  // Pre-formatted "About You" block, shared by every card's agent run so
  // workflow agents know who the user is. Refreshed on mount.
  const [userProfile, setUserProfile] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshList = useCallback(async () => {
    try {
      setList((await api.workflowList()).map(parseWorkflow));
    } catch (e) {
      logDiag({ level: "warn", source: "workflows", message: "workflowList failed", detail: e });
    }
  }, []);

  useEffect(() => { void refreshList(); }, [refreshList]);

  // Load the "About You" profile once; a failed read just omits it.
  useEffect(() => {
    api.settingsGet()
      .then((s) => setUserProfile(formatUserProfile(s.user_profile)))
      .catch((e) =>
        logDiag({ level: "warn", source: "workflows", message: "settingsGet failed", detail: e }),
      );
  }, []);

  // Non-throwing graph validation drives both the inline warning and the
  // run-button gate.
  const validation = useMemo(() => validateGraph({ cards, edges }), [cards, edges]);
  // Suppress the validation banner while the user is still building: a lone
  // card or several not-yet-connected cards is a normal mid-build state, not
  // an error. The Run button stays gated by `validation.ok` either way.
  const warning = useMemo(() => {
    if (validation.ok) return null;
    if (edges.length === 0) return null;
    return validation.error;
  }, [validation, edges]);

  // Latest unsaved graph/name, kept in a ref so unmount/navigate-away can
  // flush a pending debounced save without re-subscribing the effect.
  const pendingSave = useRef<{ id: number; name: string; graph: WorkflowGraph } | null>(null);

  const flushSave = useCallback(() => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const p = pendingSave.current;
    if (!p) return;
    pendingSave.current = null;
    api.workflowSave(p.id, p.name, serializeWorkflowGraph(p.graph))
      .then(() => {
        // Reconcile against the saved name AND graph. Use the functional form
        // so a name the user kept typing AFTER this save was queued isn't
        // clobbered — only update fields if the persisted name still matches
        // the user's current intent (selected.name was set at queue time).
        setSelected((s) =>
          s && s.id === p.id ? { ...s, name: p.name, graph: p.graph, updated_at: Date.now() } : s,
        );
        setList((l) => l.map((w) => (w.id === p.id ? { ...w, name: p.name, graph: p.graph } : w)));
      })
      .catch((e) =>
        logDiag({ level: "warn", source: "workflows", message: "workflowSave failed", detail: e }),
      );
  }, []);

  // Debounced persistence of card positions, edges and name into the workflow.
  // `name` is the local-state input mirror so a rename survives an interleaved
  // refreshList() — previously, setSelected({...selected, name}) was overwritten
  // when refreshList() rehydrated `selected` from the DB.
  //
  // The dirty-gate matters: this effect re-runs on EVERY render, including
  // renders triggered by unrelated state (status changes, userProfile loads,
  // confirm-modal lifecycle). Without the gate, the auto-save would clobber
  // any concurrent DB edit (an external migration, another window) with the
  // in-memory state — which may itself be stale from the original load.
  // Only schedule a flush when something genuinely changed since open.
  const loadedSnapshotRef = useRef<string>("");
  const loadedWorkflowIdRef = useRef<number | null>(null);
  useEffect(() => {
    if (!selected) {
      loadedSnapshotRef.current = "";
      loadedWorkflowIdRef.current = null;
      return;
    }
    // Re-baseline whenever the workflow id changes. Without this, a
    // workflow switch (A → picker → B, OR a future direct-switch path)
    // would carry A's snapshot into B's lifecycle and immediately fire a
    // spurious "B is dirty" save.
    if (loadedWorkflowIdRef.current !== selected.id) {
      loadedSnapshotRef.current = JSON.stringify({ name, cards, edges });
      loadedWorkflowIdRef.current = selected.id;
      // Reset any stale pending entry queued under the previous workflow.
      pendingSave.current = null;
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      return;
    }
    const currentSnapshot = JSON.stringify({ name, cards, edges });
    if (loadedSnapshotRef.current === currentSnapshot) {
      // No user edit since open — skip the save so unrelated renders don't
      // overwrite externally-applied DB changes. ALSO clear any stale
      // pendingSave from a prior dirty cycle that the user has since
      // reverted: without this, a `flushSave` from the unmount path would
      // re-apply the abandoned edit and lose the user's revert.
      pendingSave.current = null;
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      return;
    }
    pendingSave.current = { id: selected.id, name, graph: { cards, edges } };
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flushSave, 600);
    return () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
    };
  }, [cards, edges, selected, name, flushSave]);

  // Flush any pending save on unmount so a rename is never lost. (Belt-and-
  // suspenders: the per-effect cleanup above already flushes; this catches
  // the case where the component unmounts without re-running the effect.)
  useEffect(() => () => flushSave(), [flushSave]);

  function openWorkflow(w: Workflow) {
    setSelected(w);
    setName(w.name);
    setCards(w.graph.cards);
    setEdges(w.graph.edges);
    setCardStates({});
    setOutputs({});
    // Reset any open card-edit form left over from a prior workflow; the
    // formCard would otherwise point at an id absent from the new graph
    // and any save would silently no-op.
    setFormCard(null);
    setFormIsNew(false);
    setFormOrigin(null);
    // Clear any sticky error banner from a prior workflow's run.
    setErr(null);
  }

  async function createWorkflow() {
    try {
      const name = "Untitled workflow";
      const graph: WorkflowGraph = { cards: [], edges: [] };
      const id = await api.workflowSave(null, name, serializeWorkflowGraph(graph));
      const now = Date.now();
      const wf: Workflow = { id, name, graph, created_at: now, updated_at: now };
      await refreshList();
      openWorkflow(wf);
    } catch (e) {
      setErr(`Failed to create workflow: ${e}`);
    }
  }

  async function deleteWorkflow(id: number) {
    try {
      await api.workflowDelete(id);
      if (selected?.id === id) setSelected(null);
      await refreshList();
    } catch (e) {
      setErr(`Failed to delete workflow: ${e}`);
    }
  }

  // A blank card with a freshly generated codename. Created cards are placed
  // on the canvas straight away so the user can position and connect them.
  function freshCard(x = 0, y = 0): WorkflowCard {
    return {
      id: newCardId(),
      name: generateAgentName(),
      preset: BUILTIN_PRESETS[0].id,
      prompt: "",
      tools: [],
      schedule: null,
      backend: null,
      model: null,
      placed: true,
      unattended: false,
      x,
      y,
    };
  }

  const deleteCard = useCallback((id: string) => {
    setCards((c) => c.filter((x) => x.id !== id));
    setEdges((e) => e.filter((x) => x.from !== id && x.to !== id));
  }, []);

  // Convert a DOMRect (viewport coords) into the form's fly-origin shape.
  function rectOrigin(r: DOMRect): FormOrigin {
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }

  // Clicking the deck's top card: open the centered form on a fresh draft.
  // `position` is a viewport-aware flow-coordinate supplied by the canvas, so
  // saving lands the node where the user can currently see it.
  function createFromDeck(origin: DOMRect, position: { x: number; y: number }) {
    setFormCard(freshCard(position.x, position.y));
    setFormIsNew(true);
    setFormOrigin(rectOrigin(origin));
  }

  // Clicking a placed node: open the centered form to edit it.
  function editCard(id: string, origin: DOMRect) {
    const card = cards.find((c) => c.id === id);
    if (!card) return;
    setFormCard(card);
    setFormIsNew(false);
    setFormOrigin(rectOrigin(origin));
  }

  function closeForm() {
    setFormCard(null);
    setFormIsNew(false);
    setFormOrigin(null);
  }

  // Save from the centered form. A new card lands directly on the canvas
  // (placed:true), visible and connectable; an edited card updates in place.
  function saveCard(card: WorkflowCard) {
    if (formIsNew) {
      setCards((c) => [...c, { ...card, placed: true }]);
    } else {
      setCards((c) => c.map((x) => (x.id === card.id ? card : x)));
    }
    closeForm();
  }

  const setState = useCallback((id: string, state: CardRunState) => {
    setCardStates((s) => ({ ...s, [id]: state }));
  }, []);

  // Lifecycle hooks shared by full-workflow and single-card runs.
  const makeHooks = useCallback(
    (onDone: () => void): WorkflowHooks => ({
      onCardStart: (id) => setState(id, "running"),
      onCardOutput: (id, text) =>
        setOutputs((o) => ({
          ...o,
          [id]: { output: (o[id]?.output ?? "") + text, error: o[id]?.error },
        })),
      onCardDone: (id, result) => {
        // Every terminal status must transition the card out of "running".
        // Previously only `ok` and `skipped` were handled, leaving the badge
        // stuck on "Running" after an abort or after a downstream-of-error
        // skip resolved. `error` is also covered here as defence-in-depth —
        // onCardError fires first for that path but a missed event would
        // otherwise leave the card visibly running.
        if (result.status === "ok") setState(id, "done");
        else if (result.status === "skipped") setState(id, "idle");
        else if (result.status === "aborted" || result.status === "error") {
          setState(id, "failed");
        }
      },
      onCardError: (id, message) => {
        setState(id, "failed");
        setOutputs((o) => ({ ...o, [id]: { output: o[id]?.output ?? "", error: message } }));
      },
      onWorkflowDone: (results) => {
        setRunning(false);
        runningRef.current = false;
        abortRef.current = null;
        announce(
          results.status === "ok" ? "Workflow run finished" : "Workflow run failed",
        );
        // Surface in-card errors as a top-level banner. The runner records
        // each per-card failure as `CardResult.status = "error"` with an
        // `error` message and never throws back to the caller. Previously
        // the only visible signal was a small "Failed" badge in the run
        // panel, leaving users staring at a "Run finished" announcement
        // with no obvious reason WHY their files never got written. List
        // up to 3 failing cards by name + first 200 chars of their error.
        if (results.status === "failed") {
          const failed = results.cards.filter((c) => c.status === "error");
          if (failed.length > 0) {
            const sample = failed.slice(0, 3).map((c) => {
              const errMsg = (c.error ?? "unknown error").slice(0, 200);
              return `${c.name}: ${errMsg}`;
            });
            const more = failed.length > 3 ? ` (+${failed.length - 3} more)` : "";
            setErr(
              `Workflow failed — ${failed.length} card(s) errored:\n${sample.join("\n")}${more}`,
            );
          } else {
            // status=failed with no per-card errors means the run was aborted.
            const aborted = results.cards.filter((c) => c.status === "aborted");
            if (aborted.length > 0) {
              setErr(`Run stopped during "${aborted[0].name}".`);
            }
          }
        }
        onDone();
      },
    }),
    [setState],
  );

  /**
   * Build the per-run options. `cardSubset` restricts the model-coverage
   * check to a specific list of cards — used by `runSingleCard` so a
   * one-card run only validates THAT card's model, not every card on
   * the canvas. For `runWorkflowNow` we validate every card.
   */
  const baseRunOpts = useCallback(
    (
      cardSubset?: WorkflowCard[],
    ): Omit<RunWorkflowOptions, "model"> & { model: string } | null => {
      const subset = cardSubset ?? cards;
      // A card "needs" the fallback (loaded chat model) only when its own
      // `model` is unset. Cards with an explicit `*:cloud` model already
      // satisfy the gate — the Ollama daemon routes those without a local
      // server load. Cards with an explicit local model satisfy it too;
      // `ensureCardModelLoaded` brings up the right server before the run.
      const missing = subset.filter((c) => !c.model);
      const fallbackModel = status?.model ?? "";
      if (missing.length > 0 && !fallbackModel) {
        const names = missing.map((c) => c.name || c.id).slice(0, 3).join(", ");
        const more = missing.length > 3 ? ` (+${missing.length - 3} more)` : "";
        setErr(
          `Load a model first — ${missing.length} card(s) without a model assignment: ${names}${more}. Either assign a model to each card via Edit, or load a default in the chat picker.`,
        );
        return null;
      }
      return {
        // Cards with their own `model` ignore this; cards without one use it.
        model: fallbackModel,
        defaultBackend: (status?.backend as RunWorkflowOptions["defaultBackend"]) ?? undefined,
        serverStatus: status,
        userProfile: userProfile ?? undefined,
        // No `requestConfirmation` is passed: approval is owned by the
        // per-card `unattended` checkbox. Cards with the box checked
        // approve their own tool calls; cards without it fall through to
        // the runner's default deny-all gate, which refuses every
        // dangerous tool without ever opening a modal.
      };
    },
    [status, userProfile, cards],
  );

  /**
   * Best-effort: start the local server for the card's pinned model if
   * it differs from the currently-loaded one. Cloud Ollama models
   * (anything ending with `:cloud`) bypass startup — the daemon routes
   * them directly. Native + MLX + local Ollama models need a Start call
   * so the agent loop has a serving endpoint.
   */
  async function ensureCardModelLoaded(card: WorkflowCard): Promise<void> {
    if (!card.model) return;
    if (card.model.endsWith(":cloud")) return; // daemon-routed, no start needed
    if (status?.model === card.model && status?.running) return;
    const backend =
      card.backend === "native" || card.backend === "mlx" || card.backend === "ollama"
        ? card.backend
        : (status?.backend ?? "ollama");
    try {
      // The App-level `server-status` listener picks up the new state
      // on the next tick — no setter wiring needed here.
      await api.startServer(card.model, backend);
    } catch (e) {
      // Non-fatal — the agent loop may still succeed (cloud routing,
      // pre-existing daemon, etc.). Surface in the diag layer so the
      // user has a breadcrumb if the run fails downstream.
      logDiag({
        level: "info",
        source: "workflows",
        message: `ensureCardModelLoaded: startServer failed for ${card.model} (${backend}); continuing`,
        detail: e,
      });
    }
  }

  function runWorkflowNow() {
    // Clear any sticky banner from a prior attempt — without this,
    // fixing the issue and clicking Run again leaves the old red error
    // text on screen as if the new run also failed.
    setErr(null);
    if (!selected || !validation.ok) {
      setErr("Fix the chain warning before running.");
      return;
    }
    // Synchronous ref check — `running` state may still read false here if
    // a near-simultaneous click + workflow-trigger event both land in the
    // same tick. The ref is flipped *before* the await, claiming the slot.
    if (runningRef.current || running) {
      setErr("A run is already in progress.");
      return;
    }
    const opts = baseRunOpts();
    if (!opts) return;
    runningRef.current = true;
    // Pre-load each card's model BEFORE the runner starts. Native + MLX
    // backends have 10-30s cold starts; without this the first card hits
    // "connection refused" before its model is ready. Cloud models no-op
    // inside `ensureCardModelLoaded`. De-duped by model name so two cards
    // pinned to the same model share a single load. Sequential to avoid
    // hammering the daemon.
    const ac = new AbortController();
    abortRef.current = ac;
    setRunning(true);
    setOutputs({});
    setCardStates({});
    announce("Workflow run started");
    void (async () => {
      const loaded = new Set<string>();
      for (const c of cards) {
        if (ac.signal.aborted) break;
        if (c.model && loaded.has(c.model)) continue;
        await ensureCardModelLoaded(c);
        if (c.model) loaded.add(c.model);
      }
      if (ac.signal.aborted) {
        setRunning(false);
        runningRef.current = false;
        abortRef.current = null;
        return;
      }
      try {
        await runWorkflow({ cards, edges }, makeHooks(() => {}), {
          ...opts,
          workflowId: selected.id,
          signal: ac.signal,
        });
      } catch (e) {
        setRunning(false);
        runningRef.current = false;
        abortRef.current = null;
        setErr(`Workflow run failed: ${e}`);
      }
    })();
  }

  function runSingleCard(id: string) {
    // Clear stale banner first — see runWorkflowNow for context.
    setErr(null);
    const card = cards.find((c) => c.id === id);
    if (!card || !selected) return;
    if (runningRef.current || running) {
      setErr("A run is already in progress.");
      return;
    }
    // Scope the model check to JUST this card so a one-card run from a
    // workflow with other un-modeled cards still succeeds.
    const opts = baseRunOpts([card]);
    if (!opts) return;
    // Claim the slot AFTER the gate has been validated — otherwise an
    // early-return from `baseRunOpts` would leave the ref pinned `true`
    // and the next legitimate run would be refused.
    runningRef.current = true;
    // Clear ALL prior states + outputs before starting the single-card
    // run — leaving stale `done`/`failed` badges from a previous full
    // workflow run makes the canvas falsely suggest those agents just
    // executed. Persisted run records still hold the history.
    const ac = new AbortController();
    abortRef.current = ac;
    setRunning(true);
    setCardStates({ [id]: "running" });
    setOutputs({ [id]: { output: "" } });
    announce("Card run started");
    void (async () => {
      if (ac.signal.aborted) {
        setRunning(false);
        runningRef.current = false;
        abortRef.current = null;
        return;
      }
      // AWAIT the load before kicking the runner. Cloud routes no-op
      // inside ensureCardModelLoaded so this is fast for `*:cloud`
      // models.
      await ensureCardModelLoaded(card);
      if (ac.signal.aborted) {
        setRunning(false);
        runningRef.current = false;
        abortRef.current = null;
        return;
      }
      try {
        await runWorkflow(
          { cards: [card], edges: [] },
          makeHooks(() => {}),
          { ...opts, workflowId: selected.id, signal: ac.signal },
        );
      } catch (e) {
        setRunning(false);
        runningRef.current = false;
        abortRef.current = null;
        setErr(`Card run failed: ${e}`);
      }
    })();
  }

  function stopRun() {
    // Don't clear `running` here — the in-flight run hasn't actually resolved
    // yet, so a `workflow-trigger` arriving in the window between abort() and
    // the runner's onWorkflowDone could spawn a parallel run. Leave `running`
    // true; the runner's onWorkflowDone (always invoked, even on abort) flips
    // it back to false.
    //
    // Also DO NOT null-out abortRef.current here. A second Stop click while
    // the runner is still tearing down would then become a no-op (the new
    // ref is null), and any subsystem still polling abortRef in flight loses
    // its handle. `onWorkflowDone` is responsible for clearing the ref once
    // the run actually resolves; until then keep the live controller.
    abortRef.current?.abort();
    announce("Workflow run stopped");
  }

  // Scheduled cards: the backend emits `workflow-trigger`; the schedule glue
  // loads the workflow and runs it from the triggered card.
  //
  // A trigger for a workflow OTHER than the one open in the editor must not
  // paint into the editor's live buffers — it runs with empty hooks. A
  // trigger for the open workflow uses the visual hooks. Either way the run
  // is `scheduled: true` so cards may honor their `unattended` opt-in.
  useTauriEvent<unknown>(
    "workflow-trigger",
    useCallback(
      (e) => {
        if (runningRef.current || running) {
          logDiag({
            level: "warn",
            source: "workflows",
            message: "workflow-trigger ignored — a run is already in progress",
          });
          return;
        }
        const p = e.payload as { workflow_id?: unknown; card_id?: unknown } | null;
        const targetsOpen =
          !!selected && !!p && p.workflow_id === selected.id;
        // Model-coverage check is scoped to the cards that will actually
        // run (start card onward). A scheduled trigger that starts mid-
        // chain should not fail the gate over un-modeled cards EARLIER in
        // the same workflow that won't be executed. When the trigger is
        // for a workflow OTHER than the open one we don't have its graph
        // here, so fall back to whatever the open editor knows — the
        // schedule glue revalidates via its own runner.
        const triggerCardId = typeof p?.card_id === "string" ? p.card_id : null;
        let subset: WorkflowCard[] | undefined = undefined;
        if (targetsOpen && triggerCardId) {
          const idx = cards.findIndex((c) => c.id === triggerCardId);
          if (idx >= 0) subset = cards.slice(idx);
        }
        const opts = baseRunOpts(subset);
        if (!opts) return;
        // Claim the slot AFTER the gate has been validated — leaves the ref
        // clean if `baseRunOpts` short-circuits on missing model.
        runningRef.current = true;
        const hooks = targetsOpen
          ? makeHooks(() => void refreshList())
          : {
              onWorkflowDone: () => {
                setRunning(false);
                runningRef.current = false;
                void refreshList();
              },
            };
        setRunning(true);
        void handleWorkflowTrigger(e.payload, hooks, { ...opts, scheduled: true }).catch(
          (err) => {
            setRunning(false);
            runningRef.current = false;
            logDiag({
              level: "warn",
              source: "workflows",
              message: "workflow-trigger handling failed",
              detail: err,
            });
          },
        );
      },
      [baseRunOpts, makeHooks, refreshList, running, selected, cards],
    ),
  );

  const runInfo = useMemo<CardRunInfo[]>(
    () =>
      cards
        .filter((c) => c.placed !== false)
        .map((c) => ({
          id: c.id,
          name: c.name,
          state: cardStates[c.id] ?? "idle",
          output: outputs[c.id]?.output ?? "",
          error: outputs[c.id]?.error,
        })),
    [cards, cardStates, outputs],
  );

  const runningCardId = useMemo(
    () => cards.find((c) => (cardStates[c.id] ?? "idle") === "running")?.id ?? null,
    [cards, cardStates],
  );

  // The portal slot inside App.tsx's <header> where this page renders its
  // top-bar controls. Reading it on every render is cheap (just a DOM ref
  // lookup) and lets the page mount its header chrome into the same row
  // as the chat ModelPicker — keeping the chrome height constant across
  // views. `null` until App mounts the slot, which is true on the very
  // first render in dev w/ Strict Mode; the page degrades to no top bar
  // until the next paint, which is harmless.
  const topbarSlot =
    typeof document !== "undefined"
      ? document.getElementById("workflow-topbar-slot")
      : null;

  if (!selected) {
    const pickerHeader = (
      <>
        <h1 className="topbar-view-title">Workflows</h1>
        <button
          type="button"
          className="wf-btn wf-btn-primary topbar-action"
          onClick={createWorkflow}
        >
          + New workflow
        </button>
      </>
    );
    return (
      <div className="wf-page wf-picker" data-testid="workflows-page">
        {topbarSlot && createPortal(pickerHeader, topbarSlot)}
        {err && <div className="wf-error" onClick={() => setErr(null)}>{err}</div>}
        {list.length === 0 ? (
          <EmptyState
            icon="🧩"
            heading="No workflows yet"
            sub="Create a workflow to chain agents into an automated pipeline."
          />
        ) : (
          <ul className="wf-list">
            {list.map((w) => (
              <li key={w.id} className="wf-list-item">
                <button type="button" className="wf-list-open" onClick={() => openWorkflow(w)}>
                  <span className="wf-list-name">{w.name}</span>
                  <span className="wf-list-meta">{w.graph.cards.length} cards</span>
                </button>
                <button
                  type="button"
                  className="wf-list-del"
                  onClick={() => deleteWorkflow(w.id)}
                  aria-label={`Delete ${w.name}`}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  const canRun = runInfo.length > 0 && validation.ok;
  const editorHeader = (
    <>
      <button
        type="button"
        className="wf-btn"
        onClick={() => { flushSave(); setSelected(null); }}
      >
        ← Workflows
      </button>
      <input
        className="wf-name-input"
        value={name}
        onChange={(e) => setName(e.target.value)}
        aria-label="Workflow name"
      />
      {warning && (
        <span className="wf-warning" role="status" data-testid="wf-warning">
          ⚠ {warning}
        </span>
      )}
      {running && (
        <span
          className="wf-warning"
          role="status"
          data-testid="wf-run-warning"
          style={{ color: "var(--accent, #6c8eff)" }}
        >
          ● Run in progress — leaving this view will cancel it.
        </span>
      )}
      {/* Run/Stop sits in the top bar, immediately left of the theme
          toggle. `.topbar-action` keeps the button compact so the
          header row matches the chat ModelPicker's height. `margin-left:
          auto` pushes it to the right edge of the slot (theme toggle
          still floats further right via its own auto-margin). */}
      {running ? (
        <button
          type="button"
          className="wf-btn wf-btn-danger topbar-action"
          style={{ marginLeft: "auto" }}
          onClick={stopRun}
        >
          Stop
        </button>
      ) : (
        <button
          type="button"
          className="wf-btn wf-btn-primary topbar-action"
          style={{ marginLeft: "auto" }}
          onClick={runWorkflowNow}
          disabled={!canRun}
          title={canRun ? "Run workflow" : "Add cards and a valid linear chain first"}
        >
          Run workflow
        </button>
      )}
    </>
  );

  return (
    <div className="wf-page wf-editor" data-testid="workflows-page">
      {topbarSlot && createPortal(editorHeader, topbarSlot)}
      {err && <div className="wf-error" onClick={() => setErr(null)}>{err}</div>}
      <div className="wf-editor-body">
        <ReactFlowProvider>
          <WorkflowCanvas
            cards={cards}
            edges={edges}
            cardStates={cardStates}
            onCardsChange={setCards}
            onEdgesChange={setEdges}
            onConfigure={editCard}
            onRunCard={runSingleCard}
            onDeleteCard={deleteCard}
            onCreateFromDeck={createFromDeck}
            runningCardId={runningCardId}
          />
        </ReactFlowProvider>
        <RunPanel cards={runInfo} />
      </div>
      {formCard && (
        <CardForm
          card={formCard}
          origin={formOrigin}
          isNew={formIsNew}
          onSave={saveCard}
          onClose={closeForm}
        />
      )}
    </div>
  );
}
