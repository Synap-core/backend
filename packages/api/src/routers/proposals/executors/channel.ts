import { TRPCError } from "@trpc/server";
import {
  db,
  proposals,
  eq,
  and,
  getWorkspaceMembership,
} from "@synap/database";
import {
  ProposalStatus,
  channels,
  channelMembers,
  ChannelType,
  ChannelMemberKind,
  ChannelMemberRole,
} from "@synap/database/schema";
import { channelsRouter } from "../../channels.js";
import type { Context } from "../../../context.js";
import { registerProposalExecutor } from "../execution-registry.js";
import { reportApproved } from "./shared.js";

/** Register the channel/* approve executors. */
export function registerChannelExecutors(): void {
  // ── a2ai / join ──────────────────────────────────────────────────────────
  // The ONLY non-destructive door in this batch, and the only one that is a
  // REAL write with no executor: `postToA2AIChannel`
  // (routers/hub-protocol/channels.ts:561) proposes when an UNKNOWN agent posts
  // into an OPEN A2AI channel. Approving that proposal hit the `*​/*` catch-all,
  // which flips the row APPROVED and inserts nothing — so the agent was told
  // "waiting for user approval", the user approved, and the agent was STILL not
  // a member. Every subsequent post re-proposed. The materializer is no
  // backstop: `materializeWorkspace` handles only `"join"` for the WORKSPACE
  // subject, and this subject is `a2ai`.
  //
  // PAYLOAD: the gate stores FLAT `data: { channelId, agentUserId, topic }`
  // (nested by the request-shaped envelope as `data.data.*`). `topic` is
  // display-only — it exists so the reviewer sees which conversation they are
  // admitting an agent to; the write needs only channelId + agentUserId.
  // `proposal.agentUserId` is the attribution fallback for the joining agent.
  //
  // SECOND EFFECT: the direct (auto-approved) branch is TWO writes — the
  // `channel_members` insert AND an `updatedAt` touch on `channels` (what moves
  // the channel in every recency-ordered list). Both are replayed here.
  //
  // NOT REPLAYED — and this is deliberate, not an omission: the MESSAGE that
  // triggered the proposal is not re-posted. The gate returns `proposed`
  // BEFORE the `messages` insert, so that content was never stored anywhere
  // this executor could read it back; approval grants MEMBERSHIP, and the agent
  // re-posts. Fabricating the message from the proposal is impossible.
  //
  // Hand-written rather than replayed through the router because
  // `postToA2AIChannel` is a `scopedProcedure(["hub-protocol.write"])` whose
  // body also inserts a message, computes a tamper hash and triggers
  // auto-respond — re-running it would post a message no one wrote. The two
  // writes below are byte-for-byte the ones in the auto-approve branch,
  // including the `onConflictDoNothing` target and the default member
  // capability flags (canDraft/canPropose true, canAct false).
  registerProposalExecutor({
    key: "a2ai/join",
    async execute({ proposal, userId, input, deps }) {
      const raw = (proposal.data ?? {}) as Record<string, unknown>;
      const inner = (raw.data ?? {}) as Record<string, unknown>;
      const channelId =
        (inner.channelId as string | undefined) ??
        (raw.channelId as string | undefined) ??
        proposal.targetId;
      const joiningAgentUserId =
        (inner.agentUserId as string | undefined) ??
        (raw.agentUserId as string | undefined) ??
        proposal.agentUserId ??
        undefined;
      if (!channelId || !joiningAgentUserId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "A2AI join proposal is missing channelId/agentUserId",
        });
      }

      // Idempotency: approve is not status-guarded before dispatch.
      const [alreadyDone] = await db
        .select({ status: proposals.status })
        .from(proposals)
        .where(eq(proposals.id, input.proposalId));
      if (alreadyDone?.status === ProposalStatus.APPROVED) {
        return { success: true, alreadyApproved: true };
      }

      // Re-resolve the channel AT APPROVAL TIME and re-assert it is still an
      // A2AI channel — the same `and(id, channelType)` predicate the gate used.
      // A channel that has since been retyped must not gain an agent member.
      const channel = await db.query.channels.findFirst({
        where: and(
          eq(channels.id, channelId),
          eq(channels.channelType, ChannelType.AGENT_COLLAB)
        ),
        columns: { id: true, userId: true, workspaceId: true },
      });
      if (!channel) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "A2AI channel no longer exists",
        });
      }

      // Approver floor, on the CHANNEL's real workspace (never the
      // request-shaped proposal.workspaceId).
      if (channel.workspaceId) {
        const membership = await getWorkspaceMembership(
          db,
          channel.workspaceId,
          userId
        );
        if (!membership) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "No workspace access",
          });
        }
      }

      await db
        .insert(channelMembers)
        .values({
          channelId,
          memberId: joiningAgentUserId,
          memberKind: ChannelMemberKind.AI_AGENT,
          role: ChannelMemberRole.MEMBER,
          addedBy: channel.userId,
        })
        .onConflictDoNothing({
          target: [channelMembers.channelId, channelMembers.memberId],
        });
      await db
        .update(channels)
        .set({ updatedAt: new Date() })
        .where(eq(channels.id, channelId));

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

  // ── channel / unbind ───────────────────────────────────────────────────────
  // Approve a `channel/unbind` proposal (tRPC signal.unbindChannel): clear an
  // ALREADY-BOUND channel's context pointer. Inverse of channel/bind — same
  // membership-floor + governed channelsRouter caller, but delegates to
  // updateChannel with contextObjectType/contextObjectId set to null. NO raw
  // UPDATE here. `branchPurpose` (the firewall role) is DELIBERATELY never
  // touched — unbind only clears WHERE the channel points, never WHAT KIND of
  // channel it is (client-comms stays immutable).
  registerProposalExecutor({
    key: "channel/unbind",
    async execute({ proposal, payload, userId, input, deps }) {
      void payload;
      const outer = (proposal.data ?? {}) as Record<string, unknown>;
      const data = (outer.data ?? outer ?? {}) as Record<string, unknown>;
      const unbindWorkspaceId = proposal.workspaceId || null;
      if (!unbindWorkspaceId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Proposal is missing a valid workspaceId",
        });
      }
      const channelId = data.channelId as string | undefined;
      if (!channelId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "channel/unbind proposal is missing channelId",
        });
      }
      const membership = await getWorkspaceMembership(
        db,
        unbindWorkspaceId,
        userId
      );
      if (!membership) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "No workspace access",
        });
      }
      const unbindCallerCtx = {
        db,
        authenticated: true as const,
        userId,
        workspaceId: unbindWorkspaceId,
        workspaceRole: membership.role,
      };
      const caller = channelsRouter.createCaller(
        unbindCallerCtx as unknown as Context
      );
      await caller.updateChannel({
        channelId,
        contextObjectType: null,
        contextObjectId: null,
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
