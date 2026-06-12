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
/** Max number of `$ref` keys allowed inside an MCP `inputSchema`. */
const MCP_SCHEMA_MAX_REFS = 32;

/** Depth of the deepest object/array in `v`. Primitives → 0. */
function objectDepth(
  v: unknown,
  seen: WeakSet<object> = new WeakSet(),
): number {
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
      message: `MCP tool '${serverName}.${toolName}' inputSchema not JSON-serializable — using fallback schema.`,
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
  // Count `$ref` keys across the whole schema. The depth cap above already
  // bounds nesting of inline objects, but `$ref` can dereference to another
  // sub-schema at runtime in JSON-Schema-aware consumers; a hostile MCP
  // server could ship a schema whose serialized size fits in 16 KB but
  // contains hundreds of refs that, when expanded, blow up downstream
  // tooling (model-side schema renderers, MCP IDE plugins). Cap the count
  // at MCP_SCHEMA_MAX_REFS so the worst-case post-resolution tree stays
  // bounded even if a future renderer follows `$ref` for display.
  const refCount = countRefs(schema);
  if (refCount > MCP_SCHEMA_MAX_REFS) {
    logDiag({
      level: "warn",
      source: "mcp-tools",
      message:
        `MCP tool '${serverName}.${toolName}' inputSchema has ${refCount} \\$ref entries > ${MCP_SCHEMA_MAX_REFS} cap — ` +
        `using fallback schema.`,
    });
    return fallbackSchema();
  }
  return schema as Record<string, unknown>;
}

/** Count `$ref` keys anywhere in a JSON-like tree. */
function countRefs(v: unknown, depth = 0): number {
  // Use depth-cap instead of WeakSet cycle guard. JSON values can't
  // contain cycles, but a JS-constructed schema could share the same
  // sub-object under two paths (`{a: shared, b: shared}`). With a
  // WeakSet, the second visit was skipped — so refs reachable only
  // via that path were undercounted, weakening the cap's defense.
  // A simple depth cap halts both honest cycles AND legitimate shared
  // subtrees deterministically, and counts every reachable ref at
  // depths within the budget.
  if (depth > 64) return 0;
  if (!v || typeof v !== "object") return 0;
  let n = 0;
  if (Array.isArray(v)) {
    for (const item of v) n += countRefs(item, depth + 1);
  } else {
    for (const [k, sub] of Object.entries(v as Record<string, unknown>)) {
      // Only count `$ref` whose value is a string (the JSON-Schema
      // contract). Junk values like `{"$ref": null}` or `{"$ref": {}}`
      // are not real refs and would otherwise inflate the counter.
      if (k === "$ref" && typeof sub === "string") n += 1;
      n += countRefs(sub, depth + 1);
    }
  }
  return n;
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
  // Clear the schema cache at the start of every discovery pass so
  // schemas for servers that have since been removed (or tools that
  // were renamed) don't linger forever. Each pass repopulates the
  // cache from current state, bounding memory to the live server set
  // even under heavy MCP churn (dev workflow: start/stop/reload).
  MCP_TOOL_SCHEMAS.clear();
  const out: OpenAIToolDef[] = [];
  for (const s of servers) {
    // A server name containing the `__` separator would corrupt
    // parseMcpToolName's split, mis-routing calls and audit provenance.
    // Allow only [A-Za-z0-9-] so that `_` (anywhere) and `__` (the SEP)
    // can never produce a name that parseMcpToolName mis-splits. A name
    // like `a_b__c` would otherwise look indistinguishable from server
    // `a` calling tool `b__c` after the prefix is stripped.
    if (!/^[A-Za-z0-9-]+$/.test(s.name)) {
      logDiag({
        level: "warn",
        source: "mcp-tools",
        message:
          `Skipping MCP server '${s.name}': server names must match [A-Za-z0-9-]+ ` +
          `(no underscores or other punctuation that could collide with the '__' separator).`,
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
      // Same separator-safety rule as for server names — reject tool names
      // containing `_` or other punctuation so `mcp__<server>__<tool>` is
      // unambiguously parseable. A malicious server can't smuggle a tool
      // whose name re-splits to point at a different server.
      if (!/^[A-Za-z0-9-]+$/.test(t.name)) {
        logDiag({
          level: "warn",
          source: "mcp-tools",
          message: `Skipping MCP tool '${s.name}.${t.name}': tool names must match [A-Za-z0-9-]+`,
        });
        continue;
      }
      const params = sanitizeMcpSchema(s.name, t.name, t.inputSchema);
      const fullName = mcpToolName(s.name, t.name);
      // Cache the sanitized schema so dispatchMcpTool can do light arg
      // validation without an extra IPC. The cache is overwritten on every
      // discovery pass, so stale schemas don't accumulate.
      rememberMcpToolSchema(fullName, params);
      out.push({
        type: "function",
        function: {
          name: fullName,
          description: t.description || `MCP tool from server "${s.name}"`,
          parameters: params,
        },
      });
    }
  }
  return out;
}

/**
 * Light schema validation for MCP tool arguments. Full JSON-Schema
 * validation needs a dependency (ajv); this catches the common-case
 * failures without one:
 *   - args must be a plain object (every MCP schema is `type: "object"`)
 *   - every key in `required` must be present and non-null
 *   - top-level properties: rough type tag check (string/number/integer/
 *     boolean/array/object); permissive on `null` and unknown types
 *
 * Returns null on success, or an error message identifying the
 * first failure. The dispatcher surfaces this back to the model so it
 * can correct the call rather than letting the MCP server reject a
 * malformed payload with a less informative error.
 */
function validateMcpArgs(
  schema: Record<string, unknown> | undefined,
  args: Record<string, unknown>,
): string | null {
  if (!schema || typeof schema !== "object") return null;
  const required = Array.isArray((schema as { required?: unknown[] }).required)
    ? ((schema as { required?: string[] }).required ?? []).filter(
        (k): k is string => typeof k === "string",
      )
    : [];
  for (const key of required) {
    if (!(key in args) || args[key] == null) {
      return `missing required field '${key}'`;
    }
  }
  const props = (schema as { properties?: Record<string, unknown> }).properties;
  if (props && typeof props === "object") {
    for (const [key, sub] of Object.entries(props)) {
      if (!(key in args)) continue;
      const v = args[key];
      if (v == null) continue;
      const t = (sub as { type?: unknown })?.type;
      if (typeof t !== "string") continue;
      const expected = t.toLowerCase();
      const actual = Array.isArray(v)
        ? "array"
        : typeof v === "object"
          ? "object"
          : typeof v;
      const ok =
        expected === actual ||
        (expected === "integer" &&
          actual === "number" &&
          Number.isInteger(v as number)) ||
        (expected === "number" && actual === "number");
      if (!ok) {
        return `field '${key}' expected type '${expected}', got '${actual}'`;
      }
    }
  }
  return null;
}

/**
 * Map of known MCP tools, populated by `discoverMcpTools` so the
 * dispatcher can light-validate args without an extra IPC round-trip.
 * The map is keyed by the full `mcp__server__tool` name.
 */
const MCP_TOOL_SCHEMAS: Map<string, Record<string, unknown>> = new Map();

/** Internal: called by discoverMcpTools to keep the schema cache fresh. */
function rememberMcpToolSchema(
  fullName: string,
  schema: Record<string, unknown>,
): void {
  MCP_TOOL_SCHEMAS.set(fullName, schema);
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
  // Light schema validation: catches obvious type mismatches and missing
  // required fields before we round-trip to the server. Full validation
  // (oneOf, enum, pattern, range bounds, etc.) is intentionally left to
  // the server; we just sanity-check shape so the model gets a useful
  // error for the common-case bad call.
  if (typeof args !== "object" || args == null || Array.isArray(args)) {
    return JSON.stringify({
      ok: false,
      kind: "mcp_bad_args",
      server: parsed.server,
      tool: parsed.tool,
      message: "MCP tool arguments must be a JSON object",
    });
  }
  const schema = MCP_TOOL_SCHEMAS.get(fnName);
  const validationErr = validateMcpArgs(schema, args);
  if (validationErr) {
    return JSON.stringify({
      ok: false,
      kind: "mcp_bad_args",
      server: parsed.server,
      tool: parsed.tool,
      message: validationErr,
    });
  }
  try {
    const text = await api.mcpCallTool(parsed.server, parsed.tool, args);
    return JSON.stringify({
      ok: true,
      server: parsed.server,
      tool: parsed.tool,
      text,
    });
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
