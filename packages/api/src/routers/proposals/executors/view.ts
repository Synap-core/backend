import { TRPCError } from "@trpc/server";
import {
  db,
  proposals,
  eq,
  and,
  getWorkspaceMembership,
  isUniqueViolation,
} from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { createLogger } from "@synap-core/core";
import { sanitizeStoredViewFilters } from "@synap-core/types";
import { viewsRouter } from "../../views.js";
import type { Context } from "../../../context.js";
import { registerProposalExecutor } from "../execution-registry.js";
import {
  isViewContentProposalApproved,
  loadViewContentTarget,
  markViewContentProposalApproved,
} from "../../../services/views/view-content-proposal.js";
import { reportApproved } from "./shared.js";

const logger = createLogger({ module: "proposal-executor-view" });

/**
 * A pending proposal's `query.filters` were authored before `views.create`
 * validated them. Repair them with the SAME stored-filter normaliser
 * `views.execute` / `views.update` use, and drop (logged) what cannot be
 * repaired — so approving an old proposal still materializes the view the
 * reviewer saw, instead of failing at the create door.
 */
function normaliseProposalViewQuery(
  proposalId: string,
  query: unknown
): Record<string, unknown> | undefined {
  if (!query || typeof query !== "object" || Array.isArray(query)) {
    return undefined;
  }
  const q = query as Record<string, unknown>;
  if (q.filters === undefined) return q;
  const { filters, dropped } = sanitizeStoredViewFilters(q.filters);
  if (dropped.length > 0) {
    logger.warn(
      { proposalId, dropped },
      "view/create approval: dropped proposal filters outside the filter grammar"
    );
  }
  return { ...q, filters };
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
        query: normaliseProposalViewQuery(input.proposalId, innerData.query),
        config: innerData.config as Record<string, unknown> | undefined,
        embeddedViewIds: innerData.embeddedViewIds as string[] | undefined,
        metadata: innerData.metadata as Record<string, unknown> | undefined,
        initialContent: innerData.initialContent,
        // The project pin (W2a) — the reviewer approved a PINNED view.
        projectId:
          typeof innerData.projectId === "string"
            ? innerData.projectId
            : undefined,
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

  // ── view / updateContent ─────────────────────────────────────────────────────
  // The hub door (hub-protocol/views.ts `updateContent`) gates an agent's canvas
  // content write and files the FULL write payload
  // `{ id, version, store, elements, embeddedEntities }`. Without this executor
  // the `*/*` catch-all flipped the proposal APPROVED, emitted `.validated`, and
  // the materializer's `materializeView` matched no action: a green approval
  // that wrote nothing.
  //
  // Replays through the SAME viewsRouter.updateContent the direct path calls,
  // as the APPROVER (mirrors view/create above): `assertViewAccess(…, "write")`
  // inside it is the floor, and the content validation, document version
  // snapshot and whiteboard reload broadcast all match the direct write.
  registerProposalExecutor({
    key: "view/updateContent",
    async execute({ proposal, userId, input, ctx, deps }) {
      const innerData = ((proposal.data as Record<string, unknown>)?.data ??
        {}) as Record<string, unknown>;
      const viewId =
        (typeof innerData.id === "string" && innerData.id) ||
        (typeof proposal.targetId === "string" && proposal.targetId) ||
        undefined;
      const version = innerData.version;
      if (!viewId || typeof version !== "number") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "View content proposal is missing the view id or version",
        });
      }

      // Idempotency: every replay writes a new document version, so a second
      // approve must not re-apply.
      if (await isViewContentProposalApproved(input.proposalId)) {
        return { success: true, alreadyApproved: true };
      }

      // The workspace comes from the VIEW ROW, never from the proposal.
      const view = await loadViewContentTarget(viewId);
      if (!view) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "View to update no longer exists",
        });
      }
      const membership = view.workspaceId
        ? await getWorkspaceMembership(db, view.workspaceId, userId)
        : null;
      if (view.workspaceId && !membership) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "No workspace access",
        });
      }

      const viewCaller = viewsRouter.createCaller({
        db,
        authenticated: true as const,
        userId,
        workspaceId: view.workspaceId ?? null,
        workspaceRole: membership?.role ?? "owner",
        socketIO: ctx.socketIO,
      } as unknown as Context);
      await viewCaller.updateContent({
        viewId,
        version,
        store: innerData.store as Record<string, unknown> | undefined,
        elements: innerData.elements as unknown[] | undefined,
        embeddedEntities: innerData.embeddedEntities as string[] | undefined,
      });

      await markViewContentProposalApproved(input.proposalId, userId);

      reportApproved(deps, proposal, input.proposalId);

      deps.emitProposalReviewed(
        input.proposalId,
        proposal.workspaceId,
        "approved",
        userId
      );
      return { success: true, primaryId: viewId };
    },
  });
}
