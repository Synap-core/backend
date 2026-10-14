/**
 * THE AGENT × WORK MATRIX — the contract of `governance.matrix` (agent routing
 * W2) and the pure rules every surface draws it with.
 *
 * Rows: agents, grouped type → computer → agent. Columns: per space, one per
 * PROCESS (a playbook that works a kind's lifecycle — founder decision
 * 2026-10-14: one column per process), one "Other work" per space, and one
 * locked "Floors" column of platform limits no rule can widen. A cell is what
 * the agent's write WOULD do there, answered by the ONE resolver
 * (`dryRunAgentGovernanceDecision`), for each of the column's probes.
 *
 * Marks (founder decisions 2026-10-14): ✓ auto · ? ask · — off (no grant and
 * capability-denied share ONE mark; the why-drawer names which) · ◐ mixed
 * with its split. A collapsed group never shows one member's verdict.
 *
 * Pure + zero-dep — safe in browser, Electron, React Native, Node and CLI.
 */

/** What one probe would do: act, ask a person, or not at all. */
export type MatrixVerdict = "auto" | "ask" | "off";
/** A cell's mark: one verdict, or `mixed` when its probes / members disagree. */
export type MatrixMark = MatrixVerdict | "mixed";

export const MATRIX_VERDICTS = ["auto", "ask", "off"] as const satisfies ReadonlyArray<MatrixVerdict>;

/** The resolver's outcome → the matrix verdict (one mapping). */
export function matrixVerdictOf(outcome: "auto" | "propose" | "deny"): MatrixVerdict {
  return outcome === "auto" ? "auto" : outcome === "propose" ? "ask" : "off";
}

/** The bounds of one read. Past them the answer says `partial`, never truncates silently. */
export const AGENT_MATRIX_LIMITS = {
  agents: 200,
  columns: 30,
  probesPerColumn: 4,
} as const;

export type MatrixLens = "pod" | "mine";

/** One representative write a column tests. */
export interface MatrixProbe {
  key: string;
  /** The governance event key (`entity.update`, `entity.transition`…). */
  action: string;
  /** The kind the probe writes, when it is about one. */
  profileSlug: string | null;
}

export type MatrixColumnKind = "process" | "other" | "floors";

export interface MatrixColumn {
  id: string;
  kind: MatrixColumnKind;
  label: string;
  /** The space it sits in (`null` = pod-wide: the floors column). */
  workspaceId: string | null;
  workspaceName: string | null;
  /** A process column's playbook. */
  playbookId: string | null;
  probes: MatrixProbe[];
}

/** One probe's answer — what the why-drawer reads. */
export interface MatrixProbeAnswer {
  probeKey: string;
  verdict: MatrixVerdict;
  /** The ladder rung that decided (`rung_2_8`…) and its reason token. */
  rung: string;
  reason: string;
  /** The rule that decided, when one did. */
  ruleId: string | null;
}

export interface MatrixSplit {
  auto: number;
  ask: number;
  off: number;
}

export interface MatrixCell {
  mark: MatrixMark;
  split: MatrixSplit;
  /** Per-probe answers (an agent row only; a group row carries the split). */
  answers?: MatrixProbeAnswer[];
}

export interface MatrixAgentRow {
  agentUserId: string;
  name: string;
  agentType: string | null;
  hostUserId: string | null;
  paused: boolean;
  cells: Record<string, MatrixCell>;
}

export interface MatrixComputerGroup {
  /** The computer agent's id, or `null` for agents on no computer. */
  hostUserId: string | null;
  label: string;
  cells: Record<string, MatrixCell>;
  agents: MatrixAgentRow[];
}

export interface MatrixTypeGroup {
  agentType: string;
  cells: Record<string, MatrixCell>;
  computers: MatrixComputerGroup[];
}

export interface AgentMatrix {
  lens: MatrixLens;
  columns: MatrixColumn[];
  groups: MatrixTypeGroup[];
  /** Set when a bound was hit — the person sees what was left out. */
  partial: null | { agentsOmitted: number; columnsOmitted: number };
}

const emptySplit = (): MatrixSplit => ({ auto: 0, ask: 0, off: 0 });

/** A split's mark: one verdict when all agree, `mixed` otherwise. */
export function markOfSplit(split: MatrixSplit): MatrixMark {
  const present = MATRIX_VERDICTS.filter((v) => split[v] > 0);
  if (present.length === 1) return present[0]!;
  return present.length === 0 ? "off" : "mixed";
}

/** An agent's cell from its probes' verdicts. */
export function cellOfAnswers(answers: MatrixProbeAnswer[]): MatrixCell {
  const split = emptySplit();
  for (const a of answers) split[a.verdict] += 1;
  return { mark: markOfSplit(split), split, answers };
}

/**
 * A group's cell: the members' cells summed — a collapsed row shows the split,
 * never one member's verdict (founder decision 2026-10-14: ◐ + split).
 */
export function collapseCells(cells: readonly MatrixCell[]): MatrixCell {
  const split = emptySplit();
  for (const c of cells) {
    for (const v of MATRIX_VERDICTS) split[v] += c.split[v];
  }
  return { mark: markOfSplit(split), split };
}
