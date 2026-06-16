/*
 * Froglips brand mark — one restrained inline-SVG asset, three placements
 * (empty-chat hero, sidebar header, setup-wizard step 1).
 *
 * Theme-aware by design: every stroke/fill is `currentColor`, so the mark
 * inherits whatever text color its container sets (accent in the hero,
 * muted in chrome) and flips cleanly between light/dark without a second
 * asset. The glyph is a minimal frog silhouette — two eye domes over a
 * rounded muzzle — paired with the wordmark so it reads as a product logo
 * rather than decoration.
 *
 * `variant`:
 *   "lockup" (default) — glyph + "Froglips" wordmark, for the hero/wizard.
 *   "glyph"            — glyph only, for tight chrome (sidebar header).
 *
 * `size` drives the glyph height in px; the wordmark scales off it via em so
 * the lockup stays optically balanced at any size.
 */

interface BrandMarkProps {
  variant?: "lockup" | "glyph";
  /** Glyph height in px. Wordmark scales relative to this. */
  size?: number;
  className?: string;
  /** Accessible label; omit on purely decorative placements. */
  title?: string;
}

/** The frog glyph on its own — a 24×24 viewBox using currentColor only. */
function Glyph({ size }: { size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {/* Head / muzzle — a rounded dome sitting on a flat chin line. */}
      <path d="M4 16a8 8 0 0 1 16 0" />
      <path d="M4 16h16" />
      {/* Eye domes cresting the head. */}
      <circle cx="8.5" cy="7.5" r="2.6" />
      <circle cx="15.5" cy="7.5" r="2.6" />
      {/* Pupils — filled so the eyes read at small sizes. */}
      <circle cx="8.5" cy="7.7" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="15.5" cy="7.7" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function BrandMark({
  variant = "lockup",
  size = 22,
  className,
  title,
}: BrandMarkProps) {
  const label = title ?? "Froglips";
  return (
    <span
      className={`brand-mark${className ? ` ${className}` : ""}`}
      role="img"
      aria-label={label}
      data-testid="brand-mark"
    >
      <Glyph size={size} />
      {variant === "lockup" && (
        <span className="brand-mark-word" aria-hidden="true">
          Froglips
        </span>
      )}
    </span>
  );
}
