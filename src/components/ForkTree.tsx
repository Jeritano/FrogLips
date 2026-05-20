import { useEffect, useState } from "react";
import { api } from "../lib/tauri-api";
import type { ForkTree } from "../types";

interface Props {
  open: boolean;
  onClose: () => void;
  /** The conversation id used as the root for the tree query. */
  rootId: number | null;
  /** Called when the user picks a node — host should switch the active conv. */
  onSelect: (id: number) => void;
}

/**
 * Full branch visualizer — renders the recursive descendant tree of a
 * conversation as an indented list. Powered by `conversation_fork_tree` on
 * the backend (depth-capped server-side at 10).
 *
 * Kept intentionally minimal: a modal overlay, the tree, and a select-on-click
 * affordance. Heavier visualizations (e.g. SVG branch lines) can layer in
 * later without touching the data shape.
 */
export function ForkTreeModal({ open, onClose, rootId, onSelect }: Props) {
  const [tree, setTree] = useState<ForkTree | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || rootId == null) {
      setTree(null);
      setErr(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setErr(null);
    // If the current conversation is itself a branch we still call with its
    // id as the root — the backend treats any conv as a valid root and walks
    // its descendants. Users wanting "show me from the top" can navigate to
    // the originating root manually; we don't auto-walk upward here because
    // a conversation may be reachable from multiple paths after edits.
    api
      .conversationForkTree(rootId)
      .then((t) => {
        if (!cancelled) setTree(t);
      })
      .catch((e) => {
        if (!cancelled) setErr(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, rootId]);

  if (!open) return null;

  return (
    <div
      className="fork-tree-overlay"
      data-testid="fork-tree-modal"
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        className="fork-tree-panel"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--panel, #1a1a1a)",
          color: "var(--fg, #e6e6e6)",
          padding: "16px 20px",
          borderRadius: 8,
          maxWidth: 520,
          width: "calc(100% - 48px)",
          maxHeight: "70vh",
          overflowY: "auto",
          boxShadow: "0 10px 40px rgba(0,0,0,0.5)",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
          <strong>🌳 Branches</strong>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background: "transparent", border: "none", color: "inherit", cursor: "pointer", fontSize: 18 }}>×</button>
        </div>
        {loading && <div>Loading…</div>}
        {err && <div className="error-bar" data-testid="fork-tree-error">{err}</div>}
        {!loading && !err && tree && (
          <ForkNodeView node={tree} depth={0} onSelect={onSelect} />
        )}
        {!loading && !err && !tree && rootId == null && (
          <div>No conversation selected.</div>
        )}
      </div>
    </div>
  );
}

function ForkNodeView({ node, depth, onSelect }: { node: ForkTree; depth: number; onSelect: (id: number) => void }) {
  return (
    <div data-testid="fork-tree-node" data-depth={depth}>
      <button
        type="button"
        onClick={() => onSelect(node.id)}
        style={{
          background: "transparent",
          border: "none",
          color: "inherit",
          cursor: "pointer",
          textAlign: "left",
          padding: "4px 6px",
          marginLeft: depth * 16,
          fontFamily: "inherit",
          fontSize: 13,
        }}
        title={`Open conversation #${node.id}`}
      >
        {depth > 0 && <span aria-hidden="true">↳ </span>}
        {node.title}
      </button>
      {node.children.map((c) => (
        <ForkNodeView key={c.id} node={c} depth={depth + 1} onSelect={onSelect} />
      ))}
    </div>
  );
}
