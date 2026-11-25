/**
 * The Approvals page's rules (decision b387ca45 D5, founder 19 Nov 2026), pure
 * so they are tested without a DOM: where each `governance_rules` row came
 * from, how it is taken back, and how the one filter row (agent, tool,
 * verdict, space) narrows the list. The words are not here: who, what and
 * where come from `@synap-core/types/governance-rules`, the verdict from the
 * vocabulary door, the origin's words from the page's catalog (`ORIGIN_KEYS`
 * name every one).
 *
 * WHERE A ROW CAME FROM is read from what the row carries, never guessed:
 *   - `pod-default` — the row behind a root switch (`isRootSwitchRule`): it
 *     is changed by that switch, in Settings, never revoked alone;
 *   - `playbook`    — a playbook pre-approval (`targetSubjectId`, 0420);
 *   - `request`     — "Always approve…", "Always reject…" or "Next time, do it
 *     and tell me" on a request (`sourceProposalId`);
 *   - `posture`     — the rows an agent's posture writes (`system:settings-
 *     mirror:` author, `applyAgentPosture`): changed on its page, where the
 *     posture is chosen, so a revoke here cannot be undone by the next save;
 *   - `computer`    — a copy of an agent's approval seeded on its computer
 *     (`system:host-seed:<rule id>`): it goes with the approval it copies;
 *   - `tool-page`   — "every AI × this tool action × the pod", the tool page's
 *     run mode (`governanceRules.setActionMode`);
 *   - `person`      — set directly by a person (`user:` author: an agent
 *     page, Widen in the grid, a space's settings);
 *   - `pod`         — set up by the pod itself (any other `system:` author);
 *   - `unknown`     — an older row whose author carries no mark.
 * The author prefixes are `@synap/database`'s
 * (`utils/governance-rule-provenance.ts`, `utils/host-seed.ts`); they are
 * stored strings, so a test pins them here.
 */

import {
  actionRunModeOf,
  isRootSwitchRule,
  ruleTitle,
  type ActionRunMode,
  type GovernanceRuleRowLike,
  type HumanizeTargetOptions,
} from "@synap-core/types/governance-rules";
import { resolveVerbStepLabel } from "@synap-core/types/vocabulary";
import { verbDisplayName } from "./tool-approvals-model";

/** The author prefixes the pod stamps (`@synap/database`), as stored. */
export const AUTHORED_PREFIX = "user:";
export const POSTURE_PREFIX = "system:settings-mirror:";
export const HOST_SEED_PREFIX = "system:host-seed:";
export const MACHINE_PREFIX = "system:";

/** Every origin, so the page's catalog names each one (a test pins it). */
export const ORIGIN_KEYS = [
  "request",
  "playbook",
  "pod-default",
  "posture",
  "computer",
  "tool-page",
  "person",
  "pod",
  "unknown",
] as const;
export type ApprovalOriginKey = (typeof ORIGIN_KEYS)[number];

/** The fields of a `governanceRules.listAll` row this page reads (structural). */
export interface ApprovalRowLike extends GovernanceRuleRowLike {
  id: string;
  workspaceId: string | null;
  createdBy: string;
  targetSubjectId?: string | null;
}

export interface ApprovalOrigin {
  key: ApprovalOriginKey;
  /** The page of the thing it came from: the request, the playbook, the agent. */
  href: string | null;
}

/** How a row is taken back. Every row has one (a guard pins it). */
export type ApprovalTakeBack =
  /** `governanceRules.revoke`, after a confirmation. */
  | { kind: "revoke" }
  /** Changed where it is set: the switch in Settings, the agent's posture. */
  | { kind: "elsewhere"; href: string; where: "settings" | "agent" }
  /** A computer's copy: taken back with the approval it copies (that row). */
  | { kind: "with-source"; ruleId: string };

/** Where the console's pages are (injected, so this file stays pure). */
export interface ApprovalHrefs {
  settings: string;
  agent: (agentUserId: string) => string;
  proposal: (proposalId: string) => string;
  playbook: (playbookId: string) => string;
}

export function approvalOrigin(
  row: ApprovalRowLike,
  hrefs: ApprovalHrefs
): ApprovalOrigin {
  if (isRootSwitchRule(row))
    return { key: "pod-default", href: hrefs.settings };
  if (row.targetSubjectId)
    return { key: "playbook", href: hrefs.playbook(row.targetSubjectId) };
  if (row.sourceProposalId)
    return { key: "request", href: hrefs.proposal(row.sourceProposalId) };
  const by = row.createdBy ?? "";
  if (by.startsWith(POSTURE_PREFIX))
    return {
      key: "posture",
      href: row.agentUserId ? hrefs.agent(row.agentUserId) : null,
    };
  if (by.startsWith(HOST_SEED_PREFIX)) return { key: "computer", href: null };
  if (by.startsWith(AUTHORED_PREFIX)) {
    const toolPage =
      row.principalKind === "any" &&
      row.scopeKind === "pod" &&
      row.targetKind === "capability";
    return { key: toolPage ? "tool-page" : "person", href: null };
  }
  if (by.startsWith(MACHINE_PREFIX)) return { key: "pod", href: null };
  return { key: "unknown", href: null };
}

export function approvalTakeBack(
  row: ApprovalRowLike,
  hrefs: ApprovalHrefs
): ApprovalTakeBack {
  const origin = approvalOrigin(row, hrefs);
  if (origin.key === "pod-default")
    return { kind: "elsewhere", href: hrefs.settings, where: "settings" };
  if (origin.key === "posture" && origin.href)
    return { kind: "elsewhere", href: origin.href, where: "agent" };
  if (origin.key === "computer") {
    const ruleId = (row.createdBy ?? "").slice(HOST_SEED_PREFIX.length);
    if (ruleId) return { kind: "with-source", ruleId };
  }
  return { kind: "revoke" };
}

// ─── The one filter row ─────────────────────────────────────────────────

/** The verdicts a row can carry, in the order the chip lists them. */
export const APPROVAL_VERDICTS = ["auto", "propose", "deny"] as const;
export type ApprovalVerdict = (typeof APPROVAL_VERDICTS)[number];

/** A verdict as a run mode (auto / ask / never): the word and the mark. */
export function approvalMode(verdict: string): ActionRunMode {
  return actionRunModeOf(
    verdict === "auto" || verdict === "propose" || verdict === "deny"
      ? verdict
      : null
  );
}

/** The space key of the pod-wide rows. */
export const POD_SPACE = "pod";
/** The agent key of a row for every agent. */
export const ANY_AGENT = "any";

/** Who a row is for, as a filter value: an agent id, a class, or "any". */
export function approvalAgentKey(
  row: Pick<ApprovalRowLike, "principalKind" | "agentUserId" | "principalClass">
): string {
  if (row.principalKind === "any") return ANY_AGENT;
  if (row.principalKind === "class")
    return `class:${row.principalClass ?? "unknown"}`;
  return row.agentUserId ?? "unknown";
}

/** The tool a row names, or null when it names no tool (an action, a kind). */
export function approvalToolKey(
  row: Pick<ApprovalRowLike, "targetKind" | "targetPattern">
): string | null {
  return row.targetKind === "capability" ? row.targetPattern : null;
}

/** Where a row holds, as a filter value: "pod" or the space's id. */
export function approvalSpaceKey(
  row: Pick<ApprovalRowLike, "scopeKind" | "workspaceId">
): string {
  return row.scopeKind === "pod" || !row.workspaceId
    ? POD_SPACE
    : row.workspaceId;
}

export interface ApprovalFilters {
  agent: string | null;
  tool: string | null;
  verdict: string | null;
  space: string | null;
}

export function approvalMatches(
  row: ApprovalRowLike,
  f: ApprovalFilters,
  /**
   * The tool a row names, as the Tool filter reads it. Default: its pattern.
   * The page passes the tool it belongs to (`toolIndex`), so the filter for
   * a tool also holds the rows on each of its actions (a tool's page links
   * to `?tool=<its id>`).
   */
  toolKey: (row: ApprovalRowLike) => string | null = approvalToolKey
): boolean {
  if (f.agent && approvalAgentKey(row) !== f.agent) return false;
  if (f.tool && toolKey(row) !== f.tool) return false;
  if (f.verdict && row.verdict !== f.verdict) return false;
  if (f.space && approvalSpaceKey(row) !== f.space) return false;
  return true;
}

/**
 * The values of one filter, from the rows (never a hand-written list), each
 * with how many rows carry it. First seen first: the list is newest first, so
 * the newest agent or tool leads.
 */
export function filterValues(
  rows: readonly ApprovalRowLike[],
  keyOf: (row: ApprovalRowLike) => string | null
): Array<{ id: string; count: number; sample: ApprovalRowLike }> {
  const byId = new Map<
    string,
    { id: string; count: number; sample: ApprovalRowLike }
  >();
  for (const row of rows) {
    const id = keyOf(row);
    if (id === null) continue;
    const seen = byId.get(id);
    if (seen) seen.count += 1;
    else byId.set(id, { id, count: 1, sample: row });
  }
  return [...byId.values()];
}

// ─── What a row covers, in words ────────────────────────────────────────

/** The capability catalog fields that name a tool (`capabilities.catalog`). */
export interface ToolNameSource {
  id: string | null;
  name: string;
  verbs: ReadonlyArray<{
    verbId: string;
    label: string;
    skillId?: string | null;
  }>;
}

/**
 * A tool rule's `targetPattern` (an action's stable name, or a capability's
 * id) → its display name from the catalog: "Read a LinkedIn profile
 * (Apify)", or the capability's own name. null when the catalog does not
 * hold it.
 */
export function toolNamesOf(
  cards: readonly ToolNameSource[] | null | undefined,
  /**
   * The compositions (`capabilities.compositions`): a row 0435 made from a
   * grant names one of a tool's member tool rows, named here as the tool.
   */
  compositions?: ReadonlyArray<{
    id: string;
    members: ReadonlyArray<{ kind: string; id: string }>;
  }> | null
): (pattern: string) => string | null {
  const names = new Map<string, string>();
  for (const card of cards ?? []) {
    if (card.id) names.set(card.id, card.name);
    for (const v of card.verbs) {
      // The action's words, never its id (finding 47ff4216): the catalog
      // labels most actions with their id.
      const name = `${verbDisplayName(v)} (${card.name})`;
      if (!names.has(v.verbId)) names.set(v.verbId, name);
      // An older row names the action by its skill row id.
      if (v.skillId && !names.has(v.skillId)) names.set(v.skillId, name);
    }
  }
  for (const comp of compositions ?? []) {
    const name = names.get(comp.id);
    if (!name) continue;
    for (const m of comp.members)
      if (m.kind === "tool" && !names.has(m.id)) names.set(m.id, name);
  }
  return (pattern) => names.get(pattern) ?? null;
}

/**
 * A tool's name for a row or a chip: the catalog's label, else the
 * vocabulary's words for the action (`resolveVerbStepLabel`). Never the raw
 * id: `Tool "apify_linkedin_profile"` is what this replaced.
 */
export function approvalToolName(
  pattern: string,
  toolName: (pattern: string) => string | null
): string {
  return toolName(pattern) ?? resolveVerbStepLabel(pattern);
}

/** A row's title: a tool by its name, everything else by the shared rule words. */
export function approvalTitle(
  row: ApprovalRowLike,
  opts: HumanizeTargetOptions & {
    toolName: (pattern: string) => string | null;
  }
): string {
  if (row.targetKind === "capability")
    return approvalToolName(row.targetPattern, opts.toolName);
  return ruleTitle(row, opts);
}
