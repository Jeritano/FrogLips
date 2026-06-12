# Froglips UI kit

Token-styled primitives + Radix-backed accessible components. The design-system
foundation for Froglips: adopt these incrementally in place of hand-rolled
markup so styling + a11y stay centralized.

## Layers

1. **Tokens** — `src/styles/tokens.css`. Color tiers, semantic colors, light+dark
   themes, plus the 2026-05-31 additions: font-weight, line-height, elevation
   (`--elev-1..4`), motion (`--dur-*`, `--ease-*`), and a `prefers-reduced-motion`
   guard. **Every component value resolves to a token — no raw colors/spacing.**
2. **Primitives** — `src/components/ui/*`. Import from `components/ui`:
   ```tsx
   import { Button, IconButton, Input, Badge, Card, Spinner } from "../ui";
   ```
3. **Accessible components (Radix-backed)** — `Dialog`, `Tooltip`,
   `DropdownMenu`, `Tabs`, `Switch`. Radix supplies focus traps, keyboard nav,
   ARIA, portals, and collision handling; we own the token styling in
   `src/styles/ui.css`.

## Setup

- `ui.css` is bundled via `App.css`’s `@import` chain — no per-component import.
- `Tooltip` needs `<TooltipProvider>` mounted once near the app root before any
  `Tooltip` is used.

## Adoption (incremental — do NOT mass-migrate)

Replace one component family at a time, lowest-risk first, verifying visually:

| Hand-rolled today                 | Replace with                                        |
| --------------------------------- | --------------------------------------------------- |
| `<button className="...">`        | `<Button variant size>` / `<IconButton aria-label>` |
| `title="…"` tooltips (mouse-only) | `<Tooltip content>` (also keyboard-focus)           |
| absolutely-positioned menus       | `DropdownMenu*`                                     |
| `ConfirmDialog` / modal kit       | `Dialog` + `DialogContent`                          |
| ad-hoc toggle checkboxes          | `Switch`                                            |
| tab bars                          | `Tabs*`                                             |

The legacy per-feature CSS (`chat.css`, `panels.css`, …) and the `ui-` kit
coexist by namespace, so migration is page-by-page with no big-bang rewrite.

## Why this over shadcn/Tailwind

Froglips already had a strong token layer + ~6,900 lines of working CSS. Adopting
Tailwind would mean rewriting all of it. The headless-Radix + token approach
keeps the existing look, fixes the real gap (a11y behavior), and migrates
incrementally — ~90% of the benefit at ~10% of the disruption.
