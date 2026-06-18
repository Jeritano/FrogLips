/* ── MessagingView ───────────────────────────────────────────────────────────
 *
 * Master-detail messaging hub (Hermes-style): channel rail + per-channel detail
 * pane with a credentials/setup section, the channel's fields (driven by a
 * per-channel schema), an enable toggle, and Save changes. Six channels are
 * wired (Telegram/Matrix/Discord/Slack/Mattermost/Email); the rest show "coming
 * soon". Secrets go straight to the Keychain via messagingSetToken.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ExternalLink } from "lucide-react";
import { api } from "../lib/tauri-api";
import { useSettings, useUpdateSettings } from "../contexts/SettingsContext";
import { BRAND_ICONS } from "../lib/brand-icons";
import type { GatewayStatus, MessagingConfig } from "../types";

interface FieldDef {
  key: string;
  label: string;
  placeholder?: string;
  numeric?: boolean;
}
interface ChannelSpec {
  id: string;
  name: string;
  color: string;
  badge: string;
  desc: string;
  available?: boolean;
  /** Implemented to spec but NOT yet verified against a live server — shown as
   *  a "Beta" badge + caution so we don't overclaim. */
  beta?: boolean;
  secretLabel?: string;
  secretHint?: string;
  allowedLabel?: string;
  allowedHint?: string;
  fields?: FieldDef[];
  creds?: string;
  guide?: { label: string; url: string };
}

const CHANNELS: ChannelSpec[] = [
  {
    id: "telegram", name: "Telegram", color: "#229ED9", badge: "T", available: true,
    desc: "Run Froglips from Telegram DMs and groups.",
    secretLabel: "Bot token",
    secretHint: "Create a bot with @BotFather, then paste the token. Stored in your macOS Keychain.",
    allowedLabel: "Allowed user IDs",
    allowedHint: "Comma-separated numeric IDs from @userinfobot.",
    creds: "Message @BotFather, run /newbot, copy the token. Get your numeric ID from @userinfobot.",
    guide: { label: "Open setup guide", url: "https://core.telegram.org/bots#how-do-i-create-a-bot" },
  },
  {
    id: "matrix", name: "Matrix", color: "#0A1B2A", badge: "m", available: true,
    desc: "Run Froglips from Matrix rooms.",
    secretLabel: "Access token",
    secretHint: "A bot/user access token. Stored in your macOS Keychain.",
    allowedLabel: "Allowed user IDs",
    allowedHint: "Comma-separated Matrix IDs, e.g. @alice:matrix.org.",
    fields: [
      { key: "homeserver", label: "Homeserver URL", placeholder: "https://matrix.org" },
      { key: "bot_user_id", label: "Bot user ID", placeholder: "@yourbot:matrix.org" },
    ],
    creds: "In Element: Settings → Help & About → Access Token. Use your bot account's homeserver + @user:server.",
    guide: { label: "Matrix client-server API", url: "https://matrix.org/docs/" },
  },
  {
    id: "discord", name: "Discord", color: "#5865F2", badge: "D", available: true, beta: true,
    desc: "Run Froglips from Discord servers and DMs.",
    secretLabel: "Bot token",
    secretHint: "Bot token from the Discord Developer Portal (enable the Message Content intent).",
    allowedLabel: "Allowed user IDs",
    allowedHint: "Comma-separated numeric Discord user IDs.",
    creds: "discord.com/developers → New Application → Bot → Reset Token. Enable 'Message Content Intent'. Invite the bot to your server.",
    guide: { label: "Discord Developer Portal", url: "https://discord.com/developers/applications" },
  },
  {
    id: "slack", name: "Slack", color: "#4A154B", badge: "S", available: true, beta: true,
    desc: "Run Froglips from Slack via Socket Mode.",
    secretLabel: "App token | Bot token",
    secretHint: "Both tokens separated by a pipe: xapp-… | xoxb-… (Socket Mode app token, then bot token).",
    allowedLabel: "Allowed user IDs",
    allowedHint: "Comma-separated Slack user IDs (e.g. U012ABCDEF).",
    creds: "api.slack.com/apps → create an app, enable Socket Mode (xapp- app token), add a bot token (xoxb-) with chat:write + message scopes.",
    guide: { label: "Slack Socket Mode", url: "https://api.slack.com/apis/socket-mode" },
  },
  {
    id: "mattermost", name: "Mattermost", color: "#0058CC", badge: "M", available: true, beta: true,
    desc: "Run Froglips from Mattermost.",
    secretLabel: "Bot token",
    secretHint: "A bot access token. Stored in your macOS Keychain.",
    allowedLabel: "Allowed user IDs",
    allowedHint: "Comma-separated Mattermost user IDs.",
    fields: [{ key: "server_url", label: "Server URL", placeholder: "https://your.mattermost.com" }],
    creds: "System Console → Integrations → Bot Accounts → create a bot, copy its token.",
    guide: { label: "Mattermost bot accounts", url: "https://developers.mattermost.com/integrate/reference/bot-accounts/" },
  },
  {
    id: "email", name: "Email", color: "#EA4335", badge: "@", available: true,
    desc: "Run Froglips over IMAP/SMTP email.",
    secretLabel: "Password",
    secretHint: "Your mailbox password or an app-specific password. Stored in your macOS Keychain.",
    allowedLabel: "Allowed sender addresses",
    allowedHint: "Comma-separated email addresses allowed to drive the agent.",
    fields: [
      { key: "username", label: "Email address", placeholder: "you@example.com" },
      { key: "imap_host", label: "IMAP host", placeholder: "imap.example.com" },
      { key: "imap_port", label: "IMAP port", placeholder: "993", numeric: true },
      { key: "smtp_host", label: "SMTP host", placeholder: "smtp.example.com" },
      { key: "smtp_port", label: "SMTP port", placeholder: "465", numeric: true },
    ],
    creds: "Use your provider's IMAP/SMTP hosts. For Gmail, create an App Password (2FA required).",
  },
  // Not yet wired — listed so the rail matches the roadmap.
  { id: "whatsapp", name: "WhatsApp", color: "#25D366", badge: "W", desc: "Run Froglips from WhatsApp." },
  { id: "signal", name: "Signal", color: "#3A76F0", badge: "S", desc: "Run Froglips from Signal." },
  { id: "imessage", name: "BlueBubbles (iMessage)", color: "#34DA50", badge: "B", desc: "Run Froglips from iMessage via BlueBubbles." },
  { id: "homeassistant", name: "Home Assistant", color: "#18BCF2", badge: "H", desc: "Run Froglips from Home Assistant." },
  { id: "dingtalk", name: "DingTalk", color: "#0089FF", badge: "D", desc: "Run Froglips from DingTalk." },
  { id: "feishu", name: "Feishu / Lark", color: "#00D6B9", badge: "F", desc: "Run Froglips from Feishu / Lark." },
  { id: "wecom", name: "WeCom", color: "#2F90FF", badge: "W", desc: "Run Froglips from WeCom." },
  { id: "wechat", name: "Weixin / WeChat", color: "#07C160", badge: "W", desc: "Run Froglips from WeChat." },
  { id: "qq", name: "QQ Bot", color: "#12B7F5", badge: "Q", desc: "Run Froglips from QQ." },
];

function BrandIcon({ ch, cls }: { ch: ChannelSpec; cls: string }) {
  const path = BRAND_ICONS[ch.id];
  if (path) {
    return (
      <span className={cls} style={{ background: "#ffffff" }}>
        <svg viewBox="0 0 24 24" width="62%" height="62%" fill={ch.color} aria-hidden="true">
          <path d={path} />
        </svg>
      </span>
    );
  }
  return <span className={cls} style={{ background: ch.color }}>{ch.badge}</span>;
}

type ChanCfg = Record<string, unknown> & {
  enabled?: boolean;
  allowed_user_ids?: string[];
};

export function MessagingView() {
  const settings = useSettings();
  const updateSettings = useUpdateSettings();
  const [selected, setSelected] = useState("telegram");
  const [search, setSearch] = useState("");
  const [statuses, setStatuses] = useState<GatewayStatus[]>([]);

  const chan = CHANNELS.find((c) => c.id === selected) ?? CHANNELS[0];
  // `chan` is recomputed every render; memoize its fields so callbacks that
  // depend on them don't churn. Keyed on chan.id (the only thing that changes).
  const chanFields = useMemo(() => chan.fields ?? [], [chan.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const cfg = ((settings?.messaging as Record<string, ChanCfg> | undefined)?.[
    selected
  ] ?? {}) as ChanCfg;
  const enabled = cfg.enabled === true;

  const [secret, setSecret] = useState("");
  const [hasToken, setHasToken] = useState(false);
  const [allowedDraft, setAllowedDraft] = useState("");
  const [fieldDraft, setFieldDraft] = useState<Record<string, string>>({});
  const [validateMsg, setValidateMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Load drafts when the selected channel (or its settings) changes.
  useEffect(() => {
    setSecret("");
    setValidateMsg(null);
    setAllowedDraft((cfg.allowed_user_ids ?? []).join(", "));
    const fd: Record<string, string> = {};
    for (const f of chanFields) {
      const v = cfg[f.key];
      fd[f.key] = v == null ? "" : String(v);
    }
    setFieldDraft(fd);
    void api.messagingHasToken(selected).then(setHasToken);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, settings?.messaging]);

  // Poll status for all channels.
  useEffect(() => {
    let alive = true;
    const tick = () =>
      api.messagingStatus().then(
        (s) => alive && setStatuses(s),
        () => undefined,
      );
    void tick();
    const id = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  const statusOf = (id: string) => statuses.find((s) => s.channel === id) ?? null;
  const status = statusOf(selected);

  const parsedAllowed = useCallback(
    () =>
      allowedDraft
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    [allowedDraft],
  );

  const buildCfg = useCallback((): ChanCfg => {
    const out: ChanCfg = { ...cfg, allowed_user_ids: parsedAllowed() };
    for (const f of chanFields) {
      const raw = (fieldDraft[f.key] ?? "").trim();
      if (f.numeric) {
        // Only persist a valid positive port. An empty/garbage value is left
        // unset so the connector default applies — never coerced to 0, which
        // both layers now reject (review M9).
        const n = Number(raw);
        if (raw !== "" && Number.isInteger(n) && n > 0) out[f.key] = n;
        else delete out[f.key];
      } else {
        out[f.key] = raw;
      }
    }
    return out;
  }, [cfg, chanFields, fieldDraft, parsedAllowed]);

  const writeCfg = useCallback(
    async (next: ChanCfg) => {
      const messaging: MessagingConfig = {
        ...(settings?.messaging ?? {}),
        [selected]: next,
      } as MessagingConfig;
      await updateSettings({ messaging });
    },
    [settings, selected, updateSettings],
  );

  const saveChanges = useCallback(async () => {
    setBusy(true);
    setValidateMsg(null);
    try {
      if (secret.trim()) {
        await api.messagingSetToken(selected, secret.trim());
        setHasToken(true);
        setSecret("");
      }
      await writeCfg(buildCfg());
      try {
        const label = await api.messagingValidate(selected);
        setValidateMsg(`✓ ${label}`);
      } catch (e) {
        setValidateMsg(`✗ ${e}`);
      }
    } catch (e) {
      setValidateMsg(`✗ ${e}`);
    } finally {
      setBusy(false);
    }
  }, [secret, selected, writeCfg, buildCfg]);

  const toggleEnabled = useCallback(
    async (on: boolean) => {
      setValidateMsg(null);
      try {
        await writeCfg({ ...buildCfg(), enabled: on });
      } catch (e) {
        // Surface a rejected enable (e.g. validator refuses an incomplete
        // config) instead of silently reverting with no explanation.
        setValidateMsg(`✗ ${e}`);
      }
    },
    [writeCfg, buildCfg],
  );

  const filtered = useMemo(
    () => CHANNELS.filter((c) => c.name.toLowerCase().includes(search.trim().toLowerCase())),
    [search],
  );

  const allowedCount = (cfg.allowed_user_ids ?? []).length;
  const ready = hasToken && allowedCount > 0;

  return (
    <div className="msg-root" data-testid="messaging-view">
      <div className="msg-rail">
        <input
          className="msg-search"
          placeholder="Search messaging…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="msg-list">
          {filtered.map((c) => (
            <button
              key={c.id}
              type="button"
              className={`msg-chan${c.id === selected ? " is-active" : ""}`}
              onClick={() => setSelected(c.id)}
              data-testid={`msg-chan-${c.id}`}
            >
              <BrandIcon ch={c} cls="msg-chan-icon" />
              <span className="msg-chan-name">{c.name}</span>
              {c.beta && <span className="msg-beta">beta</span>}
              <span className={`msg-dot${statusOf(c.id)?.running ? " on" : ""}`} />
            </button>
          ))}
        </div>
      </div>

      <div className="msg-detail">
        <div className="msg-detail-inner">
          <div className="msg-head">
            <BrandIcon ch={chan} cls="msg-head-icon" />
            <div>
              <div className="msg-head-title">{chan.name}</div>
              <div className="msg-head-desc">{chan.desc}</div>
            </div>
          </div>

          {chan.available ? (
            <>
              {chan.beta && (
                <div className="msg-beta-note">
                  <strong>Beta.</strong> This connector is implemented to the
                  platform spec but has not yet been verified against a live{" "}
                  {chan.name} server. Expect rough edges; please report issues.
                </div>
              )}
              <div className="msg-pills">
                <span className={`msg-pill${enabled ? " on" : ""}`}>
                  {enabled ? "Enabled" : "Disabled"}
                </span>
                <span className={`msg-pill${ready ? " on" : " warn"}`}>
                  {ready ? "Ready" : "Needs setup"}
                </span>
                <span className={`msg-pill${status?.running ? " on" : ""}`}>
                  {status?.running
                    ? `Gateway running${status.bot_username ? ` · ${status.bot_username}` : ""}`
                    : "Gateway stopped"}
                </span>
                {status && status.messages_accepted + status.messages_blocked > 0 && (
                  <span className="msg-pill">
                    {status.messages_accepted} ok / {status.messages_blocked} blocked
                  </span>
                )}
                {status?.last_error && (
                  <span className="msg-pill warn">{status.last_error}</span>
                )}
              </div>

              {chan.creds && (
                <>
                  <div className="msg-section">Get your credentials</div>
                  <div className="msg-instr">{chan.creds}</div>
                  {chan.guide && (
                    <button
                      type="button"
                      className="msg-link"
                      onClick={() => void api.openExternal(chan.guide!.url)}
                    >
                      {chan.guide.label} <ExternalLink size={13} />
                    </button>
                  )}
                </>
              )}

              <div className="msg-section">Required</div>
              <div className="msg-field">
                <div className="msg-field-meta">
                  <div className="msg-field-name">{chan.secretLabel}</div>
                  <div className="msg-field-desc">
                    {chan.secretHint}
                    {hasToken ? " (a secret is saved)" : ""}
                  </div>
                </div>
                <input
                  type="password"
                  className="msg-field-input"
                  placeholder={hasToken ? "•••••••••• (saved)" : "Paste secret"}
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  data-testid="messaging-token-input"
                />
              </div>

              {(chan.fields ?? []).map((f) => (
                <div className="msg-field" key={f.key}>
                  <div className="msg-field-meta">
                    <div className="msg-field-name">{f.label}</div>
                  </div>
                  <input
                    type="text"
                    className="msg-field-input"
                    placeholder={f.placeholder}
                    value={fieldDraft[f.key] ?? ""}
                    onChange={(e) =>
                      setFieldDraft((d) => ({ ...d, [f.key]: e.target.value }))
                    }
                  />
                </div>
              ))}

              <div className="msg-section">Allowed senders (required)</div>
              <div className="msg-field">
                <div className="msg-field-meta">
                  <div className="msg-field-name">{chan.allowedLabel}</div>
                  <div className="msg-field-desc">
                    {chan.allowedHint}{" "}
                    <strong>Required to enable</strong> — only these can drive your
                    agent; the gateway won&apos;t start with an empty list.
                  </div>
                </div>
                <input
                  type="text"
                  className="msg-field-input"
                  placeholder="id1, id2"
                  value={allowedDraft}
                  onChange={(e) => setAllowedDraft(e.target.value)}
                  data-testid="messaging-allowed-input"
                />
              </div>

              <div className="msg-section">Safety</div>
              <div className="msg-instr">
                Remote (chat) runs are locked to <strong>read-only tools</strong> —
                no shell, file writes, or desktop control. The gateway runs only
                while Froglips is open.
              </div>

              {validateMsg && <div className="msg-validate">{validateMsg}</div>}

              <div className="msg-footer">
                <label className="msg-toggle">
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(e) => void toggleEnabled(e.target.checked)}
                    disabled={!hasToken || parsedAllowed().length === 0}
                    data-testid="messaging-enable"
                  />
                  Enable {chan.name} gateway
                </label>
                <button
                  type="button"
                  className="msg-save"
                  onClick={() => void saveChanges()}
                  disabled={busy}
                  data-testid="messaging-save"
                >
                  {busy ? "Saving…" : "Save changes"}
                </button>
              </div>
            </>
          ) : (
            <div className="msg-soon">
              <strong>Coming soon.</strong> {chan.name} isn&apos;t wired up yet.
              Wired now: Telegram, Matrix, Discord, Slack, Mattermost, Email.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
