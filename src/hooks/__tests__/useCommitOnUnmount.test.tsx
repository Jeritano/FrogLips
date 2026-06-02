import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useCommitOnUnmount } from "../useCommitOnUnmount";

// Minimal harness: render a component that drives useCommitOnUnmount with a
// controllable `value`, using the createRoot/act pattern (no testing-library).
let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => { root?.unmount(); });
  root = null;
  container?.remove();
  container = null;
});

function Harness({ value, commit }: { value: number | null; commit: (v: number) => void }) {
  useCommitOnUnmount(value, commit);
  return null;
}

function mount(value: number | null, commit: (v: number) => void) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root!.render(<Harness value={value} commit={commit} />); });
}

function rerender(value: number | null, commit: (v: number) => void) {
  act(() => { root!.render(<Harness value={value} commit={commit} />); });
}

describe("useCommitOnUnmount", () => {
  it("commits the pending value once on unmount", () => {
    const commit = vi.fn();
    mount(42, commit);
    expect(commit).not.toHaveBeenCalled(); // not while mounted
    act(() => { root!.unmount(); root = null; });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(42);
  });

  it("does NOT commit when the value is cleared (the undo path)", () => {
    // This is the exact regression: delete sets value=conv, Undo clears it to
    // null. A [value]-dep effect would fire the cleanup on that change and
    // commit the just-undone delete. The hook must NOT.
    const commit = vi.fn();
    mount(7, commit);
    rerender(null, commit); // user clicks Undo → pending cleared
    expect(commit).not.toHaveBeenCalled();
    // And a subsequent unmount with no pending value commits nothing.
    act(() => { root!.unmount(); root = null; });
    expect(commit).not.toHaveBeenCalled();
  });

  it("commits the LATEST pending value on unmount, not a stale one", () => {
    const commit = vi.fn();
    mount(1, commit);
    rerender(2, commit); // a second delete supersedes the first
    act(() => { root!.unmount(); root = null; });
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(2);
  });

  it("commits nothing on unmount when never pending", () => {
    const commit = vi.fn();
    mount(null, commit);
    act(() => { root!.unmount(); root = null; });
    expect(commit).not.toHaveBeenCalled();
  });
});
