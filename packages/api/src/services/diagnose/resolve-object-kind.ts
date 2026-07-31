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
  events,
} from "@synap/database";
import { userVisibleWhere } from "../../utils/user-visible-where.js";
import { visibleSkillsWhere } from "../skills/visibility.js";
import { EXTERNAL_DISPATCH_SOURCE } from "../../connectors/external-dispatch-constants.js";
import { AI_DECISION } from "../../lib/ai-events.js";
import type { ObjectKind } from "./types.js";

/** `events.data.kind` for a capability run's ai_decision event (see runs/index.ts). */
const CAPABILITY_RUN_EVENT_KIND = "capability_run";

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

  // FALLBACK — `id` as a `proposals.correlationId`, not a row id. A capability
  // run (and every governed request chain) is stamped with a correlationId, and
  // that pointer is what an agent gets back from a run and hands to
  // `diagnose(id)`. None of the row-id probes above match it, so without this
  // the pointer dead-ends at "no diagnosable object" even though the run
  // executed and its result sits on the proposal. Resolve it to that proposal
  // (returning the proposal's ROW id, not the correlationId — the caller looks
  // the object up by `resolved.id`). Runs LAST: only when nothing matched by row
  // id, and `correlation_id` is indexed. Most recent wins if a chain shares one.
  const [byCorrelation] = await db
    .select({ id: proposals.id })
    .from(proposals)
    .where(
      and(
        eq(proposals.correlationId, id),
        userVisibleWhere(proposals.workspaceId, userId)
      )
    )
    .orderBy(drizzleSql`${proposals.createdAt} DESC`)
    .limit(1);
  if (byCorrelation) return { kind: "proposal", id: byCorrelation.id };

  // FALLBACK 2 — a DIRECT capability run (owner-bypass / read-only builtin /
  // governance-auto-granted agent) has NO proposal: its correlationId lives only
  // on the `capability_run` ai_decision event (executeCapability). Without this,
  // `diagnose(<direct-run correlationId>)` dead-ends at "no diagnosable object"
  // even though the run executed. Resolve it to the backing skill under the SAME
  // "capability" kind the skill/tool probes use — `diagnoseObject`'s capability
  // branch then explains the skill (and getRun({flowType:"capability"}) still
  // renders the run's own timeline for a caller that passes the flow). User-
  // floored on `events.userId` (the acting operator). Most recent wins.
  const [byEvent] = await db
    .select({ data: events.data })
    .from(events)
    .where(
      and(
        eq(events.correlationId, id),
        eq(events.subjectType, AI_DECISION),
        eq(events.userId, userId),
        drizzleSql`${events.data}->>'kind' = ${CAPABILITY_RUN_EVENT_KIND}`
      )
    )
    .orderBy(drizzleSql`${events.timestamp} DESC`)
    .limit(1);
  if (byEvent) {
    const skillId = (byEvent.data as Record<string, unknown> | null)?.skillId;
    if (typeof skillId === "string" && skillId)
      return { kind: "capability", id: skillId };
  }

  // FALLBACK 3 — a completed EXTERNAL SEND (messaging.external.send / provider
  // proxy call, `connectors/external-dispatch.ts`'s `recordExternalAction`) has
  // no row of its own: its ONLY trace is the `correlationId`-keyed audit event
  // that call stamps with `source: EXTERNAL_DISPATCH_SOURCE`. Without this,
  // `diagnose(<send correlationId>)` dead-ended at "no diagnosable object" even
  // though the send happened and its audit event exists — the exact
  // unresolvable-by-diagnose gap this wave closes. User-floored on the event's
  // own `userId` (the acting operator/agent-effective actor). Most recent wins.
  const [byExternalSend] = await db
    .select({ one: drizzleSql<number>`1` })
    .from(events)
    .where(
      and(
        eq(events.correlationId, id),
        eq(events.source, EXTERNAL_DISPATCH_SOURCE),
        eq(events.userId, userId)
      )
    )
    .orderBy(drizzleSql`${events.timestamp} DESC`)
    .limit(1);
  if (byExternalSend) return { kind: "external_send", id };

  return null;
}
