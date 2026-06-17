/* ── MessagingView ───────────────────────────────────────────────────────────
 *
 * Run the Froglips agent over chat platforms. v1 ships Telegram (the rest are
 * shown as "coming soon" so the layout matches the roadmap). Mirrors Hermes'
 * Messaging panel: channel list + a credential/allowlist form + enable toggle +
 * live gateway status.
 *
 * Bot token is written straight to the Keychain via messagingSetToken (never
 * stored in settings or React state after save). The enable toggle + allowlist
 * live in settings.messaging.telegram; the useMessagingGateway hook reacts to
 * the toggle to start/stop the Rust gateway.
 */

import { useCallback, useEffect, useState } from "react";
import { Send } from "lucide-react";
import { api } from "../lib/tauri-api";
import { useSettings, useUpdateSettings } from "../contexts/SettingsContext";
import type { GatewayStatus, MessagingConfig } from "../types";

const COMING_SOON = [
  "Discord",
  "Slack",
  "Signal",
  "WhatsApp",
  "iMessage (BlueBubbles)",
  "Email (IMAP)",
  "SMS (Twilio)",
  "Matrix",
];

export function MessagingView() {
  const settings = useSettings();
  const updateSettings = useUpdateSettings();
  const tg = settings?.messaging?.telegram ?? {};
  const enabled = tg.enabled === true;
  const allowedStr = (tg.allowed_user_ids ?? []).join(", ");

  const [token, setToken] = useState("");
  const [hasToken, setHasToken] = useState(false);
  const [allowedDraft, setAllowedDraft] = useState(allowedStr);
  const [validateMsg, setValidateMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<GatewayStatus | null>(null);

  useEffect(() => {
    void api.messagingHasToken().then(setHasToken);
  }, []);
  // Keep the allowlist draft in sync when settings load/refresh.
  useEffect(() => {
    setAllowedDraft(allowedStr);
  }, [allowedStr]);
  // Poll gateway status.
  useEffect(() => {
    let alive = true;
    const tick = () =>
      api.messagingStatus().then(
        (s) => alive && setStatus(s),
        () => undefined,
      );
    void tick();
    const id = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const writeTelegram = useCallback(
    async (patch: Partial<NonNullable<MessagingConfig["telegram"]>>) => {
      const current = settings?.messaging?.telegram ?? {};
      const messaging: MessagingConfig = {
        ...(settings?.messaging ?? {}),
        telegram: { ...current, ...patch },
      };
      await updateSettings({ messaging });
    },
    [settings, updateSettings],
  );

  const saveToken = useCallback(async () => {
    setBusy(true);
    setValidateMsg(null);
    try {
      await api.messagingSetToken(token.trim());
      setHasToken(token.trim().length > 0);
      if (token.trim()) {
        const name = await api.messagingValidateToken(token.trim());
        setValidateMsg(`✓ Connected as @${name}`);
      }
      setToken("");
    } catch (e) {
      setValidateMsg(`✗ ${e}`);
    } finally {
      setBusy(false);
    }
  }, [token]);

  const saveAllowed = useCallback(async () => {
    const ids = allowedDraft
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter((s) => /^-?\d+$/.test(s));
    await writeTelegram({ allowed_user_ids: ids });
  }, [allowedDraft, writeTelegram]);

  const toggleEnabled = useCallback(
    async (on: boolean) => {
      // Save the current allowlist alongside enabling so a fresh enable can't
      // start with a stale/empty list.
      if (on) await saveAllowed();
      await writeTelegram({ enabled: on });
    },
    [saveAllowed, writeTelegram],
  );

  const allowedCount = (tg.allowed_user_ids ?? []).length;

  return (
    <div className="agent-settings" data-testid="messaging-view">
      <div className="agent-settings-row">
        <span className="agent-settings-label" style={{ fontSize: "var(--fs-lg)" }}>
          <Send size={16} style={{ verticalAlign: "-2px", marginRight: 6 }} />
          Messaging — run Froglips from chat
        </span>
      </div>
      <div className="agent-settings-row">
        <span className="agent-settings-hint">
          Connect a chat platform and message your agent from anywhere. Remote
          runs are locked to <strong>read-only tools</strong> (no shell, writes,
          or desktop control) and gated by an allowed-sender list. The gateway
          runs only while Froglips is open.
        </span>
      </div>

      {/* ── Telegram ── */}
      <div className="agent-settings-row">
        <span className="agent-settings-label">Telegram</span>
        <label>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => void toggleEnabled(e.target.checked)}
            disabled={!hasToken || allowedCount === 0}
          />
          Enable Telegram gateway
        </label>
        {status && (
          <span
            className="agent-settings-hint"
            data-testid="messaging-status"
            style={{ marginLeft: 8 }}
          >
            {status.running
              ? `● running${status.bot_username ? ` @${status.bot_username}` : ""} · ${status.messages_accepted} ok / ${status.messages_blocked} blocked`
              : "○ stopped"}
            {status.last_error ? ` · ${status.last_error}` : ""}
          </span>
        )}
      </div>

      <div className="agent-settings-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
        <span className="agent-settings-label">Bot token</span>
        <span className="agent-settings-hint">
          In Telegram, message <code>@BotFather</code>, run <code>/newbot</code>,
          and paste the token here. Stored in your macOS Keychain.
          {hasToken ? " (a token is saved)" : ""}
        </span>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            type="password"
            className="agent-settings-value"
            style={{ flex: 1 }}
            placeholder={hasToken ? "•••••••••• (saved)" : "Paste Telegram bot token"}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            data-testid="messaging-token-input"
          />
          <button
            type="button"
            className="agent-settings-btn"
            onClick={() => void saveToken()}
            disabled={busy || token.trim().length === 0}
          >
            Save token
          </button>
        </div>
        {validateMsg && <span className="agent-settings-hint">{validateMsg}</span>}
      </div>

      <div className="agent-settings-row" style={{ flexDirection: "column", alignItems: "stretch", gap: 6 }}>
        <span className="agent-settings-label">Allowed user IDs (required)</span>
        <span className="agent-settings-hint">
          Comma-separated numeric Telegram user IDs (from <code>@userinfobot</code>
          ). <strong>Only these users can drive your agent</strong> — the gateway
          won&apos;t start with an empty list.
        </span>
        <div style={{ display: "flex", gap: 8 }}>
          <input
            type="text"
            className="agent-settings-value"
            style={{ flex: 1 }}
            placeholder="123456789, 987654321"
            value={allowedDraft}
            onChange={(e) => setAllowedDraft(e.target.value)}
            data-testid="messaging-allowed-input"
          />
          <button
            type="button"
            className="agent-settings-btn"
            onClick={() => void saveAllowed()}
          >
            Save IDs
          </button>
        </div>
      </div>

      {/* ── Coming soon ── */}
      <div className="agent-settings-row" style={{ marginTop: 12 }}>
        <span className="agent-settings-label">More channels</span>
        <span className="agent-settings-hint">
          Coming soon: {COMING_SOON.join(", ")}.
        </span>
      </div>
    </div>
  );
}
