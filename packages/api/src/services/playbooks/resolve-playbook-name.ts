/**
 * Public playbook name resolve — user-floor, never silent multi-match pick.
 *
 * Uniqueness index already enforces at-most-one non-archived playbook per
 * `(workspace | pod-wide, lower(name))`. Across workspaces the same display
 * name can still collide (CRM "Hygiene" vs Sales "Hygiene"); this door returns
 * candidates instead of inventing a winner.
 *
 * Used by MCP `synap_run_playbook` (playbookId OR unambiguous playbookName).
 */

import {
  getDb,
  eq,
  and,
  or,
  ne,
  isNull,
  drizzleSql,
  playbooks,
} from "@synap/database";
import type { Playbook } from "@synap/database/schema";
import { AccessContext, scopedDb } from "../../access/index.js";

export type PlaybookNameCandidate = {
  id: string;
  name: string;
  workspaceId: string | null;
};

export type ResolvePlaybookByNameResult =
  | { status: "found"; playbook: Playbook }
  | { status: "ambiguous"; candidates: PlaybookNameCandidate[] }
  | { status: "not_found" };

/** Lean shape for multi-match errors (id, name, workspaceId only). */
export function toPlaybookNameCandidate(
  row: Pick<Playbook, "id" | "name" | "workspaceId">
): PlaybookNameCandidate {
  return {
    id: row.id,
    name: row.name,
    workspaceId: row.workspaceId,
  };
}

/**
 * Pure partition of name matches — unique → found, many → ambiguous, none → not_found.
 * Exported for unit tests without a DB.
 */
export function pickPlaybookNameMatch(
  matches: Playbook[]
): ResolvePlaybookByNameResult {
  if (matches.length === 0) return { status: "not_found" };
  if (matches.length === 1) {
    return { status: "found", playbook: matches[0]! };
  }
  return {
    status: "ambiguous",
    candidates: matches.map(toPlaybookNameCandidate),
  };
}

/**
 * Resolve a playbook by public name under the caller's user-visible floor.
 *
 * - Case-insensitive (`lower(name)`), non-archived only (pairs with the
 *   workspace+name uniqueness index).
 * - Optional `workspaceId` is a narrow-only filter: that workspace OR
 *   pod-wide NULL (same contract as `playbooks.listAllPage`).
 * - Exactly one match → found; multiple → ambiguous with candidates; zero → not_found.
 */
export async function resolvePlaybookByPublicName(opts: {
  userId: string;
  name: string;
  /** Narrow-only: workspace OR pod-wide. Omit for full user floor. */
  workspaceId?: string | null;
  agentUserId?: string | null;
}): Promise<ResolvePlaybookByNameResult> {
  const name = opts.name.trim();
  if (!name) return { status: "not_found" };

  const database = await getDb();
  const access = AccessContext.agent({
    userId: opts.userId,
    agentUserId: opts.agentUserId,
  });
  // User floor (no workspace lens) — optional workspaceId is applied as a
  // query narrow, not as AccessContext lens (lens would drop other-workspace
  // candidates the agent needs for multi-match errors).
  const visibility = scopedDb(access).predicate(playbooks);

  const rows = await database
    .select()
    .from(playbooks)
    .where(
      and(
        visibility,
        drizzleSql`lower(${playbooks.name}) = lower(${name})`,
        ne(playbooks.status, "archived"),
        opts.workspaceId
          ? or(
              isNull(playbooks.workspaceId),
              eq(playbooks.workspaceId, opts.workspaceId)
            )
          : undefined
      )
    );

  return pickPlaybookNameMatch(rows as Playbook[]);
}

/**
 * Load a playbook by id if it is on the caller's user-visible floor.
 */
export async function resolvePlaybookByIdVisible(opts: {
  userId: string;
  playbookId: string;
  agentUserId?: string | null;
}): Promise<Playbook | null> {
  const access = AccessContext.agent({
    userId: opts.userId,
    agentUserId: opts.agentUserId,
  });
  const row = await scopedDb(access).findFirst<Playbook>(playbooks, {
    where: eq(playbooks.id, opts.playbookId),
  });
  return row ?? null;
}

/**
 * Write workspace for a playbook run — never membership[0].
 *
 * Ladder: explicit/focused lens → playbook home → subject entity home →
 * ambient session home. Pod-wide playbooks with none of these must reject
 * (caller uses `rejectMissingWriteWorkspace`).
 */
export function resolvePlaybookRunWriteWorkspace(opts: {
  explicitWorkspaceId?: string | null;
  playbookWorkspaceId: string | null;
  subjectWorkspaceId?: string | null;
  sessionWorkspaceId?: string | null;
}): string | null {
  return (
    nullIfEmpty(opts.explicitWorkspaceId) ??
    nullIfEmpty(opts.playbookWorkspaceId) ??
    nullIfEmpty(opts.subjectWorkspaceId) ??
    nullIfEmpty(opts.sessionWorkspaceId) ??
    null
  );
}

function nullIfEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") return value ?? null;
  const t = value.trim();
  return t === "" ? null : t;
}
