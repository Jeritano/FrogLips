/* ── Shared streaming line reader ──────────────────────────────────────────
 *
 * Both the Ollama NDJSON client and the MLX OpenAI-SSE client need to
 * accumulate decoded chunks, split on `\n`, and feed complete lines onward
 * while carrying the leftover tail across reads. This is that loop, once.
 *
 * The buffer is capped at 1 MB: a malformed server that never emits a
 * newline can otherwise grow the buffer unbounded. On overflow we drop
 * everything before the last newline (a clean line boundary) so we never
 * slice a line — and therefore a `data:` prefix — mid-token.
 */

import { logDiag } from "./diagnostics";

const MAX_BUF = 1 << 20; // 1 MB

/**
 * Read a byte stream, decode it, and invoke `onLine` for every complete
 * `\n`-terminated line. Any leftover (unterminated) tail is delivered once
 * the stream ends. The reader lock is always released.
 *
 * If the per-read buffer ever exceeds `MAX_BUF` (a server that emits a
 * single ~1 MB+ line, or pathologically newline-less output), the dropped
 * prefix is logged via `logDiag` so the loss is visible. Previously the
 * truncation was silent and tool-call chunks past the cap vanished.
 */
export async function readLines(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  onLine: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // Drain every complete line FIRST so already-parseable NDJSON lines are
      // never collateral damage of the overflow guard below. Otherwise a single
      // read that coalesces normal lines with an oversized unterminated tail
      // (e.g. a multi-MB tool_call blob) would silently drop the earlier,
      // fully-formed lines before processLine ever saw them. (bug, medium)
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        onLine(line);
      }
      // Only the residual unterminated tail remains. Cap it: a malformed server
      // that never emits a newline would otherwise grow the buffer unbounded.
      if (buf.length > MAX_BUF) {
        logDiag({
          level: "warn",
          source: "stream-lines",
          message: `readLines buffer exceeded ${MAX_BUF} bytes; dropping ${buf.length} bytes`,
          detail: {
            bufLength: buf.length,
            droppedBytes: buf.length,
            keepingTail: 0,
          },
        });
        buf = "";
      }
    }
    if (buf.length > 0) onLine(buf);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* noop */
    }
  }
}
