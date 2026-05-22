// Shared accessibility announcer. Any component fires `announce(msg)`; the
// single <LiveRegion> mounted near the app root receives the window
// CustomEvent and pushes the text into one polite aria-live region. Keeping
// it event-based avoids threading a context through locked components.

const EVENT = "froglips:announce";

export interface AnnounceDetail {
  message: string;
}

/** Announce a short status string through the app's shared live region. */
export function announce(message: string): void {
  const text = message.trim();
  if (!text) return;
  window.dispatchEvent(
    new CustomEvent<AnnounceDetail>(EVENT, { detail: { message: text } }),
  );
}

export const ANNOUNCE_EVENT = EVENT;
