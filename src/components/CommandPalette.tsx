import { useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpen,
  MessageSquare,
  Moon,
  Plus,
  Search,
  Users,
  Wrench,
  Zap,
} from "lucide-react";
import type { Conversation } from "../types";

/*
 * Cmd+K command palette (product review 2026-06-10, IA #7). Every
 * destination beyond the four nav tabs used to require mouse travel through
 * the hamburger menu or nested toggles. The palette is a flat, fuzzy-typed
 * action registry: views, modals, theme, new chat, and jump-to-conversation
 * by title. Pure overlay — actions are injected by App, so this component
 * owns zero app state and stays trivially testable.
 */

export interface PaletteAction {
  id: string;
  label: string;
  /** Optional grouping hint rendered as a right-aligned chip. */
  hint?: string;
  icon?: React.ReactNode;
  run: () => void;
}

interface Props {
  open: boolean;
  onClose: () => void;
  actions: PaletteAction[];
  conversations: Conversation[];
  onOpenConversation: (c: Conversation) => void;
}

/** Case-insensitive subsequence match — "wkf" hits "Go to Flows (workflows)". */
export function fuzzyMatch(query: string, target: string): boolean {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let ti = 0;
  for (const ch of q) {
    ti = t.indexOf(ch, ti);
    if (ti === -1) return false;
    ti++;
  }
  return true;
}

const MAX_RESULTS = 12;

export function CommandPalette({
  open,
  onClose,
  actions,
  conversations,
  onOpenConversation,
}: Props) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSel(0);
      // Focus after the overlay paints.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const results = useMemo(() => {
    const q = query.trim();
    const actionHits = (
      q ? actions.filter((a) => fuzzyMatch(q, a.label)) : actions
    ).map((a) => ({
      kind: "action" as const,
      key: a.id,
      label: a.label,
      hint: a.hint,
      icon: a.icon,
      run: a.run,
    }));
    // Conversations join the list only once the user types — an empty query
    // shows the action registry, not a wall of chat titles.
    const convHits = q
      ? conversations
          .filter((c) => fuzzyMatch(q, c.title))
          .slice(0, MAX_RESULTS)
          .map((c) => ({
            kind: "conv" as const,
            key: `conv-${c.id}`,
            label: c.title,
            hint: "conversation",
            icon: <MessageSquare size={14} />,
            run: () => onOpenConversation(c),
          }))
      : [];
    return [...actionHits, ...convHits].slice(0, MAX_RESULTS);
  }, [query, actions, conversations, onOpenConversation]);

  // Clamp selection when the result set shrinks under it.
  useEffect(() => {
    if (sel >= results.length) setSel(Math.max(0, results.length - 1));
  }, [results.length, sel]);

  useEffect(() => {
    // Keep the selected row visible while arrowing through a long list.
    const el = listRef.current?.querySelector<HTMLElement>(
      `[data-idx="${sel}"]`,
    );
    el?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  if (!open) return null;

  function runRow(i: number) {
    const row = results[i];
    if (!row) return;
    onClose();
    row.run();
  }

  return (
    <div
      className="cmdk-overlay"
      data-testid="command-palette"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="cmdk-panel" role="dialog" aria-label="Command palette">
        <div className="cmdk-input-row">
          <Search size={15} aria-hidden="true" />
          <input
            ref={inputRef}
            className="cmdk-input"
            data-testid="command-palette-input"
            placeholder="Type a command or conversation title…"
            role="combobox"
            aria-expanded={results.length > 0}
            aria-controls="cmdk-listbox"
            aria-autocomplete="list"
            aria-activedescendant={
              results.length > 0 ? `cmdk-option-${sel}` : undefined
            }
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSel(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              } else if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((s) => Math.min(s + 1, results.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((s) => Math.max(s - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                runRow(sel);
              }
            }}
          />
        </div>
        <div
          className="cmdk-list"
          ref={listRef}
          id="cmdk-listbox"
          role="listbox"
          aria-label="Commands and conversations"
        >
          {results.length === 0 && (
            <div className="cmdk-empty">No matches.</div>
          )}
          {results.map((r, i) => (
            <button
              key={r.key}
              type="button"
              data-idx={i}
              id={`cmdk-option-${i}`}
              role="option"
              aria-selected={i === sel}
              className={`cmdk-row${i === sel ? " selected" : ""}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => runRow(i)}
            >
              <span className="cmdk-row-icon">{r.icon}</span>
              <span className="cmdk-row-label">{r.label}</span>
              {r.hint && <span className="cmdk-row-hint">{r.hint}</span>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Icon set re-exported so App's action registry doesn't re-import lucide. */
export const paletteIcons = {
  flows: <Zap size={14} />,
  chat: <MessageSquare size={14} />,
  table: <Users size={14} />,
  knowledge: <BookOpen size={14} />,
  tools: <Wrench size={14} />,
  newChat: <Plus size={14} />,
  theme: <Moon size={14} />,
};
