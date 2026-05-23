import { useEffect, useRef } from "react";

export interface ImageContextMenuAction {
  /** Stable id — used for keys + telemetry. */
  id: string;
  /** Visible menu label. */
  label: string;
  /** Single emoji or unicode prefix (optional). */
  icon?: string;
  /** True grays the row out and blocks click. */
  disabled?: boolean;
  /** True draws the row in danger red and gates a destructive op. */
  danger?: boolean;
  /** Fires when the user clicks the row. */
  onClick: () => void;
}

interface Props {
  /** Pointer position in viewport coords (from `event.clientX/Y`). */
  x: number;
  y: number;
  actions: ImageContextMenuAction[];
  onClose: () => void;
}

/**
 * In-app right-click menu for generated images.
 *
 * WebKit's native context menu ("Open image in new window", "Save image
 * as…") fails on `asset://` URLs because Tauri 2 blocks new-window
 * creation by default and the asset scheme is not a real http URL the OS
 * can route to. Every image surface in the Image tab calls
 * `event.preventDefault()` on `contextmenu` and opens this menu instead,
 * routing each action through a Rust IPC that operates on the on-disk
 * path (validated under the images root) — not the in-webview URL.
 *
 * The menu pins to the click coordinates and auto-closes on outside
 * click, Esc, or scroll. Action `onClick` callbacks are responsible for
 * any toast / error handling; this component just dispatches them.
 */
export function ImageContextMenu({ x, y, actions, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);

  // Esc / outside-click / scroll / blur close.
  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (!ref.current?.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    function onScroll() {
      onClose();
    }
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  // Clamp to viewport so a menu near the edge doesn't clip off-screen.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const overflowX = rect.right - window.innerWidth;
    const overflowY = rect.bottom - window.innerHeight;
    if (overflowX > 0) el.style.left = `${Math.max(0, x - overflowX - 8)}px`;
    if (overflowY > 0) el.style.top = `${Math.max(0, y - overflowY - 8)}px`;
  }, [x, y]);

  return (
    <div
      ref={ref}
      className="image-ctx-menu"
      role="menu"
      style={{ left: x, top: y }}
      // Don't let a click on the menu surface itself bubble up and close it
      // before the per-action onClick handler runs.
      onPointerDown={(e) => e.stopPropagation()}
    >
      {actions.map((a) => (
        <button
          key={a.id}
          type="button"
          role="menuitem"
          className={`image-ctx-item ${a.danger ? "danger" : ""}`}
          disabled={a.disabled}
          onClick={() => {
            if (a.disabled) return;
            a.onClick();
            onClose();
          }}
        >
          {a.icon && <span className="image-ctx-icon" aria-hidden="true">{a.icon}</span>}
          <span className="image-ctx-label">{a.label}</span>
        </button>
      ))}
    </div>
  );
}
