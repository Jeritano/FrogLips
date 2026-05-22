import { useRef } from "react";

interface Props {
  /** Click the top card to open the centered form for a fresh agent. */
  onCreate: (origin: DOMRect) => void;
}

/**
 * The card deck — a neat stack in the corner of the table. The top card is
 * always a fresh "new agent" card: clicking it opens the centered form,
 * dragging it onto the table-top creates a placed node at the drop point.
 */
export function CardDeck({ onCreate }: Props) {
  const topRef = useRef<HTMLDivElement>(null);

  return (
    <div className="wf-deck" data-testid="wf-deck" aria-label="Agent deck">
      <div className="wf-deck-stack" aria-hidden="true">
        <div className="wf-deck-card wf-deck-card-3" />
        <div className="wf-deck-card wf-deck-card-2" />
      </div>
      <div
        className="wf-deck-card wf-deck-top"
        ref={topRef}
        role="button"
        tabIndex={0}
        draggable
        data-testid="wf-deck-top"
        onClick={() => {
          if (topRef.current) onCreate(topRef.current.getBoundingClientRect());
        }}
        onKeyDown={(e) => {
          if ((e.key === "Enter" || e.key === " ") && topRef.current) {
            e.preventDefault();
            onCreate(topRef.current.getBoundingClientRect());
          }
        }}
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = "copy";
          e.dataTransfer.setData("application/wf-card", "new");
        }}
        title="Click to configure · drag onto the table to place"
      >
        <span className="wf-deck-plus" aria-hidden="true">+</span>
        <span className="wf-deck-label">New agent</span>
      </div>
    </div>
  );
}
