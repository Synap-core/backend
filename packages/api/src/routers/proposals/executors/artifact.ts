import { TRPCError } from "@trpc/server";
import { db, proposals, eq, artifacts } from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { registerProposalExecutor } from "../execution-registry.js";
import { reportApproved } from "./shared.js";

/** Register the artifact/* approve executors. */
export function registerArtifactExecutors(): void {
  // ── artifact / create ─────────────────────────────────────────────────────
  // Before the payload widening this gate lost `props` — which IS the
  // artifact's content — so an approved proposal created an empty shell with a
  // title and nothing in it. It now carries the full insert shape.
  //
  // NO PROCEDURE TO REPLAY: the direct path is an inline `db.insert(artifacts)`
  // in the REST handler (`hub-protocol/rest/artifacts.ts` POST), not a tRPC
  // mutation, so this mirrors it — including the ONE side effect it does fire,
  // `emitHubRealtimeEvent("artifact.changed.completed")`. Dropping that emit
  // would leave the artifact in the database and invisible in every open
  // client until a manual refresh: present but unseen, which reads to a user
  // as "approval did nothing".
  //
  // DEFAULTS are copied from the direct path rather than re-invented:
  // `state: "working"` and `placement: body.placement ?? "desk"`. The gate
  // already resolved `placement`, so the `?? "desk"` here is only a floor for
  // an older proposal stored before that default existed.
  //
  // WORKSPACE: `artifacts.workspaceId` is NOT NULL and the gate stored the
  // CONFINED value, so a missing lens is a hard refusal, never a pod-wide
  // fallback.
  registerProposalExecutor({
    key: "artifact/create",
    async execute({ proposal, userId, input, deps }) {
      const raw = (proposal.data ?? {}) as Record<string, unknown>;
      const inner = (raw.data ?? raw ?? {}) as Record<string, unknown>;

      const kind = inner.kind as string | undefined;
      const title = inner.title as string | undefined;
      if (!kind || !title) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Artifact proposal is missing kind/title",
        });
      }

      const workspaceId =
        (inner.workspaceId as string | undefined) ??
        proposal.workspaceId ??
        undefined;
      if (!workspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Artifact proposal has no workspace scope — artifacts are workspace-scoped (NOT NULL).",
        });
      }

      // Idempotency: the insert mints a fresh id each run, so a re-approve
      // without this guard would create a second artifact.
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const [created] = await db
        .insert(artifacts)
        .values({
          workspaceId,
          // The direct path stamps the ACTING user. Preserve the author the
          // same way the other create executors do: the agent wrote it, the
          // human only approved it.
          userId: proposal.agentUserId ?? userId,
          kind: kind as (typeof artifacts.$inferInsert)["kind"],
          refId: (inner.refId as string | null) ?? null,
          cellKey: (inner.cellKey as string | null) ?? null,
          props: (inner.props as Record<string, unknown> | null) ?? null,
          title,
          originKind:
            (inner.originKind as (typeof artifacts.$inferInsert)["originKind"]) ??
            "agent",
          actorId: (inner.actorId as string | null) ?? null,
          sessionId: (inner.sessionId as string | null) ?? null,
          state: "working",
          placement:
            (inner.placement as (typeof artifacts.$inferInsert)["placement"]) ??
            "desk",
        })
        .returning();

      // The direct path's realtime emit. Non-fatal: the row is already
      // committed, so a failed notify must never fail the approval (the same
      // policy `tool/create` applies to its grant seed).
      try {
        const { emitHubRealtimeEvent } =
          await import("../../../utils/domain-event-bridge.js");
        emitHubRealtimeEvent({
          eventType: "artifact.changed.completed",
          subjectId: created.id,
          userId,
          data: {
            id: created.id,
            workspaceId: created.workspaceId,
            state: created.state,
            placement: created.placement,
            kind: created.kind,
            title: created.title,
          },
        });
      } catch {
        // Swallowed deliberately — see above.
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
