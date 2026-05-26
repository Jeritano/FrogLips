# 0006: Workflow run state lifted to App-level context

- Status: accepted
- Date: 2026-05-26
- Deciders: @Jeritano

## Context

Workflow run state (`AbortController`, per-card live deltas, in-flight
gate) lived inside `WorkflowsPage.tsx` as React state + refs. When the
user navigated away — Workflows → Chat, Workflows → Images, etc. —
React unmounted the page, the cleanup effect aborted the controller,
and the run died. The Workflows view's "you must stay on this page"
banner was a workaround, not a design.

Three architectural paths were considered:

1. **Lift state to an App-level context** (this ADR). Same TS runner,
   provider above the page, page becomes a view. Cost: ~1 day.
2. **Move the runner to Rust + Tauri events**. Survives webview
   reload, not only navigation. Cost: 1-2 weeks; would need to either
   port `agent-loop/dispatch.ts` to Rust or call back into chat's
   agent loop, both heavy.
3. **Option 1 + IndexedDB / SQLite checkpoints**. Survives full app
   reload too. Cost: option 1 + ~2 days for checkpoint protocol.

## Decision

Option 1. Ship now, defer 2 + 3 until users actually ask for full
reload-survival.

Concretely:

- New `src/lib/workflow/run-context.tsx` exports `<WorkflowRunProvider>`
  + `useWorkflowRun()`.
- `<App>` is wrapped at module level via `AppWithProviders` so the
  provider sits above every page.
- Provider owns: `runningWorkflowId`, per-card `cardStates`,
  `lastSummary`, the `AbortController`, and the synchronous
  `runningIdRef` that gates concurrent `start()` callers.
- `WorkflowsPage.tsx` is now a view: reads provider state, calls
  `run.start(...)` / `run.stop()`. Its local `running`, `cardStates`,
  `outputs` are computed from the provider.
- Sidebar entry gets a small pulsing-dot badge when a run is live,
  pointing the user back to the Workflows view.
- The `workflow-trigger` event (scheduled-run path) was also re-
  routed through `run.start()` so a scheduled trigger arriving while
  the user is in Chat is captured by the provider and visible to the
  user when they return.

## Consequences

**+** Navigation away no longer kills runs. Sidebar badge tells users
where their work is. Same `runWorkflow` runner — risk is contained
to ownership-of-state, not runner semantics.

**−** Full app reload still kills runs (only Option 3 fixes that).
Single-run-at-a-time invariant still enforced (provider refuses a
second `start()` when one is in flight) — running two workflows in
parallel needs separate work.

**Hard to change later**: every WorkflowsPage state field that's now
provider-derived (cardStates, outputs, running) was previously
owner-local. Going back means re-introducing the unmount-abort hazard.

**Re-evaluate**: when users report losing a workflow run to an app
crash / reload — that's the signal Option 3 is worth the cost.
