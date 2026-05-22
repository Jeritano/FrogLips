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

const MAX_BUF = 1 << 20; // 1 MB

/**
 * Read a byte stream, decode it, and invoke `onLine` for every complete
 * `\n`-terminated line. Any leftover (unterminated) tail is delivered once
 * the stream ends. The reader lock is always released.
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
      if (buf.length > MAX_BUF) {
        const lastNl = buf.lastIndexOf("\n", buf.length - MAX_BUF);
        buf = lastNl >= 0 ? buf.slice(lastNl + 1) : "";
      }
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        onLine(line);
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
