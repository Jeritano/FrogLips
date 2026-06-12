import { useEffect, useState } from "react";
import { ANNOUNCE_EVENT, type AnnounceDetail } from "../lib/announce";

// Single shared polite aria-live region. Mounted once near the app root.
// Listens for `froglips:announce` window events and renders the latest
// message off-screen for assistive tech. Re-asserting the same string is
// debounced via a counter suffix so a repeated message still re-announces.
export function LiveRegion() {
  const [message, setMessage] = useState("");

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<AnnounceDetail>).detail;
      if (!detail?.message) return;
      // Clear first so identical consecutive messages still trigger SR output.
      setMessage("");
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setMessage(detail.message), 60);
    };
    window.addEventListener(ANNOUNCE_EVENT, handler);
    return () => {
      window.removeEventListener(ANNOUNCE_EVENT, handler);
      if (timer) clearTimeout(timer);
    };
  }, []);

  return (
    <div
      className="sr-only"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      {message}
    </div>
  );
}
