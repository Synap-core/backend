/**
 * `resolveObjectKind` — ordered polymorphic id → kind probe.
 *
 * A bare `diagnose({ id })` hands over a UUID with no hint of what it is. UUIDs
 * are shape-identical across tables, so we cannot parse the kind — we PROBE, in
 * a fixed order, USER-floored, short-circuiting on the first hit. Cost is a
 * handful of indexed point-lookups.
 *
 * There is no existing single polymorphic id-resolver to reuse — the runs
 * substrate's per-flow scans require you to already know the flow (confirmed by
 * the design audit; re-grepped). This is the net-new piece.
 */

import {
  db,
  and,
  eq,
  isNull,
  drizzleSql,
  proposals,
  focusSessions,
  capabilities,
  automationRuns,
  playbookRuns,
  users,
  entities,
  skills,
  tools,
} from "@synap/database";
import { userVisibleWhere } from "../../utils/user-visible-where.js";
import { visibleSkillsWhere } from "../skills/visibility.js";
import type { ObjectKind } from "./types.js";

export interface ResolvedObject {
  kind: ObjectKind;
  id: string;
}

/**
 * The probe order. Most-specific governance objects first (a proposal id is the
 * commonest thing an agent will hand over), then sessions, capabilities, runs,
 * agent-users, and finally the broad `entities` catch. Documented as data so the
 * ordering is testable and reviewable.
 */
export const PROBE_ORDER: ObjectKind[] = [
  "proposal",
  "session",
  "capability",
  "automation_run",
  "playbook_run",
  "agent",
  "entity",
];

/**
 * Probe `id` against each candidate table in order, USER-floored per table, and
 * return the first kind that matches — or null if the id resolves to nothing the
 * caller can see.
 */
export async function resolveObjectKind(
  id: string,
  userId: string
): Promise<ResolvedObject | null> {
  // Each probe is its own tiny query — kept explicit (not a table-map loop) so
  // each table's OWN user-floor predicate is visible and correct.
  const probes: Array<{ kind: ObjectKind; run: () => Promise<boolean> }> = [
    {
      kind: "proposal",
      run: async () => {
        const [r] = await db
          .select({ one: drizzleSql<number>`1` })
          .from(proposals)
          .where(
            and(
              eq(proposals.id, id),
              userVisibleWhere(proposals.workspaceId, userId)
            )
          )
          .limit(1);
        return !!r;
      },
    },
    {
      kind: "session",
      run: async () => {
        const [r] = await db
          .select({ one: drizzleSql<number>`1` })
          .from(focusSessions)
          .where(
            and(
              eq(focusSessions.id, id),
              // Sessions carry an owner (userId) AND a workspace lens — a user
              // sees their own sessions and those in workspaces they can read.
              drizzleSql`(${focusSessions.userId} = ${userId} OR ${userVisibleWhere(
                focusSessions.workspaceId,
                userId
              )})`
            )
          )
          .limit(1);
        return !!r;
      },
    },
    {
      kind: "capability",
      run: async () => {
        const [capabilityRow] = await db
          .select({ one: drizzleSql<number>`1` })
          .from(capabilities)
          .where(
            and(
              eq(capabilities.id, id),
              userVisibleWhere(capabilities.workspaceId, userId)
            )
          )
          .limit(1);
        if (capabilityRow) return true;

        // A `capability.run`/`capability/run` proposal's skillId is a `skills`
        // (or `tools`) row, not necessarily a registered `capabilities` verb —
        // without this, `diagnose(<skillId>)` fell through to "no diagnosable
        // object" for those. Probed under the SAME "capability" kind (there is
        // no separate ObjectKind for a raw skill/tool).
        const [skillRow] = await db
          .select({ one: drizzleSql<number>`1` })
          .from(skills)
          .where(and(eq(skills.id, id), visibleSkillsWhere(userId)))
          .limit(1);
        if (skillRow) return true;

        const [toolRow] = await db
          .select({ one: drizzleSql<number>`1` })
          .from(tools)
          .where(
            and(eq(tools.id, id), userVisibleWhere(tools.workspaceId, userId))
          )
          .limit(1);
        return !!toolRow;
      },
    },
    {
      kind: "automation_run",
      run: async () => {
        const [r] = await db
          .select({ one: drizzleSql<number>`1` })
          .from(automationRuns)
          .where(
            and(
              eq(automationRuns.id, id),
              userVisibleWhere(automationRuns.workspaceId, userId)
            )
          )
          .limit(1);
        return !!r;
      },
    },
    {
      kind: "playbook_run",
      run: async () => {
        const [r] = await db
          .select({ one: drizzleSql<number>`1` })
          .from(playbookRuns)
          .where(
            and(
              eq(playbookRuns.id, id),
              userVisibleWhere(playbookRuns.workspaceId, userId)
            )
          )
          .limit(1);
        return !!r;
      },
    },
    {
      kind: "agent",
      run: async () => {
        // Only the caller's OWN agent-users (createdByUserId floor) — the
        // scorecard reads governance data scoped to this owner.
        const [r] = await db
          .select({ one: drizzleSql<number>`1` })
          .from(users)
          .where(
            and(
              eq(users.id, id),
              eq(users.userType, "agent"),
              eq(users.createdByUserId, userId)
            )
          )
          .limit(1);
        return !!r;
      },
    },
    {
      kind: "entity",
      run: async () => {
        const [r] = await db
          .select({ one: drizzleSql<number>`1` })
          .from(entities)
          .where(
            and(
              eq(entities.id, id),
              isNull(entities.deletedAt),
              userVisibleWhere(entities.workspaceId, userId)
            )
          )
          .limit(1);
        return !!r;
      },
    },
  ];

  // Drive the probe sequence from PROBE_ORDER (not the literal's declaration
  // order) so that constant is load-bearing: its test protects real resolution
  // precedence, and reordering it — e.g. floating the broad `entity` catch above
  // `proposal` — actually changes behaviour instead of silently diverging.
  const byKind = new Map(probes.map((p) => [p.kind, p]));
  for (const kind of PROBE_ORDER) {
    const probe = byKind.get(kind);
    if (probe && (await probe.run())) return { kind, id };
  }
  return null;
}
