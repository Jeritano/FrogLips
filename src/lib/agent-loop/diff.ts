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
