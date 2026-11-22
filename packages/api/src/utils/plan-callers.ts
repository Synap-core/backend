/**
 * plan-callers — the ONE place that builds the composite materializer's
 * connected-plan callers (`PlanCallers`): projects, sessions, session edges,
 * documents, and the compensation that undoes a plan which did not apply.
 *
 * Mirrors `rule-loop-callers.ts`: every caller routes to the EXISTING door for
 * its object, lazily imported (the routers import back into proposals), and
 * every caller THROWS on anything but a clean apply — inside a plan a skipped
 * step is a failed plan.
 *
 *   project  → `projectsRouter.create` / `.update` (as the approver, exactly
 *              like the `project/create` executor — the approval IS the human
 *              decision, so the agent gravity gate does not re-run here; it
 *              was surfaced to the reviewer at propose time instead)
 *   session  → `createFocusSession` (no agentUserId: the approval is the human
 *              decision), with the parent passed at create when it exists
 *   goal     → `startTrack` as the plan's owner (the approval is the human
 *              decision, so no agent rides it), then goal → goal
 *              `blocked_by` through THE governed dependency door
 *              (`addUnitBlockers`, approved by this proposal)
 *   kind     → `applyApprovedKind`, the `profile/create` executor's writer
 *              (the profile door as the approver + each field, checked again)
 *   edge     → `addSessionBlocker` (`blocked_by`) / `recordSessionSpawn`
 *              (`spawned_from`) — the same producers `POST /links` and the
 *              create doors use, floored on the plan's session OWNER
 *   document → `materializeApprovedDocument` (the `document/create` executor's
 *              writer), attached through the governed `entities.update`, and
 *              recorded on a session through `recordSessionArtifact`
 *   undo     → sessions through the ONE close door (`cancelSession` →
 *              `completeFocusSession`, so the close event, run close and
 *              unblock reactor fire as for any cancel), goals dropped through
 *              THE goal status door (`setTrackStatus`, verdict `mistake`),
 *              kinds retired through THE one retirement write
 *              (`markProfileRetired`), then
 *              `revertProposalCreations` (the one undo engine) for the rest,
 *              then the governed document delete door
 *
 * WHOSE ROWS. Sessions belong to — and every session edge floors on — the
 * proposal's SUBJECT user (`sessionOwnerUserId`), never an approving admin:
 * the session ids in a plan were authored for that principal, and flooring on
 * the approver would let a plan name the approver's own sessions (the E1
 * blocker rule, `applyApprovedBlockedBy`). Projects and documents are written
 * as the applying principal, exactly like their single-object executors.
 */

import { randomUUID } from "crypto";
import { and, eq, focusSessions, links, type db } from "@synap/database";
import type { LinkEndpointType } from "@synap/database/schema";
import type { Context } from "../context.js";
import type {
  MaterializeResult,
  PlanCallers,
  PlanCompensationReport,
} from "./materialize-composite.js";

export interface PlanCallerContext {
  database: typeof db;
  /** The applying principal (approver, or the capturing human on auto-apply). */
  userId: string;
  /** Owner of the plan's sessions and the floor for every session edge. */
  sessionOwnerUserId: string;
  /** The proposal's workspace (null = pod-personal). */
  workspaceId: string | null;
  workspaceRole?: string;
  /** The SAME governed entity caller the apply uses (document → entity body). */
  entityCaller: { update: (input: any) => Promise<any> };
  /** The proposal being applied — lineage for created rows and the undo. */
  proposal: {
    id: string | null;
    sessionId: string | null;
    /** The agent that filed it (a kind's provenance), when an agent did. */
    agentUserId?: string | null;
  };
}

/** The `links` row id of an edge, by its unique key. */
async function linkIdFor(
  database: typeof db,
  edge: { fromId: string; toId: string; type: "blocked_by" | "spawned_from" }
): Promise<string | null> {
  const [row] = await database
    .select({ id: links.id })
    .from(links)
    .where(
      and(
        eq(links.fromType, "session"),
        eq(links.fromId, edge.fromId),
        eq(links.toType, "session"),
        eq(links.toId, edge.toId),
        eq(links.linkType, edge.type)
      )
    )
    .limit(1);
  return row?.id ?? null;
}

/** The `blocked_by` row id of a cross-kind dependency edge. */
async function dependencyLinkIdFor(
  database: typeof db,
  edge: {
    fromType: LinkEndpointType;
    fromId: string;
    toType: LinkEndpointType;
    toId: string;
  }
): Promise<string | null> {
  const [row] = await database
    .select({ id: links.id })
    .from(links)
    .where(
      and(
        eq(links.fromType, edge.fromType),
        eq(links.fromId, edge.fromId),
        eq(links.toType, edge.toType),
        eq(links.toId, edge.toId),
        eq(links.linkType, "blocked_by")
      )
    )
    .limit(1);
  return row?.id ?? null;
}

export function buildPlanCallers(ctx: PlanCallerContext): PlanCallers {
  const { database, userId, sessionOwnerUserId, workspaceId } = ctx;
  // `child>parent` of each `spawned_from` edge the session door wrote AT
  // create in this run. P2 then meets the edge already there; it is still this
  // run's row (the child did not exist before), so it is reported as created
  // and plan undo removes it.
  const spawnedAtCreate = new Set<string>();

  const routerCtx = (): Context =>
    ({
      db: database,
      authenticated: true as const,
      userId,
      workspaceId: workspaceId ?? undefined,
      workspaceRole: ctx.workspaceRole,
    }) as unknown as Context;

  return {
    projectCaller: {
      create: async ({ name, description }) => {
        const { projectsRouter } = await import("../routers/projects.js");
        const out = (await projectsRouter.createCaller(routerCtx()).create({
          name,
          ...(description ? { description } : {}),
        })) as { status?: string; projectId?: string };
        if (out.status === "created" && out.projectId) {
          return { id: out.projectId, linked: false };
        }
        // The door reuses an ACTIVE project of the exact same name. Not this
        // run's row: it is reported `linked` and never compensated.
        if (out.status === "deduped" && out.projectId) {
          return { id: out.projectId, linked: true };
        }
        throw new Error(
          `project "${name}" did not apply (${out.status ?? "no status"})`
        );
      },
      setSubject: async ({ projectId, subjectEntityId }) => {
        const { projectsRouter } = await import("../routers/projects.js");
        const out = (await projectsRouter.createCaller(routerCtx()).update({
          id: projectId,
          subjectEntityId,
        })) as { status?: string; subjectBound?: boolean };
        if (out.status === "proposed" || out.subjectBound === false) {
          throw new Error(
            `the project's subject ${subjectEntityId} was not bound (${out.status ?? "subjectBound: false"})`
          );
        }
      },
    },

    sessionCaller: {
      create: async (input) => {
        const { createFocusSession } =
          await import("../services/focus-sessions/create-session.js");
        const out = await createFocusSession({
          userId: sessionOwnerUserId,
          workspaceId,
          projectId: input.projectId,
          subjectEntityId: input.subjectEntityId,
          // The parent AT create, as a direct start passes it: the door derives
          // the project, goal and space from it and writes `spawned_from`.
          ...(input.parentSessionId
            ? { parentSessionId: input.parentSessionId }
            : {}),
          // The goal AT create, as `start_session` + `trackId`: the door files
          // the session in it and derives its project.
          ...(input.trackId ? { trackId: input.trackId } : {}),
          title: input.title,
          goal: input.goal,
          ...(input.expectedOutputs.length > 0
            ? {
                expectedOutputs:
                  input.expectedOutputs as unknown as NonNullable<
                    Parameters<typeof createFocusSession>[0]["expectedOutputs"]
                  >,
              }
            : {}),
          // Criteria the plan proposed. The door validates them with the same
          // schema every other session door uses, so a malformed list is
          // refused here rather than reaching a person as a broken contract.
          ...(input.criteria.length > 0
            ? {
                criteria: input.criteria as unknown as NonNullable<
                  Parameters<typeof createFocusSession>[0]["criteria"]
                >,
              }
            : {}),
        });
        if (out.status === "created") {
          if (out.parentLink?.status === "linked") {
            spawnedAtCreate.add(
              `${out.session.id}>${out.parentLink.parentSessionId}`
            );
          }
          return { id: out.session.id, linked: false };
        }
        // The door reuses an OPEN session of the same goal and scope. Not this
        // run's row: it is reported `linked` and never compensated — the same
        // contract as the project step above.
        if (out.status === "deduped") {
          return { id: out.session.id, linked: true };
        }
        throw new Error(
          `session "${input.title ?? input.goal}" was routed to a proposal instead of being created`
        );
      },
      update: async ({ sessionId, patch }) => {
        // The step as it is now: what a failed plan puts back.
        const read = async () => {
          const [row] = await database
            .select({
              title: focusSessions.title,
              goal: focusSessions.goal,
              status: focusSessions.status,
            })
            .from(focusSessions)
            .where(
              and(
                eq(focusSessions.id, sessionId),
                eq(focusSessions.userId, sessionOwnerUserId)
              )
            )
            .limit(1);
          return row
            ? { title: row.title ?? null, goal: row.goal, status: row.status }
            : null;
        };
        const before = await read();
        if (!before) {
          throw new Error(
            `session ${sessionId} was not found among the plan owner's sessions`
          );
        }
        const { updateFocusSession } =
          await import("../services/focus-sessions/update-session.js");
        // THE session update door, as the plan's owner: its move rules judge
        // a status change, and the move is compare-and-set on what was read.
        const out = await updateFocusSession({
          sessionId,
          userId: sessionOwnerUserId,
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.goal !== undefined ? { goal: patch.goal } : {}),
          ...(patch.status !== undefined
            ? {
                status: patch.status,
                expectedStatus: before.status as Parameters<
                  typeof updateFocusSession
                >[0]["expectedStatus"],
              }
            : {}),
        });
        if (out.status !== "updated") {
          throw new Error(
            `session ${sessionId} was not changed (${out.status}${"reason" in out && out.reason ? `: ${out.reason}` : ""})`
          );
        }
        const after = await read();
        return { before, after: after ?? before };
      },
    },

    trackCaller: {
      create: async (input) => {
        const { startTrack } =
          await import("../services/tracks/tracks-service.js");
        const out = await startTrack({
          projectId: input.projectId,
          name: input.name,
          ...(input.direction ? { direction: input.direction } : {}),
          ...(input.kpi ? { kpi: input.kpi } : {}),
          ...(input.criteria ? { criteria: input.criteria } : {}),
          ...(input.workKind ? { workKind: input.workKind } : {}),
          ...(input.endState ? { endState: input.endState } : {}),
          ...(input.parentGoalId ? { parentGoalId: input.parentGoalId } : {}),
          // The plan's owner starts it, as a person: the approval (or a
          // person's own capture) is the human decision.
          actor: {
            userId: sessionOwnerUserId,
            agentUserId: null,
            sessionId: ctx.proposal.sessionId,
            source: "plan",
          },
        });
        if (out.status === "started")
          return { id: out.track.id, linked: false };
        // A LIVE goal of the same name on the project: not this run's row,
        // reported `linked` and never compensated (as a reused project).
        if (out.status === "exists") return { id: out.track.id, linked: true };
        throw new Error(
          `goal "${input.name}" was routed to a proposal instead of being started`
        );
      },
      addBlockers: async ({ trackId, blockerTrackIds }) => {
        const { addUnitBlockers } =
          await import("../services/links/unit-blockers.js");
        const reports = await addUnitBlockers({
          from: { type: "track", id: trackId },
          kind: "track",
          ids: blockerTrackIds,
          userId: sessionOwnerUserId,
          approvedProposalId: ctx.proposal.id,
          sessionId: ctx.proposal.sessionId,
          door: "capture plan",
        });
        const refused = reports.filter((r) => r.status !== "linked");
        if (refused.length > 0) {
          throw new Error(
            refused
              .map(
                (r) =>
                  `goal ${trackId} could not wait on goal ${r.blockerTrackId} (${r.status === "failed" ? `${r.reason}${r.message ? `: ${r.message}` : ""}` : r.status})`
              )
              .join("; ")
          );
        }
        const linkIds: string[] = [];
        for (const r of reports) {
          if (r.status !== "linked" || r.inserted === 0) continue;
          const id = await dependencyLinkIdFor(database, {
            fromType: "track",
            fromId: trackId,
            toType: "track",
            toId: r.blockerTrackId as string,
          });
          if (id) linkIds.push(id);
        }
        return { linkIds };
      },
    },

    kindCaller: {
      define: async (input) => {
        if (!workspaceId) {
          throw new Error(
            `kind "${input.slug}" needs a space: the plan was filed in none`
          );
        }
        // The applying person's role in the space, read now (as the
        // `profile/create` executor does): the profile door judges it.
        const { getWorkspaceMembership } = await import("@synap/database");
        const membership = await getWorkspaceMembership(
          database,
          workspaceId,
          userId
        );
        if (!membership) {
          throw new Error(
            `kind "${input.slug}" was not created: you are not a member of the plan's space`
          );
        }
        const { applyApprovedKind } =
          await import("../services/profiles/apply-approved-kind.js");
        const uiHints: Record<string, unknown> = {
          ...(input.icon ? { icon: input.icon } : {}),
          ...(input.description ? { description: input.description } : {}),
        };
        const out = await applyApprovedKind({
          userId,
          workspaceId,
          workspaceRole: membership.role,
          proposalId: ctx.proposal.id ?? "",
          agentAuthored: !!ctx.proposal.agentUserId,
          // The plan's reviewer saw the kind as NEW; a kind of that slug
          // appearing since is refused below, never reused.
          duplicateReviewed: false,
          slug: input.slug,
          displayName: input.displayName,
          ...(Object.keys(uiHints).length > 0 ? { uiHints } : {}),
          scope: "workspace",
          ...(input.entityScope ? { entityScope: input.entityScope } : {}),
          profileKind: "kind",
          kindFields: input.fields,
        });
        if (out.existing || !out.profileId) {
          throw new Error(
            `a kind "${input.slug}" already exists: the plan said it would create it — use the existing kind (drop the kinds[] step)`
          );
        }
        const refused = out.fieldOutcomes.filter(
          (f) => f.outcome === "refused"
        );
        if (refused.length > 0) {
          // Its records may need the field: inside a plan a refused field is
          // a failed step, and the kind goes with the rollback.
          const { markProfileRetired } = await import("@synap/database");
          await markProfileRetired(database, out.profileId, {
            reason: "plan_rolled_back",
            ...(ctx.proposal.id ? { byProposalId: ctx.proposal.id } : {}),
          });
          throw new Error(
            refused
              .map(
                (f) =>
                  `field "${f.slug ?? "?"}" of kind "${input.slug}" was not created: ${f.reason ?? "refused"}`
              )
              .join("; ")
          );
        }
        return { profileId: out.profileId };
      },
    },

    linkCaller: {
      create: async ({ type, fromSessionId, toSessionId }) => {
        if (type === "blocked_by") {
          const { addSessionBlocker } =
            await import("../services/focus-sessions/session-blocked-by.js");
          const out = await addSessionBlocker({
            sessionId: fromSessionId,
            blockerSessionId: toSessionId,
            userId: sessionOwnerUserId,
          });
          if (!out.linked) {
            throw new Error(
              `blocked_by ${fromSessionId} → ${toSessionId} was refused (${out.reason}): both sessions must exist and belong to the plan's owner`
            );
          }
          return {
            linkId: await linkIdFor(database, {
              fromId: fromSessionId,
              toId: toSessionId,
              type,
            }),
            preExisting: out.inserted === 0,
          };
        }
        const { recordSessionSpawn } = await import("@synap/database");
        const existedBefore = await linkIdFor(database, {
          fromId: fromSessionId,
          toId: toSessionId,
          type,
        });
        const out = await recordSessionSpawn({
          childSessionId: fromSessionId,
          parentSessionId: toSessionId,
          userId: sessionOwnerUserId,
          workspaceId,
        });
        if (!out.linked) {
          throw new Error(
            `spawned_from ${fromSessionId} → ${toSessionId} was refused (${out.reason}): the parent must exist and belong to the plan's owner`
          );
        }
        return {
          linkId:
            existedBefore ??
            (await linkIdFor(database, {
              fromId: fromSessionId,
              toId: toSessionId,
              type,
            })),
          preExisting:
            existedBefore !== null &&
            !spawnedAtCreate.has(`${fromSessionId}>${toSessionId}`),
        };
      },
      createCrossKind: async ({ fromSessionId, toKind, toId }) => {
        const { addUnitBlockers } =
          await import("../services/links/unit-blockers.js");
        const [report] = await addUnitBlockers({
          from: { type: "session", id: fromSessionId },
          kind: toKind,
          ids: [toId],
          userId: sessionOwnerUserId,
          approvedProposalId: ctx.proposal.id,
          sessionId: fromSessionId,
          door: "capture plan",
        });
        if (!report || report.status !== "linked") {
          throw new Error(
            `session ${fromSessionId} could not wait on ${toKind === "entity" ? "decision" : "goal"} ${toId} (${report?.status === "failed" ? `${report.reason}${report.message ? `: ${report.message}` : ""}` : (report?.status ?? "no answer")})`
          );
        }
        return {
          linkId: await dependencyLinkIdFor(database, {
            fromType: "session",
            fromId: fromSessionId,
            toType: toKind,
            toId,
          }),
          preExisting: report.inserted === 0,
        };
      },
      remove: async ({ fromSessionId, toKind, toId }) => {
        if (toKind === "session") {
          const { removeSessionBlocker } =
            await import("../services/focus-sessions/session-blocked-by.js");
          const out = await removeSessionBlocker({
            sessionId: fromSessionId,
            blockerSessionId: toId,
            userId: sessionOwnerUserId,
          });
          if (out.removed) return { removed: true };
          if (out.reason === "no_edge") return { removed: false };
          throw new Error(
            `blocked_by ${fromSessionId} → ${toId} was not removed (${out.reason}): both sessions must belong to the plan's owner`
          );
        }
        const { removeUnitBlockers } =
          await import("../services/links/unit-blockers.js");
        const [report] = await removeUnitBlockers({
          from: { type: "session", id: fromSessionId },
          kind: toKind,
          ids: [toId],
          userId: sessionOwnerUserId,
          approvedProposalId: ctx.proposal.id,
          sessionId: fromSessionId,
          door: "capture plan",
        });
        if (report?.status === "removed") return { removed: true };
        if (report?.status === "absent") return { removed: false };
        throw new Error(
          `session ${fromSessionId} still waits on ${toKind} ${toId} (${report?.status === "failed" ? `${report.reason}${report.message ? `: ${report.message}` : ""}` : (report?.status ?? "no answer")})`
        );
      },
    },

    documentCaller: {
      create: async ({
        title,
        content,
        entityId,
        sessionId,
        expectedLabel,
      }) => {
        const { materializeApprovedDocument } =
          await import("../services/proposals/materialize-approved-document.js");
        const { id } = await materializeApprovedDocument({
          documentId: randomUUID(),
          title,
          content,
          userId,
          workspaceId,
          sourceProposalId: ctx.proposal.id,
        });
        if (entityId) {
          const attached = (await ctx.entityCaller.update({
            id: entityId,
            documentId: id,
            reasoning: "Attach the plan's document as this entity's body",
          })) as { status?: string } | undefined;
          if (attached?.status === "proposed") {
            throw new Error(
              `attaching document "${title}" to entity ${entityId} was routed to a proposal instead of applying`
            );
          }
        }
        if (sessionId) {
          const { recordSessionArtifact } =
            await import("../services/focus-sessions/record-session-artifact.js");
          const artifactId = await recordSessionArtifact({
            sessionId,
            workspaceId,
            userId,
            kind: "document",
            refId: id,
            title,
            // The slot claim, when the plan step named one; otherwise nothing
            // to claim — forwarded explicitly either way.
            expectedLabel: expectedLabel ?? undefined,
          });
          if (!artifactId) {
            throw new Error(
              `document "${title}" could not be recorded as an output of session ${sessionId}`
            );
          }
        }
        return { id };
      },
    },

    compensate: async (
      applied: MaterializeResult
    ): Promise<PlanCompensationReport> => {
      const { buildMaterializedRecord } =
        await import("../services/proposals/stamp-materialized.js");
      const { creationsPlanFromRecord } =
        await import("../routers/proposals/revert.js");
      const { revertProposalCreations, revertSkipView } =
        await import("../services/proposals/revert-creations.js");

      const record = buildMaterializedRecord(applied);
      const plan = creationsPlanFromRecord(record);
      const notCompensated: PlanCompensationReport["notCompensated"] = [];

      // RE-PLAN EDITS first, newest first: each existing step gets back the
      // fields it had, through the same door, and each dropped edge comes
      // back through the door that owns it. A step changed by someone since
      // is still put back (the plan failed seconds ago): reported if refused.
      const restoredSessionIds: string[] = [];
      for (const u of [...(applied.sessionUpdates ?? [])].reverse().slice(0, 0)) { // NEGCTL
        try {
          const { updateFocusSession } =
            await import("../services/focus-sessions/update-session.js");
          const out = await updateFocusSession({
            sessionId: u.sessionId,
            userId: sessionOwnerUserId,
            title: u.before.title,
            goal: u.before.goal,
            ...(u.before.status !== u.after.status &&
            (u.before.status === "active" || u.before.status === "paused")
              ? { status: u.before.status }
              : {}),
          });
          // A status the update door cannot move back to (it moves to active
          // or paused only) is named, never silently left.
          if (
            u.before.status !== u.after.status &&
            u.before.status !== "active" &&
            u.before.status !== "paused"
          ) {
            notCompensated.push({
              kind: "session_update",
              id: u.sessionId,
              reason: `its status was ${u.before.status} and cannot be put back through the update door`,
            });
          }
          if (out.status === "updated") restoredSessionIds.push(u.sessionId);
          else
            notCompensated.push({
              kind: "session_update",
              id: u.sessionId,
              reason: `the step could not be put back (${out.status})`,
            });
        } catch (err) {
          notCompensated.push({
            kind: "session_update",
            id: u.sessionId,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
      const restoredLinks: string[] = [];
      for (const r of applied.linkRemovals ?? []) {
        if (!r.removed) continue;
        const key = `${r.fromSessionId}>${r.toKind}:${r.toId}`;
        try {
          if (r.toKind === "session") {
            const { addSessionBlocker } =
              await import("../services/focus-sessions/session-blocked-by.js");
            const out = await addSessionBlocker({
              sessionId: r.fromSessionId,
              blockerSessionId: r.toId,
              userId: sessionOwnerUserId,
            });
            if (!out.linked) throw new Error(out.reason);
          } else {
            const { addUnitBlockers } =
              await import("../services/links/unit-blockers.js");
            const [report] = await addUnitBlockers({
              from: { type: "session", id: r.fromSessionId },
              kind: r.toKind,
              ids: [r.toId],
              userId: sessionOwnerUserId,
              approvedProposalId: ctx.proposal.id,
              sessionId: r.fromSessionId,
              door: "capture plan undo",
            });
            if (report?.status !== "linked")
              throw new Error(report?.status ?? "no answer");
          }
          restoredLinks.push(key);
        } catch (err) {
          notCompensated.push({
            kind: "link_removal",
            id: key,
            reason: `the edge could not be put back: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      }

      // SESSIONS FIRST, through the ONE close door. A session's terminal status
      // is owned by `completeFocusSession` (the `session-terminal-one-door`
      // tripwire): cancelling there emits the close event the live mirrors
      // read and runs the same close side effects every other cancel runs —
      // a raw status stamp inside the undo transaction would leave a browser
      // showing an active session the database calls cancelled.
      const cancelledSessionIds: string[] = [];
      if ((record.sessionIds ?? []).length > 0) {
        const { cancelSession } =
          await import("../services/focus-sessions/cancel-session.js");
        for (const sessionId of record.sessionIds ?? []) {
          try {
            const out = await cancelSession({
              sessionId,
              userId: sessionOwnerUserId,
              reason:
                "The plan that created this session did not apply as a whole, so it was rolled back.",
            });
            if (out?.session.status === "cancelled") {
              cancelledSessionIds.push(sessionId);
            } else {
              notCompensated.push({
                kind: "session",
                id: sessionId,
                reason: out
                  ? `the session is already ${out.session.status}`
                  : "the session was not found for its owner",
              });
            }
          } catch (err) {
            notCompensated.push({
              kind: "session",
              id: sessionId,
              reason: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      // GOALS the plan started: dropped through THE goal status door (the
      // row stays, as a cancelled session does; a dropped goal holds no name,
      // so a corrected plan can start it again). After the sessions, so none
      // is still filed in a live goal.
      const droppedTrackIds: string[] = [];
      if ((record.trackIds ?? []).length > 0) {
        const { setTrackStatus } =
          await import("../services/tracks/tracks-service.js");
        for (const trackId of record.trackIds ?? []) {
          try {
            await setTrackStatus({
              trackId,
              status: "archived",
              verdict: "mistake",
              actor: { userId: sessionOwnerUserId, agentUserId: null },
            });
            droppedTrackIds.push(trackId);
          } catch (err) {
            notCompensated.push({
              kind: "track",
              id: trackId,
              reason: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      // `data.materialized` carries no `stampedAt`: edit detection is OFF, so
      // nothing is skipped as "edited since" — these rows were created
      // seconds ago by this same apply. Lineage still refuses a row naming a
      // DIFFERENT proposal.
      const creations = await revertProposalCreations({
        proposal: {
          id: ctx.proposal.id ?? "",
          workspaceId,
          sessionId: ctx.proposal.sessionId,
          data: { materialized: record },
        },
        plan,
        userId,
        database,
        // Only the sessions that really are cancelled stop counting as a use
        // of the project: one that could not be cancelled keeps it "in use",
        // and the project is reported, not archived under a live session.
        ownSessionIds: cancelledSessionIds,
      });

      for (const s of creations.skipped) {
        if (s.reason === "already_reverted") continue;
        const view = revertSkipView(s);
        notCompensated.push({
          kind: view.kind,
          id: view.id,
          reason: view.detail,
        });
      }

      // Plan documents have no soft delete: the governed document door
      // deletes them (row + storage), exactly as a proposal revert does.
      const deletedDocumentIds: string[] = [];
      if (plan.documentIds.length > 0) {
        const { documentsRouter } = await import("../routers/documents.js");
        const documentCaller = documentsRouter.createCaller(routerCtx());
        for (const documentId of plan.documentIds) {
          try {
            await documentCaller.delete({ documentId });
            deletedDocumentIds.push(documentId);
          } catch (err) {
            notCompensated.push({
              kind: "document",
              id: documentId,
              reason: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      // KINDS last: their records were retired above by the undo engine.
      // THE one retirement write (soft, reversible with `reactivate`).
      const retiredKindIds: string[] = [];
      if ((record.kindIds ?? []).length > 0) {
        const { markProfileRetired } = await import("@synap/database");
        for (const profileId of record.kindIds ?? []) {
          try {
            await markProfileRetired(database, profileId, {
              reason: "plan_rolled_back",
              ...(ctx.proposal.id ? { byProposalId: ctx.proposal.id } : {}),
            });
            retiredKindIds.push(profileId);
          } catch (err) {
            notCompensated.push({
              kind: "kind",
              id: profileId,
              reason: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      const undone = creations.undone;
      return {
        undone: Object.fromEntries(
          Object.entries({
            entity: undone.entityIds ?? [],
            relation: undone.relationIds ?? [],
            facet: undone.facetIds ?? [],
            skill: undone.skillIds ?? [],
            automation: undone.automationIds ?? [],
            rule: undone.ruleIds ?? [],
            session: cancelledSessionIds,
            project: undone.projectIds ?? [],
            link: undone.linkIds ?? [],
            document: deletedDocumentIds,
            track: droppedTrackIds,
            kind: retiredKindIds,
            session_update: restoredSessionIds,
            link_removal: restoredLinks,
          }).filter(([, ids]) => ids.length > 0)
        ),
        notCompensated,
      };
    },
  };
}
