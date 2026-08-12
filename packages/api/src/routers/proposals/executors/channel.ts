import { TRPCError } from "@trpc/server";
import { db, proposals, eq, getWorkspaceMembership } from "@synap/database";
import { ProposalStatus } from "@synap/database/schema";
import { channelsRouter } from "../../channels.js";
import type { Context } from "../../../context.js";
import { registerProposalExecutor } from "../execution-registry.js";
import { reportApproved } from "./shared.js";

/** Register the channel/* approve executors. */
export function registerChannelExecutors(): void {
  // ── channel / create_branch ────────────────────────────────────────────────
  registerProposalExecutor({
    key: "channel/create_branch",
    async execute({ proposal, payload, userId, input, deps }) {
      void payload;
      const data = (proposal.data ?? {}) as Record<string, unknown>;
      const branchWorkspaceId = proposal.workspaceId || null;
      if (!branchWorkspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Proposal is missing a valid workspaceId",
        });
      }
      const membership = await getWorkspaceMembership(
        db,
        branchWorkspaceId,
        userId
      );
      if (!membership) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "No workspace access",
        });
      }
      const branchCallerCtx = {
        db,
        authenticated: true as const,
        userId,
        workspaceId: branchWorkspaceId,
        workspaceRole: membership.role,
      };
      const caller = channelsRouter.createCaller(
        branchCallerCtx as unknown as Context
      );
      await caller.createChannel({
        parentChannelId: data.parentChannelId as string,
        branchPurpose: data.branchPurpose as string,
        agentId: data.agentId as string | undefined,
        agentConfig: data.agentConfig as Record<string, unknown> | undefined,
        inheritContext: (data.inheritContext as boolean) ?? true,
      });

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

  // ── channel / merge_branch ─────────────────────────────────────────────────
  registerProposalExecutor({
    key: "channel/merge_branch",
    async execute({ proposal, payload, userId, input, deps }) {
      void payload;
      const data = (proposal.data ?? {}) as Record<string, unknown>;
      const mergeWorkspaceId = proposal.workspaceId || null;
      if (!mergeWorkspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Proposal is missing a valid workspaceId",
        });
      }
      const membership = await getWorkspaceMembership(
        db,
        mergeWorkspaceId,
        userId
      );
      if (!membership) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "No workspace access",
        });
      }
      const mergeCallerCtx = {
        db,
        authenticated: true as const,
        userId,
        workspaceId: mergeWorkspaceId,
        workspaceRole: membership.role,
      };
      const caller = channelsRouter.createCaller(
        mergeCallerCtx as unknown as Context
      );
      await caller.mergeBranch({
        branchId: data.branchId as string,
        summary: data.summary as string | undefined,
      });

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

  // ── channel / create_external ──────────────────────────────────────────────
  registerProposalExecutor({
    key: "channel/create_external",
    async execute({ proposal, payload, userId, input, deps }) {
      void payload;
      const data = (proposal.data ?? {}) as Record<string, unknown>;
      const extWorkspaceId = proposal.workspaceId || null;
      if (!extWorkspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Proposal is missing a valid workspaceId",
        });
      }
      const membership = await getWorkspaceMembership(
        db,
        extWorkspaceId,
        userId
      );
      if (!membership) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "No workspace access",
        });
      }
      const extCallerCtx = {
        db,
        authenticated: true as const,
        userId,
        workspaceId: extWorkspaceId,
        workspaceRole: membership.role,
      };
      const caller = channelsRouter.createCaller(
        extCallerCtx as unknown as Context
      );
      await caller.createExternalChannel({
        externalSource: data.externalSource as string,
        externalChannelId: data.externalChannelId as string,
        title: data.title as string,
        externalParticipants: data.externalParticipants as string[] | undefined,
        initialMessage: data.initialMessage as string | undefined,
        metadata: data.metadata as Record<string, unknown> | undefined,
      });

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

  // ── channel / bind ─────────────────────────────────────────────────────────
  // Approve a bindChannel proposal (hub-protocol channels.bindChannel): point an
  // ALREADY-EXISTING channel at a context object, optionally stamping the firewall
  // role. Structurally identical to create_external — resolve the membership floor,
  // build the governed channelsRouter caller, and DELEGATE the write to
  // updateChannel (which sets context_object_id and routes branchPurpose through
  // the setChannelBranchPurpose one-door). NO raw UPDATE here.
  //
  // Data shape: the bind door files via checkPermissionOrPropose(source:
  // "intelligence") → createProposal, which stores the gate data REQUEST-SHAPED
  // (nested under proposal.data.data), like entity/create. We read nested-first
  // with a flat fallback so the executor is robust to either envelope.
  //
  // FIREWALL: updateChannel wraps setChannelBranchPurpose and rethrows a
  // ChannelFirewallImmutableError as FORBIDDEN — so approving a bind that would
  // flip an already-client-comms channel FAILS LOUDLY (the proposal lands in
  // APPROVAL_FAILED), never silently reclassifying a real client's conversation.
  registerProposalExecutor({
    key: "channel/bind",
    async execute({ proposal, payload, userId, input, deps }) {
      void payload;
      const outer = (proposal.data ?? {}) as Record<string, unknown>;
      const data = (outer.data ?? outer ?? {}) as Record<string, unknown>;
      const bindWorkspaceId = proposal.workspaceId || null;
      if (!bindWorkspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Proposal is missing a valid workspaceId",
        });
      }
      const channelId = data.channelId as string | undefined;
      const contextObjectId = data.contextObjectId as string | undefined;
      if (!channelId || !contextObjectId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "channel/bind proposal is missing channelId or contextObjectId",
        });
      }
      const membership = await getWorkspaceMembership(
        db,
        bindWorkspaceId,
        userId
      );
      if (!membership) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "No workspace access",
        });
      }
      const bindCallerCtx = {
        db,
        authenticated: true as const,
        userId,
        workspaceId: bindWorkspaceId,
        workspaceRole: membership.role,
      };
      const caller = channelsRouter.createCaller(
        bindCallerCtx as unknown as Context
      );
      await caller.updateChannel({
        channelId,
        contextObjectType:
          (data.contextObjectType as
            "entity" | "document" | "view" | undefined) ?? "entity",
        contextObjectId,
        ...(typeof data.branchPurpose === "string"
          ? { branchPurpose: data.branchPurpose }
          : {}),
      });

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
