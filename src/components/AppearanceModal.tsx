import { useRef, useState } from "react";
import { useModalA11y } from "../lib/use-modal-a11y";
import {
  SYNTAX_THEMES,
  getSyntaxTheme,
  setSyntaxTheme,
  type SyntaxThemeId,
} from "../lib/syntax-theme";
import { BUBBLE_COLORS, getBubbleColor, setBubbleColor } from "../lib/bubble-color";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Current app theme + toggle, owned by App so the moon button + this
   *  modal stay in sync. */
  theme: "dark" | "light";
  onToggleTheme: () => void;
}

/**
 * Appearance settings — theme, chat-bubble color, code-block syntax
 * palette. These are general device-local cosmetic prefs, surfaced from
 * the hamburger menu so they're reachable without turning on agent mode
 * (where the ⚙ gear used to be the only entry point).
 */
export function AppearanceModal({ open, onClose, theme, onToggleTheme }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useModalA11y({ open, onClose, containerRef: ref });
  const [syntaxTheme, setSyntaxThemeState] = useState<SyntaxThemeId>(() => getSyntaxTheme());
  const [bubbleColor, setBubbleColorState] = useState<string | null>(() => getBubbleColor());

  if (!open) return null;

  return (
    <div
      className="memories-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-label="Appearance settings"
    >
      <div ref={ref} className="memories-modal appearance-modal">
        <div className="memories-modal-header">
          <span>Appearance</span>
          <button onClick={onClose} aria-label="Close" className="memories-close">×</button>
        </div>

        <div className="appearance-section">
          <span className="appearance-label">Theme</span>
          <button className="agent-settings-btn" onClick={onToggleTheme}>
            {theme === "dark" ? "🌙 Dark" : "☀️ Light"} — switch to {theme === "dark" ? "light" : "dark"}
          </button>
        </div>

        <div className="appearance-section">
          <span className="appearance-label">Chat bubble color</span>
          <div className="wf-color-row" role="radiogroup" aria-label="User chat bubble color">
            {BUBBLE_COLORS.map((c) => {
              const selected = (bubbleColor ?? null) === c.value;
              return (
                <button
                  key={c.name}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  className={`wf-color-swatch${selected ? " selected" : ""}${c.value === null ? " wf-color-default" : ""}`}
                  style={c.value ? { background: c.value } : undefined}
                  title={c.name}
                  aria-label={c.name}
                  onClick={() => { setBubbleColorState(c.value); setBubbleColor(c.value); }}
                />
              );
            })}
          </div>
        </div>

        <div className="appearance-section">
          <span className="appearance-label">Code block colors</span>
          <select
            className="agent-settings-select"
            value={syntaxTheme}
            aria-label="Code syntax highlight palette"
            onChange={(e) => {
              const id = e.target.value as SyntaxThemeId;
              setSyntaxThemeState(id);
              setSyntaxTheme(id);
            }}
          >
            {SYNTAX_THEMES.map((t) => (
              <option key={t.id} value={t.id}>{t.label}</option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}
