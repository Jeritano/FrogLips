import { useState } from "react";
import {
  loadAllPresets,
  getActivePresetId,
  setActivePresetId,
} from "../lib/agent-presets";
import type { AgentPreset } from "../lib/agent-presets";
import { logDiag } from "../lib/diagnostics";

function loadAllowlist(): string[] {
  try {
    const raw = localStorage.getItem("agent.allowlist");
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
}
function saveAllowlist(list: string[]) {
  localStorage.setItem("agent.allowlist", JSON.stringify(list));
}

function loadDryRun(): boolean {
  try {
    return localStorage.getItem("agent.dryRun") === "true";
  } catch {
    return false;
  }
}
function saveDryRun(v: boolean) {
  try {
    localStorage.setItem("agent.dryRun", v ? "true" : "false");
  } catch (err) {
    logDiag({
      level: "warn",
      source: "chat-window",
      message: "saveDryRun: localStorage write failed",
      detail: err,
    });
  }
}

export interface AgentSettings {
  allowlist: string[];
  resetAllowlist: () => void;
  toggleAllowed: (name: string) => void;
  dryRun: boolean;
  setDryRun: (v: boolean) => void;
  approveAllShell: boolean;
  setApproveAllShell: (v: boolean) => void;
  approveAllWrite: boolean;
  setApproveAllWrite: (v: boolean) => void;
  approvedShellPrefixes: string[];
  setApprovedShellPrefixes: React.Dispatch<React.SetStateAction<string[]>>;
  presets: AgentPreset[];
  activePresetId: string;
  activePreset: AgentPreset | undefined;
  selectPreset: (id: string) => void;
}

/**
 * Agent-mode settings: tool allowlist, dry-run, session approvals, approved
 * shell prefixes and presets — including localStorage persistence for the
 * allowlist and dry-run flag.
 */
export function useAgentSettings(): AgentSettings {
  const [allowlist, setAllowlist] = useState<string[]>(() => loadAllowlist());
  const [approveAllShell, setApproveAllShell] = useState(false);
  const [approveAllWrite, setApproveAllWrite] = useState(false);
  const [dryRunState, setDryRunState] = useState<boolean>(() => loadDryRun());
  const [approvedShellPrefixes, setApprovedShellPrefixes] = useState<string[]>(
    [],
  );
  const [presets, setPresets] = useState<AgentPreset[]>(() => loadAllPresets());
  const [activePresetId, setActivePresetIdState] = useState<string>(() =>
    getActivePresetId(),
  );

  const activePreset =
    presets.find((p) => p.id === activePresetId) ?? presets[0];

  const toggleAllowed = (name: string) => {
    setAllowlist((prev) => {
      const next = prev.includes(name)
        ? prev.filter((n) => n !== name)
        : [...prev, name];
      saveAllowlist(next);
      return next;
    });
  };

  const resetAllowlist = () => {
    setAllowlist([]);
    saveAllowlist([]);
  };

  const setDryRun = (v: boolean) => {
    setDryRunState(v);
    saveDryRun(v);
  };

  const selectPreset = (id: string) => {
    setActivePresetIdState(id);
    setActivePresetId(id);
    setPresets(loadAllPresets());
  };

  return {
    allowlist,
    resetAllowlist,
    toggleAllowed,
    dryRun: dryRunState,
    setDryRun,
    approveAllShell,
    setApproveAllShell,
    approveAllWrite,
    setApproveAllWrite,
    approvedShellPrefixes,
    setApprovedShellPrefixes,
    presets,
    activePresetId,
    activePreset,
    selectPreset,
  };
}
