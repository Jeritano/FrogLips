# 0003: Local-only, no telemetry

- Status: accepted
- Date: 2026-05-26
- Deciders: @Jeritano

## Context

Local-LLM users are explicitly opting out of cloud chat. Shipping
analytics, crash telemetry, or usage metrics — even anonymized — runs
counter to the value proposition.

Tradeoffs:

- No telemetry → no usage data → product decisions made on user
  reports + intuition. Slower learning loop.
- Crash reports stay local (`~/.local-llm-app/crash.log`). Users must
  attach manually to bug reports via Diagnostics → Export Bundle.

## Decision

Zero outbound telemetry. Crashes, diagnostics, audit log all stay
on-disk in the user's home directory. Diagnostics bundle export is a
user-initiated action with redaction (`redact_secrets` already strips
API keys / tokens).

The only outbound network traffic this app makes is:

1. User-initiated model pulls from huggingface.co / ollama.com
2. User-initiated chat to the configured backend (mlx / ollama / native
   / `*:cloud` / novita)
3. User-initiated `web_fetch` / `web_search` / `http_request` agent
   tools
4. Updater fetch of `latest.json` from
   `github.com/Jeritano/FrogLips/releases/latest/download/`
5. Civitai/HuggingFace search in the Model Browser

No background pings. No analytics SDK.

## Consequences

**+** Trust positioning. Matches the user's mental model of "this is
my local AI". Compatible with regulated-industry users (legal,
medical, security).

**−** No data for product-decision feedback loop. Bug repro requires
explicit user effort. No way to know which models are popular, which
features get used.

**Re-evaluate**: never on involuntary telemetry. Possibly on
explicitly-opt-in survey data, but the bar is very high.
