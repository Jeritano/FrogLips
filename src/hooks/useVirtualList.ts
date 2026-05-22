import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

interface VirtualWindow {
  /** First item index to render (inclusive). */
  start: number;
  /** Last item index to render (exclusive). */
  end: number;
  /** Spacer height above the rendered slice, in px. */
  padTop: number;
  /** Spacer height below the rendered slice, in px. */
  padBottom: number;
}

interface Options {
  /** Total number of items in the list. */
  count: number;
  /** Fixed per-row height in px (rows must be uniform). */
  rowHeight: number;
  /** Extra rows rendered above/below the viewport to mask fast scrolls. */
  overscan?: number;
}

/**
 * Fixed-height list virtualization. Renders only the rows in/near the
 * scrollport and pads the rest with two spacer elements so the scrollbar
 * geometry is identical to a fully-rendered list. Suitable only for lists
 * whose rows are uniform height.
 */
export function useVirtualList<T extends HTMLElement>({ count, rowHeight, overscan = 6 }: Options) {
  const scrollRef = useRef<T>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);

  const measure = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setScrollTop(el.scrollTop);
    setViewport(el.clientHeight);
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el) setScrollTop(el.scrollTop);
  }, []);

  useLayoutEffect(() => {
    measure();
  }, [measure, count]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  const visibleRows = viewport > 0 ? Math.ceil(viewport / rowHeight) : count;
  const rawStart = Math.floor(scrollTop / rowHeight) - overscan;
  const start = Math.max(0, rawStart);
  const end = Math.min(count, start + visibleRows + overscan * 2);

  const window: VirtualWindow = {
    start,
    end,
    padTop: start * rowHeight,
    padBottom: Math.max(0, (count - end) * rowHeight),
  };

  return { scrollRef, window, onScroll };
}
