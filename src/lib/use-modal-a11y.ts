import { useEffect, useRef } from "react";

/**
 * Modal accessibility kit.
 *
 * Wires four things every modal-shaped overlay in the app needs:
 *   1. **Focus trap** — Tab / Shift+Tab cycle through focusable descendants
 *      of the container ref, never escape to the underlying app.
 *   2. **Escape to close** — listens at the document level so the focus
 *      doesn't have to be inside the modal for ESC to work (the modal IS
 *      focused on open, but Safari may steal focus to the address bar).
 *   3. **Autofocus on open** — moves focus to the first interactive element
 *      inside the container so keyboard users land where they expect.
 *   4. **Focus restoration** — when the modal unmounts, focus returns to
 *      whatever element opened it (often the trigger button), preserving
 *      keyboard navigation continuity.
 *
 * Usage:
 *   const ref = useRef<HTMLDivElement>(null);
 *   useModalA11y({ open, onClose, containerRef: ref });
 *   return <div ref={ref} role="dialog" aria-modal="true">…</div>;
 *
 * The hook is no-op while `open` is false, so callers can mount the modal
 * conditionally without juggling lifecycle.
 */
const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "textarea:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

export function useModalA11y(opts: {
  open: boolean;
  onClose: () => void;
  containerRef: React.RefObject<HTMLElement | null>;
  /** Pass `false` to skip autofocus (e.g. for modals that focus a custom
   *  element themselves). Default true. */
  autoFocus?: boolean;
}) {
  const { open, onClose, containerRef, autoFocus = true } = opts;
  // Snapshot the opener so we can restore focus on close. Captured fresh
  // every time the modal opens (a single hook instance can be re-opened).
  const openerRef = useRef<HTMLElement | null>(null);
  // Hold `onClose` in a ref so the main effect does NOT depend on it.
  // Callers routinely pass an inline arrow that changes identity on every
  // parent re-render; if the effect depended on `onClose` it would tear
  // down + re-run on each re-render — restoring focus to the opener and
  // re-autofocusing, which dismisses any open native <select> popup.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    openerRef.current = (document.activeElement as HTMLElement | null) ?? null;

    // Autofocus first focusable. rAF so React has flushed the children.
    if (autoFocus) {
      requestAnimationFrame(() => {
        const root = containerRef.current;
        if (!root) return;
        const first = root.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
        if (first) first.focus();
        else (root.setAttribute("tabindex", "-1"), root.focus());
      });
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const root = containerRef.current;
      if (!root) return;
      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter(
        (el) => !el.hasAttribute("disabled") && el.offsetParent !== null,
      );
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || !root.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !root.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      // Restore focus to whoever opened the modal. Skipped if the opener was
      // removed from the DOM in the meantime.
      const opener = openerRef.current;
      if (opener && document.body.contains(opener)) {
        try {
          opener.focus();
        } catch {
          /* focus restore is best-effort */
        }
      }
    };
  }, [open, containerRef, autoFocus]);
}
