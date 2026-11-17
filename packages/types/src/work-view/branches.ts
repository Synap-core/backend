/**
 * jobBranches — a job's child jobs as BRANCHES (forks in its Activity), from
 * the work graph (`focusSessions.graph`, Hub `GET /focus-sessions/graph`;
 * api `services/focus-sessions/work-graph.ts`). Plan 5207fbb6, point of view
 * 3e47abde §2: a branch is a child job (`spawned_from`, child → parent) and
 * nothing else. A pull request or a `blocked_by` is a MARK on the job's line,
 * never a branch; the other edges (`updated`, `triggered`, `waits_on_output`)
 * draw nothing here.
 *
 * A FAILED READ IS NOT AN EMPTY ONE: the graph says per section whether its
 * read answered. A section that did not answer is listed in `unavailable`, so
 * a surface says "could not read the pull requests", never "no pull request".
 * A CUT READ IS NOT A WHOLE ONE: when the graph's window left sessions out
 * (`window.truncated`) or its far ends could not be read (`farEnds`), a fork's
 * "(+N)" may be low, so `partial` is true and a surface says "at least N".
 *
 * Pure. Order is the graph's node order (the pod's: open first), so two reads
 * of one graph draw the same tree.
 */

/** The fields of a graph node this reads (structural: `WorkGraphNode`). */
export interface BranchGraphNode {
  id: string;
  title?: string | null;
  goal?: string | null;
  status: string;
}

export interface BranchGraphEdge {
  kind: string;
  from: string;
  to: string;
}

export interface BranchGraphPullRequest {
  id: string;
  url: string;
  label: string;
  sessions: Array<{ sessionId: string; state: string }>;
}

export type BranchGraphSection =
  { status: "ok" } | { status: "unavailable"; reason: string };

/** The work graph as {@link jobBranches} reads it (structural: `WorkGraph`). */
export interface BranchGraph {
  nodes: readonly BranchGraphNode[];
  edges: readonly BranchGraphEdge[];
  pullRequests?: readonly BranchGraphPullRequest[];
  sections?: Partial<Record<GraphSection, BranchGraphSection>>;
  /** `WorkGraphWindow`: `truncated` = sessions were left out. */
  window?: { truncated: boolean };
}

type GraphSection = "blockedBy" | "pullRequests" | "farEnds";

/** A mark on a job's line. */
export type JobMark =
  | {
      kind: "pull_request";
      id: string;
      url: string;
      label: string;
      /** The outcome's own state on this job (`open`, `done`, …). */
      state: string;
    }
  | {
      kind: "blocked_by";
      /** The job this one waits on. */
      jobId: string;
      /** Its title when the graph carries the node; null when it does not. */
      title: string | null;
      status: string | null;
    };

export interface JobBranch {
  id: string;
  title: string | null;
  status: string;
  /** 0 at a root. */
  depth: number;
  /** Child jobs, in graph order: the forks. */
  branches: JobBranch[];
  /** Every job under it, at any depth: the "(+N)" of a folded fork. */
  descendants: number;
  marks: JobMark[];
}

export interface JobBranches {
  /** The roots asked for, or every job with no parent in the graph. */
  roots: JobBranch[];
  /** Sections whose read FAILED: their marks or jobs are missing, not absent. */
  unavailable: GraphSection[];
  /**
   * The graph is not whole (its window left sessions out, or its far ends
   * could not be read): `descendants` is a floor, never the count.
   */
  partial: boolean;
}

/**
 * child → parent, from the `spawned_from` edges. With `nodes`, only a parent
 * the graph carries (one the caller can see): a parent off the graph is no
 * parent, so the child is a root here as it is in {@link jobBranches}.
 */
function parentMap(
  graph: Pick<BranchGraph, "edges"> & { nodes?: BranchGraph["nodes"] }
): Map<string, string> {
  const seen = graph.nodes ? new Set(graph.nodes.map((n) => n.id)) : null;
  const up = new Map<string, string>();
  for (const e of graph.edges) {
    if (e.kind !== "spawned_from" || e.from === e.to || up.has(e.from))
      continue;
    if (seen && !seen.has(e.to)) continue;
    up.set(e.from, e.to);
  }
  return up;
}

/**
 * A job's parent job in the graph, or null at a root: the roll-up
 * `requestsOf` reads (`parentOf`). Pass the nodes too, so a job rolls up only
 * to a job the caller can see.
 */
export function parentOfGraph(
  graph: Pick<BranchGraph, "edges"> & { nodes?: BranchGraph["nodes"] }
): (jobId: string) => string | null {
  const up = parentMap(graph);
  return (jobId) => up.get(jobId) ?? null;
}

/**
 * The graph as a forest of jobs, each with its child jobs as branches and its
 * PRs and blockers as marks. `rootIds` narrows it to those jobs (a job page:
 * its own id); absent, every job with no parent in the graph is a root.
 */
export function jobBranches(
  graph: BranchGraph,
  rootIds?: readonly string[]
): JobBranches {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const up = parentMap(graph);
  const children = new Map<string, string[]>();
  for (const n of graph.nodes) {
    const parent = up.get(n.id);
    if (!parent) continue;
    const list = children.get(parent) ?? [];
    list.push(n.id);
    children.set(parent, list);
  }

  const marks = new Map<string, JobMark[]>();
  const mark = (id: string, m: JobMark) => {
    const list = marks.get(id) ?? [];
    list.push(m);
    marks.set(id, list);
  };
  for (const e of graph.edges) {
    if (e.kind !== "blocked_by") continue;
    const to = nodes.get(e.to);
    mark(e.from, {
      kind: "blocked_by",
      jobId: e.to,
      title: to ? (to.title ?? null) : null,
      status: to ? to.status : null,
    });
  }
  for (const pr of graph.pullRequests ?? []) {
    for (const s of pr.sessions) {
      mark(s.sessionId, {
        kind: "pull_request",
        id: pr.id,
        url: pr.url,
        label: pr.label,
        state: s.state,
      });
    }
  }

  const build = (id: string, depth: number, seen: Set<string>): JobBranch => {
    // Every id built is a node: a root is filtered to nodes, a child comes
    // from `graph.nodes`.
    const node = nodes.get(id)!;
    const next = new Set(seen).add(id);
    const branches = (children.get(id) ?? [])
      .filter((c) => !next.has(c))
      .map((c) => build(c, depth + 1, next));
    return {
      id,
      title: node.title ?? null,
      status: node.status,
      depth,
      branches,
      descendants: branches.reduce((n, b) => n + 1 + b.descendants, 0),
      marks: marks.get(id) ?? [],
    };
  };

  const roots = rootIds
    ? rootIds.filter((id) => nodes.has(id))
    : graph.nodes.filter((n) => !up.has(n.id)).map((n) => n.id);
  const unavailable = (
    ["blockedBy", "pullRequests", "farEnds"] as const
  ).filter((s) => graph.sections?.[s]?.status === "unavailable");
  return {
    roots: roots.map((id) => build(id, 0, new Set())),
    unavailable,
    partial:
      graph.window?.truncated === true || unavailable.includes("farEnds"),
  };
}
