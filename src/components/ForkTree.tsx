import { useEffect, useRef, useState } from "react";
import { api } from "../lib/tauri-api";
import { useModalA11y } from "../lib/use-modal-a11y";
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

  return <ForkTreeOverlay onClose={onClose} tree={tree} err={err} loading={loading} rootId={rootId} onSelect={onSelect} />;
}

function ForkTreeOverlay({
  onClose,
  tree,
  err,
  loading,
  rootId,
  onSelect,
}: {
  onClose: () => void;
  tree: ForkTree | null;
  err: string | null;
  loading: boolean;
  rootId: number | null;
  onSelect: (id: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useModalA11y({ open: true, onClose, containerRef: ref });
  return (
    <div
      className="fork-tree-overlay"
      data-testid="fork-tree-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Branches"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      ref={ref}
    >
      <div className="fork-tree-panel" onClick={(e) => e.stopPropagation()}>
        <div className="fork-tree-header">
          <strong>🌳 Branches</strong>
          <button type="button" onClick={onClose} aria-label="Close" className="fork-tree-close">×</button>
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
  // Cap depth-driven indentation so a long-branched conversation can't push
  // the row text off the right edge of the modal.
  const capped = Math.min(depth, 6);
  return (
    <div data-testid="fork-tree-node" data-depth={depth}>
      <button
        type="button"
        className="fork-tree-node-btn"
        onClick={() => onSelect(node.id)}
        style={{ marginLeft: capped * 16 }}
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
