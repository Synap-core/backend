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
 *              decision)
 *   edge     → `addSessionBlocker` (`blocked_by`) / `recordSessionSpawn`
 *              (`spawned_from`) — the same producers `POST /links` and the
 *              create doors use, floored on the plan's session OWNER
 *   document → `materializeApprovedDocument` (the `document/create` executor's
 *              writer), attached through the governed `entities.update`, and
 *              recorded on a session through `recordSessionArtifact`
 *   undo     → sessions through the ONE close door (`cancelSession` →
 *              `completeFocusSession`, so the close event, run close and
 *              unblock reactor fire as for any cancel), then
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
import { and, eq, links, type db } from "@synap/database";
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
  proposal: { id: string | null; sessionId: string | null };
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

export function buildPlanCallers(ctx: PlanCallerContext): PlanCallers {
  const { database, userId, sessionOwnerUserId, workspaceId } = ctx;

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
        });
        if (out.status !== "created") {
          throw new Error(
            `session "${input.title ?? input.goal}" was routed to a proposal instead of being created`
          );
        }
        return { id: out.session.id };
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
          preExisting: existedBefore !== null,
        };
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
          }).filter(([, ids]) => ids.length > 0)
        ),
        notCompensated,
      };
    },
  };
}
