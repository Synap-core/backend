/**
 * The approval rows of ONE tool, as its page, an agent's page and the
 * Approvals grid read them (decision b387ca45 D2, D3, D5; lane W3). Pure, so
 * every rule here is tested without a DOM. There is no store of its own: the
 * rows are `governanceRules.listAll`'s, the same read the Approvals list
 * makes, and every change goes through the governed doors
 * (`governanceRules.create` / `revoke`).
 *
 * WHICH ROWS NAME A TOOL. A `capability` row's `targetPattern` names:
 *   - one ACTION: its stable name (the verb id), or its skill row id (older
 *     rows, matched the same by the gate);
 *   - the whole TOOL: the container id (D3: "everyone × this tool"), or one
 *     of its member tool rows (a row 0435 made from a grant names the tool
 *     row the grant matched, which every action of that row runs under).
 * The gate ranks them (`scoreRuleTarget`, `resolveGovernanceRule`): principal
 * (an agent 2, a class 1, every AI 0) + place (a space 2, the pod 0) + target
 * (an action 3, the tool 2); on a tie the stricter verdict wins (never > asks
 * first > runs on its own). This file only GROUPS the rows that way, so the
 * page says what is stored; it never re-decides a run.
 *
 * "EVERYONE" is every AI on the whole pod (`principalKind: any`, scope pod).
 * Every other row on the tool (one agent, a class, a space) is an EXCEPTION.
 */

import {
  actionRunModeOf,
  type ActionRunMode,
  type GovernanceRuleRowLike,
} from "@synap-core/types/governance-rules";
import { resolveVerbStepLabel } from "@synap-core/types/vocabulary";

/** The fields of an approval row this file reads. */
export interface ToolRuleRow extends Pick<
  GovernanceRuleRowLike,
  | "principalKind"
  | "agentUserId"
  | "agentLabel"
  | "principalClass"
  | "scopeKind"
  | "targetKind"
  | "targetPattern"
  | "verdict"
> {
  id: string;
  workspaceId: string | null;
}

// ─── An action's name ───────────────────────────────────────────────────

/** A raw identifier: `apify_run_actor`, `gmail.send`, never a sentence. */
function looksLikeAnId(label: string): boolean {
  return !/\s/.test(label) && /[._:-]/.test(label);
}

/**
 * An action's name in words (finding 47ff4216): the name its tool declares
 * when it wrote one, else the vocabulary's words for its id
 * (`resolveVerbStepLabel`). Never the raw id: the catalog labels most actions
 * with their id (`capability-registry.ts`, `label: verbId`).
 */
export function verbDisplayName(verb: {
  verbId: string;
  label?: string | null;
}): string {
  const label = verb.label?.trim() ?? "";
  if (label && label !== verb.verbId && !looksLikeAnId(label)) return label;
  return resolveVerbStepLabel(verb.verbId);
}

// ─── One tool's rows ────────────────────────────────────────────────────

/** What a tool is made of, for matching rows (from the catalog and its composition). */
export interface ToolShape {
  /** The container (`capabilities.id`). */
  id: string;
  /** Its member tool rows: a row naming one covers every action. */
  memberToolIds: readonly string[];
  actions: ReadonlyArray<{ verbId: string; skillId: string | null }>;
}

/** Build a tool's shape from its catalog card and its composition's members. */
export function toolShapeOf(
  card: {
    id: string | null;
    verbs: ReadonlyArray<{ verbId: string; skillId: string | null }>;
  },
  members: ReadonlyArray<{ kind: string; id: string }> | null | undefined
): ToolShape | null {
  if (!card.id) return null;
  return {
    id: card.id,
    memberToolIds: (members ?? [])
      .filter((m) => m.kind === "tool")
      .map((m) => m.id),
    actions: card.verbs.map((v) => ({ verbId: v.verbId, skillId: v.skillId })),
  };
}

export type ToolRowLevel =
  { level: "tool" } | { level: "action"; verbId: string };

/** Does this row name this tool, and at which level? null = it does not. */
export function toolRowLevel(
  row: Pick<ToolRuleRow, "targetKind" | "targetPattern">,
  tool: ToolShape
): ToolRowLevel | null {
  if (row.targetKind !== "capability") return null;
  const p = row.targetPattern;
  if (p === tool.id || tool.memberToolIds.includes(p)) return { level: "tool" };
  const action = tool.actions.find(
    (a) => a.verbId === p || (a.skillId !== null && a.skillId === p)
  );
  return action ? { level: "action", verbId: action.verbId } : null;
}

/** Every AI, the whole pod: the row a tool page's "everyone" control holds. */
export function isEveryoneRow(
  row: Pick<ToolRuleRow, "principalKind" | "scopeKind">
): boolean {
  return row.principalKind === "any" && row.scopeKind === "pod";
}

/** The gate's tie rule for a tool run: never > asks first > runs on its own. */
function strictness(verdict: ToolRuleRow["verdict"]): number {
  return verdict === "deny" ? 2 : verdict === "propose" ? 1 : 0;
}

/**
 * Of rows at the SAME rank, the one that decides: the stricter verdict, as
 * the gate breaks a tie (`verdictStrictness`, resolve-agent-governance-
 * decision.ts). undefined when there is none.
 */
export function decidingRow<R extends Pick<ToolRuleRow, "verdict">>(
  rows: readonly R[]
): R | undefined {
  let best: R | undefined;
  for (const r of rows)
    if (!best || strictness(r.verdict) > strictness(best.verdict)) best = r;
  return best;
}

export interface LevelRows<R> {
  /** Every AI × the whole pod at this level (usually one; more is a tie). */
  everyone: R[];
  /** One agent, a class of agents, or one space. */
  exceptions: R[];
}

export interface ToolApprovals<R> {
  tool: LevelRows<R>;
  /** Keyed by the action's verb id; every action of the tool has an entry. */
  actions: Record<string, LevelRows<R>>;
  /** How many rows name this tool at all. */
  count: number;
}

/** The rows that name this tool, grouped: the whole tool, then each action. */
export function toolApprovals<R extends ToolRuleRow>(
  rows: readonly R[],
  tool: ToolShape
): ToolApprovals<R> {
  const empty = (): LevelRows<R> => ({ everyone: [], exceptions: [] });
  const out: ToolApprovals<R> = {
    tool: empty(),
    actions: Object.fromEntries(tool.actions.map((a) => [a.verbId, empty()])),
    count: 0,
  };
  for (const row of rows) {
    const level = toolRowLevel(row, tool);
    if (!level) continue;
    out.count += 1;
    const bucket =
      level.level === "tool"
        ? out.tool
        : (out.actions[level.verbId] ??= empty());
    (isEveryoneRow(row) ? bucket.everyone : bucket.exceptions).push(row);
  }
  return out;
}

// ─── "Every AI" on one action, or the whole tool ────────────────────────

/** What the everyone control shows: a stored mode, or the tool's (an action only). */
export type EveryoneValue = ActionRunMode | "tool";

export interface EveryoneState {
  /** The control's value. */
  value: EveryoneValue;
  /** The mode it comes to, for every AI on the pod with no exception. */
  mode: ActionRunMode;
  /**
   * Where the mode comes from: a row on this action, the row on the whole
   * tool, or no row at all (a tool run asks first by default).
   */
  from: "action" | "tool" | "default";
}

/** The whole tool's everyone mode: its row, or none (asks first). */
export function toolEveryoneState(
  approvals: Pick<ToolApprovals<ToolRuleRow>, "tool">
): EveryoneState {
  const row = decidingRow(approvals.tool.everyone);
  return row
    ? {
        value: actionRunModeOf(row.verdict),
        mode: actionRunModeOf(row.verdict),
        from: "tool",
      }
    : { value: "ask", mode: "ask", from: "default" };
}

/**
 * One action's everyone mode: a row naming the action outranks the row on
 * the whole tool (3 > 2), which outranks nothing (asks first).
 */
export function actionEveryoneState(
  approvals: ToolApprovals<ToolRuleRow>,
  verbId: string
): EveryoneState {
  const own = decidingRow(approvals.actions[verbId]?.everyone ?? []);
  if (own) {
    const mode = actionRunModeOf(own.verdict);
    return { value: mode, mode, from: "action" };
  }
  const tool = decidingRow(approvals.tool.everyone);
  if (tool)
    return { value: "tool", mode: actionRunModeOf(tool.verdict), from: "tool" };
  return { value: "ask", mode: "ask", from: "default" };
}

// ─── Changing it: which rows to write and take back ─────────────────────

/** The `governanceRules.create` input for an everyone row (without its proof). */
export interface EveryoneDraft {
  principalKind: "any";
  scopeKind: "pod";
  targetKind: "capability";
  targetPattern: string;
  verdict: "auto" | "propose" | "deny";
}

export interface EveryoneChange {
  /** Written FIRST: while both stand, the stricter one decides (a tie). */
  create: EveryoneDraft | null;
  /** Taken back after. */
  revoke: string[];
}

const VERDICT_OF: Record<ActionRunMode, EveryoneDraft["verdict"]> = {
  auto: "auto",
  ask: "propose",
  never: "deny",
};

/**
 * The rows to write and take back so every AI's mode at one level becomes
 * `next`. Written before taken back, so in between the stricter row decides
 * (the gate's tie rule) and a run is never looser than either setting.
 *
 *   - "tool" (an action only): no row on the action; it follows the tool.
 *   - "ask" with nothing broader to override (the whole tool, or an action
 *     whose tool has no row or asks first): no row, the gate's default.
 *   - "ask" on an action whose tool runs on its own or never: an explicit
 *     asks-first row on the action, which outranks the tool's.
 *   - "auto" / "never": one row with that verdict.
 * Nothing changes (`null`) when the stored rows already say it.
 */
export function planEveryoneChange(input: {
  /** The pattern a new row names: the container id, or the action's verb id. */
  pattern: string;
  level: "tool" | "action";
  /** The everyone rows stored at this level now. */
  current: readonly Pick<ToolRuleRow, "id" | "verdict" | "targetPattern">[];
  /** The tool's own everyone mode (for an action), or null for the tool level. */
  toolMode: ActionRunMode | null;
  next: EveryoneValue;
}): EveryoneChange | null {
  const { pattern, level, current, toolMode, next } = input;
  let verdict: EveryoneDraft["verdict"] | null;
  if (next === "tool") verdict = null;
  else if (next === "ask")
    verdict =
      level === "action" && toolMode !== null && toolMode !== "ask"
        ? "propose"
        : null;
  else verdict = VERDICT_OF[next];

  const keep =
    verdict === null
      ? undefined
      : current.find(
          (r) => r.verdict === verdict && r.targetPattern === pattern
        );
  const revoke = current.filter((r) => r !== keep).map((r) => r.id);
  const create =
    verdict !== null && !keep
      ? {
          principalKind: "any" as const,
          scopeKind: "pod" as const,
          targetKind: "capability" as const,
          targetPattern: pattern,
          verdict,
        }
      : null;
  if (!create && revoke.length === 0) return null;
  return { create, revoke };
}

// ─── Which tool a row names (an agent's page, the grid) ─────────────────

export interface ToolIndexEntry {
  id: string;
  name: string;
  /** The action the pattern names, null when it names the whole tool. */
  verbId: string | null;
}

/**
 * Pattern → the tool it belongs to, from the catalog cards (and the
 * compositions' member tool rows). A pattern no tool holds is left out:
 * its row is still listed, by its words, with no door to a tool.
 */
export function toolIndex(
  cards: ReadonlyArray<{
    id: string | null;
    name: string;
    verbs: ReadonlyArray<{ verbId: string; skillId: string | null }>;
  }>,
  members?: ReadonlyArray<{
    id: string;
    members: ReadonlyArray<{ kind: string; id: string }>;
  }> | null
): Map<string, ToolIndexEntry> {
  const out = new Map<string, ToolIndexEntry>();
  const nameOf = new Map<string, string>();
  for (const card of cards) {
    if (!card.id) continue;
    nameOf.set(card.id, card.name);
    out.set(card.id, { id: card.id, name: card.name, verbId: null });
    for (const v of card.verbs) {
      const entry = { id: card.id, name: card.name, verbId: v.verbId };
      if (!out.has(v.verbId)) out.set(v.verbId, entry);
      if (v.skillId && !out.has(v.skillId)) out.set(v.skillId, entry);
    }
  }
  for (const comp of members ?? []) {
    const name = nameOf.get(comp.id);
    if (!name) continue;
    for (const m of comp.members)
      if (m.kind === "tool" && !out.has(m.id))
        out.set(m.id, { id: comp.id, name, verbId: null });
  }
  return out;
}

// ─── An agent's own rows ────────────────────────────────────────────────

/** The author prefixes whose rows an agent's page shows elsewhere (approvals-model). */
const POSTURE_PREFIX = "system:settings-mirror:";
const HOST_SEED_PREFIX = "system:host-seed:";

/**
 * The approvals that name this agent, as its page lists them: every row for
 * it alone, newest first, except the rows its posture writes (the posture
 * control above them is how they change) and the copies seeded on its
 * computer (each goes with the approval it copies, which is listed).
 */
export function agentOwnRows<
  R extends ToolRuleRow & { createdBy?: string | null },
>(rows: readonly R[], agentUserId: string): R[] {
  return rows.filter(
    (r) =>
      r.principalKind === "agent" &&
      r.agentUserId === agentUserId &&
      !(r.createdBy ?? "").startsWith(POSTURE_PREFIX) &&
      !(r.createdBy ?? "").startsWith(HOST_SEED_PREFIX)
  );
}

// ─── The agents × tools grid ────────────────────────────────────────────

/** A grid row: every AI, a class of agents, or one agent. */
export interface GridPrincipal {
  /** The Approvals list's agent filter value (`approvalAgentKey`). */
  key: string;
  kind: "any" | "class" | "agent";
  agentUserId: string | null;
  sample: ToolRuleRow;
}

export interface GridTool {
  /** The container id, or the raw pattern when no tool holds it. */
  key: string;
  /** Known tool: its id (a door to its page). */
  toolId: string | null;
  name: string | null;
  pattern: string;
}

export type GridMark = ActionRunMode | "mixed";

export interface GridCell {
  /** The modes of the rows in this cell, or null when it has none. */
  mark: GridMark | null;
  count: number;
}

export interface ToolsGrid {
  principals: GridPrincipal[];
  tools: GridTool[];
  /** `${principal.key}|${tool.key}` → its cell. */
  cells: Map<string, GridCell>;
}

export const gridCellKey = (principal: string, tool: string) =>
  `${principal}|${tool}`;

function principalKeyOf(row: ToolRuleRow): string {
  if (row.principalKind === "any") return "any";
  if (row.principalKind === "class")
    return `class:${row.principalClass ?? "unknown"}`;
  return row.agentUserId ?? "unknown";
}

/**
 * Every capability row placed in its (who, tool) cell. Rows: every AI first,
 * then classes, then agents, each in the order its first row was seen (the
 * list is newest first). Columns: the tools those rows name, in the same
 * order. A cell holds every row of that who on that tool, at either level
 * and in any place: one mode, or "mixed" when its rows differ.
 */
export function toolsGrid(
  rows: readonly ToolRuleRow[],
  index: Map<string, ToolIndexEntry>
): ToolsGrid {
  const principals = new Map<string, GridPrincipal>();
  const tools = new Map<string, GridTool>();
  const modes = new Map<string, { set: Set<ActionRunMode>; count: number }>();
  for (const row of rows) {
    if (row.targetKind !== "capability") continue;
    const pKey = principalKeyOf(row);
    if (!principals.has(pKey))
      principals.set(pKey, {
        key: pKey,
        kind: row.principalKind,
        agentUserId: row.principalKind === "agent" ? row.agentUserId : null,
        sample: row,
      });
    const hit = index.get(row.targetPattern);
    const tKey = hit ? hit.id : row.targetPattern;
    if (!tools.has(tKey))
      tools.set(tKey, {
        key: tKey,
        toolId: hit?.id ?? null,
        name: hit?.name ?? null,
        pattern: row.targetPattern,
      });
    const cKey = gridCellKey(pKey, tKey);
    const cell = modes.get(cKey) ?? { set: new Set(), count: 0 };
    cell.set.add(actionRunModeOf(row.verdict));
    cell.count += 1;
    modes.set(cKey, cell);
  }
  const order = { any: 0, class: 1, agent: 2 } as const;
  const cells = new Map<string, GridCell>();
  for (const [k, v] of modes)
    cells.set(k, {
      mark: v.set.size === 1 ? [...v.set][0]! : "mixed",
      count: v.count,
    });
  return {
    principals: [...principals.values()].sort(
      (a, b) => order[a.kind] - order[b.kind]
    ),
    tools: [...tools.values()],
    cells,
  };
}
