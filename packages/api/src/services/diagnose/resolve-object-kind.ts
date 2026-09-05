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
 *
 * ── ONE PROBER, TWO CONSUMERS ────────────────────────────────────────────────
 * `GET /resolve/:id` (the `synap open <bare-id>` door) used to carry a SECOND,
 * unguarded probe list of its own — four kinds against this one's seven — so a
 * bare id could open 4 of the ~21 kinds the browser routes. That list is gone;
 * the endpoint calls this function. The two lists diverged in VOCABULARY as well
 * as coverage (`view`/`document` existed only there), so what merged is the
 * MECHANISM — which table owns this id, under the caller's floor — and the
 * union of the kinds. The LABEL stays per-consumer: diagnose keeps its
 * explanatory kinds (`automation_run`, `playbook_run`, `capability` covering
 * three tables), and `/resolve/:id` projects them onto the browser's route table
 * via `routers/hub-protocol/rest/resolve-browser-route.ts`.
 */

import {
  db,
  and,
  or,
  eq,
  isNull,
  isNotNull,
  drizzleSql,
  proposals,
  focusSessions,
  capabilities,
  automationRuns,
  playbookRuns,
  users,
  entities,
  views,
  documents,
  skills,
  tools,
  events,
} from "@synap/database";
import { accessScopeWhere } from "../../utils/project-scope.js";
import { userVisibleWhere } from "../../utils/user-visible-where.js";
import { authoredByUser } from "../agent-identity-service.js";
import { visibleSkillsWhere } from "../skills/visibility.js";
import { EXTERNAL_DISPATCH_SOURCE } from "../../connectors/external-dispatch-constants.js";
import { AI_DECISION } from "../../lib/ai-events.js";
import type { ObjectKind } from "./types.js";

/** `events.data.kind` for a capability run's ai_decision event (see runs/index.ts). */
const CAPABILITY_RUN_EVENT_KIND = "capability_run";

export interface ResolvedObject {
  kind: ObjectKind;
  id: string;
  /**
   * Display metadata read off the SAME row the matching probe already had to
   * touch — never a second query. `/resolve/:id` needs a title to print; making
   * that a follow-up lookup per kind would rebuild, in the consumer, exactly the
   * per-table list this prober exists to own. Absent (undefined) for the
   * correlationId fallbacks, which match no display row.
   */
  displayName?: string | null;
  workspaceId?: string | null;
  /** `entities.type` — the profile slug. Only the `entity` probe sets it. */
  profileSlug?: string | null;
  /**
   * WHICH table under the `capability` umbrella matched. `capability` is one
   * diagnose kind covering three tables (a registered verb, a bare skill, a bare
   * tool), because diagnose explains all three the same way. A consumer that
   * ROUTES cannot collapse them — the browser has a separate door per table — so
   * the distinction is carried here instead of being re-derived by re-probing.
   */
  subKind?: "capability" | "skill" | "tool";
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
  // `view` and `document` sit ABOVE the broad `entity` catch and BELOW every
  // specific governance/capability probe — the same slot they held in the
  // `/resolve/:id` list this prober absorbed (which probed entities → views →
  // documents). Ids are UUIDs from disjoint tables, so relative order between
  // these three only ever matters on a collision; keeping the specific probes
  // first preserves the precedence both lists already had.
  "view",
  "document",
  "entity",
];

/** What a probe returns on a hit: the display metadata off the matched row.
 *  `null` = miss. `{}` is a legitimate hit for a table with nothing to show. */
type ProbeHit = Omit<ResolvedObject, "kind" | "id">;

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
  // each table's OWN user-floor predicate is visible and correct. A probe
  // returns the display metadata off the row it matched (or `{}` when the table
  // has none), never a bare boolean: the row was already fetched, and a consumer
  // that needs a title must not have to re-derive "which table was that?".
  const probes: Array<{
    kind: ObjectKind;
    run: () => Promise<ProbeHit | null>;
  }> = [
    {
      kind: "proposal",
      run: async () => {
        const [r] = await db
          .select({
            targetType: proposals.targetType,
            targetId: proposals.targetId,
            workspaceId: proposals.workspaceId,
          })
          .from(proposals)
          .where(
            and(
              eq(proposals.id, id),
              // LENS **or** OWNERSHIP. The bare lens here was a live
              // contradiction: whole-pod health reports "N more of yours sit
              // outside your workspace lens — list proposals to see them", and
              // then this probe answered "no diagnosable object found" for
              // exactly those rows. `authoredByUser` carries no membership
              // term, so this admits nothing beyond the caller's own rows.
              or(
                userVisibleWhere(proposals.workspaceId, userId),
                authoredByUser(userId)
              )
            )
          )
          .limit(1);
        if (!r) return null;
        // Same label `/resolve/:id` printed before it stopped probing itself.
        const target =
          typeof r.targetId === "string" ? r.targetId.slice(0, 8) : "";
        return {
          displayName: `Proposal (${r.targetType}:${target}…)`,
          workspaceId: r.workspaceId ?? null,
        };
      },
    },
    {
      kind: "session",
      run: async () => {
        const [r] = await db
          .select({
            goal: focusSessions.goal,
            workspaceId: focusSessions.workspaceId,
          })
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
        if (!r) return null;
        return {
          displayName: r.goal ?? null,
          workspaceId: r.workspaceId ?? null,
        };
      },
    },
    {
      kind: "capability",
      run: async () => {
        const [capabilityRow] = await db
          .select({
            name: capabilities.name,
            workspaceId: capabilities.workspaceId,
          })
          .from(capabilities)
          .where(
            and(
              eq(capabilities.id, id),
              userVisibleWhere(capabilities.workspaceId, userId)
            )
          )
          .limit(1);
        if (capabilityRow)
          return {
            subKind: "capability" as const,
            displayName: capabilityRow.name ?? null,
            workspaceId: capabilityRow.workspaceId ?? null,
          };

        // A `capability.run`/`capability/run` proposal's skillId is a `skills`
        // (or `tools`) row, not necessarily a registered `capabilities` verb —
        // without this, `diagnose(<skillId>)` fell through to "no diagnosable
        // object" for those. Probed under the SAME "capability" kind (diagnose
        // explains all three identically); `subKind` records WHICH table
        // matched, because a consumer that ROUTES needs the distinction.
        const [skillRow] = await db
          .select({ name: skills.name, workspaceId: skills.workspaceId })
          .from(skills)
          .where(and(eq(skills.id, id), visibleSkillsWhere(userId)))
          .limit(1);
        if (skillRow)
          return {
            subKind: "skill" as const,
            displayName: skillRow.name ?? null,
            workspaceId: skillRow.workspaceId ?? null,
          };

        const [toolRow] = await db
          .select({ name: tools.name, workspaceId: tools.workspaceId })
          .from(tools)
          .where(
            and(eq(tools.id, id), userVisibleWhere(tools.workspaceId, userId))
          )
          .limit(1);
        if (!toolRow) return null;
        return {
          subKind: "tool" as const,
          displayName: toolRow.name ?? null,
          workspaceId: toolRow.workspaceId ?? null,
        };
      },
    },
    {
      kind: "automation_run",
      run: async () => {
        const [r] = await db
          .select({ workspaceId: automationRuns.workspaceId })
          .from(automationRuns)
          .where(
            and(
              eq(automationRuns.id, id),
              userVisibleWhere(automationRuns.workspaceId, userId)
            )
          )
          .limit(1);
        return r ? { workspaceId: r.workspaceId ?? null } : null;
      },
    },
    {
      kind: "playbook_run",
      run: async () => {
        const [r] = await db
          .select({ workspaceId: playbookRuns.workspaceId })
          .from(playbookRuns)
          .where(
            and(
              eq(playbookRuns.id, id),
              userVisibleWhere(playbookRuns.workspaceId, userId)
            )
          )
          .limit(1);
        return r ? { workspaceId: r.workspaceId ?? null } : null;
      },
    },
    {
      kind: "agent",
      run: async () => {
        // Only the caller's OWN agent-users (createdByUserId floor) — the
        // scorecard reads governance data scoped to this owner.
        const [r] = await db
          .select({ name: users.name })
          .from(users)
          .where(
            and(
              eq(users.id, id),
              eq(users.userType, "agent"),
              eq(users.createdByUserId, userId)
            )
          )
          .limit(1);
        return r ? { displayName: r.name ?? null } : null;
      },
    },
    {
      kind: "view",
      run: async () => {
        const [r] = await db
          .select({ name: views.name, workspaceId: views.workspaceId })
          .from(views)
          // Mirror the canonical views floor (viewVisibleWhere in views.ts):
          // pod-personal (owner) OR workspace-membership. Views carry no
          // facets. Copied VERBATIM from the `/resolve/:id` probe this
          // absorbed — the floor is unchanged, only its home moved.
          .where(
            and(
              eq(views.id, id),
              or(
                and(isNull(views.workspaceId), eq(views.userId, userId)),
                and(
                  isNotNull(views.workspaceId),
                  userVisibleWhere(views.workspaceId, userId)
                )
              )
            )
          )
          .limit(1);
        return r
          ? { displayName: r.name ?? null, workspaceId: r.workspaceId ?? null }
          : null;
      },
    },
    {
      kind: "document",
      run: async () => {
        const [r] = await db
          .select({
            title: documents.title,
            workspaceId: documents.workspaceId,
          })
          .from(documents)
          // Canonical DATA-table floor (registry documents rule) — NO
          // facetLens (documents have no facets; their id doesn't map to
          // entity_facets). Copied VERBATIM from the `/resolve/:id` probe.
          .where(
            and(
              eq(documents.id, id),
              accessScopeWhere({
                workspaceIdColumn: documents.workspaceId,
                entityIdColumn: documents.id,
                ownerColumn: documents.userId,
                userId,
              })
            )
          )
          .limit(1);
        return r
          ? { displayName: r.title ?? null, workspaceId: r.workspaceId ?? null }
          : null;
      },
    },
    {
      kind: "entity",
      run: async () => {
        const [r] = await db
          .select({
            title: entities.title,
            type: entities.type,
            workspaceId: entities.workspaceId,
          })
          .from(entities)
          .where(
            and(
              eq(entities.id, id),
              isNull(entities.deletedAt),
              userVisibleWhere(entities.workspaceId, userId)
            )
          )
          .limit(1);
        return r
          ? {
              displayName: r.title ?? null,
              workspaceId: r.workspaceId ?? null,
              profileSlug: r.type ?? null,
            }
          : null;
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
    if (!probe) continue;
    const hit = await probe.run();
    if (hit) return { kind, id, ...hit };
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
        // Same reason as the row-id probe above: an agent hands back a
        // correlationId from a run whose proposal may be placed outside the
        // caller's workspace lens.
        or(
          userVisibleWhere(proposals.workspaceId, userId),
          authoredByUser(userId)
        )
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
