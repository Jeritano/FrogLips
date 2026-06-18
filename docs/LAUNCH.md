# Froglips — Launch Kit (v0.15 "Prove + Launch")

Draft assets for the public launch. **Nothing here is posted automatically** —
Joseph posts, edits the voice, and picks timing. Honest by design: no claim we
can't back up.

## The one-line wedge

> Froglips runs LLMs **fully on your Mac, zero install** — and pairs that with a
> **visual multi-agent Workflows canvas**. No other local-LLM app pairs
> orchestration this visual with inference this self-contained.

Everything below leads with that. Chat is table stakes; the differentiator is
**visual orchestration × in-process local inference**.

---

## 60-second demo storyboard (the README hero GIF)

Record on a clean install, dark theme, window ~1280×800. Keep it silent, fast
cuts, on-screen captions. Target ≤ 8 MB GIF (or MP4 + poster).

1. **0–6s — Zero install.** Cold-open the app → pick a small model from the
   picker → it loads *in-process* (caption: "runs on your Mac — no Python, no
   daemon, no cloud"). Send one chat message, tokens stream.
2. **6–26s — Build a pipeline.** Switch to **Flows**. Drop two agent cards
   ("Researcher" → "Writer"). Wire output→input. Give card 1 a prompt
   ("summarize the key risks in ./SECURITY.md"), card 2 ("turn it into release
   notes"). (caption: "chain agents visually").
3. **26–46s — Run it.** Click **Run workflow**. Show card 1 working
   (read_file tool call), handing to card 2, final output rendering. (caption:
   "multi-agent run — all local").
4. **46–60s — The trust line.** Flash the agent confirm modal on a dangerous
   tool + the "read-only over chat" messaging note. End card: "Local. Private.
   MIT. Apple Silicon." + the repo URL.

Then drop the GIF into the README hero (replace the static `screenshot-home.png`
slot, keep the banner).

---

## r/LocalLLaMA post

**Title:**
`Froglips: native macOS app that runs local LLMs in-process (zero install) + a visual multi-agent workflow canvas — MIT`

**Body:**

I built Froglips — a native macOS app (Tauri + Rust, no Electron) for running
LLMs locally. Two things make it different from the usual local-chat GUIs:

1. **Zero-install in-process inference.** It embeds `mistralrs` + candle + Metal
   and runs models *inside the app process* on Apple Silicon — no Python, no
   separate daemon, no subprocess. First load pulls weights from HF; after that
   it's instant. (It also drives Ollama/MLX if you already run them, and can
   route to cloud endpoints, but the headline is the self-contained path.)

2. **A visual multi-agent Workflows canvas.** You place agent cards on a
   table-top, wire them output→input, give each its own model/role/tools, and
   run (or schedule) the whole pipeline. Local models powering a visual
   orchestration graph — that's the part I haven't seen elsewhere.

Plus the workstation stuff: agent mode with filesystem/shell/web/git/code tools
(every dangerous tool is confirmation-gated and shell/code run under a macOS
Seatbelt sandbox), project RAG + vector-recall memory, a multi-model router, MCP
server support, and signed auto-updates.

Free, MIT, local-only, no telemetry. **Apple-Silicon only** for now (the Metal
inference path is the whole point). Some chat-platform connectors (Discord/
Slack/Mattermost) are marked **beta** — built to spec but not yet verified
against live servers; Telegram/Matrix/Email are tested.

Repo + DMG: https://github.com/Jeritano/FrogLips
`brew install --cask jeritano/tap/froglips`

Happy to answer anything about the in-process inference or the agent sandbox.

---

## Show HN post

**Title:**
`Show HN: Froglips – local-LLM workstation with a visual multi-agent canvas (macOS)`

**Body:**

Froglips runs LLMs entirely on your Mac and adds a visual canvas where you wire
agent "cards" into multi-agent pipelines. The models powering those cards run
in-process via embedded mistralrs + Metal — zero install, no Python, no daemon.

It's a native Tauri/Rust app (no Electron, ~66 MB). Alongside the workflow
canvas: a tool-calling agent (fs/shell/web/git/code) with risk-classified
confirmation and a Seatbelt sandbox on shell/code exec, project RAG, vector
memory, a multi-model router, and MCP support. MIT, local-only, no telemetry.

Apple-Silicon only today.

**First comment (technical):**

A few implementation notes for the HN crowd:
- Inference is `mistralrs-core` + candle with the Metal backend, linked into the
  app and called in-process — no HTTP hop to a local server for the bundled
  path. Weights live in `~/.cache/huggingface/hub`.
- The agent's trust boundary is the set of Tauri commands; dangerous tools
  require an approval token (SHA-256-bound to the call) minted only after a human
  confirms, and shell/code run under `sandbox-exec` with a credential-deny
  profile. It's been through several adversarial security passes.
- Secrets (API keys, bot tokens) live in the macOS Keychain, never in settings
  on disk.
- Releases are Developer-ID signed + Apple-notarized with a signed auto-updater.

Repo: https://github.com/Jeritano/FrogLips

---

## Pre-launch checklist

- [ ] Record + embed the demo GIF (storyboard above).
- [ ] Decide messaging connectors: ship Discord/Slack/Mattermost as **beta**
      (done — UI badge + caution) or verify live first (needs test creds).
- [ ] Skim the README hero on a fresh clone — does the wedge land in 5 seconds?
- [ ] Confirm `brew install --cask jeritano/tap/froglips` works from clean.
- [ ] Pick a launch window (Tue–Thu morning ET tends to do well on both).
- [ ] Be around for the first few hours to answer comments.
