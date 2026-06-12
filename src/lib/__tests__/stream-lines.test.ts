import { describe, expect, it } from "vitest";
import { readLines } from "../stream-lines";

/** A reader over a ReadableStream that emits each chunk as a Uint8Array. */
function readerFor(chunks: string[]): ReadableStreamDefaultReader<Uint8Array> {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c));
      controller.close();
    },
  });
  return stream.getReader();
}

async function collect(chunks: string[]): Promise<string[]> {
  const lines: string[] = [];
  await readLines(readerFor(chunks), (l) => lines.push(l));
  return lines;
}

describe("readLines", () => {
  it("emits one callback per newline-terminated line", async () => {
    expect(await collect(["a\nb\nc\n"])).toEqual(["a", "b", "c"]);
  });

  it("delivers multiple lines from a single chunk", async () => {
    expect(await collect(["one\ntwo\nthree\n"])).toEqual([
      "one",
      "two",
      "three",
    ]);
  });

  it("reassembles a line split across chunk boundaries", async () => {
    expect(await collect(["hel", "lo\nwor", "ld\n"])).toEqual([
      "hello",
      "world",
    ]);
  });

  it("delivers an unterminated trailing tail when the stream ends", async () => {
    expect(await collect(["a\ntail"])).toEqual(["a", "tail"]);
  });

  it("does not emit anything for an empty stream", async () => {
    expect(await collect([])).toEqual([]);
  });

  it("emits empty strings for blank lines / keepalives", async () => {
    expect(await collect(["data\n\n\nmore\n"])).toEqual([
      "data",
      "",
      "",
      "more",
    ]);
  });

  it("handles a chunk that is exactly a newline", async () => {
    expect(await collect(["a", "\n", "b\n"])).toEqual(["a", "b"]);
  });

  it("keeps complete lines that arrive before an over-cap unterminated run", async () => {
    // A clean line, then a huge newline-less run that pushes the buffer past
    // the 1MB cap. The early complete line is emitted before truncation;
    // the oversized garbage run is discarded.
    const huge = "x".repeat((1 << 20) + 100);
    const lines = await collect(["early\n", huge, "kept\n"]);
    expect(lines).toContain("early");
    expect(lines).toContain("kept");
    expect(lines).not.toContain(huge);
  });

  it("discards an oversized buffer with no newline boundary", async () => {
    // No newline anywhere in an over-cap buffer — buffer is cleared entirely,
    // then a final clean line still parses.
    const huge = "y".repeat((1 << 20) + 50);
    const lines = await collect([huge, "after\n"]);
    expect(lines).toEqual(["after"]);
  });

  it("releases the reader lock when done", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("a\n"));
        controller.close();
      },
    });
    const reader = stream.getReader();
    await readLines(reader, () => {});
    // Lock released — a fresh getReader() must succeed.
    expect(() => stream.getReader()).not.toThrow();
  });
});
