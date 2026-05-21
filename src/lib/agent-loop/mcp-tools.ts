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
      const params =
        t.inputSchema && typeof t.inputSchema === "object"
          ? (t.inputSchema as Record<string, unknown>)
          : { type: "object", properties: {} };
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
