import { TRPCError } from "@trpc/server";
import {
  db,
  proposals,
  eq,
  focusSessions,
  recordSessionSpawn,
} from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { emitHubRealtimeEvent } from "../../../utils/domain-event-bridge.js";
import {
  registerProposalExecutor,
  type ProposalEffect,
} from "../execution-registry.js";
import { reportApproved } from "./shared.js";
import {
  isTerminalSessionStatus,
  type TerminalSessionStatus,
} from "../../../services/focus-sessions/session-statuses.js";

/** Register the focus_session/* approve executors. */
export function registerFocusSessionExecutors(): void {
  // ── focus_session / create ──────────────────────────────────────────────────
  // A gated createFocusSession (AI caller in a review-required workspace) lands
  // here on approval. Without this executor the `*/*` catch-all flipped the
  // proposal APPROVED but NEVER inserted the session row — approving a
  // focus-session proposal materialized NOTHING, and update/list/complete (which
  // scope by the operator userId) could never find it. Structure mirrors
  // entity/create; the insert mirrors services/focus-sessions/create-session.ts.
  //
  // Gate data may include subjectEntityId / channelId / expectedOutputs / agentIds
  // (create-session.ts). workspaceId / projectId come from the proposal row.
  // After insert, ensureSessionChannel mints a room if channelId is still null.
  registerProposalExecutor({
    key: "focus_session/create",
    async execute({ proposal, userId, input, deps }) {
      const innerData = ((proposal.data as Record<string, unknown>)?.data ??
        {}) as Record<string, unknown>;
      const goal = innerData.goal as string | undefined;
      if (!goal) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Focus session proposal is missing goal",
        });
      }

      // Idempotency: approve is not status-guarded before dispatch and the row
      // uses a fixed id, so skip if this proposal was already materialized.
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return {
          success: true,
          alreadyApproved: true,
          effect: {
            applied: "none",
            reason:
              "Already approved — this proposal's session row was materialized " +
              "by the winning attempt; a re-approve writes nothing by design.",
          },
        };
      }

      const insertedSessions = await db
        .insert(focusSessions)
        .values({
          // id = proposal.targetId so any link built at propose time resolves.
          id: proposal.targetId,
          workspaceId: proposal.workspaceId,
          projectId: proposal.projectId,
          subjectEntityId:
            (innerData.subjectEntityId as string | undefined) ?? null,
          // userId = the operator/approver so update/list/complete (scoped by
          // operator userId) can resolve this session.
          userId,
          goal,
          templateId: (innerData.templateId as string | undefined) ?? null,
          // Typed origin (migration 0240). Unlike create-session.ts this door
          // does not resolve templateId against the playbooks table, so it
          // cannot know whether the session is a playbook run — but it CAN know
          // it is never an automation run (automation sessions come from
          // openRunSession and never propose). "agent" is what the sniff also
          // returns for these rows (no playbookId, no automation metadata).
          origin: "agent",
          expectedOutputs:
            (innerData.expectedOutputs as unknown[] | undefined) ?? [],
          channelId: (innerData.channelId as string | undefined) ?? null,
          agentIds: (innerData.agentIds as string[] | undefined) ?? [],
          status: "active",
        })
        .onConflictDoNothing()
        .returning();

      // ── THE EFFECT RECEIPT (reference conversion — template for the rest) ──
      // `insertedSessions` is what POSTGRES returned for THIS statement, not a
      // service-layer boolean and not "we reached this line". `onConflictDoNothing`
      // makes ZERO rows a real, reachable outcome (double-approve, or a session
      // row already at `proposal.targetId`), and until now that case still
      // returned a bare `{ success: true }` — an approval reporting a write it
      // did not perform, which is the exact defect this receipt closes.
      // Convert the other executors by doing the same thing: name the statement's
      // own `.returning()` / affected-row count as the evidence, never re-derive
      // it from the code path that decided to write.
      const created = insertedSessions[0];
      const effect: ProposalEffect = {
        applied: "verified",
        rows: insertedSessions.length,
        ids: insertedSessions.map((row) => row.id),
        subject: "focus_session",
      };

      // Detour lineage carried through the proposal (parity with
      // createFocusSession's post-insert step). Owner-floored by the producer
      // against the APPROVER's userId — which is the session's own owner here.
      if (created && typeof innerData.parentSessionId === "string") {
        await recordSessionSpawn({
          childSessionId: created.id,
          parentSessionId: innerData.parentSessionId,
          userId,
          workspaceId: created.workspaceId,
          suspendedIntent:
            typeof innerData.suspendedIntent === "string"
              ? innerData.suspendedIntent
              : null,
        });
      }

      // Gate 2: mint work channel if none (parity with createFocusSession).
      if (created && !created.channelId) {
        const { ensureSessionChannel } =
          await import("../../../services/focus-sessions/ensure-session-channel.js");
        await ensureSessionChannel({
          sessionId: created.id,
          userId,
          workspaceId: created.workspaceId,
          goal: created.goal,
        });
      }

      // Mirror create-session so the browser mirrors the new session live.
      if (created) {
        emitHubRealtimeEvent({
          eventType: "focus_session.create.completed",
          subjectId: created.id,
          userId,
          data: {
            id: created.id,
            workspaceId: created.workspaceId,
            status: created.status,
            goal: created.goal,
            progress: created.progress,
          },
        });
      }

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(proposals.id, input.proposalId));

      // Report to IS telemetry (fire-and-forget — never blocks)
      reportApproved(deps, proposal, input.proposalId);

      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true, effect };
    },
  });

  // ── focus_session / update ──────────────────────────────────────────────────
  // A gated updateFocusSession / completeFocusSession / Hub PATCH lands here on
  // approval. Without this executor the `*/*` catch-all flipped APPROVED but
  // never applied the patch or closed the session. Close reuses completeFocusSession
  // (human authority — no agentUserId) so playbook_run + verificationReport stay
  // consistent with the direct complete door. Non-close applies defined fields
  // via direct db.update and emits focus_session.update.completed.
  registerProposalExecutor({
    key: "focus_session/update",
    async execute({ proposal, userId, input, deps }) {
      // Idempotency: approve is not status-guarded before dispatch.
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const innerData = ((proposal.data as Record<string, unknown>)?.data ??
        {}) as Record<string, unknown>;
      const sessionId = proposal.targetId;

      const session = await db.query.focusSessions.findFirst({
        where: eq(focusSessions.id, sessionId),
      });
      if (!session) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Focus session ${sessionId} not found`,
        });
      }

      // EVERY terminal status routes to the one door, not just the "closed"
      // literal. `cancelled` and `failed` are equally proposable (both doors
      // derive their zod enum from UPDATABLE_SESSION_STATUSES), and gating on
      // one of the three meant approving a "cancel this session" proposal
      // stamped the row raw — no review pack, no running-run close, no
      // session-bound ephemeral expiry, no close event. Derive the branch from
      // the vocabulary so a fourth terminal status can never miss the door.
      // `innerData` is Record<string, unknown>; the guard takes a string.
      const requestedStatus =
        typeof innerData.status === "string" ? innerData.status : undefined;
      if (isTerminalSessionStatus(requestedStatus)) {
        const terminalStatus: TerminalSessionStatus = requestedStatus;
        // Close path: human approve executes complete without re-entering agent
        // governance (no agentUserId from the original proposal).
        try {
          const { completeFocusSession } =
            await import("../../../services/focus-sessions/complete-session.js");
          const result = await completeFocusSession({
            sessionId,
            // Scope by session owner so the service's userId floor resolves.
            userId: session.userId,
            terminalStatus,
            summary:
              typeof innerData.sessionSummary === "string"
                ? innerData.sessionSummary
                : undefined,
            verificationReport:
              innerData.verificationReport != null &&
              typeof innerData.verificationReport === "object" &&
              !Array.isArray(innerData.verificationReport)
                ? (innerData.verificationReport as Record<string, unknown>)
                : undefined,
          });
          if (!result) {
            // complete returned null (ownership miss / gone) — only OK if
            // the session is already closed (idempotent re-approve).
            if (session.status !== terminalStatus) {
              const again = await db.query.focusSessions.findFirst({
                where: eq(focusSessions.id, sessionId),
                columns: { status: true },
              });
              if (again?.status !== terminalStatus) {
                throw new TRPCError({
                  code: "BAD_REQUEST",
                  message: `Focus session ${sessionId} could not be completed`,
                });
              }
            }
          }
        } catch (err) {
          if (err instanceof TRPCError) throw err;
          const e = err as {
            code?: string;
            proposalId?: string;
            message?: string;
          };
          // complete re-proposed under human authority — should not happen
          // (DEFAULT_AUTO_APPROVE + no agentUserId). Surface clearly.
          if (e.code === "FORBIDDEN" && e.proposalId) {
            throw new TRPCError({
              code: "BAD_REQUEST",
              message:
                "Focus session close was re-proposed during approve — unexpected for human authority. " +
                (e.message ?? "approval required"),
            });
          }
          throw err;
        }
      } else {
        // Non-close update: apply only defined scalar fields from gate data.
        const set: Partial<typeof focusSessions.$inferInsert> = {
          updatedAt: new Date(),
        };
        if (typeof innerData.status === "string") {
          set.status = innerData.status as NonNullable<
            typeof focusSessions.$inferInsert.status
          >;
        }
        if (typeof innerData.progress === "number") {
          set.progress = innerData.progress;
        }
        if (typeof innerData.goal === "string") {
          set.goal = innerData.goal;
        }
        if (typeof innerData.currentStage === "string") {
          set.currentStage = innerData.currentStage;
        }

        // Roster append. Carried by BOTH proposing doors (`update-session.ts`
        // and the Hub PATCH) so the PROPOSED path is not a silent no-op —
        // approving a "staff this session" proposal that changed nothing is the
        // authoring↔runtime fork this codebase keeps paying for. Applied via
        // the ONE append door, floored on the session's OWN owner (the approver
        // may be a different human).
        if (typeof innerData.addAgentId === "string") {
          const { attachSessionAgent } =
            await import("../../../services/focus-sessions/attach-session-agent.js");
          await attachSessionAgent({
            sessionId,
            agentId: innerData.addAgentId,
            userId: session.userId,
          });
        }

        const [updated] = await db
          .update(focusSessions)
          .set(set)
          .where(eq(focusSessions.id, sessionId))
          .returning();

        if (updated) {
          emitHubRealtimeEvent({
            eventType: "focus_session.update.completed",
            subjectId: updated.id,
            userId,
            data: {
              id: updated.id,
              workspaceId: updated.workspaceId,
              status: updated.status,
              goal: updated.goal,
              progress: updated.progress,
            },
          });
        }
      }

      await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(proposals.id, input.proposalId));

      reportApproved(deps, proposal, input.proposalId);

      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true };
    },
  });
}
