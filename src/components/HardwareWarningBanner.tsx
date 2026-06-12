import { AlertTriangle } from "lucide-react";
import type { Headroom } from "../lib/hardware-profile";

/**
 * A calm, honest strip shown when the selected model would strain or exceed the
 * machine's memory. Renders nothing for comfortable/tight fits (those read via
 * the inline headroom badge) — only the cases worth interrupting for. Not a
 * blocker: the user can still Start; this just tells the truth before they do.
 */
export function HardwareWarningBanner({
  headroom,
}: {
  headroom: Headroom | null;
}) {
  if (!headroom || !headroom.label) return null;
  if (headroom.tier === "comfortable" || headroom.tier === "tight") return null;

  const severe = headroom.tier === "impossible";
  return (
    <div
      className={`hw-warning-banner${severe ? " is-severe" : ""}`}
      data-tier={headroom.tier}
      role={severe ? "alert" : "status"}
    >
      <AlertTriangle size={14} aria-hidden="true" className="hw-warning-icon" />
      <span className="hw-warning-text">
        <strong>{headroom.label}.</strong>{" "}
        {severe
          ? `Needs ${headroom.detail} of RAM — it may fail to load or thrash.`
          : `Needs ${headroom.detail} of RAM — other apps may slow down.`}
      </span>
    </div>
  );
}
