import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ReactFlowProvider } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Puzzle, X } from "lucide-react";
import { api } from "../../lib/tauri-api";
import { validateGraph, parseWorkflowTrigger } from "../../lib/workflow";
import type { RunWorkflowOptions } from "../../lib/workflow";
import {
  useWorkflowRunControl,
  useWorkflowRunCards,
} from "../../lib/workflow/run-context";
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
import {
  FLOW_TEMPLATES,
  cloneTemplateGraph,
  type FlowTemplate,
} from "../../lib/workflow/templates";
import { healStaleTemplateClones } from "../../lib/workflow/heal-templates";
import { flowToDoc, flowFromDoc } from "../../lib/workflow/export";
import { WorkflowCanvas } from "./WorkflowCanvas";
import { CardForm, type FormOrigin } from "./CardForm";
import { RunPanel, type CardRunInfo } from "./RunPanel";
import { SkillsPanel } from "./SkillsPanel";
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
  // Skills panel (procedural-memory inspector) — opened from the editor
  // header. The panel itself owns its fetch lifecycle and refetches when
  // `workflowId` changes, so we just toggle visibility here.
  const [skillsOpen, setSkillsOpen] = useState(false);
  // Shareable-Flow import (paste a copied Flow doc).
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importErr, setImportErr] = useState<string | null>(null);
  // 2026-05-26 Option-A lift: workflow run state now lives in the
  // App-level WorkflowRunProvider so a navigate-away no longer aborts
  // the run. The provider also owns the AbortController + synchronous
  // running-id ref so the entry-point gating semantics are preserved.
  //
  // Perf (adversarial review HIGH, 2026-06-12): the page shell subscribes
  // ONLY to the STABLE control surface (running id, summary, start/stop) so
  // a streamed token no longer repaints this ~1000-line component. The HOT
  // per-card snapshot — the only thing that changes per token — is isolated
  // in `<RunSurface>` below, which subscribes to the card context and is the
  // sole subtree that re-renders during streaming.
  const run = useWorkflowRunControl();
  const [err, setErr] = useState<string | null>(null);
  // Approval policy: per-card `unattended` checkbox is the SOLE approval
  // surface. Cards with the box checked auto-approve every tool call.
  // Cards without it use the runner's default deny-all gate. Either way
  // no modal opens during a workflow run — the user already declared
  // their intent at card-edit time.
  //
  // Unmount no longer aborts: the WorkflowRunProvider owns the
  // AbortController, so navigating to Chat / Images / etc. keeps the
  // run alive. The user gets a sidebar badge to navigate back. Run
  // dies only on full app reload or explicit Stop.

  // Mirror provider's lastSummary.errorBanner into the page's `err`
  // banner whenever a finished run's banner changes — preserves the
  // previous UX where in-card errors surface as a top banner.
  useEffect(() => {
    if (run.lastSummary?.errorBanner) {
      setErr(run.lastSummary.errorBanner);
    }
  }, [run.lastSummary]);

  // Per-card snapshots (`run.cardStates`) are deliberately NOT read here —
  // they update on every streamed token. The `<RunSurface>` child owns that
  // hot subscription so the page shell stays put during a run. `running`
  // comes from the stable control surface (flips once per run boundary).
  const running = run.runningWorkflowId !== null;
  // Pre-formatted "About You" block, shared by every card's agent run so
  // workflow agents know who the user is. Refreshed on mount.
  const [userProfile, setUserProfile] = useState<string | null>(null);
  // Active agent write-workspace, surfaced in the RunPanel so the user always
  // knows where a flow's file-writing cards land. `undefined` = not yet loaded
  // (render nothing); `null` = unset (warn: files scatter under ~).
  const [workspace, setWorkspace] = useState<string | null | undefined>(
    undefined,
  );
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshList = useCallback(async () => {
    try {
      setList((await api.workflowList()).map(parseWorkflow));
    } catch (e) {
      logDiag({
        level: "warn",
        source: "workflows",
        message: "workflowList failed",
        detail: e,
      });
    }
  }, []);

  useEffect(() => {
    void refreshList();
  }, [refreshList]);

  // First-open demo seed (product review 2026-06-10, onboarding #3): a new
  // user opening Flows saw an empty canvas plus abstract template cards —
  // nothing demonstrating what a finished multi-agent run looks like. Seed
  // ONE ready-to-run flow from the gallery exactly once (flag in
  // localStorage, only when the list is genuinely empty so we never inject
  // into a real workspace).
  const demoSeeded = useRef(false);
  useEffect(() => {
    if (demoSeeded.current) return;
    if (localStorage.getItem("froglips.demoFlowSeeded")) return;
    void (async () => {
      try {
        const existing = await api.workflowList();
        if (existing.length > 0) {
          localStorage.setItem("froglips.demoFlowSeeded", "1");
          return;
        }
        const t =
          FLOW_TEMPLATES.find((x) => x.id === "brainstorm-moa") ??
          FLOW_TEMPLATES[0];
        if (!t) return;
        demoSeeded.current = true;
        const graph = cloneTemplateGraph(t);
        await api.workflowSave(
          null,
          `Demo — ${t.name} (try me)`,
          serializeWorkflowGraph(graph),
        );
        localStorage.setItem("froglips.demoFlowSeeded", "1");
        await refreshList();
      } catch (e) {
        logDiag({
          level: "info",
          source: "workflows",
          message: "demo flow seed skipped",
          detail: e,
        });
      }
    })();
  }, [refreshList]);

  // Heal stale template clones once per load (v0.13.2). Workflows cloned from
  // a gallery template BEFORE the v0.13.1 fix froze the old config — action
  // cards with `unattended:false` (so write_file/run_shell silently deny-gated
  // → the flow produced nothing) and a `verifyCmd:"npm test"` that exited 254
  // and looped the critic. `healStaleTemplateClones` re-syncs the execution
  // config of UNMODIFIED clones (same card ids + identical prompts) from their
  // source template; user-customized clones are left untouched. Idempotent: a
  // re-heal of an already-healed clone reports `changed:false`, so this is safe
  // to run on every mount.
  const healed = useRef(false);
  useEffect(() => {
    if (healed.current) return;
    healed.current = true;
    void (async () => {
      try {
        const loaded = (await api.workflowList()).map(parseWorkflow);
        const results = healStaleTemplateClones(loaded);
        const changed = results.filter((r) => r.changed);
        if (changed.length === 0) return;
        for (const { workflow } of changed) {
          await api.workflowSave(
            workflow.id,
            workflow.name,
            serializeWorkflowGraph(workflow.graph),
          );
        }
        logDiag({
          level: "info",
          source: "workflows",
          message: `healed ${changed.length} stale template clone(s) to current template config`,
        });
        await refreshList();
      } catch (e) {
        logDiag({
          level: "warn",
          source: "workflows",
          message: "template-clone heal skipped",
          detail: e,
        });
      }
    })();
  }, [refreshList]);

  // Load the "About You" profile once; a failed read just omits it.
  useEffect(() => {
    api
      .settingsGet()
      .then((s) => setUserProfile(formatUserProfile(s.user_profile)))
      .catch((e) =>
        logDiag({
          level: "warn",
          source: "workflows",
          message: "settingsGet failed",
          detail: e,
        }),
      );
  }, []);

  // Resolve the active agent write-workspace for the RunPanel indicator.
  // Mirrors ChatWindow's mount fetch. A failed read must not block or error
  // the page — leave it `undefined` so the indicator simply stays hidden.
  useEffect(() => {
    api
      .agentGetWorkspace()
      .then(setWorkspace)
      .catch((e) =>
        logDiag({
          level: "warn",
          source: "workflows",
          message: "agentGetWorkspace failed — workspace indicator hidden",
          detail: e,
        }),
      );
  }, []);

  // Non-throwing graph validation drives both the inline warning and the
  // run-button gate. Only the *topology* (which cards exist + how they're
  // wired) affects the result, so key the memo on a cheap connectivity
  // signature rather than the `cards`/`edges` identities. A pure position
  // drag bumps `cards` identity every frame but leaves the signature
  // unchanged, so the full topo resolve no longer re-runs on every drag
  // tick (or any unrelated re-render). `.order` — the only field that holds
  // live card objects — is never read here; the page consumes `.ok`/`.error`.
  const graphSignature = useMemo(
    () =>
      cards.map((c) => c.id).join(",") +
      "|" +
      edges.map((e) => `${e.from}>${e.to}`).join(","),
    [cards, edges],
  );
  const validation = useMemo(
    () => validateGraph({ cards, edges }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally keyed on the topology signature, not the cards/edges identities, so a position-only drag doesn't re-resolve the chain. The signature changes iff connectivity changes, which is the only thing validateGraph depends on.
    [graphSignature],
  );
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
  const pendingSave = useRef<{
    id: number;
    name: string;
    graph: WorkflowGraph;
  } | null>(null);

  const flushSave = useCallback(() => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    const p = pendingSave.current;
    if (!p) return;
    pendingSave.current = null;
    api
      .workflowSave(p.id, p.name, serializeWorkflowGraph(p.graph))
      .then(() => {
        // Reconcile against the saved name AND graph. Use the functional form
        // so a name the user kept typing AFTER this save was queued isn't
        // clobbered — only update fields if the persisted name still matches
        // the user's current intent (selected.name was set at queue time).
        setSelected((s) =>
          s && s.id === p.id
            ? { ...s, name: p.name, graph: p.graph, updated_at: Date.now() }
            : s,
        );
        setList((l) =>
          l.map((w) =>
            w.id === p.id ? { ...w, name: p.name, graph: p.graph } : w,
          ),
        );
      })
      .catch((e) =>
        logDiag({
          level: "warn",
          source: "workflows",
          message: "workflowSave failed",
          detail: e,
        }),
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
    // Card states are owned by the provider now; when a different
    // workflow is opened we clear the lastSummary banner so a stale
    // failure message doesn't carry over. If this workflow is the
    // currently-running one, the provider's cardStates intentionally
    // remain — user returning to a running workflow should see the
    // live state.
    if (run.runningWorkflowId !== w.id) {
      run.clearSummary();
    }
    // Reset any open card-edit form left over from a prior workflow; the
    // formCard would otherwise point at an id absent from the new graph
    // and any save would silently no-op.
    setFormCard(null);
    setFormIsNew(false);
    setFormOrigin(null);
    // Close any open Skills panel so it doesn't carry the prior workflow's
    // list into the new one. The panel itself also refetches on
    // workflowId change, but closing keeps the UX uncluttered.
    setSkillsOpen(false);
    // Clear any sticky error banner from a prior workflow's run.
    setErr(null);
  }

  async function createWorkflow() {
    try {
      const name = "Untitled workflow";
      const graph: WorkflowGraph = { cards: [], edges: [] };
      const id = await api.workflowSave(
        null,
        name,
        serializeWorkflowGraph(graph),
      );
      const now = Date.now();
      const wf: Workflow = {
        id,
        name,
        graph,
        created_at: now,
        updated_at: now,
      };
      await refreshList();
      openWorkflow(wf);
    } catch (e) {
      setErr(`Failed to create workflow: ${e}`);
    }
  }

  async function useTemplate(t: FlowTemplate) {
    try {
      const graph = cloneTemplateGraph(t);
      const id = await api.workflowSave(
        null,
        t.name,
        serializeWorkflowGraph(graph),
      );
      const now = Date.now();
      await refreshList();
      openWorkflow({
        id,
        name: t.name,
        graph,
        created_at: now,
        updated_at: now,
      });
    } catch (e) {
      setErr(`Failed to use template "${t.name}": ${e}`);
    }
  }

  // Export the open Flow as a portable doc → clipboard (paste anywhere to share).
  async function exportFlow() {
    if (!selected) return;
    try {
      await api.agentClipboardSet(flowToDoc(name, { cards, edges }));
      announce("Flow copied to clipboard");
    } catch (e) {
      setErr(`Failed to copy Flow: ${e}`);
    }
  }

  // Import a pasted Flow doc → validate → save → open.
  async function doImport() {
    const parsed = flowFromDoc(importText);
    if (!parsed.ok) {
      setImportErr(parsed.error);
      return;
    }
    try {
      const id = await api.workflowSave(
        null,
        parsed.name,
        serializeWorkflowGraph(parsed.graph),
      );
      const now = Date.now();
      setImportOpen(false);
      setImportText("");
      setImportErr(null);
      await refreshList();
      openWorkflow({
        id,
        name: parsed.name,
        graph: parsed.graph,
        created_at: now,
        updated_at: now,
      });
    } catch (e) {
      setImportErr(`Failed to import: ${e}`);
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
  // saving lands the node where the user can currently see it. Stable identity
  // (useCallback) so the canvas's `nodes` memo isn't rebuilt every streaming
  // flush just because this handler closure changed.
  const createFromDeck = useCallback(
    (origin: DOMRect, position: { x: number; y: number }) => {
      setFormCard(freshCard(position.x, position.y));
      setFormIsNew(true);
      setFormOrigin(rectOrigin(origin));
    },
    [],
  );

  // Clicking a placed node: open the centered form to edit it. Keyed on
  // `cards` only — that's stable across a run's per-token streaming, so the
  // canvas node memo holds and only the live status surface repaints.
  const editCard = useCallback(
    (id: string, origin: DOMRect) => {
      const card = cards.find((c) => c.id === id);
      if (!card) return;
      setFormCard(card);
      setFormIsNew(false);
      setFormOrigin(rectOrigin(origin));
    },
    [cards],
  );

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

  // Lifecycle hooks lived here in pre-Option-A code; they're now owned
  // by `WorkflowRunProvider.start()` so navigating away doesn't strand
  // the per-card delta stream. Page-level error banner picks up
  // `lastSummary.errorBanner` via the useEffect above.

  /**
   * Build the per-run options. `cardSubset` restricts the model-coverage
   * check to a specific list of cards — used by `runSingleCard` so a
   * one-card run only validates THAT card's model, not every card on
   * the canvas. For `runWorkflowNow` we validate every card.
   */
  const baseRunOpts = useCallback(
    (
      cardSubset?: WorkflowCard[],
    ): (Omit<RunWorkflowOptions, "model"> & { model: string }) | null => {
      const subset = cardSubset ?? cards;
      // A card "needs" the fallback (loaded chat model) only when its own
      // `model` is unset. Cards with an explicit `*:cloud` model already
      // satisfy the gate — the Ollama daemon routes those without a local
      // server load. Cards with an explicit local model satisfy it too;
      // `ensureCardModelLoaded` brings up the right server before the run.
      const missing = subset.filter((c) => !c.model);
      const fallbackModel = status?.model ?? "";
      if (missing.length > 0 && !fallbackModel) {
        const names = missing
          .map((c) => c.name || c.id)
          .slice(0, 3)
          .join(", ");
        const more = missing.length > 3 ? ` (+${missing.length - 3} more)` : "";
        setErr(
          `Load a model first — ${missing.length} card(s) without a model assignment: ${names}${more}. Either assign a model to each card via Edit, or load a default in the chat picker.`,
        );
        return null;
      }
      return {
        // Cards with their own `model` ignore this; cards without one use it.
        model: fallbackModel,
        defaultBackend:
          (status?.backend as RunWorkflowOptions["defaultBackend"]) ??
          undefined,
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
      card.backend === "native" ||
      card.backend === "mlx" ||
      card.backend === "ollama"
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
    setErr(null);
    if (!selected || !validation.ok) {
      setErr("Fix the chain warning before running.");
      return;
    }
    const opts = baseRunOpts();
    if (!opts) return;
    // Provider owns the gating + AbortController. `start()` returns
    // false synchronously when a run is already in flight, so two
    // near-simultaneous entry points can't both spawn.
    const accepted = run.start({
      workflowId: selected.id,
      graph: { cards, edges },
      opts,
      preflight: async (signal) => {
        // Pre-load each card's model under the abort signal. Native +
        // MLX cold-starts can be 10-30s; cloud paths no-op.
        const loaded = new Set<string>();
        for (const c of cards) {
          if (signal.aborted) break;
          if (c.model && loaded.has(c.model)) continue;
          await ensureCardModelLoaded(c);
          if (c.model) loaded.add(c.model);
        }
      },
    });
    if (!accepted) {
      setErr("A run is already in progress.");
    }
  }

  // Stable identity so the canvas's per-node `onRun` wiring (and thus its
  // `nodes` memo) doesn't churn on every streamed token. Depends on
  // `run.start` — which is memoized in the provider — rather than the whole
  // `run` aggregate (that object is rebuilt per token by `useWorkflowRun`).
  const runSingleCard = useCallback(
    (id: string) => {
      setErr(null);
      const card = cards.find((c) => c.id === id);
      if (!card || !selected) return;
      const opts = baseRunOpts([card]);
      if (!opts) return;
      const accepted = run.start({
        workflowId: selected.id,
        graph: { cards: [card], edges: [] },
        opts,
        preflight: async (signal) => {
          if (signal.aborted) return;
          await ensureCardModelLoaded(card);
        },
      });
      if (!accepted) {
        setErr("A run is already in progress.");
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `ensureCardModelLoaded` is recreated each render but only reads `status`, which already drives `baseRunOpts`; capturing it via that dep keeps the model gate fresh without re-creating this callback per token.
    [cards, selected, baseRunOpts, run.start],
  );

  // Re-run the whole graph but resume from a specific card (review UX #6):
  // the runner already honors `startCardId` — used by the scheduled-trigger
  // path — so a failed/partial run can be retried from the card that broke
  // without re-doing the upstream work. The full graph is passed so the
  // runner can resolve the start card's position and run it + everything
  // downstream. Stable identity so `<RunSurface>` doesn't re-render per token.
  const runFromCard = useCallback(
    (id: string) => {
      setErr(null);
      if (!selected || !validation.ok) {
        setErr("Fix the chain warning before running.");
        return;
      }
      const startIdx = cards.findIndex((c) => c.id === id);
      if (startIdx < 0) return;
      const opts = baseRunOpts(cards.slice(startIdx));
      if (!opts) return;
      const accepted = run.start({
        workflowId: selected.id,
        graph: { cards, edges },
        opts: { ...opts, startCardId: id },
        preflight: async (signal) => {
          const loaded = new Set<string>();
          for (const c of cards.slice(startIdx)) {
            if (signal.aborted) break;
            if (c.model && loaded.has(c.model)) continue;
            await ensureCardModelLoaded(c);
            if (c.model) loaded.add(c.model);
          }
        },
      });
      if (!accepted) {
        setErr("A run is already in progress.");
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- see runSingleCard: ensureCardModelLoaded reads `status`, which already drives `baseRunOpts`.
    [cards, edges, selected, validation, baseRunOpts, run.start],
  );

  // Imperative focus hook the canvas registers into (review UX #5): clicking a
  // failed card in the status panel scrolls + frames its node on the canvas.
  // A ref (not state) so the canvas registering its focuser never re-renders
  // the page, and so the page can call it without a render cycle in between.
  const focusNodeRef = useRef<((id: string) => void) | null>(null);
  const registerFocusNode = useCallback((fn: ((id: string) => void) | null) => {
    focusNodeRef.current = fn;
  }, []);
  const focusNode = useCallback((id: string) => {
    focusNodeRef.current?.(id);
  }, []);

  function stopRun() {
    run.stop();
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
        if (run.runningWorkflowId !== null) {
          logDiag({
            level: "warn",
            source: "workflows",
            message: "workflow-trigger ignored — a run is already in progress",
          });
          return;
        }
        const trigger = parseWorkflowTrigger(e.payload);
        if (!trigger) return;
        const targetsOpen = !!selected && trigger.workflow_id === selected.id;
        const subset: WorkflowCard[] | undefined =
          targetsOpen && trigger.card_id
            ? cards.slice(
                Math.max(
                  0,
                  cards.findIndex((c) => c.id === trigger.card_id),
                ),
              )
            : undefined;
        const opts = baseRunOpts(subset);
        if (!opts) return;
        // Route the scheduled trigger through the provider too. Fetches
        // the workflow graph from DB (same as the old
        // handleWorkflowTrigger did internally) then hands off. If the
        // user navigates away mid-trigger the run survives — same as
        // the manual path.
        void (async () => {
          try {
            const raw = await api.workflowGet(trigger.workflow_id);
            if (!raw) return;
            const wf = parseWorkflow(raw);
            run.start({
              workflowId: wf.id,
              graph: wf.graph,
              opts: { ...opts, scheduled: true, startCardId: trigger.card_id },
            });
            void refreshList();
          } catch (err) {
            logDiag({
              level: "warn",
              source: "workflows",
              message: "workflow-trigger handling failed",
              detail: err,
            });
          }
        })();
      },
      [baseRunOpts, refreshList, run, selected, cards],
    ),
  );

  // `runInfo` / `runningCardId` used to live here, but they read the hot
  // per-card snapshot and so forced a full-page re-render per token. They now
  // live inside `<RunSurface>` (the isolated hot subtree). The number of
  // placed cards — all the page shell needs for the Run-button gate — is a
  // pure function of `cards`, independent of run state.
  const placedCardCount = useMemo(
    () => cards.filter((c) => c.placed !== false).length,
    [cards],
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
        <h1 className="topbar-view-title">Flows</h1>
        <button
          type="button"
          className="wf-btn topbar-action"
          onClick={() => {
            setImportErr(null);
            setImportText("");
            setImportOpen(true);
          }}
          style={{ marginLeft: "auto" }}
          data-testid="wf-import-btn"
        >
          Import
        </button>
        <button
          type="button"
          className="wf-btn wf-btn-primary topbar-action"
          onClick={createWorkflow}
        >
          + New Flow
        </button>
      </>
    );
    return (
      <div className="wf-page wf-picker" data-testid="workflows-page">
        {topbarSlot && createPortal(pickerHeader, topbarSlot)}
        {err && (
          <div className="wf-error" onClick={() => setErr(null)}>
            {err}
          </div>
        )}

        <section className="wf-templates" data-testid="wf-templates">
          <h2 className="wf-templates-title">Start from a template</h2>
          <p className="wf-templates-sub">
            Proven Flows that chain small local models into a result that beats
            any single call. One click to drop one on the canvas and customize.
          </p>
          <div className="wf-template-grid">
            {FLOW_TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                className="wf-template-card"
                data-testid={`wf-template-${t.id}`}
                onClick={() => void useTemplate(t)}
              >
                <span className="wf-template-cat">{t.category}</span>
                <span className="wf-template-name">{t.name}</span>
                <span className="wf-template-summary">{t.summary}</span>
                <span className="wf-template-meta">
                  {t.graph.cards.length} steps →
                </span>
              </button>
            ))}
          </div>
        </section>

        {list.length > 0 && (
          <h2 className="wf-templates-title wf-your-flows">Your Flows</h2>
        )}
        {list.length === 0 ? (
          <EmptyState
            icon={<Puzzle size={24} />}
            heading="No Flows yet"
            sub="Use a template above, or create a blank Flow to chain agents into a pipeline."
          />
        ) : (
          <ul className="wf-list">
            {list.map((w) => (
              <li key={w.id} className="wf-list-item">
                <button
                  type="button"
                  className="wf-list-open"
                  onClick={() => openWorkflow(w)}
                >
                  <span className="wf-list-name">{w.name}</span>
                  <span className="wf-list-meta">
                    {w.graph.cards.length} cards
                  </span>
                </button>
                <button
                  type="button"
                  className="wf-list-del"
                  onClick={() => deleteWorkflow(w.id)}
                  aria-label={`Delete ${w.name}`}
                >
                  <X size={16} />
                </button>
              </li>
            ))}
          </ul>
        )}

        {importOpen && (
          <div
            className="dashboard-overlay"
            role="dialog"
            aria-modal="true"
            aria-label="Import a Flow"
            onClick={(e) => {
              if (e.target === e.currentTarget) setImportOpen(false);
            }}
          >
            <div className="dashboard-modal wf-import-modal">
              <h2 className="wf-import-title">Import a Flow</h2>
              <p className="wf-import-sub">
                Paste a Flow you exported (or someone shared). It's validated
                before it's saved.
              </p>
              <textarea
                className="wf-import-textarea"
                value={importText}
                onChange={(e) => {
                  setImportText(e.target.value);
                  setImportErr(null);
                }}
                placeholder='{ "froglips_flow": 1, "name": "...", "graph": { ... } }'
                rows={10}
                data-testid="wf-import-textarea"
                autoFocus
              />
              {importErr && (
                <div className="wf-error" data-testid="wf-import-err">
                  {importErr}
                </div>
              )}
              <div className="wf-import-actions">
                <button
                  type="button"
                  className="wf-btn"
                  onClick={() => setImportOpen(false)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="wf-btn wf-btn-primary"
                  onClick={() => void doImport()}
                  disabled={!importText.trim()}
                  data-testid="wf-import-confirm"
                >
                  Import Flow
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  const canRun = placedCardCount > 0 && validation.ok;
  const editorHeader = (
    <>
      <button
        type="button"
        className="wf-btn"
        onClick={() => {
          flushSave();
          setSelected(null);
        }}
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
          ● Run in progress — safe to navigate away.
        </span>
      )}
      {/* Export the open Flow as a portable doc → clipboard (share it). */}
      <button
        type="button"
        className="wf-btn topbar-action"
        style={{ marginLeft: "auto" }}
        onClick={() => void exportFlow()}
        data-testid="wf-export-btn"
        title="Copy this Flow to the clipboard — paste to share or back it up"
      >
        Export
      </button>
      {/* Skills panel opener — procedural memory inspector. Lives next
          to Run/Stop so the user can pop the panel mid-build. */}
      <button
        type="button"
        className="wf-btn topbar-action"
        onClick={() => setSkillsOpen(true)}
        data-testid="wf-open-skills"
        title="View procedural-memory skills saved by agent runs"
      >
        Skills
      </button>
      {/* Run/Stop sits in the top bar, immediately left of the theme
          toggle. `.topbar-action` keeps the button compact so the
          header row matches the chat ModelPicker's height. The Skills
          button above carries `margin-left: auto` so Run/Stop sits
          flush against it. */}
      {running ? (
        <button
          type="button"
          className="wf-btn wf-btn-danger topbar-action"
          onClick={stopRun}
        >
          Stop
        </button>
      ) : (
        <button
          type="button"
          className="wf-btn wf-btn-primary topbar-action"
          onClick={runWorkflowNow}
          disabled={!canRun}
          title={
            canRun ? "Run workflow" : "Add cards and a valid linear chain first"
          }
        >
          Run workflow
        </button>
      )}
    </>
  );

  return (
    <div className="wf-page wf-editor" data-testid="workflows-page">
      {topbarSlot && createPortal(editorHeader, topbarSlot)}
      {err && (
        <div className="wf-error" onClick={() => setErr(null)}>
          {err}
        </div>
      )}
      <div className="wf-editor-body">
        <RunSurface
          cards={cards}
          edges={edges}
          onCardsChange={setCards}
          onEdgesChange={setEdges}
          onConfigure={editCard}
          onRunCard={runSingleCard}
          onDeleteCard={deleteCard}
          onCreateFromDeck={createFromDeck}
          onFocusNode={focusNode}
          onRerunFromCard={runFromCard}
          onRegisterFocus={registerFocusNode}
          workspace={workspace}
        />
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
      <SkillsPanel
        workflowId={selected.id}
        workflowName={name || selected.name}
        open={skillsOpen}
        onClose={() => setSkillsOpen(false)}
      />
    </div>
  );
}

interface RunSurfaceProps {
  cards: WorkflowCard[];
  edges: WorkflowEdge[];
  onCardsChange: (cards: WorkflowCard[]) => void;
  onEdgesChange: (edges: WorkflowEdge[]) => void;
  onConfigure: (id: string, origin: DOMRect) => void;
  onRunCard: (id: string) => void;
  onDeleteCard: (id: string) => void;
  onCreateFromDeck: (
    origin: DOMRect,
    position: { x: number; y: number },
  ) => void;
  /** Scroll + frame a node on the canvas (clicked from a failed status row). */
  onFocusNode: (id: string) => void;
  /** Re-run the graph resuming from a card (the "re-run from here" action). */
  onRerunFromCard: (id: string) => void;
  /** Lets the canvas hand its imperative node-focuser up to the page. */
  onRegisterFocus: (fn: ((id: string) => void) | null) => void;
  /** Active agent write-workspace for the RunPanel's "where do files go" chip. */
  workspace?: string | null;
}

/**
 * The HOT subtree (adversarial review HIGH, 2026-06-12). This is the ONLY
 * part of the Workflows editor that subscribes to the per-card run snapshot,
 * so a streamed token re-renders just the canvas badges + status panel — not
 * the ~1000-line page shell. Everything it needs from the page (cards, edges,
 * stable handlers) arrives as props with stable identities; the only changing
 * input is `run.cardStates`, owned here.
 */
function RunSurface({
  cards,
  edges,
  onCardsChange,
  onEdgesChange,
  onConfigure,
  onRunCard,
  onDeleteCard,
  onCreateFromDeck,
  onFocusNode,
  onRerunFromCard,
  onRegisterFocus,
  workspace,
}: RunSurfaceProps) {
  const { cardStates: snapshot } = useWorkflowRunCards();

  // Provider's per-card snapshot → the legacy `state` map the canvas badges
  // and run panel consume. Derived (not duplicated) so an in-flight run paints
  // the instant the user returns to the Workflows view.
  const cardStates: Record<string, CardRunState> = useMemo(() => {
    const out: Record<string, CardRunState> = {};
    for (const [id, snap] of Object.entries(snapshot)) {
      out[id] = snap.state;
    }
    return out;
  }, [snapshot]);

  const runInfo = useMemo<CardRunInfo[]>(
    () =>
      cards
        .filter((c) => c.placed !== false)
        .map((c) => ({
          id: c.id,
          name: c.name,
          state: cardStates[c.id] ?? "idle",
          output: snapshot[c.id]?.output ?? "",
          error: snapshot[c.id]?.error,
        })),
    [cards, cardStates, snapshot],
  );

  const runningCardId = useMemo(
    () =>
      cards.find((c) => (cardStates[c.id] ?? "idle") === "running")?.id ?? null,
    [cards, cardStates],
  );

  return (
    <>
      <ReactFlowProvider>
        <WorkflowCanvas
          cards={cards}
          edges={edges}
          cardStates={cardStates}
          onCardsChange={onCardsChange}
          onEdgesChange={onEdgesChange}
          onConfigure={onConfigure}
          onRunCard={onRunCard}
          onDeleteCard={onDeleteCard}
          onCreateFromDeck={onCreateFromDeck}
          runningCardId={runningCardId}
          onRegisterFocus={onRegisterFocus}
        />
      </ReactFlowProvider>
      <RunPanel
        cards={runInfo}
        runningCardId={runningCardId}
        onFocusNode={onFocusNode}
        onRerunFromCard={onRerunFromCard}
        workspace={workspace}
      />
    </>
  );
}
