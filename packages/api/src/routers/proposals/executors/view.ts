import { TRPCError } from "@trpc/server";
import { db, proposals, eq, getWorkspaceMembership } from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { viewsRouter } from "../../views.js";
import type { Context } from "../../../context.js";
import { registerProposalExecutor } from "../execution-registry.js";
import { reportApproved } from "./shared.js";

/** Register the view/* approve executors. */
export function registerViewExecutors(): void {
  // ── view / create ────────────────────────────────────────────────────────────
  // A gated createView (agent-authored — the views router threads agentUserId +
  // source into the gate — or a member whose role lacks `create`) lands here on
  // approval. Without this executor the `*/*` catch-all threw NOT_IMPLEMENTED.
  // Materializes via the SAME viewsRouter.create the direct path uses — re-run as
  // the APPROVER (no agentUserId ⇒ the re-entrant gate auto-grants for the
  // operator authority), so the canvas-document / config / ViewEvents side-effects
  // match the direct create exactly. Pod-wide (null workspace) views run at pod
  // scope; workspace-scoped views verify the approver's membership (entity/create).
  //
  // DATA-SHAPE NOTE: the propose gate (routers/views.ts + hub-protocol/views.ts)
  // stores only { name, type, scopeProfileIds } — enough to materialize a
  // structured view; `config` / `initialContent` (bento layout, canvas content)
  // are NOT carried through the proposal and fall to create-time defaults
  // (create-then-configure). Fields are read defensively so a future gate-`data`
  // widening flows through unchanged.
  registerProposalExecutor({
    key: "view/create",
    async execute({ proposal, userId, input, deps }) {
      const innerData = ((proposal.data as Record<string, unknown>)?.data ??
        {}) as Record<string, unknown>;
      const name = innerData.name as string | undefined;
      const type = innerData.type as string | undefined;
      if (!name || !type) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "View proposal is missing name/type",
        });
      }

      // Idempotency: skip if already materialized (createCaller mints a fresh
      // view id each run).
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      const workspaceId = proposal.workspaceId ?? null;
      let viewCallerCtx: {
        db: typeof db;
        authenticated: true;
        userId: string;
        workspaceId: string | null;
        workspaceRole: string;
      };
      if (workspaceId) {
        const membership = await getWorkspaceMembership(
          db,
          workspaceId,
          userId
        );
        if (!membership) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "No workspace access",
          });
        }
        viewCallerCtx = {
          db,
          authenticated: true as const,
          userId,
          workspaceId,
          workspaceRole: membership.role,
        };
      } else {
        viewCallerCtx = {
          db,
          authenticated: true as const,
          userId,
          workspaceId: null,
          workspaceRole: "owner",
        };
      }

      const viewCaller = viewsRouter.createCaller(
        viewCallerCtx as unknown as Context
      );
      const createArgs = {
        name,
        type,
        workspaceId: workspaceId ?? undefined,
        scopeProfileIds: innerData.scopeProfileIds as string[] | undefined,
        description: innerData.description as string | undefined,
        config: innerData.config as Record<string, unknown> | undefined,
        initialContent: innerData.initialContent,
      };
      await viewCaller.create(
        createArgs as Parameters<typeof viewCaller.create>[0]
      );

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
      return { success: true };
    },
  });
}
