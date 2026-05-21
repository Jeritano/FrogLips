import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useTwoClickConfirm, type TwoClickConfirm } from "../use-two-click-confirm";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* ── Test harness ──────────────────────────────────────────────────────────
 * The codebase doesn't depend on @testing-library/react. Instead we mount a
 * tiny probe component into a real DOM root (happy-dom), capture the live
 * hook return on every render, and drive interactions through `act()`. The
 * pattern mirrors src/components/__tests__/MessageList.fork.test.tsx.
 */
interface Probe {
  root: Root;
  container: HTMLElement;
  get current(): TwoClickConfirm;
}

function mountProbe(windowMs?: number): Probe {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const ref: { current: TwoClickConfirm | null } = { current: null };

  function ProbeComp() {
    const value = useTwoClickConfirm(windowMs);
    useEffect(() => {
      ref.current = value;
    });
    // Capture synchronously too so the very first read after mount works.
    ref.current = value;
    return null;
  }

  act(() => {
    root.render(createElement(ProbeComp));
  });

  return {
    root,
    container,
    get current() {
      if (!ref.current) throw new Error("probe not rendered");
      return ref.current;
    },
  };
}

function unmountProbe(probe: Probe) {
  act(() => {
    probe.root.unmount();
  });
  probe.container.remove();
}

describe("useTwoClickConfirm", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("arms on first click without invoking the callback", () => {
    const probe = mountProbe(4000);
    const onConfirm = vi.fn();

    expect(probe.current.armed).toBe(null);
    expect(probe.current.labelFor("a", "Delete")).toBe("Delete");

    act(() => {
      probe.current.request("a", onConfirm);
    });

    expect(probe.current.armed).toBe("a");
    expect(probe.current.labelFor("a", "Delete")).toBe("Click again to confirm");
    expect(probe.current.labelFor("b", "Delete")).toBe("Delete");
    expect(onConfirm).not.toHaveBeenCalled();

    unmountProbe(probe);
  });

  it("invokes the callback on a second click within the window and resets", () => {
    const probe = mountProbe(4000);
    const onConfirm = vi.fn();

    act(() => {
      probe.current.request("row-1", onConfirm);
    });
    expect(probe.current.armed).toBe("row-1");

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    act(() => {
      probe.current.request("row-1", onConfirm);
    });

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith("row-1");
    expect(probe.current.armed).toBe(null);
    expect(probe.current.labelFor("row-1", "Delete")).toBe("Delete");

    unmountProbe(probe);
  });

  it("resets armed state automatically after the timeout expires", () => {
    const probe = mountProbe(4000);
    const onConfirm = vi.fn();

    act(() => {
      probe.current.request("x", onConfirm);
    });
    expect(probe.current.armed).toBe("x");

    act(() => {
      vi.advanceTimersByTime(4000);
    });

    expect(probe.current.armed).toBe(null);
    expect(onConfirm).not.toHaveBeenCalled();

    // A subsequent single click only arms (does not fire).
    act(() => {
      probe.current.request("x", onConfirm);
    });
    expect(probe.current.armed).toBe("x");
    expect(onConfirm).not.toHaveBeenCalled();

    unmountProbe(probe);
  });

  it("switching to a different id re-arms without firing the previous one", () => {
    const probe = mountProbe(4000);
    const onConfirm = vi.fn();

    act(() => {
      probe.current.request("a", onConfirm);
    });
    expect(probe.current.armed).toBe("a");

    act(() => {
      probe.current.request("b", onConfirm);
    });

    expect(probe.current.armed).toBe("b");
    expect(onConfirm).not.toHaveBeenCalled();
    expect(probe.current.labelFor("a", "Delete")).toBe("Delete");
    expect(probe.current.labelFor("b", "Delete")).toBe("Click again to confirm");

    unmountProbe(probe);
  });

  it("reset() clears the armed state and any pending timer", () => {
    const probe = mountProbe(4000);
    const onConfirm = vi.fn();

    act(() => {
      probe.current.request("z", onConfirm);
    });
    expect(probe.current.armed).toBe("z");

    act(() => {
      probe.current.reset();
    });
    expect(probe.current.armed).toBe(null);

    // Advancing past the window must not produce a stale armed state if the
    // timer was properly cleared.
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(probe.current.armed).toBe(null);

    unmountProbe(probe);
  });
});
