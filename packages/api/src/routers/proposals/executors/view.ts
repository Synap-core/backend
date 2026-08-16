import { TRPCError } from "@trpc/server";
import {
  db,
  proposals,
  eq,
  and,
  getWorkspaceMembership,
} from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { viewsRouter } from "../../views.js";
import type { Context } from "../../../context.js";
import { registerProposalExecutor } from "../execution-registry.js";
import { reportApproved } from "./shared.js";

function isUniqueViolation(err: unknown): boolean {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur && typeof cur === "object"; i++) {
    const rec = cur as { code?: string; cause?: unknown; message?: string };
    if (rec.code === "23505") return true;
    if (
      typeof rec.message === "string" &&
      /duplicate key|unique constraint/i.test(rec.message)
    ) {
      return true;
    }
    cur = rec.cause;
  }
  return false;
}

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
  // Gate data is the FULL create payload (id, name, type, config, …). We
  // re-run viewsRouter.create with that reserved id so approve does not mint
  // an empty clone. Unique PK on views.id is the lock against double-approve.
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
      const reservedId =
        (typeof innerData.id === "string" && innerData.id) ||
        (typeof proposal.targetId === "string" && proposal.targetId) ||
        undefined;
      const createArgs = {
        id: reservedId,
        name,
        type,
        workspaceId: workspaceId ?? undefined,
        scopeProfileIds: innerData.scopeProfileIds as string[] | undefined,
        scopeMode: innerData.scopeMode as "explicit" | "observed" | undefined,
        description: innerData.description as string | undefined,
        query: innerData.query as Record<string, unknown> | undefined,
        config: innerData.config as Record<string, unknown> | undefined,
        embeddedViewIds: innerData.embeddedViewIds as string[] | undefined,
        metadata: innerData.metadata as Record<string, unknown> | undefined,
        initialContent: innerData.initialContent,
      };
      try {
        await viewCaller.create(
          createArgs as Parameters<typeof viewCaller.create>[0]
        );
      } catch (err) {
        // Second approve: the reserved id is already the view row.
        // Drizzle / postgres.js / TRPC wrap 23505 at different depths.
        if (!isUniqueViolation(err)) throw err;
      }

      const [claimed] = await db
        .update(proposals)
        .set({
          status: ProposalStatus.APPROVED,
          reviewedBy: userId,
          reviewedAt: new Date(),
          updatedAt: new Date(),
          ...(reservedId ? { targetId: reservedId } : {}),
        })
        .where(
          and(
            eq(proposals.id, input.proposalId),
            eq(proposals.status, ProposalStatus.PENDING)
          )
        )
        .returning({ id: proposals.id });

      if (!claimed) {
        return { success: true, alreadyApproved: true };
      }

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
