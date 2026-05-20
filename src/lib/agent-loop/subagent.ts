import type { AgentRunOptions } from "./types";
import { runAgentLoop } from "./runner";

export const MAX_SUBAGENT_DEPTH = 3;

export async function runSubagent(
  args: Record<string, unknown>,
  parent: AgentRunOptions,
): Promise<string> {
  const depth = (parent._subagentDepth ?? 0) + 1;
  if (depth > MAX_SUBAGENT_DEPTH) {
    return JSON.stringify({
      ok: false,
      kind: "depth_exceeded",
      message: `spawn_subagent depth cap (${MAX_SUBAGENT_DEPTH}) reached`,
    });
  }
  const prompt = String(args.prompt ?? "");
  if (!prompt.trim()) {
    return JSON.stringify({ ok: false, kind: "invalid_argument", message: "prompt is empty" });
  }
  const presetId = args.preset ? String(args.preset) : null;

  // Lazy-load presets to avoid a static cycle.
  const { loadAllPresets } = await import("../agent-presets");
  const presets = loadAllPresets();
  const chosen = presetId ? presets.find((p) => p.id === presetId) : undefined;

  const subOpts: AgentRunOptions = {
    model: parent.model,
    messages: [
      { conversation_id: parent.conversationId, role: "user", content: prompt },
    ],
    conversationId: parent.conversationId,
    workspaceRoot: parent.workspaceRoot,
    systemPromptOverride: chosen?.systemPromptOverride ?? parent.systemPromptOverride,
    toolAllowlist: chosen?.allowedTools.length ? chosen.allowedTools : parent.toolAllowlist,
    approveAllShell: parent.approveAllShell,
    approveAllWrite: parent.approveAllWrite,
    approvedShellPrefixes: parent.approvedShellPrefixes,
    onApproveShellPrefix: parent.onApproveShellPrefix,
    // Suppress UI noise: subagent runs are background work; parent's
    // metrics + UI shouldn't see every intermediate step.
    onUpdate: () => {},
    onStatusChange: () => {},
    onMetrics: () => {},
    requestConfirmation: parent.requestConfirmation,
    signal: parent.signal,
    _subagentDepth: depth,
  };
  const final = await runAgentLoop(subOpts);
  return JSON.stringify({
    ok: true,
    depth,
    preset: presetId,
    answer: final ?? "(subagent returned nothing)",
  });
}
