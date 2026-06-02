/* ── Prompt template library ────────────────────────────────────────────
 *
 * LocalStorage-backed slash-command palette: typing "/explain" in the chat
 * input expands a pre-written prompt. Built-ins ship with the app and can be
 * hidden (not deleted); custom templates are user-authored and fully mutable.
 *
 * Variables in a template body are written as {name} and surface in the UI
 * as [name] placeholders the user replaces inline before sending.
 */

export interface PromptTemplate {
  id: string;
  name: string;
  trigger: string;
  body: string;
  builtIn?: boolean;
  variables: string[];
}

const STORAGE_KEY = "prompt.templates";
const HIDDEN_KEY = "prompt.templates.hiddenBuiltIns";

interface RawBuiltIn {
  id: string;
  name: string;
  trigger: string;
  body: string;
}

const BUILTIN_DEFS: RawBuiltIn[] = [
  {
    id: "explain",
    name: "Explain",
    trigger: "explain",
    body: "Explain {selection} in plain English. Cover: what it does, why it exists, and the key trade-offs.",
  },
  {
    id: "refactor",
    name: "Refactor",
    trigger: "refactor",
    body: "Refactor {selection} for {goal}. Preserve behavior. Explain each change briefly.",
  },
  {
    id: "test",
    name: "Write tests",
    trigger: "test",
    body: "Write unit tests for {selection}. Use the project's existing test framework. Cover happy path + 2 edge cases.",
  },
  {
    id: "summarize",
    name: "Summarize conversation",
    trigger: "summarize",
    body: "Summarize the conversation so far. Bullet the key decisions and any open questions.",
  },
  {
    id: "commit",
    name: "Commit message",
    trigger: "commit",
    body: "Suggest a Conventional Commits message for the staged changes. Reply with just the message, no commentary.",
  },
];

/** Extract `{name}` placeholders from a body in first-seen order, no dupes. */
export function extractVariables(body: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re = /\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const name = m[1];
    if (!seen.has(name)) {
      seen.add(name);
      out.push(name);
    }
  }
  return out;
}

export function getBuiltInTemplates(): PromptTemplate[] {
  return BUILTIN_DEFS.map((def) => ({
    ...def,
    builtIn: true,
    variables: extractVariables(def.body),
  }));
}

function isValidTemplate(x: unknown): x is PromptTemplate {
  if (!x || typeof x !== "object") return false;
  const t = x as Record<string, unknown>;
  return (
    typeof t.id === "string" &&
    typeof t.name === "string" &&
    typeof t.trigger === "string" &&
    typeof t.body === "string"
  );
}

function loadCustom(): PromptTemplate[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(isValidTemplate).map((t) => ({
      ...t,
      builtIn: false,
      variables: extractVariables(t.body),
    }));
  } catch {
    return [];
  }
}

function saveCustom(list: PromptTemplate[]) {
  // Strip computed `variables` before persisting (it's derived from `body`).
  const stripped = list.map(({ variables: _v, builtIn: _b, ...rest }) => rest);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stripped));
}

function loadHidden(): Set<string> {
  try {
    const raw = localStorage.getItem(HIDDEN_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((x): x is string => typeof x === "string"));
  } catch {
    return new Set();
  }
}

function saveHidden(ids: Set<string>) {
  localStorage.setItem(HIDDEN_KEY, JSON.stringify(Array.from(ids)));
}

/**
 * Return the full visible template list — built-ins (minus hidden ones) plus
 * custom templates, with custom templates overriding built-ins that share a
 * trigger string. Order: visible built-ins first (definition order), then
 * custom templates.
 */
export function loadAllTemplates(): PromptTemplate[] {
  const hidden = loadHidden();
  const custom = loadCustom();
  const customTriggers = new Set(custom.map((c) => c.trigger));
  const visibleBuiltIns = getBuiltInTemplates().filter(
    (b) => !hidden.has(b.id) && !customTriggers.has(b.trigger),
  );
  return [...visibleBuiltIns, ...custom];
}

/** All templates including hidden built-ins — used by the library manager. */
export function loadAllTemplatesForManager(): {
  builtIns: PromptTemplate[];
  custom: PromptTemplate[];
  hiddenIds: Set<string>;
} {
  return {
    builtIns: getBuiltInTemplates(),
    custom: loadCustom(),
    hiddenIds: loadHidden(),
  };
}

export function saveCustomTemplate(tpl: PromptTemplate) {
  const list = loadCustom().filter((t) => t.id !== tpl.id);
  list.push({
    ...tpl,
    builtIn: false,
    variables: extractVariables(tpl.body),
  });
  saveCustom(list);
}

export function deleteCustomTemplate(id: string) {
  saveCustom(loadCustom().filter((t) => t.id !== id));
}

export function setBuiltInHidden(id: string, hidden: boolean) {
  const set = loadHidden();
  if (hidden) set.add(id);
  else set.delete(id);
  saveHidden(set);
}

/** Filter templates by trigger prefix (case-insensitive). */
export function filterByTrigger(
  templates: PromptTemplate[],
  prefix: string,
): PromptTemplate[] {
  const p = prefix.toLowerCase();
  if (!p) return templates;
  return templates.filter((t) => t.trigger.toLowerCase().startsWith(p));
}

/**
 * Apply a template to produce input text + the range of the first variable
 * placeholder for auto-selection. Variables become `[name]` literals.
 * If no variables, `firstVarRange` is null.
 */
export function applyTemplate(tpl: PromptTemplate): {
  text: string;
  firstVarRange: { start: number; end: number } | null;
} {
  let text = tpl.body;
  for (const v of tpl.variables) {
    text = text.replace(new RegExp(`\\{${v}\\}`, "g"), `[${v}]`);
  }
  if (tpl.variables.length === 0) {
    return { text, firstVarRange: null };
  }
  const first = `[${tpl.variables[0]}]`;
  const idx = text.indexOf(first);
  if (idx < 0) return { text, firstVarRange: null };
  return { text, firstVarRange: { start: idx, end: idx + first.length } };
}

/**
 * Generate a unique id for a new custom template. Pure string munging — no
 * UUID dep. Uses the trigger as a base when possible.
 */
export function generateTemplateId(trigger: string): string {
  const cleaned = trigger
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const base = cleaned || "custom";
  return `${base}-${Date.now().toString(36)}`;
}
