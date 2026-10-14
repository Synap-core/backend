/**
 * Pure view-model for Governance › Agents & work — the agent × work matrix
 * (`governanceRules.matrix`, contract `@synap-core/types/agent-matrix`).
 *
 * Framework-free on purpose (no React / HeroUI / trpc): the grouping, the
 * keyboard model, the mark → words mapping and the widen routing are the
 * decisions worth testing, so they live here and the components only draw.
 *
 * Words come from the vocabulary door (`@synap-core/types/vocabulary`); the
 * only copy here is sentence-level (aria labels, button text).
 */

import {
  MATRIX_MARKS,
  MATRIX_VERDICTS,
  canWidenAnswer,
  type AgentMatrix,
  type MatrixAgentRow,
  type MatrixCell,
  type MatrixColumn,
  type MatrixMark,
  type MatrixProbe,
  type MatrixProbeAnswer,
} from "@synap-core/types/agent-matrix";
import type { NextRungOutcome } from "@synap-core/types/trust-ladder";
import {
  buildObjectActionTitle,
  resolveMatrixMarkLabel,
} from "@synap-core/types/vocabulary";

// ─── Marks ──────────────────────────────────────────────────────────────────

export interface MarkView {
  glyph: string;
  tone: (typeof MATRIX_MARKS)[MatrixMark]["tone"];
  /** The mark's words ("Acts", "Mixed"). */
  label: string;
  /** The split in words, only when it is mixed ("2 acts, 1 asks first"). */
  splitWords: string | null;
}

export function markView(cell: Pick<MatrixCell, "mark" | "split">): MarkView {
  return {
    glyph: MATRIX_MARKS[cell.mark].glyph,
    tone: MATRIX_MARKS[cell.mark].tone,
    label: resolveMatrixMarkLabel(cell.mark),
    splitWords:
      cell.mark === "mixed"
        ? MATRIX_VERDICTS.filter((v) => cell.split[v] > 0)
            .map((v) => `${cell.split[v]} ${resolveMatrixMarkLabel(v).toLowerCase()}`)
            .join(", ")
        : null,
  };
}

/** A column's name with its space, for a screen reader and the drawer. */
export function columnTitle(column: MatrixColumn): string {
  return column.workspaceName
    ? `${column.label} (${column.workspaceName})`
    : column.label;
}

/** What a screen reader hears for one cell — the mark's whole answer. */
export function cellAriaLabel(
  rowLabel: string,
  column: MatrixColumn,
  cell: MatrixCell
): string {
  const m = markView(cell);
  const what = m.splitWords ? `${m.label}: ${m.splitWords}` : m.label;
  const locked = column.kind === "floors" ? ", locked platform limit" : "";
  return `${rowLabel}, ${columnTitle(column)}: ${what}${locked}`;
}

// ─── Columns grouped under their space ──────────────────────────────────────

export interface ColumnGroup {
  key: string;
  /** The space's name; `null` for the pod-wide floors. */
  label: string | null;
  columns: MatrixColumn[];
}

/** Consecutive columns of one space share one header (the reader orders them). */
export function columnGroups(columns: readonly MatrixColumn[]): ColumnGroup[] {
  const groups: ColumnGroup[] = [];
  for (const column of columns) {
    const key = column.workspaceId ?? "pod";
    const last = groups.at(-1);
    if (last && last.key === key) last.columns.push(column);
    else groups.push({ key, label: column.workspaceName, columns: [column] });
  }
  return groups;
}

// ─── Rows: type → computer → agent ──────────────────────────────────────────

/** How many type groups render before "Show all". */
export const TYPE_GROUP_CAP = 12;
/** At or below this many agents, every group opens expanded. */
export const EXPAND_ALL_AT_OR_BELOW = 20;

export type MatrixRowKind = "type" | "computer" | "agent";

export interface MatrixRow {
  key: string;
  kind: MatrixRowKind;
  /** 1 = type, 2 = computer, 2 or 3 = agent (an agent on no computer sits under its type). */
  level: number;
  label: string;
  cells: Record<string, MatrixCell>;
  /** Groups only: how many agents it holds. */
  memberCount: number;
  /** Groups only. */
  expanded: boolean;
  agent: MatrixAgentRow | null;
  /** Groups only: the agents it holds (for the group's why-drawer). */
  members: MatrixAgentRow[];
}

const typeKey = (agentType: string) => `type:${agentType}`;
const computerKey = (agentType: string, hostUserId: string | null) =>
  `computer:${agentType}:${hostUserId ?? "none"}`;

function everyGroupKey(matrix: AgentMatrix): Set<string> {
  const keys = new Set<string>();
  for (const g of matrix.groups) {
    keys.add(typeKey(g.agentType));
    for (const c of g.computers) keys.add(computerKey(g.agentType, c.hostUserId));
  }
  return keys;
}

/** A small pod opens with every group expanded; a big one collapsed. */
export function defaultExpanded(matrix: AgentMatrix): Set<string> {
  const agents = matrix.groups.reduce(
    (n, g) => n + g.computers.reduce((m, c) => m + c.agents.length, 0),
    0
  );
  return agents > EXPAND_ALL_AT_OR_BELOW ? new Set() : everyGroupKey(matrix);
}

/**
 * The visible rows, in order. A computer row exists only for a real computer:
 * agents on no computer sit directly under their type (a "No computer" level
 * would be a heading over nothing to act on). Past {@link TYPE_GROUP_CAP} type
 * groups the rest are hidden until "Show all".
 */
export function visibleRows(
  matrix: AgentMatrix,
  expanded: ReadonlySet<string>,
  showAll: boolean
): { rows: MatrixRow[]; hiddenTypeGroups: number } {
  const groups = showAll ? matrix.groups : matrix.groups.slice(0, TYPE_GROUP_CAP);
  const rows: MatrixRow[] = [];
  const agentRow = (a: MatrixAgentRow, level: number): MatrixRow => ({
    key: agentRowKey(a.agentUserId),
    kind: "agent",
    level,
    label: a.name,
    cells: a.cells,
    memberCount: 0,
    expanded: false,
    agent: a,
    members: [],
  });
  for (const g of groups) {
    const members = g.computers.flatMap((c) => c.agents);
    const tKey = typeKey(g.agentType);
    const tOpen = expanded.has(tKey);
    rows.push({
      key: tKey,
      kind: "type",
      level: 1,
      label: g.agentType,
      cells: g.cells,
      memberCount: members.length,
      expanded: tOpen,
      agent: null,
      members,
    });
    if (!tOpen) continue;
    for (const c of g.computers) {
      if (c.hostUserId === null) {
        for (const a of c.agents) rows.push(agentRow(a, 2));
        continue;
      }
      const cKey = computerKey(g.agentType, c.hostUserId);
      const cOpen = expanded.has(cKey);
      rows.push({
        key: cKey,
        kind: "computer",
        level: 2,
        label: c.label,
        cells: c.cells,
        memberCount: c.agents.length,
        expanded: cOpen,
        agent: null,
        members: c.agents,
      });
      if (cOpen) for (const a of c.agents) rows.push(agentRow(a, 3));
    }
  }
  return { rows, hiddenTypeGroups: matrix.groups.length - groups.length };
}

/**
 * A row by key from the CURRENT read, whether or not it is visible — the
 * why-drawer holds a key, so a refetch after Widen / Revoke redraws it fresh.
 */
export function findRow(matrix: AgentMatrix, key: string): MatrixRow | null {
  return (
    visibleRows(matrix, everyGroupKey(matrix), true).rows.find((r) => r.key === key) ??
    null
  );
}

export const agentRowKey = (agentUserId: string) => `agent:${agentUserId}`;

export function toggleExpanded(
  expanded: ReadonlySet<string>,
  key: string
): Set<string> {
  const next = new Set(expanded);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

// ─── Keyboard model (role="grid") ───────────────────────────────────────────

/** Column 0 is the row header; 1..n are the matrix columns. */
export interface GridPos {
  row: number;
  col: number;
}

export type GridAction =
  | { type: "move"; to: GridPos }
  | { type: "why"; at: GridPos }
  | { type: "toggle"; at: GridPos }
  | null;

/**
 * One key on the grid → what it does. Arrows move (clamped), Home / End go to
 * the row's ends (with Ctrl/Meta: the grid's corners). Enter opens the WHY of a
 * cell (on a group's header it expands, like Space). Space expands / collapses
 * a group row from any of its cells.
 */
export function gridKeyAction(
  key: string,
  pos: GridPos,
  size: { rows: number; cols: number },
  rowIsGroup: boolean,
  mod = false
): GridAction {
  const clamp = (p: GridPos): GridPos => ({
    row: Math.max(0, Math.min(size.rows - 1, p.row)),
    col: Math.max(0, Math.min(size.cols - 1, p.col)),
  });
  switch (key) {
    case "ArrowUp":
      return { type: "move", to: clamp({ ...pos, row: pos.row - 1 }) };
    case "ArrowDown":
      return { type: "move", to: clamp({ ...pos, row: pos.row + 1 }) };
    case "ArrowLeft":
      return { type: "move", to: clamp({ ...pos, col: pos.col - 1 }) };
    case "ArrowRight":
      return { type: "move", to: clamp({ ...pos, col: pos.col + 1 }) };
    case "Home":
      return { type: "move", to: clamp(mod ? { row: 0, col: 0 } : { ...pos, col: 0 }) };
    case "End":
      return {
        type: "move",
        to: clamp(mod ? { row: size.rows - 1, col: size.cols - 1 } : { ...pos, col: size.cols - 1 }),
      };
    case " ":
    case "Spacebar":
      return rowIsGroup ? { type: "toggle", at: pos } : null;
    case "Enter":
      if (pos.col === 0) return rowIsGroup ? { type: "toggle", at: pos } : null;
      return { type: "why", at: pos };
    default:
      return null;
  }
}

// ─── WHY: the per-probe answers and the one primary action ──────────────────

export interface ProbeView {
  probe: MatrixProbe;
  answer: MatrixProbeAnswer;
  /** "Create note", "Delete workspace" — the write it tested, in words. */
  title: string;
  widenable: boolean;
}

export function probeViews(column: MatrixColumn, cell: MatrixCell): ProbeView[] {
  const byKey = new Map((cell.answers ?? []).map((a) => [a.probeKey, a]));
  const out: ProbeView[] = [];
  for (const probe of column.probes) {
    const answer = byKey.get(probe.key);
    if (!answer) continue;
    const dot = probe.action.indexOf(".");
    out.push({
      probe,
      answer,
      title: buildObjectActionTitle({
        action: probe.action.slice(dot + 1),
        objectKind: probe.profileSlug ?? probe.action.slice(0, dot),
      }),
      // The floors column is locked: nothing there is ever offered.
      widenable: column.kind !== "floors" && canWidenAnswer(answer, probe),
    });
  }
  return out;
}

export type WidenRoute = "rule" | "owner";

export interface WidenPlan {
  /** A rule now (you own the agent) or a proposal to its owner (decision 8). */
  route: WidenRoute;
  label: string;
  probes: MatrixProbe[];
}

/**
 * The drawer's ONE primary action, or `null` when nothing in the cell can be
 * widened. Routing is the server's call (`governanceRules.widenCell`); this
 * only says it before the click, from `ownedByViewer`.
 */
export function widenPlan(
  agent: Pick<MatrixAgentRow, "ownedByViewer">,
  probes: readonly ProbeView[]
): WidenPlan | null {
  const targets = probes.filter((p) => p.widenable).map((p) => p.probe);
  if (targets.length === 0) return null;
  return agent.ownedByViewer
    ? { route: "rule", label: "Widen", probes: targets }
    : { route: "owner", label: "Ask the owner to widen", probes: targets };
}

/** The rules that decided this cell's probes — each one may be revoked. */
export function decidingRuleIds(probes: readonly ProbeView[]): string[] {
  return [
    ...new Set(
      probes.flatMap((p) => (p.answer.ruleId ? [p.answer.ruleId] : []))
    ),
  ];
}

/**
 * Several probes widened at once read as ONE mark: a failure wins (say it),
 * then the strongest thing that happened — a rule added, then a request sent,
 * then "already a rule". `null` when nothing ran.
 */
export function combineWidenOutcomes(
  outcomes: ReadonlyArray<NextRungOutcome | "failed">
): NextRungOutcome | "failed" | null {
  const order: Array<NextRungOutcome | "failed"> = [
    "failed",
    "created",
    "proposed",
    "needs_admin",
    "already_covered",
  ];
  return order.find((o) => outcomes.includes(o)) ?? null;
}

/** The rule's door: the space's Governance tab lists it with Revoke. */
export function ruleHref(workspaceId: string | null): string | null {
  return workspaceId ? `/workspaces/${workspaceId}?tab=governance` : null;
}

// ─── Page state ─────────────────────────────────────────────────────────────

export type MatrixState = "loading" | "failed" | "no-agents" | "ready";

/** A failed read is never an empty matrix. */
export function matrixState(q: {
  isLoading: boolean;
  isError: boolean;
  data: AgentMatrix | undefined;
}): MatrixState {
  if (q.isError) return "failed";
  if (q.isLoading || !q.data) return "loading";
  return q.data.groups.length === 0 ? "no-agents" : "ready";
}

/** No space has a process yet — the grid still shows Other work + floors. */
export function hasNoProcesses(matrix: AgentMatrix): boolean {
  return !matrix.columns.some((c) => c.kind === "process");
}
