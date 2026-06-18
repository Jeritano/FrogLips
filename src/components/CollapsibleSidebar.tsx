import { useCallback } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { usePersistedState } from "../hooks/usePersistedState";

/*
 * A resizable + collapsible side panel with a drag handle on its inner edge.
 *
 * Used for the per-view "Templates" rail in Flows / Table: it sits to the RIGHT
 * of the saved-work column, scrolls independently, can be dragged wider/narrower
 * by its handle, and collapses to a thin reopen tab so the middle column is
 * front-and-centre. Width + open/closed persist per `storageKey` so the user's
 * layout survives view switches and restarts.
 */
interface Props {
  /** Which edge the panel hugs. The grab handle sits on the INNER edge. */
  side: "left" | "right";
  /** Persistence namespace, e.g. "flows.templates". */
  storageKey: string;
  /** Header title shown when open. */
  title: string;
  /** Vertical label shown on the collapsed reopen tab. Defaults to `title`. */
  collapsedLabel?: string;
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === "boolean";

export function CollapsibleSidebar({
  side,
  storageKey,
  title,
  collapsedLabel,
  defaultWidth = 300,
  minWidth = 220,
  maxWidth = 480,
  defaultOpen = true,
  children,
}: Props) {
  const [open, setOpen] = usePersistedState<boolean>(
    `${storageKey}.open`,
    defaultOpen,
    isBool,
  );
  const [width, setWidth] = usePersistedState<number>(
    `${storageKey}.w`,
    defaultWidth,
    isNum,
  );

  // Drag the inner-edge handle to resize. Listeners live on `window` so the drag
  // keeps tracking even if the cursor outruns the thin handle. Mouse (not
  // pointer) events: this is a desktop-only webview with no touch/pen, and mouse
  // events fire for both real input and synthetic automation.
  const onHandleDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = width;
      const onMove = (ev: MouseEvent) => {
        const dx = ev.clientX - startX;
        // right-side panel grows when the handle (its left edge) is dragged left.
        const next = side === "right" ? startW - dx : startW + dx;
        setWidth(clamp(next, minWidth, maxWidth));
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [width, side, minWidth, maxWidth, setWidth],
  );

  if (!open) {
    const Chevron = side === "right" ? ChevronLeft : ChevronRight;
    return (
      <button
        type="button"
        className={`cside-reopen cside-reopen-${side}`}
        onClick={() => setOpen(true)}
        title={`Show ${title}`}
        aria-label={`Show ${title}`}
        data-testid={`cside-reopen-${storageKey}`}
      >
        <Chevron size={14} />
        <span className="cside-reopen-label">{collapsedLabel ?? title}</span>
      </button>
    );
  }

  const handle = (
    <div
      className={`cside-handle cside-handle-${side}`}
      onMouseDown={onHandleDown}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${title}`}
      title="Drag to resize"
    />
  );

  return (
    <aside
      className={`cside cside-${side}`}
      style={{ width, flex: `0 0 ${width}px` }}
      data-testid={`cside-${storageKey}`}
    >
      {side === "right" && handle}
      <div className="cside-inner">
        <div className="cside-header">
          <span className="cside-title">{title}</span>
          <button
            type="button"
            className="cside-close"
            onClick={() => setOpen(false)}
            title={`Hide ${title}`}
            aria-label={`Hide ${title}`}
            data-testid={`cside-close-${storageKey}`}
          >
            <X size={15} />
          </button>
        </div>
        <div className="cside-body">{children}</div>
      </div>
      {side === "left" && handle}
    </aside>
  );
}
