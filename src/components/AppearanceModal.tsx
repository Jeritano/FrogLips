import { useRef, useState, type ReactNode } from "react";
import { X, Sun, Moon, Monitor } from "lucide-react";
import { useModalA11y } from "../lib/use-modal-a11y";
import {
  SYNTAX_THEMES,
  type SyntaxThemeId,
  type UiFont,
  type TranscriptSize,
  type ThemePref,
  getCodeTheme,
  setCodeTheme,
  getCodeFont,
  setCodeFont,
  getUiFont,
  setUiFont,
  getTranscriptSize,
  setTranscriptSize,
  getHighContrast,
  setHighContrast,
} from "../lib/appearance";
import {
  BUBBLE_COLORS,
  getBubbleColor,
  setBubbleColor,
} from "../lib/bubble-color";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Resolved concrete app theme (light | dark) — drives the high-contrast
   *  copy + which surfaces preview light/dark. */
  theme: "dark" | "light";
  /** User's theme PREFERENCE (light | dark | system), owned by App so the
   *  selector here + the topbar moon button stay in sync. */
  themePref: ThemePref;
  /** Set an explicit theme preference (System follows the OS, live). */
  onSetThemePref: (pref: ThemePref) => void;
}

/** A tiny syntax-highlighted snippet so each palette is previewed live. The
 *  `data-cv-*` attributes scope `--hl-*` per pane (see appearance.css), so a
 *  light pane and a dark pane render their own palettes simultaneously. */
function CodePreview({
  mode,
  palette,
}: {
  mode: "light" | "dark";
  palette: SyntaxThemeId;
}) {
  return (
    <div
      className="cv"
      data-cv-theme={mode}
      data-cv-pal={palette}
      aria-hidden="true"
    >
      <pre className="cv-pre">
        <code className="hljs">
          <span className="cv-ln">1</span>
          <span className="hljs-keyword">function</span>{" "}
          <span className="hljs-title function_">greet</span>(
          <span className="hljs-params">name</span>) {"{"}
          {"\n"}
          <span className="cv-ln">2</span>
          {"  "}
          <span className="hljs-keyword">return</span>{" "}
          <span className="hljs-string">{"`Hello, ${name}!`"}</span>;{"\n"}
          <span className="cv-ln">3</span>
          {"}"}
        </code>
      </pre>
    </div>
  );
}

/**
 * Appearance settings — restyled to match the Claude Code "Appearance" panel:
 * a "Code appearance" block with independent light/dark code-theme pickers +
 * live previews and a custom code font, then an "Appearance" block with a
 * high-contrast toggle, interface font, and transcript text size. Froglips
 * extras (app theme toggle, chat-bubble color) live below. All prefs are
 * device-local (localStorage).
 */
export function AppearanceModal({
  open,
  onClose,
  theme,
  themePref,
  onSetThemePref,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useModalA11y({ open, onClose, containerRef: ref });

  const [lightPal, setLightPal] = useState<SyntaxThemeId>(() =>
    getCodeTheme("light"),
  );
  const [darkPal, setDarkPal] = useState<SyntaxThemeId>(() =>
    getCodeTheme("dark"),
  );
  const [codeFont, setCodeFontState] = useState<string>(() => getCodeFont());
  const [uiFont, setUiFontState] = useState<UiFont>(() => getUiFont());
  const [txtSize, setTxtSize] = useState<TranscriptSize>(() =>
    getTranscriptSize(),
  );
  const [highContrast, setHC] = useState<boolean>(() => getHighContrast());
  const [bubbleColor, setBubbleColorState] = useState<string | null>(() =>
    getBubbleColor(),
  );

  if (!open) return null;

  return (
    <div
      className="memories-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Appearance settings"
    >
      <div ref={ref} className="memories-modal appearance-modal">
        <div className="memories-modal-header">
          <span>Appearance</span>
          <button
            onClick={onClose}
            aria-label="Close"
            className="memories-close"
          >
            <X size={16} />
          </button>
        </div>

        <div className="appearance-body">
          {/* ── Code appearance ─────────────────────────────────────────── */}
          <h3 className="appr-h">Code appearance</h3>

          <div className="appr-code-grid">
            <div className="appr-code-col">
              <select
                className="agent-settings-select appr-select"
                value={lightPal}
                aria-label="Light code theme"
                onChange={(e) => {
                  const id = e.target.value as SyntaxThemeId;
                  setLightPal(id);
                  setCodeTheme("light", id);
                }}
              >
                {SYNTAX_THEMES.map((t) => (
                  <option key={t.id} value={t.id}>
                    Light · {t.label}
                  </option>
                ))}
              </select>
              <CodePreview mode="light" palette={lightPal} />
            </div>

            <div className="appr-code-col">
              <select
                className="agent-settings-select appr-select"
                value={darkPal}
                aria-label="Dark code theme"
                onChange={(e) => {
                  const id = e.target.value as SyntaxThemeId;
                  setDarkPal(id);
                  setCodeTheme("dark", id);
                }}
              >
                {SYNTAX_THEMES.map((t) => (
                  <option key={t.id} value={t.id}>
                    Dark · {t.label}
                  </option>
                ))}
              </select>
              <CodePreview mode="dark" palette={darkPal} />
            </div>
          </div>

          <div className="appr-row">
            <div className="appr-row-text">
              <span className="appr-row-title">Code font</span>
              <span className="appr-row-desc">
                Set a custom monospace font for code and terminal.
              </span>
            </div>
            <input
              className="appr-input"
              type="text"
              placeholder="e.g. JetBrains Mono"
              value={codeFont}
              aria-label="Code font family"
              onChange={(e) => {
                setCodeFontState(e.target.value);
                setCodeFont(e.target.value);
              }}
            />
          </div>

          {/* ── Appearance ──────────────────────────────────────────────── */}
          <h3 className="appr-h appr-h-gap">Appearance</h3>

          <div className="appr-row">
            <div className="appr-row-text">
              <span className="appr-row-title">High contrast</span>
              <span className="appr-row-desc">
                Stronger surface and border separation — a near-black background
                in dark mode, crisper borders in light mode.
              </span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={highContrast}
              aria-label="High contrast"
              className={`appr-switch${highContrast ? " on" : ""}`}
              onClick={() => {
                const next = !highContrast;
                setHC(next);
                setHighContrast(next);
              }}
            >
              <span className="appr-switch-knob" />
            </button>
          </div>

          <div className="appr-row">
            <div className="appr-row-text">
              <span className="appr-row-title">Interface font</span>
              <span className="appr-row-desc">
                Font for the Froglips interface — menus, sidebar, and chat.
              </span>
            </div>
            <div
              className="appr-seg"
              role="radiogroup"
              aria-label="Interface font"
            >
              {(["froglips", "system"] as UiFont[]).map((v) => (
                <button
                  key={v}
                  type="button"
                  role="radio"
                  aria-checked={uiFont === v}
                  className={`appr-seg-btn${uiFont === v ? " on" : ""}`}
                  onClick={() => {
                    setUiFontState(v);
                    setUiFont(v);
                  }}
                >
                  {v === "froglips" ? "Froglips Sans" : "System"}
                </button>
              ))}
            </div>
          </div>

          <div className="appr-row">
            <div className="appr-row-text">
              <span className="appr-row-title">Transcript text size</span>
              <span className="appr-row-desc">
                Size of the conversation transcript text.
              </span>
            </div>
            <div
              className="appr-seg"
              role="radiogroup"
              aria-label="Transcript text size"
            >
              {(["small", "medium", "large"] as TranscriptSize[]).map((v) => (
                <button
                  key={v}
                  type="button"
                  role="radio"
                  aria-checked={txtSize === v}
                  className={`appr-seg-btn${txtSize === v ? " on" : ""}`}
                  onClick={() => {
                    setTxtSize(v);
                    setTranscriptSize(v);
                  }}
                >
                  {v[0].toUpperCase() + v.slice(1)}
                </button>
              ))}
            </div>
          </div>

          {/* ── Froglips extras ─────────────────────────────────────────── */}
          <h3 className="appr-h appr-h-gap">Theme &amp; color</h3>

          <div className="appr-row">
            <div className="appr-row-text">
              <span className="appr-row-title">App theme</span>
              <span className="appr-row-desc">
                Light, dark, or follow the system —{" "}
                {themePref === "system"
                  ? `currently ${theme}`
                  : "System tracks your OS appearance live"}
                .
              </span>
            </div>
            <div className="appr-seg" role="radiogroup" aria-label="App theme">
              {(
                [
                  { id: "system", label: "System", icon: <Monitor size={13} /> },
                  { id: "light", label: "Light", icon: <Sun size={13} /> },
                  { id: "dark", label: "Dark", icon: <Moon size={13} /> },
                ] as { id: ThemePref; label: string; icon: ReactNode }[]
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  role="radio"
                  aria-checked={themePref === opt.id}
                  className={`appr-seg-btn${themePref === opt.id ? " on" : ""}`}
                  onClick={() => onSetThemePref(opt.id)}
                  style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
                >
                  {opt.icon}
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="appr-row">
            <div className="appr-row-text">
              <span className="appr-row-title">Chat bubble color</span>
              <span className="appr-row-desc">
                Accent color for your own messages.
              </span>
            </div>
            <div
              className="wf-color-row"
              role="radiogroup"
              aria-label="User chat bubble color"
            >
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
                    onClick={() => {
                      setBubbleColorState(c.value);
                      setBubbleColor(c.value);
                    }}
                  />
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
