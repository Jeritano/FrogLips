/* ── Minimal unified-diff generation ───────────────────────────────────────
 *
 * Used by the dry-run edit tooling to show the agent what a suppressed
 * write would have produced.
 */

/**
 * Minimal unified-diff generator. Not as polished as `diff`'s LCS — produces
 * a serviceable replace-block diff (one `-`/`+` chunk per change). Enough
 * for the agent to see what the dry-run would have written.
 */
export function makeUnifiedDiff(
  path: string,
  before: string,
  after: string,
): string {
  if (before === after) {
    return `--- a/${path}\n+++ b/${path}\n@@ (no changes) @@\n`;
  }
  const a = before.split("\n");
  const b = after.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tailA = a.length - 1;
  let tailB = b.length - 1;
  while (tailA >= head && tailB >= head && a[tailA] === b[tailB]) {
    tailA--;
    tailB--;
  }
  const context = 3;
  const ctxStart = Math.max(0, head - context);
  const removed = a.slice(head, tailA + 1);
  const added = b.slice(head, tailB + 1);
  const ctxBefore = a.slice(ctxStart, head);
  const ctxAfterEndA = Math.min(a.length, tailA + 1 + context);
  const ctxAfterEndB = Math.min(b.length, tailB + 1 + context);
  const ctxAfter = a.slice(tailA + 1, ctxAfterEndA);
  // sanity: tail context should match across files (they were equal there)
  void ctxAfterEndB;
  const aHunkLen = ctxBefore.length + removed.length + ctxAfter.length;
  const bHunkLen = ctxBefore.length + added.length + ctxAfter.length;
  const aStart = ctxStart + 1; // 1-indexed
  const bStart = ctxStart + 1;
  const lines: string[] = [];
  lines.push(`--- a/${path}`);
  lines.push(`+++ b/${path}`);
  lines.push(`@@ -${aStart},${aHunkLen} +${bStart},${bHunkLen} @@`);
  for (const l of ctxBefore) lines.push(` ${l}`);
  for (const l of removed) lines.push(`-${l}`);
  for (const l of added) lines.push(`+${l}`);
  for (const l of ctxAfter) lines.push(` ${l}`);
  return lines.join("\n");
}

/** Cap a preview so a whole-file write or a giant patch can't flood the
 *  confirmation modal. The full payload is always in the raw-args collapsible. */
function clampPreview(s: string, max = 4000): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]`;
}

/**
 * Build a readable diff preview for a write/edit confirmation modal (item 1),
 * SYNCHRONOUSLY from the tool args alone — no file read. For the tools where the
 * before-content isn't in `args` (`write_file`, `write_files`) we render the new
 * content as an all-`+` block; for `edit_file` / `multi_edit` we diff each
 * `old_string` → `new_string`; for `apply_patch` the supplied patch already IS a
 * unified diff. Returns `null` for tools without a diff-able preview so the modal
 * falls back to the plain summary + raw args.
 *
 * This is presentation-only: the authoritative dry-run preview (which reads the
 * real on-disk before-content) still lives in `dry-run.ts`. This helper exists so
 * the confirm modal can show a diff for the LIVE (non-dry-run) write path the
 * user is about to approve.
 */
export function buildConfirmDiff(
  name: string,
  args: Record<string, unknown>,
): string | null {
  const str = (k: string, src: Record<string, unknown> = args): string =>
    typeof src[k] === "string" ? (src[k] as string) : "";
  switch (name) {
    case "write_file": {
      const path = str("path") || "(file)";
      const content = str("content");
      // New-file write: show the content as an added block (no before).
      return clampPreview(makeUnifiedDiff(path, "", content));
    }
    case "write_files": {
      const files = Array.isArray(args.files)
        ? (args.files as Array<Record<string, unknown>>)
        : [];
      if (files.length === 0) return null;
      const parts = files.map((f) => {
        const p = str("path", f) || "(file)";
        return makeUnifiedDiff(p, "", str("content", f));
      });
      return clampPreview(parts.join("\n\n"));
    }
    case "edit_file": {
      const path = str("path") || "(file)";
      return clampPreview(
        makeUnifiedDiff(path, str("old_string"), str("new_string")),
      );
    }
    case "multi_edit": {
      const path = str("path") || "(file)";
      const edits = Array.isArray(args.edits)
        ? (args.edits as Array<Record<string, unknown>>)
        : [];
      if (edits.length === 0) return null;
      const parts = edits.map((e) =>
        makeUnifiedDiff(path, str("old_string", e), str("new_string", e)),
      );
      return clampPreview(parts.join("\n\n"));
    }
    case "apply_patch": {
      const patch = str("patch");
      return patch ? clampPreview(patch) : null;
    }
    default:
      return null;
  }
}
