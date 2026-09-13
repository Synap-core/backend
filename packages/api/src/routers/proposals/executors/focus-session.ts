import { TRPCError } from "@trpc/server";
import type { ExpectedOutput } from "@synap/playbooks";
import {
  db,
  proposals,
  eq,
  focusSessions,
  recordSessionSpawn,
} from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
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
import {
  applyOutputMutations,
  expectedOutputWireSchema,
  sanitizeDeclaredOutputs,
} from "../../../services/focus-sessions/update-session.js";
import { updateExpectedOutputsLocked } from "../../../services/focus-sessions/delegate-output.js";
import { addCreateTimeBlockers } from "../../../services/focus-sessions/session-blocked-by.js";
import {
  normalizeSessionTitle,
  SESSION_TITLE_MAX,
} from "@synap-core/types/focus-sessions";
import { z } from "zod";

/**
 * A title from a stored payload: one line, blank ⇒ null, over the column bound
 * ⇒ null (the payload predates a door that would have refused it; writing it
 * would throw on the varchar, and a clipped name is a claim nobody made).
 */
function storedTitle(value: unknown): string | null {
  const title = normalizeSessionTitle(typeof value === "string" ? value : null);
  return title && title.length <= SESSION_TITLE_MAX ? title : null;
}

const logger = createLogger({
  module: "proposal-approve-executors-focus-session",
});

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
          title: storedTitle(innerData.title),
          goal,
          templateId: (innerData.templateId as string | undefined) ?? null,
          // Typed origin (migration 0240). Unlike create-session.ts this door
          // does not resolve templateId against the playbooks table, so it
          // cannot know whether the session is a playbook run — but it CAN know
          // it is never an automation run (automation sessions come from
          // openRunSession and never propose). "agent" is what the sniff also
          // returns for these rows (no playbookId, no automation metadata).
          origin: "agent",
          // THE FLOOR, on the door an AI caller actually takes.
          //
          // `create-session.ts` sanitizes its DIRECT insert, but an AI caller
          // is precisely the one routed through a proposal — so for a while
          // this branch inserted the caller's array verbatim, and every receipt
          // the floor exists to refuse (`attestedBy` naming a human who never
          // looked, `retiredAt` making the slot invisible to `owedSlotWhere`
          // from birth, `status: "done"`) landed here one approval later. The
          // `owedSince` invariant was lost too: an `owner: 'human'` slot
          // inserted with no clock for the owed board to age it by.
          //
          // Sanitizing HERE and not only at the propose site is deliberate:
          // this is the write, and a payload can sit in the proposals table for
          // weeks between the two. `now` is approval time, which is the moment
          // the slot actually becomes owed.
          expectedOutputs: sanitizeDeclaredOutputs(
            (innerData.expectedOutputs as ExpectedOutput[] | undefined) ?? []
          ),
          channelId: (innerData.channelId as string | undefined) ?? null,
          agentIds: (innerData.agentIds as string[] | undefined) ?? [],
          status: "active",
          // A playbook-instantiate proposal (routers/playbooks.ts) carries the
          // rendered goalTemplate as `prompt` alongside the title in `goal` —
          // the same split instantiateSession writes directly. Stamp it so the
          // approved path does not silently drop the agent's instruction.
          // Absent on every other focus_session/create proposal ⇒ {} default.
          ...(typeof innerData.prompt === "string" && innerData.prompt.trim()
            ? { metadata: { prompt: innerData.prompt } }
            : {}),
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
      // createFocusSession's post-insert step). WHOSE FLOOR: the principal the
      // proposal was filed for (`subjectUserId`), never the approver — the
      // parent id in `data` was authored by the proposer, and flooring on an
      // approving admin let the edge name the ADMIN's own session. Same rule
      // as the blockers below and `applyApprovedBlockedBy`.
      // Best-effort by CONTRACT (founder decision, 2026-09-07): this runs AFTER
      // the session row is already committed above, so a lineage-edge failure
      // must never fail the approval — the session exists either way. Without
      // this catch, an unexpected `recordSessionSpawn` throw (a transport blip,
      // a malformed handle) would propagate to `dispatchProposalApproval`,
      // which records the whole approval as a TERMINAL FAILURE and re-throws,
      // even though the session was successfully created.
      // Best-effort is not SILENT: a missed edge lands on `refusals`, the
      // result's documented partial-application channel.
      const lineageRefusals: string[] = [];
      if (
        created &&
        typeof innerData.parentSessionId === "string" &&
        !proposal.subjectUserId
      ) {
        lineageRefusals.push(
          `Parent session ${innerData.parentSessionId} was not linked: the proposal records no owner (subject_user_id).`
        );
      } else if (created && typeof innerData.parentSessionId === "string") {
        try {
          const spawn = await recordSessionSpawn({
            childSessionId: created.id,
            parentSessionId: innerData.parentSessionId,
            userId: proposal.subjectUserId as string,
            workspaceId: created.workspaceId,
            suspendedIntent:
              typeof innerData.suspendedIntent === "string"
                ? innerData.suspendedIntent
                : null,
          });
          if (!spawn.linked) {
            lineageRefusals.push(
              `Parent session ${innerData.parentSessionId} was not linked (${spawn.reason}): it must exist and belong to the session's owner.`
            );
          }
        } catch (err) {
          logger.warn(
            {
              err,
              sessionId: created.id,
              parentSessionId: innerData.parentSessionId,
            },
            "recordSessionSpawn failed — session kept, spawned_from edge not written"
          );
          lineageRefusals.push(
            `Parent session ${innerData.parentSessionId} was not linked: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      // Create-time blockers carried through the proposal, written through the
      // SAME door as the direct path. No `agentUserId`: this approval IS the
      // human decision. WHOSE FLOOR: the principal the proposal was filed for
      // (`subjectUserId`), never the approver — the ids in `data` were authored
      // by the proposer, and flooring on an approving admin would let them name
      // the admin's sessions (see `applyApprovedBlockedBy`). The new row is the
      // approver's, so an approver who is not that principal floors out and is
      // told so, rather than linking across owners.
      const blockedByIds = Array.isArray(innerData.blockedBySessionIds)
        ? innerData.blockedBySessionIds.filter(
            (id): id is string => typeof id === "string"
          )
        : [];
      if (created && blockedByIds.length > 0) {
        const floorUserId = proposal.subjectUserId;
        if (!floorUserId) {
          lineageRefusals.push(
            `Blockers ${blockedByIds.join(", ")} were not linked: the proposal records no owner (subject_user_id).`
          );
        } else {
          const reports = await addCreateTimeBlockers({
            sessionId: created.id,
            blockerSessionIds: blockedByIds,
            userId: floorUserId,
          });
          for (const r of reports) {
            if (r.status === "failed") {
              lineageRefusals.push(
                `Blocker session ${r.blockerSessionId} was not linked (${r.reason})${r.message ? `: ${r.message}` : ""}.`
              );
            }
          }
        }
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
      return {
        success: true,
        effect,
        ...(lineageRefusals.length > 0 ? { refusals: lineageRefusals } : {}),
      };
    },
  });

  // ── focus_session / update ──────────────────────────────────────────────────
  // A gated updateFocusSession / completeFocusSession / Hub PATCH lands here on
  // approval. Without this executor the `*/*` catch-all flipped APPROVED but
  // never applied the patch or closed the session. EVERY terminal status
  // (closed | cancelled | failed) reuses completeFocusSession
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

      // Parts of the approved patch the pod DECLINED to apply. Reported on the
      // result rather than thrown: the rest of the update legitimately landed,
      // and failing the whole approval would leave the proposal pending after a
      // partial write.
      let outputRefusals: string[] = [];

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
        // Terminal path: human approve executes complete without re-entering
        // agent governance (no agentUserId from the original proposal).
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
            // ANY terminal state satisfies this, not just the one requested:
            // a session another path already `failed` must not error here just
            // because this proposal asked for `cancelled`. The lifecycle has
            // exited, which is what the approval was asking for.
            if (!isTerminalSessionStatus(session.status)) {
              const again = await db.query.focusSessions.findFirst({
                where: eq(focusSessions.id, sessionId),
                columns: { status: true },
              });
              if (!isTerminalSessionStatus(again?.status)) {
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
        // `null` (or blank) is the CLEAR — same explicit arm as the subject.
        if (innerData.title === null || typeof innerData.title === "string") {
          set.title = storedTitle(innerData.title);
        }
        if (typeof innerData.currentStage === "string") {
          set.currentStage = innerData.currentStage;
        }
        // SUBJECT anchor. Carried by both proposing doors; hand-listing the set
        // above is exactly how the deliverables half went unapplied for months,
        // so a field added to the gate payload is added HERE in the same hunk.
        // `null` is the CLEAR and must survive — hence the explicit null arm
        // rather than a `typeof === "string"` test that would silently drop it.
        if (
          innerData.subjectEntityId === null ||
          typeof innerData.subjectEntityId === "string"
        ) {
          set.subjectEntityId = innerData.subjectEntityId;
        }

        // DELIVERABLES. Carried into the gate payload by both proposing doors
        // and, until 2026-09-08, applied by NEITHER: the field set above was
        // hand-listed as status/progress/goal/currentStage, so approving a
        // proposal that declared a blocker, appended a slot or marked one
        // complete returned SUCCESS and changed nothing — a receipt for a change
        // that never happened, which is worse than a refusal.
        //
        // Applied through `applyOutputMutations` — the SAME function the direct
        // write uses, so the merge (and therefore the no-erasure rule and the
        // `owner: 'human'` completion floor) cannot fork between the ungated and
        // the approved path — inside the SAME row lock the direct write takes.
        outputRefusals = await applyProposedOutputMutations(
          sessionId,
          innerData
        );

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
      return {
        success: true,
        ...(outputRefusals.length > 0 ? { refusals: outputRefusals } : {}),
      };
    },
  });
}

/**
 * Re-apply the deliverable half of an approved `focus_session/update`.
 *
 * The gate payload is untyped JSONB by the time it reaches here, so each field
 * is PARSED with the same wire schema the proposing door parsed it with rather
 * than cast — a payload that has been sitting in the queue since before a schema
 * change must fail closed on its bad half, not write it.
 *
 * No-op (and no lock taken) when the proposal carried no output mutation at all.
 *
 * Returns the human-readable refusals the shared applier reported, so approving
 * a proposal whose `completeOutput` the governance floor declined does not hand
 * the reviewer a bare success for a change that did not happen. The rest of the
 * patch still lands — a wholesale update must not be lost because one slot was
 * the human's.
 */
async function applyProposedOutputMutations(
  sessionId: string,
  innerData: Record<string, unknown>
): Promise<string[]> {
  const expectedOutputs = z
    .array(expectedOutputWireSchema)
    .safeParse(innerData.expectedOutputs);
  const addOutput = AddOutputSchema.safeParse(innerData.addOutput);
  const completeOutput =
    typeof innerData.completeOutput === "string"
      ? innerData.completeOutput
      : undefined;

  const patch = {
    ...(expectedOutputs.success
      ? { expectedOutputs: expectedOutputs.data }
      : {}),
    ...(addOutput.success ? { addOutput: addOutput.data } : {}),
    ...(completeOutput !== undefined ? { completeOutput } : {}),
  };
  if (Object.keys(patch).length === 0) return [];

  const refusals: string[] = [];
  await updateExpectedOutputsLocked(sessionId, (current) => {
    const applied = applyOutputMutations(current, patch);
    if (
      applied.completeOutput &&
      applied.completeOutput.result !== "completed"
    ) {
      refusals.push(
        applied.completeOutput.message ??
          `"${applied.completeOutput.label}" was not marked done.`
      );
    }
    return applied.outputs;
  });
  return refusals;
}

/**
 * `addOutput`'s wire shape. The three ownership fields ride the same schema the
 * MCP door advertises; everything else about the slot is server-owned and is
 * NOT accepted from a stored payload.
 */
const AddOutputSchema = expectedOutputWireSchema.pick({
  kind: true,
  label: true,
  icon: true,
  owner: true,
  blockedReason: true,
  why: true,
});
