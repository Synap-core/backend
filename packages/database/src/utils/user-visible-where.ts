/**
 * `userVisibleWhere` / `workspaceLensWhere` — single source of truth for "what
 * workspaces can this user see" as a Drizzle WHERE predicate.
 *
 * WHY IT LIVES IN `@synap/database` (and not `@synap/api`, where it was born):
 * the identical reason `podMemberWhere` moved here (utils/pod-membership.ts) —
 * MULTIPLE MIRRORS MUST NOT DRIFT, and the packages that need it cannot import
 * each other. `@synap/api` depends on `@synap/jobs` (api/package.json declares
 * `"@synap/jobs": "workspace:*"`), so `@synap/jobs` can NEVER import
 * `@synap/api` — the reason workers/entity-query-scope.ts had to duplicate
 * `accessScopeWhere` by hand. The automation executor's non-entity read nodes
 * (`runs_query`, `proposals_query`) must apply EXACTLY the predicate the
 * corresponding api listing applies (`listAutomationRuns`, `proposals.list`),
 * or a report would tell a different story than the browser. Hosting the
 * predicate in `@synap/database` — which both packages already depend on — is
 * the only way to share ONE implementation instead of a fourth copy.
 *
 * `@synap/api`'s utils/user-visible-where.ts re-exports these under their
 * original names, so every existing api import is unchanged.
 *
 * Background:
 *   Workspaces are lenses, not silos. When a UI surface above the workspace
 *   level (Eve OS, cross-workspace search, dashboards, AI agents that span
 *   contexts) asks the pod for data, the filter MUST be by USER, not by
 *   workspace. This helper expresses that as a Drizzle WHERE predicate:
 *
 *     "rows where workspaceId IS NULL (pod-wide globals) OR workspaceId
 *      belongs to a workspace the user is a member of"
 *
 * ONE-DOOR CONTRACT: there is no `.list`/`.listAll` split. Every user-data
 * table has a single scope-aware `.list` door built on `workspaceLensWhere`
 * below: no lens (`undefined`) = the full user floor (all the user's
 * workspaces + pod-wide globals — this is what Eve OS and cross-workspace
 * callers pass); a workspace/project lens only narrows that floor, it can
 * never widen it. A second `listAll` door is the exact two-door split this
 * collapsed and is CI-blocked (`read-scoping.tripwire.test.ts`, "THE
 * ONE-DOOR LOCK") — the only allowed exception is `subscriptions.listAll`,
 * grandfathered because `events` has no `workspace_id` column to lens on.
 */

import {
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  or,
  sql as drizzleSql,
  type SQL,
} from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { db } from "../client-pg.js";
import { workspaceMembers, workspaces } from "../schema/workspaces.js";
import { podReaderWhere } from "./pod-membership.js";

/**
 * The workspace lens, as a composable scope dimension:
 *   - `undefined`  → no narrowing (all the user's workspaces + globals — the floor)
 *   - `null`       → globals only (`workspaceId IS NULL`)
 *   - `"<id>"`     → that one workspace (+ globals per opts)
 *   - `string[]`   → that SET of workspaces (OR/union); `[]` == `undefined` (floor)
 * Multi-valued so a caller can fetch across several workspaces in one query.
 */
export type WorkspaceLens = string | string[] | null | undefined;

/**
 * Returns a Drizzle predicate matching rows visible to `userId`:
 *   - rows whose `workspaceId` is in any workspace the user is a member of or
 *     owns, OR
 *   - for a pod READER only (`podReaderWhere`: never a guest, never an unknown
 *     principal): rows where `workspaceIdColumn IS NULL` (pod-wide globals) and
 *     rows in a pod-visible / pod-joinable workspace.
 *
 * The subquery is correlated at the database level — Postgres can optimise
 * it as a semi-join, so one round-trip serves arbitrarily many workspaces
 * without an N+1 fan-out on the client.
 *
 * Compose with other conditions via `and(...)`:
 *
 *   const conditions = [
 *     isNull(table.deletedAt),
 *     userVisibleWhere(table.workspaceId, ctx.userId),
 *   ];
 *   const rows = await db.query.table.findMany({ where: and(...conditions) });
 *
 * NOT for an `ownerPrivate` table (entities, views, projects, focus_sessions,
 * documents, …): the `isNull(workspaceId)` branch below carries NO owner term,
 * so on those it admits every user's pod-personal rows. Use
 * `ownerPrivateVisibleWhere` (bottom of this file) there. The example above
 * deliberately no longer names a real ownerPrivate table — a doc that spells out
 * the leaky call is how the leaky call spreads.
 */
/**
 * The THREE branches of the workspace floor, each as a reusable id subquery.
 *
 * These exist so the floor has exactly ONE definition. `userVisibleWhere` needs
 * it as a predicate over a column; `ProfileRepository.getAccessibleProfiles`
 * needs it as an id set for its workspace-less branch. Before this split, the
 * profile path re-derived only the MEMBER branch, which meant a sovereign
 * single-user pod's owner — who legitimately has no `workspace_members` row —
 * saw a truncated vocabulary (SYSTEM + USER profiles only) at pod altitude.
 * Anything that needs "which workspaces can this user see" composes these;
 * nothing re-derives them.
 */
export function memberWorkspaceIds(userId: string) {
  return db
    .select({ id: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId));
}

/**
 * OWNED is separate from membership on purpose: `workspaces.owner_id` is a
 * first-class column and a sovereign/single-user pod's owner may have no member
 * row at all. Membership alone would hide their own data.
 */
export function ownedWorkspaceIds(userId: string) {
  return db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(eq(workspaces.ownerId, userId));
}

/**
 * The ONE spelling of "this workspace is pod-visible by setting". Private: a
 * caller wants `podVisibleWorkspaceWhere(userId)`, which also applies the
 * reader gate. Only `userVisibleWhere` composes it bare, because there the
 * reader gate is hoisted once over both reader-only branches.
 */
function podVisibleSettingWhere(): SQL {
  return drizzleSql`${workspaces.settings}->>'workspaceVisibility' IN ('pod_visible','pod_joinable')`;
}

/**
 * Workspaces readable by every pod READER (`podReaderWhere`): a participant, a
 * project-only non-guest member, or a known user who has joined nothing yet.
 * NEVER by a guest (Sites W2) and never by an unknown principal. A predicate
 * over `workspaces`, usable in any query/transaction.
 */
export function podVisibleWorkspaceWhere(userId: string): SQL {
  return and(podVisibleSettingWhere(), podReaderWhere(userId))!;
}

/** The pod-visible workspace ids `userId` may read, as a subquery. */
export function podVisibleWorkspaceIds(userId: string) {
  return db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(podVisibleWorkspaceWhere(userId));
}

export function userVisibleWhere(
  workspaceIdColumn: AnyPgColumn,
  userId: string
): SQL {
  // A user can see a row's workspace if they are a MEMBER of it, they OWN it
  // (ownerId is a first-class column, SEPARATE from workspace_members — a
  // sovereign/single-user pod's owner may not have a member row, so membership
  // alone would hide their own data), or it is POD-VISIBLE. This mirrors
  // getUserAccessibleWorkspaceIds so reads are consistent.
  //
  // The two POD-LEVEL branches — pod-wide globals (NULL workspace) and
  // pod-visible workspaces — are admitted only to a pod READER
  // (`podReaderWhere`): never to a GUEST (Sites W2: a guest's floor is the
  // exposure branch only) and never to an unknown principal. The gate is
  // hoisted over both branches so it is emitted once. A guest holds no member
  // or owned workspace by definition, so those two branches need no gate.
  const memberWs = memberWorkspaceIds(userId);
  const ownedWs = ownedWorkspaceIds(userId);
  const podVisibleWs = db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(podVisibleSettingWhere());

  // `proposals.workspace_id` is TEXT while `workspaces.id` /
  // `workspace_members.workspace_id` are UUID — cast the column to uuid so the
  // IN comparison matches. This is a no-op for the already-uuid columns this
  // helper is also used on (entities/views/channels/automations); every stored
  // value is a valid uuid.
  const col = drizzleSql`${workspaceIdColumn}::uuid`;
  // `or(...)` of non-null operands is non-null.
  return or(
    inArray(col, memberWs),
    inArray(col, ownedWs),
    and(
      podReaderWhere(userId),
      or(isNull(workspaceIdColumn), inArray(col, podVisibleWs))
    )
  )!;
}

/**
 * The workspace dimension as a LENS over the user floor. This is the one place
 * the "workspace is an optional narrowing, the user is the boundary" rule is
 * encoded — three states of `lens`:
 *
 *   - `undefined` → no lens: everything the USER can see (all their workspaces
 *      + pod-wide globals). The "pod-wide view" / Eve-OS / cross-workspace case.
 *   - `null`      → globals only (`workspaceId IS NULL`).
 *   - `"<id>"`    → that workspace's rows + pod-wide globals.
 *
 * A specific lens is INTERSECTED with the user floor, so a stale or forged
 * workspace id can never widen access past what the user may already see — the
 * lens only narrows. (When the id is one the user can see, the AND simplifies to
 * exactly "that workspace + globals".)
 */
export function workspaceLensWhere(
  workspaceIdColumn: AnyPgColumn,
  userId: string,
  lens?: WorkspaceLens,
  opts?: { includeGlobals?: boolean }
): SQL {
  const floor = userVisibleWhere(workspaceIdColumn, userId);
  // No lens = the pod-wide / user-focused view → globals ARE visible (the floor
  // already includes `IS NULL`). An EMPTY array is treated identically (no
  // constraint specified) — an empty filter must never silently match zero rows.
  if (lens === undefined || (Array.isArray(lens) && lens.length === 0)) {
    return floor;
  }
  // Globals-only is still the POD-LEVEL branch: a guest / unknown principal
  // gets no pod-wide global rows through it either (see `userVisibleWhere`).
  if (lens === null)
    return and(isNull(workspaceIdColumn), podReaderWhere(userId))!;
  // A SPECIFIC workspace (or set of workspaces) is selected → show THOSE
  // workspaces only; pod-wide globals do NOT bleed into a focused workspace
  // (product decision 2026-06-15). The exception is SUBSTRATE config (builtin
  // widgets, base relation-defs, SYSTEM profiles) which must stay visible inside
  // every workspace — those rules pass `includeGlobals: true`. Either way it's
  // intersected with the user floor so the lens can only narrow.
  // Multiple ids = OR (union) within the dimension.
  const lensMatch = Array.isArray(lens)
    ? inArray(workspaceIdColumn, lens)
    : eq(workspaceIdColumn, lens);
  return opts?.includeGlobals
    ? and(or(isNull(workspaceIdColumn), lensMatch), floor)!
    : and(lensMatch, floor)!;
}

/**
 * OWNER-PRIVATE floor for tables that have BOTH a `workspace_id` and a per-user
 * owner column, where a NULL workspace means "personal to the owner" — the
 * `ownerPrivate` shape in the access registry (focus_sessions, entities,
 * documents, …). Plain `userVisibleWhere` admits EVERY NULL-workspace row to ALL
 * users (its `isNull(workspaceId)` branch is owner-blind), so on such a table it
 * leaks another user's private sessions/rows. This gates the NULL branch by
 * owner and keeps the workspace-scoped branch on the shared user floor.
 *
 * For the entity graph prefer `accessScopeWhere` (it also carries exposure +
 * role-lens); this is the minimal owner-gate for hand-built join queries over
 * ownerPrivate tables that are NOT part of the entity-facet substrate.
 *
 * LIVES HERE for the same reason `userVisibleWhere` above does: it was born in
 * `@synap/api` and justified staying there by "api-only — no non-api consumer
 * today", which was FALSE — `services/team-person-bridge.ts` and
 * `utils/entity-project-membership.ts` inside `@synap/database` each hand-inlined
 * this exact predicate, and `@synap/database` cannot import upward. Two
 * hand-copies of a predicate with a canonical definition elsewhere is the drift
 * this package exists to prevent. `@synap/api`'s utils/user-visible-where.ts
 * re-exports it under the same name, so every existing api import is unchanged.
 */
export function ownerPrivateVisibleWhere(
  workspaceIdColumn: AnyPgColumn,
  ownerColumn: AnyPgColumn,
  userId: string
): SQL {
  return or(
    and(isNull(workspaceIdColumn), eq(ownerColumn, userId)),
    and(
      isNotNull(workspaceIdColumn),
      userVisibleWhere(workspaceIdColumn, userId)
    )
  )!;
}
