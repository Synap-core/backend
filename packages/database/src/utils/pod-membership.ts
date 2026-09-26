/**
 * POD-MEMBERSHIP predicates — the ONE door for "is the caller a member of this
 * pod?" as SQL (Membership → Visibility, Wave 2), plus the audience predicates
 * of the Sites W2 guest floor (`podParticipantWhere`, `podGuestWhere`,
 * `podReaderWhere`). They are SQL, not a request-context flag, because ~265
 * floor call sites pass a bare userId and never see an AccessContext.
 *
 * It lives in `@synap/database` rather than `@synap/api` because THREE mirrors
 * need it and they must not drift:
 *   1. `accessScopeWhere` (packages/api utils/project-scope.ts) — the entity floor
 *   2. `facetVisibilityConditions` (utils/facet-visibility.ts, this package) +
 *      the `entityFacets` VisibilityRule (packages/api access/registry.ts)
 *   3. `entityQueryVisibilityWhere` (packages/jobs workers/entity-query-scope.ts)
 * `@synap/api` re-exports `podMemberWhere` from here; `@synap/jobs` imports it
 * directly (neither package may import the other).
 *
 * Emitted as `EXISTS (SELECT 1 FROM pod_members WHERE user_id = <userId>)`: a
 * membership FACT about the CALLER, bound to exactly the caller's own id and
 * independent of any row's columns. It is therefore only ever ANDed with a
 * row-shape predicate (e.g. `workspace_id IS NULL AND <shared-to-pod>`) — on its
 * own it would be a constant.
 */

import {
  and,
  eq,
  exists,
  not,
  notExists,
  or,
  sql as drizzleSql,
  type SQL,
} from "drizzle-orm";
import { db } from "../client-pg.js";
import {
  podMembers,
  workspaceMembers,
  workspaces,
} from "../schema/workspaces.js";
import { projectMembers } from "../schema/project-members.js";
import { users } from "../schema/users.js";

/** The project role a guest membership carries (`project_members.role`). */
export const GUEST_PROJECT_ROLE = "guest";

// The audience predicates below are built from query-BUILDER subqueries
// (`exists(db.select()…)`), never from a raw `sql` template naming columns: a
// relational query (`db.query.<t>.findMany({ where })`, which is what scopedDb
// runs) re-qualifies columns inside a raw template with ITS OWN table alias, so
// `sql\`… FROM pod_members WHERE ${podMembers.userId} = …\`` renders as
// `"<t>"."user_id"` there. Builder subqueries keep their own qualification.
const ONE = drizzleSql`1`;

function hasGuestProjectRole(userId: string) {
  return db
    .select({ one: ONE })
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.userId, userId),
        eq(projectMembers.role, GUEST_PROJECT_ROLE)
      )
    );
}

/**
 * A POD PARTICIPANT: has a `pod_members` row, a `workspace_members` row, or
 * owns a workspace. Each probe is an index lookup bound to the caller's own id
 * (`pod_members_user_unique`, `idx_workspace_members_user_id` (0276),
 * `idx_workspaces_owner_workspace_type`) and uncorrelated with the outer row,
 * so Postgres plans each EXISTS as a one-time InitPlan, never per row.
 */
export function podParticipantWhere(userId: string): SQL {
  return or(
    exists(
      db
        .select({ one: ONE })
        .from(podMembers)
        .where(eq(podMembers.userId, userId))
    ),
    exists(
      db
        .select({ one: ONE })
        .from(workspaceMembers)
        .where(eq(workspaceMembers.userId, userId))
    ),
    exists(
      db
        .select({ one: ONE })
        .from(workspaces)
        .where(eq(workspaces.ownerId, userId))
    )
  )!;
}

/**
 * A GUEST (founder decision, Sites W2): holds at least one
 * `project_members.role = 'guest'` row AND is NOT a pod participant. A guest's
 * floor is the EXPOSURE branch only: no pod-visible workspaces, no pod-wide
 * globals, no pod-personal DATA rows (see `podReaderWhere` / `accessScopeWhere`).
 *
 * Deliberately NOT "anyone who is not a participant": a project-only member
 * with a viewer/editor role (the federated `scopeKind:"project"` path) is not a
 * guest and keeps exactly the access it had before this predicate existed.
 *
 * Never NULL: EXISTS is two-valued, so `NOT (...)` over it is safe.
 */
export function podGuestWhere(userId: string): SQL {
  return and(
    exists(hasGuestProjectRole(userId)),
    not(podParticipantWhere(userId))
  )!;
}

/**
 * A POD READER: may read the pod-level (non-exposure) floor — pod-visible /
 * pod-joinable workspaces and pod-wide (NULL-workspace) global rows.
 *
 *   participant                                   → reader
 *   not a participant, holds a guest role         → NOT a reader (a guest)
 *   not a participant, no guest role, KNOWN user  → reader (today's behaviour
 *                                                    for project-only viewer /
 *                                                    editor members and for a
 *                                                    signed-in user who has
 *                                                    joined nothing yet)
 *   an id with no `users` row at all              → NOT a reader (an unknown /
 *                                                    anonymous principal reads
 *                                                    nothing)
 *
 * The participant probe comes first so the common case short-circuits.
 */
export function podReaderWhere(userId: string): SQL {
  return or(
    podParticipantWhere(userId),
    and(
      notExists(hasGuestProjectRole(userId)),
      exists(db.select({ one: ONE }).from(users).where(eq(users.id, userId)))
    )
  )!;
}

/**
 * SHARED-TO-POD, defined once: a facet row whose `workspace_id IS NULL` is
 * pod-wide, and pod-wide IS the share grant — the pod-level twin of "a facet in
 * workspace W is shared with W's members". There is no per-facet private flag
 * (see entity-facets.ts), so NULL-workspace is the only available signal. An
 * ENTITY is shared-to-pod when it is itself pod-wide AND carries such a facet;
 * an un-faceted pod-wide entity stays owner-private.
 */
export function podMemberWhere(userId: string): SQL {
  // A BUILDER subquery, not a raw template (Sites W2 S2 fix). The raw form
  // `sql\`EXISTS (SELECT 1 FROM ${podMembers} WHERE ${podMembers.userId} = …)\``
  // rendered correctly under `db.select()`, but a relational query
  // (`db.query.<t>.findMany({ where })` — every scopedDb read) re-qualifies EVERY
  // column in a raw template with its own alias (drizzle `mapColumnsInSQLToAlias`),
  // so it compiled to `… FROM "pod_members" WHERE "<t>"."user_id" = <caller>`: the
  // pod-shared branch silently read "the row's owner is the caller" there, and a
  // pod member never saw a pod-shared entity through scopedDb (fail-closed).
  return exists(
    db
      .select({ one: ONE })
      .from(podMembers)
      .where(eq(podMembers.userId, userId))
  );
}
