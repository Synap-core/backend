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

import { PROFILED_SUBJECTS } from "../trust-ladder/index.js";
import type { UnitTone } from "../units/state.js";

/** What one probe would do: act, ask a person, or not at all. */
export type MatrixVerdict = "auto" | "ask" | "off";
/** A cell's mark: one verdict, or `mixed` when its probes / members disagree. */
export type MatrixMark = MatrixVerdict | "mixed";

export const MATRIX_VERDICTS = [
  "auto",
  "ask",
  "off",
] as const satisfies ReadonlyArray<MatrixVerdict>;

/**
 * Each mark as a MARK (ui-composition §1) — the glyph the founder chose and a
 * tone token (`@synap-core/types/units`), the same on every surface that draws
 * the matrix. The words are the vocabulary's (`resolveMatrixMarkLabel`), never
 * here. Keyed by `MatrixMark`: a new mark stops the build until it has one.
 */
export const MATRIX_MARKS = {
  auto: { glyph: "✓", tone: "success" },
  ask: { glyph: "?", tone: "warning" },
  off: { glyph: "—", tone: "textMuted" },
  mixed: { glyph: "◐", tone: "info" },
} as const satisfies Record<MatrixMark, { glyph: string; tone: UnitTone }>;

/** The resolver's outcome → the matrix verdict (one mapping). */
export function matrixVerdictOf(
  outcome: "auto" | "propose" | "deny"
): MatrixVerdict {
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

/**
 * Every rung token the dry-run names as "what decided"
 * (`dryRunAgentGovernanceDecision`, `@synap/database`). The vocabulary keys
 * its words by this list, so a new rung is a BUILD error there until it is
 * named; a tripwire in `@synap/api` derives the producer's literals and fails
 * when one is missing here.
 */
export const GOVERNANCE_RUNGS = [
  "governance-rule",
  "default-auto-approve",
  "workspace-auto-approve-for",
  "default",
  "not-agent",
  "cbac-capability-allowlist",
  "admin-actions",
  "force-propose",
  "project-filing",
  "criteria-change",
  "possible-duplicate",
  "pod-admin-schema-change",
  "agent-schema-definition",
  "agent-structure-write",
  "destructive-actions-hard-floor",
  "user-observation-inference",
  "per-capability-governance",
  "agent-owned-workspace-destructive",
  "writes-require-proposal",
  "per-channel-capability-gate",
  "untrusted-origin",
  "daily-write-ceiling",
  "human-gate",
  "arbitrary-execution",
  "human-only-status",
  "lifecycle-terminal",
] as const;
export type GovernanceRung = (typeof GOVERNANCE_RUNGS)[number];

/**
 * The rungs a new `auto` rule can change: those decided BELOW the rules store
 * (rung 2.8 of `decideAgentPolicy` — 2.85 closing a thing, which a rule naming
 * the exact write may widen; 5 "writes require proposal"; 9 the ask-first
 * default). Everything above it (the floors, an untrusted source,
 * the daily limit, kind / tool / channel gates) no rule reaches, so the
 * why-drawer names the reason instead of offering Widen. A `propose` RULE is
 * not here either: the person revokes it, never stacks an `auto` rule on it.
 */
export const RULE_WIDENABLE_RUNGS = [
  "default",
  "writes-require-proposal",
  "lifecycle-terminal",
] as const satisfies ReadonlyArray<GovernanceRung>;

/**
 * May this probe's answer be widened by a rule? It asks today, a rule can
 * reach the rung that decided, and — like the trust ladder — an entity write
 * names its kind (a rule without one would cover every kind). The SERVER
 * re-asks the resolver and also refuses floors and irreversible writes
 * (`governanceRules.widenCell`); this only decides whether to offer.
 */
export function canWidenAnswer(
  answer: Pick<MatrixProbeAnswer, "verdict" | "rung">,
  probe: Pick<MatrixProbe, "action" | "profileSlug">
): boolean {
  if (answer.verdict !== "ask") return false;
  if (!(RULE_WIDENABLE_RUNGS as readonly string[]).includes(answer.rung))
    return false;
  const subject = probe.action.slice(0, probe.action.indexOf("."));
  return !PROFILED_SUBJECTS.includes(subject) || !!probe.profileSlug;
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
  /**
   * The reader owns this agent. Widening an agent you own writes the rule;
   * widening anyone else's files a proposal to its owner (founder decision 8,
   * 2026-10-14), so a surface says which before the click.
   */
  ownedByViewer: boolean;
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
