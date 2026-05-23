/* ── MCP tool discovery + dispatch ────────────────────────────────────── */
/*
 * Bridges user-configured MCP servers into the agent's tool surface.
 *
 * Tool naming: every MCP tool is exposed to the model as
 *   `mcp__{serverName}__{toolName}`
 * to avoid colliding with built-in tools (read_file, etc.) and to make the
 * provenance obvious in chat transcripts and tool history.
 */

import { api } from "../tauri-api";
import { logDiag } from "../diagnostics";

export interface OpenAIToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

const PREFIX = "mcp__";
const SEP = "__";

/**
 * Bound on a per-tool `inputSchema` payload after JSON serialization. An
 * MCP server is out-of-process and attacker-influenceable — a malicious or
 * careless server can ship a multi-megabyte schema (or a recursive one
 * abusing `$ref`) that bloats the system-prompt token budget or trips
 * stack/recursion limits inside marked/DOMPurify-like consumers downstream.
 */
// 16 KB chosen as a realistic ceiling: many production MCP servers ship
// schemas in the 3-8 KB range (rich enum lists, nested response shapes), so
// the previous 2 KB cap was rejecting legitimate tools. 16 KB still bounds
// per-tool system-prompt cost — even with dozens of MCP tools the worst case
// stays well under the model's context window — while leaving headroom for
// realistic schemas. Depth cap (below) is unchanged.
const MCP_SCHEMA_MAX_BYTES = 16384;
/** Max nesting depth allowed inside an MCP `inputSchema` object/array tree. */
const MCP_SCHEMA_MAX_DEPTH = 8;

/** Depth of the deepest object/array in `v`. Primitives → 0. */
function objectDepth(v: unknown, seen: WeakSet<object> = new WeakSet()): number {
  if (!v || typeof v !== "object") return 0;
  if (seen.has(v as object)) return MCP_SCHEMA_MAX_DEPTH + 1; // cycle → over cap
  seen.add(v as object);
  let max = 0;
  if (Array.isArray(v)) {
    for (const item of v) {
      const d = objectDepth(item, seen);
      if (d > max) max = d;
    }
  } else {
    for (const k of Object.keys(v as Record<string, unknown>)) {
      const d = objectDepth((v as Record<string, unknown>)[k], seen);
      if (d > max) max = d;
    }
  }
  return 1 + max;
}

/** A fallback schema used when the server-supplied one is rejected. */
function fallbackSchema(): Record<string, unknown> {
  return { type: "object", properties: {} };
}

/**
 * Validate an MCP-supplied JSON-Schema-ish object before it crosses into the
 * agent loop. Returns either the original schema or a safe fallback. A
 * truncated/replaced schema still permits the call to be made (with an empty
 * parameter shape); the alternative — forwarding a bloated/cyclic schema —
 * is strictly worse.
 */
function sanitizeMcpSchema(
  serverName: string,
  toolName: string,
  schema: unknown,
): Record<string, unknown> {
  if (!schema || typeof schema !== "object") return fallbackSchema();
  const depth = objectDepth(schema);
  if (depth > MCP_SCHEMA_MAX_DEPTH) {
    logDiag({
      level: "warn",
      source: "mcp-tools",
      message:
        `MCP tool '${serverName}.${toolName}' inputSchema depth ${depth} > ${MCP_SCHEMA_MAX_DEPTH} — ` +
        `using fallback schema.`,
    });
    return fallbackSchema();
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(schema);
  } catch {
    // Cycle / non-serializable values.
    logDiag({
      level: "warn",
      source: "mcp-tools",
      message:
        `MCP tool '${serverName}.${toolName}' inputSchema not JSON-serializable — using fallback schema.`,
    });
    return fallbackSchema();
  }
  if (serialized.length > MCP_SCHEMA_MAX_BYTES) {
    logDiag({
      level: "warn",
      source: "mcp-tools",
      message:
        `MCP tool '${serverName}.${toolName}' inputSchema ${serialized.length}B > ${MCP_SCHEMA_MAX_BYTES}B cap — ` +
        `using fallback schema.`,
    });
    return fallbackSchema();
  }
  return schema as Record<string, unknown>;
}

/** True iff the given function name refers to an MCP-provided tool. */
export function isMcpToolName(name: string): boolean {
  return name.startsWith(PREFIX) && name.slice(PREFIX.length).includes(SEP);
}

/** Decode `mcp__server__tool` into its components. Returns null if malformed. */
export function parseMcpToolName(
  name: string,
): { server: string; tool: string } | null {
  if (!name.startsWith(PREFIX)) return null;
  const rest = name.slice(PREFIX.length);
  const idx = rest.indexOf(SEP);
  if (idx <= 0 || idx >= rest.length - SEP.length) return null;
  return { server: rest.slice(0, idx), tool: rest.slice(idx + SEP.length) };
}

/** Build the `mcp__server__tool` name from components. */
export function mcpToolName(server: string, tool: string): string {
  return `${PREFIX}${server}${SEP}${tool}`;
}

/**
 * Query the registry for every running MCP server and merge their tools
 * into a list of OpenAI-format tool definitions ready to hand to the model.
 * Errors are swallowed per-server so one broken server can't kill the loop.
 */
export async function fetchMcpTools(): Promise<OpenAIToolDef[]> {
  let servers: { name: string }[] = [];
  try {
    servers = await api.mcpListServers();
  } catch {
    return [];
  }
  const out: OpenAIToolDef[] = [];
  for (const s of servers) {
    // A server name containing the `__` separator would corrupt
    // parseMcpToolName's split, mis-routing calls and audit provenance.
    if (s.name.includes(SEP)) {
      logDiag({
        level: "warn",
        source: "mcp-tools",
        message: `Skipping MCP server '${s.name}': name contains reserved separator '__'`,
      });
      continue;
    }
    let tools;
    try {
      tools = await api.mcpListTools(s.name);
    } catch {
      continue;
    }
    for (const t of tools) {
      const params = sanitizeMcpSchema(s.name, t.name, t.inputSchema);
      out.push({
        type: "function",
        function: {
          name: mcpToolName(s.name, t.name),
          description: t.description || `MCP tool from server "${s.name}"`,
          parameters: params,
        },
      });
    }
  }
  return out;
}

/** Execute an `mcp__server__tool` call, returning the raw text response. */
export async function dispatchMcpTool(
  fnName: string,
  args: Record<string, unknown>,
): Promise<string> {
  const parsed = parseMcpToolName(fnName);
  if (!parsed) {
    return JSON.stringify({
      ok: false,
      kind: "bad_mcp_name",
      message: `Malformed MCP tool name: ${fnName}`,
    });
  }
  try {
    const text = await api.mcpCallTool(parsed.server, parsed.tool, args);
    return JSON.stringify({ ok: true, server: parsed.server, tool: parsed.tool, text });
  } catch (e) {
    return JSON.stringify({
      ok: false,
      kind: "mcp_error",
      server: parsed.server,
      tool: parsed.tool,
      message: String((e as { message?: string })?.message ?? e),
    });
  }
}
