import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { api } from "../lib/tauri-api";
import { logDiag } from "../lib/diagnostics";
import { useModalA11y } from "../lib/use-modal-a11y";
import { ErrorBar } from "./ErrorBar";
import type { UserProfile } from "../types";

interface Props {
  /** Close the modal — the parent unmounts on this. */
  onClose: () => void;
}

/** Per-field caps mirroring the Rust-side `settings_set` validation. */
const SHORT_MAX = 200;
const LONG_MAX = 2048;

const EMPTY: UserProfile = {
  enabled: false,
  name: "",
  occupation: "",
  location: "",
  about: "",
  response_style: "",
};

/**
 * "About You" — the explicit, user-authored profile (the Custom Instructions
 * pattern). What the user enters here is formatted into a system-prompt block
 * injected into every chat and workflow agent run, so the model knows who it
 * is talking to. Stored locally in settings.json; never auto-populated.
 */
export function AboutYouModal({ onClose }: Props) {
  const modalRef = useRef<HTMLDivElement>(null);
  useModalA11y({ open: true, onClose, containerRef: modalRef });

  const [profile, setProfile] = useState<UserProfile>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Load the saved profile once. A missing/legacy profile falls back to EMPTY.
  useEffect(() => {
    let cancelled = false;
    api
      .settingsGet()
      .then((s) => {
        if (!cancelled && s.user_profile)
          setProfile({ ...EMPTY, ...s.user_profile });
      })
      .catch((e) =>
        logDiag({
          level: "warn",
          source: "user-profile",
          message: "settingsGet failed",
          detail: e,
        }),
      )
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function set<K extends keyof UserProfile>(key: K, value: UserProfile[K]) {
    setProfile((p) => ({ ...p, [key]: value }));
  }

  async function handleSave() {
    setSaving(true);
    setErr(null);
    try {
      // Trim and null-out blank fields so an empty profile stays clean.
      const norm = (v: string | null | undefined) => {
        const t = (v ?? "").trim();
        return t.length > 0 ? t : null;
      };
      const name = norm(profile.name);
      const occupation = norm(profile.occupation);
      const location = norm(profile.location);
      const about = norm(profile.about);
      const responseStyle = norm(profile.response_style);
      const hasAnyContent = !!(
        name ||
        occupation ||
        location ||
        about ||
        responseStyle
      );
      // Foot-gun fix: if the user typed anything at all, treat saving as an
      // intent to use the profile. They can still uncheck the box later.
      // An entirely blank save leaves enabled at whatever it was so an
      // explicit disable still sticks.
      const effectiveEnabled = profile.enabled || hasAnyContent;
      await api.settingsSet({
        user_profile: {
          enabled: effectiveEnabled,
          name,
          occupation,
          location,
          about,
          response_style: responseStyle,
        },
      });
      onClose();
    } catch (e) {
      setErr(`Could not save your profile: ${e}`);
      setSaving(false);
    }
  }

  return (
    <div
      className="memories-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="About You"
    >
      <div className="memories-modal profile-modal" ref={modalRef}>
        <div className="memories-modal-header">
          <span>About You</span>
          <button
            onClick={onClose}
            aria-label="Close"
            className="memories-close"
          >
            <X size={16} />
          </button>
        </div>

        <p className="profile-intro">
          Tell the AI who you are. When enabled, this is shared with every chat
          and workflow agent so responses fit you. It stays on this machine and
          is never sent anywhere except to the model you are already chatting
          with.
        </p>

        {loading ? (
          <div className="profile-loading">Loading…</div>
        ) : (
          <div className="profile-form">
            <label className="profile-check">
              <input
                type="checkbox"
                checked={profile.enabled}
                onChange={(e) => set("enabled", e.target.checked)}
              />
              Use my profile in chats and workflows
            </label>

            <label className="profile-field">
              <span>Name / what to call you</span>
              <input
                type="text"
                maxLength={SHORT_MAX}
                value={profile.name ?? ""}
                onChange={(e) => set("name", e.target.value)}
                placeholder="e.g. Alex"
              />
            </label>

            <label className="profile-field">
              <span>What you do</span>
              <input
                type="text"
                maxLength={SHORT_MAX}
                value={profile.occupation ?? ""}
                onChange={(e) => set("occupation", e.target.value)}
                placeholder="e.g. Cybersecurity engineer"
              />
            </label>

            <label className="profile-field">
              <span>Location</span>
              <input
                type="text"
                maxLength={SHORT_MAX}
                value={profile.location ?? ""}
                onChange={(e) => set("location", e.target.value)}
                placeholder="e.g. Ohio, United States"
              />
            </label>

            <label className="profile-field">
              <span>Anything else the AI should know about you</span>
              <textarea
                rows={4}
                maxLength={LONG_MAX}
                value={profile.about ?? ""}
                onChange={(e) => set("about", e.target.value)}
                placeholder="Projects, expertise, preferences, goals…"
              />
            </label>

            <label className="profile-field">
              <span>How you want the AI to respond</span>
              <textarea
                rows={3}
                maxLength={LONG_MAX}
                value={profile.response_style ?? ""}
                onChange={(e) => set("response_style", e.target.value)}
                placeholder="e.g. Be concise and direct. Skip preamble. Show code first."
              />
            </label>

            <ErrorBar message={err} onDismiss={() => setErr(null)} />

            <div className="profile-actions">
              <button
                className="agent-settings-btn"
                onClick={onClose}
                disabled={saving}
              >
                Cancel
              </button>
              <button
                className="agent-settings-btn profile-save"
                onClick={handleSave}
                disabled={saving}
              >
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
