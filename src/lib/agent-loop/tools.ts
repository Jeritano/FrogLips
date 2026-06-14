/* ── Tool definitions (OpenAI function format) ──
 *
 * DERIVED from `TOOL_REGISTRY` (tool-registry.ts) — the single source of truth
 * for every built-in agent tool. The wire array preserves registry order
 * (read_file first … load_claude_skill last) and the exact `{type:"function",
 * function:{name, description, parameters}}` shape every consumer (runner,
 * system-prompt, MCP merge) already relies on. The schema objects come
 * straight from each descriptor's `schema`, so editing a tool's
 * description/parameters happens in ONE place (the registry).
 */

import { TOOL_REGISTRY } from "./tool-registry";

export const TOOLS = TOOL_REGISTRY.map((d) => ({
  type: "function" as const,
  function: {
    name: d.name,
    description: d.schema.description,
    parameters: d.schema.parameters,
  },
}));
