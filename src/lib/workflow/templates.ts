/* ── Bundled Flow templates ──────────────────────────────────────────────────
 *
 * Proven, ready-to-run Flows that show the headline value: chain a few small
 * local models into a pipeline that punches above any single model call. Shown
 * in the Flows hub gallery; "Use template" clones the graph into a new workflow.
 *
 * Each graph passes validateGraph (cards carry id/name/preset/prompt + layout;
 * edges chain them). Card ids are unique within the template; cloning into a new
 * workflow needs no re-id (ids only need to be unique within one graph).
 */

import type { WorkflowCard, WorkflowGraph } from "../../types";

export interface FlowTemplate {
  id: string;
  name: string;
  category: string;
  /** One-line gallery summary. */
  summary: string;
  graph: WorkflowGraph;
}

/** Card factory — fills the boilerplate so a template only states what matters. */
function card(
  id: string,
  x: number,
  partial: Pick<WorkflowCard, "name" | "preset" | "prompt"> & Partial<WorkflowCard>,
): WorkflowCard {
  return {
    id,
    schedule: null,
    backend: null,
    model: null,
    placed: true,
    unattended: false,
    tools: [],
    x,
    y: 0,
    ...partial,
  };
}

const chain = (ids: string[]) => ids.slice(1).map((to, i) => ({ from: ids[i], to }));

const RESEARCH_TOOLS = ["web_search", "web_fetch", "read_file", "list_dir", "search_files"];
const CODE_TOOLS = ["read_file", "list_dir", "search_files", "git_status", "git_diff", "git_log"];

export const FLOW_TEMPLATES: FlowTemplate[] = [
  {
    id: "deep-research",
    name: "Deep Research",
    category: "Research",
    summary: "Gather sources → cross-check → synthesize a cited brief. Beats one model guessing.",
    graph: {
      cards: [
        card("r1", 0, {
          name: "Gather",
          preset: "researcher",
          prompt:
            "Research the user's question. Use web_search + web_fetch (prefer JSON/API endpoints) to collect facts from multiple independent sources. Output the raw findings with each source URL.",
          tools: RESEARCH_TOOLS,
        }),
        card("r2", 320, {
          name: "Verify",
          preset: "skeptic",
          prompt:
            "You are given research findings. Cross-check the claims against the cited sources, flag anything unsupported or contradictory, and drop low-confidence items. Output the verified facts only.",
          tools: RESEARCH_TOOLS,
        }),
        card("r3", 640, {
          name: "Brief",
          preset: "summarizer",
          prompt:
            "Write a tight, well-structured brief from the verified facts. Lead with the answer, then supporting points, then a Sources list. No fluff.",
          tools: [],
        }),
      ],
      edges: chain(["r1", "r2", "r3"]),
    },
  },
  {
    id: "code-review",
    name: "Code Review",
    category: "Code",
    summary: "Read the diff → adversarial review → concrete fixes. A reviewer that doesn't rubber-stamp.",
    graph: {
      cards: [
        card("c1", 0, {
          name: "Read diff",
          preset: "coder",
          prompt:
            "Inspect the current repo state with git_status + git_diff (and read_file for context). Summarize what changed and why, file by file.",
          tools: CODE_TOOLS,
        }),
        card("c2", 320, {
          name: "Critique",
          preset: "skeptic",
          prompt:
            "Adversarially review the change for correctness bugs, edge cases, security issues, and missing tests. Be specific: file + line + why. Assume something is wrong until proven otherwise.",
          tools: CODE_TOOLS,
        }),
        card("c3", 640, {
          name: "Fixes",
          preset: "editor",
          prompt:
            "Turn the critique into a concrete, ordered fix list: for each issue, the exact change to make. Group by file. Skip anything that turned out to be a non-issue.",
          tools: ["read_file"],
        }),
      ],
      edges: chain(["c1", "c2", "c3"]),
    },
  },
  {
    id: "brainstorm-moa",
    name: "Brainstorm + refine",
    category: "Ideation",
    summary: "Pragmatic idea → ambitious counter → synthesis. Diverge, then converge.",
    graph: {
      cards: [
        card("b1", 0, {
          name: "Pragmatic",
          preset: "general",
          prompt:
            "Propose the most PRACTICAL approach to the user's goal — what ships fastest with least risk. Be concrete.",
          tools: [],
        }),
        card("b2", 320, {
          name: "Ambitious",
          preset: "general",
          prompt:
            "You're given a pragmatic proposal. Now propose a MORE AMBITIOUS alternative — ignore short-term cost, aim for the best possible outcome — and name what it buys over the pragmatic one.",
          tools: [],
        }),
        card("b3", 640, {
          name: "Synthesize",
          preset: "summarizer",
          prompt:
            "You're given a pragmatic proposal and an ambitious alternative. Merge their best ideas into one recommended plan, stating the trade-off you chose and why.",
          tools: [],
        }),
      ],
      edges: chain(["b1", "b2", "b3"]),
    },
  },
  {
    id: "summarize-folder",
    name: "Summarize a project",
    category: "Knowledge",
    summary: "Read a folder → distill what it does + how it's structured. Onboarding in one click.",
    graph: {
      cards: [
        card("s1", 0, {
          name: "Survey",
          preset: "researcher",
          prompt:
            "Survey the workspace: list_dir the top levels, read the README and key entry-point files, and search_files for the main modules. Output a factual map of the project.",
          tools: ["read_file", "list_dir", "search_files"],
        }),
        card("s2", 320, {
          name: "Explain",
          preset: "summarizer",
          prompt:
            "From the project map, write a clear overview: what it does, the main components, and how to get started. Aimed at a new contributor.",
          tools: [],
        }),
      ],
      edges: chain(["s1", "s2"]),
    },
  },
];

/** Deep-clone a template's graph for insertion into a new workflow. */
export function cloneTemplateGraph(t: FlowTemplate): WorkflowGraph {
  return JSON.parse(JSON.stringify(t.graph)) as WorkflowGraph;
}
