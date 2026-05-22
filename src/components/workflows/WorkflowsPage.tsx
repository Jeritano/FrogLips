import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  // The card currently open in the centered form. `formIsNew` distinguishes a
  // freshly created (not-yet-saved) draft from editing an existing card.
  const [formCard, setFormCard] = useState<WorkflowCard | null>(null);
  const [formIsNew, setFormIsNew] = useState(false);
  const [formOrigin, setFormOrigin] = useState<FormOrigin | null>(null);
  const [cardStates, setCardStates] = useState<Record<string, CardRunState>>({});
  const [outputs, setOutputs] = useState<Record<string, { output: string; error?: string }>>({});
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
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

  // Non-throwing graph validation drives both the inline warning and the
  // run-button gate.
  const validation = useMemo(() => validateGraph({ cards, edges }), [cards, edges]);
  const warning = validation.ok ? null : validation.error;

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
        setSelected((s) => (s && s.id === p.id ? { ...s, graph: p.graph, updated_at: Date.now() } : s));
        setList((l) => l.map((w) => (w.id === p.id ? { ...w, name: p.name, graph: p.graph } : w)));
      })
      .catch((e) =>
        logDiag({ level: "warn", source: "workflows", message: "workflowSave failed", detail: e }),
      );
  }, []);

  // Debounced persistence of card positions, edges and name into the workflow.
  useEffect(() => {
    if (!selected) return;
    pendingSave.current = { id: selected.id, name: selected.name, graph: { cards, edges } };
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flushSave, 600);
    return () => { if (saveTimer.current) clearTimeout(saveTimer.current); };
  }, [cards, edges, selected, flushSave]);

  // Flush any pending save on unmount so a rename is never lost.
  useEffect(() => () => flushSave(), [flushSave]);

  function openWorkflow(w: Workflow) {
    setSelected(w);
    setCards(w.graph.cards);
    setEdges(w.graph.edges);
    setCardStates({});
    setOutputs({});
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

  // A blank card with a freshly generated codename. `placed` stays false
  // until the card lands on the table (drag-drop or save-from-deck).
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
      placed: false,
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
  function createFromDeck(origin: DOMRect) {
    setFormCard(freshCard());
    setFormIsNew(true);
    setFormOrigin(rectOrigin(origin));
  }

  // Dragging a card from the deck onto the table: place it immediately.
  function placeCard(x: number, y: number) {
    setCards((c) => [...c, { ...freshCard(x, y), placed: true }]);
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

  // Save from the centered form. A new card lands on the deck (placed:false);
  // an edited card updates in place. The form animates back on its own.
  function saveCard(card: WorkflowCard) {
    if (formIsNew) {
      setCards((c) => [...c, card]);
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
        if (result.status === "ok") setState(id, "done");
        else if (result.status === "skipped") setState(id, "idle");
      },
      onCardError: (id, message) => {
        setState(id, "failed");
        setOutputs((o) => ({ ...o, [id]: { output: o[id]?.output ?? "", error: message } }));
      },
      onWorkflowDone: (results) => {
        setRunning(false);
        abortRef.current = null;
        announce(
          results.status === "ok" ? "Workflow run finished" : "Workflow run failed",
        );
        onDone();
      },
    }),
    [setState],
  );

  const baseRunOpts = useCallback((): Omit<RunWorkflowOptions, "model"> & { model: string } | null => {
    if (!status?.model) {
      setErr("Load a model before running a workflow.");
      return null;
    }
    return {
      model: status.model,
      defaultBackend: (status.backend as RunWorkflowOptions["defaultBackend"]) ?? undefined,
      serverStatus: status,
    };
  }, [status]);

  function runWorkflowNow() {
    if (!selected || !validation.ok) {
      setErr("Fix the chain warning before running.");
      return;
    }
    if (running) {
      setErr("A run is already in progress.");
      return;
    }
    const opts = baseRunOpts();
    if (!opts) return;
    const ac = new AbortController();
    abortRef.current = ac;
    setRunning(true);
    setOutputs({});
    setCardStates({});
    announce("Workflow run started");
    void runWorkflow({ cards, edges }, makeHooks(() => {}), {
      ...opts,
      workflowId: selected.id,
      signal: ac.signal,
    }).catch((e) => {
      setRunning(false);
      abortRef.current = null;
      setErr(`Workflow run failed: ${e}`);
    });
  }

  function runSingleCard(id: string) {
    const card = cards.find((c) => c.id === id);
    if (!card || !selected) return;
    if (running) {
      setErr("A run is already in progress.");
      return;
    }
    const opts = baseRunOpts();
    if (!opts) return;
    const ac = new AbortController();
    abortRef.current = ac;
    setRunning(true);
    setCardStates((s) => ({ ...s, [id]: "running" }));
    setOutputs((o) => ({ ...o, [id]: { output: "" } }));
    void runWorkflow(
      { cards: [card], edges: [] },
      makeHooks(() => {}),
      { ...opts, workflowId: selected.id, signal: ac.signal },
    ).catch((e) => {
      setRunning(false);
      abortRef.current = null;
      setErr(`Card run failed: ${e}`);
    });
  }

  function stopRun() {
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
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
        if (running) {
          logDiag({
            level: "warn",
            source: "workflows",
            message: "workflow-trigger ignored — a run is already in progress",
          });
          return;
        }
        const opts = baseRunOpts();
        if (!opts) return;
        const p = e.payload as { workflow_id?: unknown } | null;
        const targetsOpen =
          !!selected && !!p && p.workflow_id === selected.id;
        const hooks = targetsOpen
          ? makeHooks(() => void refreshList())
          : { onWorkflowDone: () => { setRunning(false); void refreshList(); } };
        setRunning(true);
        void handleWorkflowTrigger(e.payload, hooks, { ...opts, scheduled: true }).catch(
          (err) => {
            setRunning(false);
            logDiag({
              level: "warn",
              source: "workflows",
              message: "workflow-trigger handling failed",
              detail: err,
            });
          },
        );
      },
      [baseRunOpts, makeHooks, refreshList, running, selected],
    ),
  );

  const runInfo = useMemo<CardRunInfo[]>(
    () =>
      cards.map((c) => ({
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

  if (!selected) {
    return (
      <div className="wf-page wf-picker" data-testid="workflows-page">
        <div className="wf-picker-head">
          <h2>Workflows</h2>
          <button type="button" className="wf-btn wf-btn-primary" onClick={createWorkflow}>
            + New workflow
          </button>
        </div>
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

  return (
    <div className="wf-page wf-editor" data-testid="workflows-page">
      <div className="wf-editor-bar">
        <button
          type="button"
          className="wf-btn"
          onClick={() => { flushSave(); setSelected(null); }}
        >
          ← Workflows
        </button>
        <input
          className="wf-name-input"
          value={selected.name}
          onChange={(e) => setSelected({ ...selected, name: e.target.value })}
          aria-label="Workflow name"
        />
        {warning && (
          <span className="wf-warning" role="status" data-testid="wf-warning">
            ⚠ {warning}
          </span>
        )}
      </div>
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
            onPlaceCard={placeCard}
            onCreateFromDeck={createFromDeck}
            runningCardId={runningCardId}
          />
        </ReactFlowProvider>
        <RunPanel
          running={running}
          canRun={cards.length > 0 && validation.ok}
          cards={runInfo}
          onRun={runWorkflowNow}
          onStop={stopRun}
        />
      </div>
      {formCard && (
        <CardForm
          card={formCard}
          origin={formOrigin}
          onSave={saveCard}
          onClose={closeForm}
        />
      )}
    </div>
  );
}
