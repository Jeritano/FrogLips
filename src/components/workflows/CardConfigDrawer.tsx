import { useEffect, useRef, useState } from "react";
import type { WorkflowCard } from "../../types";
import { loadAllPresets } from "../../lib/agent-presets";
import { useModalA11y } from "../../lib/use-modal-a11y";

interface Props {
  card: WorkflowCard;
  onSave: (card: WorkflowCard) => void;
  onClose: () => void;
}

/** All tool ids surfaced across the built-in presets — the config checklist. */
const ALL_TOOLS = [
  "read_file", "list_dir", "search_files", "file_exists",
  "edit_file", "multi_edit", "write_file", "run_shell",
  "git_status", "git_diff", "git_log", "git_show", "git_branches", "git_commit",
  "read_pdf", "web_fetch", "web_search",
];

/**
 * Schedule grammar the Rust scheduler accepts: `every <n>m` / `every <n>h`
 * (interval) or `daily HH:MM` (clock time). Blank = manual run only.
 */
const HINT = "Use 'every 30m', 'every 2h', or 'daily 09:00'.";

function scheduleError(value: string): string | null {
  const v = value.trim().toLowerCase();
  if (v === "") return null;
  const every = v.match(/^every\s+(\d+)\s*([mh])$/);
  if (every) return Number(every[1]) > 0 ? null : HINT;
  const daily = v.match(/^daily\s+(\d{1,2}):(\d{2})$/);
  if (daily) {
    const hh = Number(daily[1]);
    const mm = Number(daily[2]);
    return hh < 24 && mm < 60 ? null : HINT;
  }
  return HINT;
}

/**
 * Side drawer to edit one agent card — name, preset, prompt, tools, backend
 * and schedule. A blank schedule means "manual run only".
 */
export function CardConfigDrawer({ card, onSave, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const presets = loadAllPresets();
  const [draft, setDraft] = useState<WorkflowCard>(card);

  useModalA11y({ open: true, onClose, containerRef: ref });
  useEffect(() => setDraft(card), [card]);

  const schedErr = scheduleError(draft.schedule ?? "");

  function set<K extends keyof WorkflowCard>(key: K, value: WorkflowCard[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
  }

  function toggleTool(tool: string) {
    setDraft((d) => ({
      ...d,
      tools: d.tools.includes(tool)
        ? d.tools.filter((t) => t !== tool)
        : [...d.tools, tool],
    }));
  }

  return (
    <div
      className="wf-drawer-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-label="Configure agent card"
    >
      <div className="wf-drawer" ref={ref}>
        <div className="wf-drawer-head">
          <span>Configure card</span>
          <button type="button" className="wf-drawer-close" onClick={onClose} aria-label="Close">×</button>
        </div>
        <div className="wf-drawer-body">
          <label className="wf-field">
            <span>Name</span>
            <input
              value={draft.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="Card name"
            />
          </label>
          <label className="wf-field">
            <span>Preset</span>
            <select value={draft.preset} onChange={(e) => set("preset", e.target.value)}>
              {presets.map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
          <label className="wf-field">
            <span>Prompt</span>
            <textarea
              value={draft.prompt}
              onChange={(e) => set("prompt", e.target.value)}
              rows={4}
              placeholder="Task for this agent…"
            />
          </label>
          <label className="wf-field">
            <span>Backend</span>
            <select
              value={draft.backend ?? ""}
              onChange={(e) => set("backend", e.target.value || null)}
            >
              <option value="">Default</option>
              <option value="mlx">MLX</option>
              <option value="ollama">Ollama</option>
              <option value="native">Native</option>
            </select>
          </label>
          <label className="wf-field">
            <span>Schedule (blank = manual)</span>
            <input
              value={draft.schedule ?? ""}
              onChange={(e) => set("schedule", e.target.value || null)}
              placeholder="every 30m  ·  daily 09:00"
              aria-invalid={schedErr != null}
            />
            {schedErr && (
              <p className="wf-field-error" role="alert">{schedErr}</p>
            )}
          </label>
          <label className="wf-field wf-field-check">
            <input
              type="checkbox"
              checked={draft.unattended === true}
              onChange={(e) => set("unattended", e.target.checked)}
            />
            <span>
              Allow unattended runs (auto-approves this card's tools when run
              on a schedule)
            </span>
          </label>
          <div className="wf-field">
            <span>Tools</span>
            <div className="wf-tool-grid">
              {ALL_TOOLS.map((tool) => (
                <label key={tool} className="wf-tool-item">
                  <input
                    type="checkbox"
                    checked={draft.tools.includes(tool)}
                    onChange={() => toggleTool(tool)}
                  />
                  {tool}
                </label>
              ))}
            </div>
            <p className="wf-field-hint">No tools selected = preset default tools.</p>
          </div>
        </div>
        <div className="wf-drawer-foot">
          <button type="button" className="wf-btn" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="wf-btn wf-btn-primary"
            onClick={() => onSave(draft)}
            disabled={schedErr != null}
            title={schedErr ?? "Save card"}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
