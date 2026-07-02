/**
 * Built-in capability verbs (Tier-0) — first-party Synap operations exposed
 * through the SAME capability substrate as external connector verbs.
 *
 * A `kind:'builtin'` skill carries neither code nor a providerSpec; its NAME
 * (= verbId) resolves to a handler here that runs IN-PROCESS by calling the
 * existing governed router/service. No Intelligence Service, no isolate, no
 * external HTTP — the correct vehicle for in-process DB ops (the provider-verb
 * tier is HTTP-to-external only; the code tier round-trips through the IS).
 *
 * GOVERNANCE: each handler delegates to a governed service that runs its OWN
 * permission check (e.g. checkPermissionOrPropose). The capability-level gate in
 * executeCapability still applies to the builtin SKILL (approval + grant), so an
 * owner running their own seeded builtin verb passes straight through; the
 * handler's service is the authoritative gate on the underlying write.
 *
 * Registry starts EMPTY — the `synap-core` built-in capability (W5) registers
 * the pilot verbs (channel.create, feed.post). Adding a handler here is the ONLY
 * way a builtin verb becomes runnable, so the surface is explicit + auditable.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  db,
  eq,
  channels,
  getWorkspaceMembership,
  insertChannelMessage,
} from "@synap/database";
import type { Context } from "../../context.js";
import {
  placeArtboardDeck,
  ArtboardDeckSlideSchema,
  BoardPlacementOptionsSchema,
} from "./place-artboard-deck.js";
import { triageEmails } from "../mail-feed/triage.js";

export interface BuiltinVerbContext {
  /** The acting operator (bearer's user id). */
  userId: string;
  /** Acting workspace lens, or null for a pod-wide run. */
  workspaceId: string | null;
}

export type BuiltinVerbHandler = (
  params: Record<string, unknown>,
  ctx: BuiltinVerbContext
) => Promise<unknown>;

// ── Pilot handlers (W5) ───────────────────────────────────────────────────────
//
// Each handler runs POST-gate (executeCapability already gated the builtin skill)
// and delegates to the EXISTING in-process governed path — it never raw-inserts
// or reimplements the operation:
//   channel.create → the governed `channelsRouter.createChannel` caller (a
//                    workspaceProcedure that re-checks membership + role).
//   feed.post      → `insertChannelMessage` (@synap/database), the ONE shared
//                    channel-message writer that also mirrors to a bound Discord
//                    channel (the same primitive the mail-feed + event-sync feed
//                    producers use). It preserves the hash-chain insert + mirror.
//
// `channelsRouter` is imported dynamically inside the handler: this module is
// imported at top-level by execute-capability.ts, and the channels router pulls
// in a large dependency graph — a lazy import keeps the module-load order free of
// any accidental cycle (mirrors how the hub proactive route lazy-imports helpers).

/** channel.create — create a channel through the governed createChannel caller. */
const channelCreateParams = z.object({
  /** Optional channel title (main AI channel). */
  title: z.string().max(500).optional(),
  /** Assign an agent by slug (resolved to a UUID server-side by createChannel). */
  agentSlug: z.string().max(100).optional(),
  /** When set, create a branch under this parent instead of a main channel. */
  parentChannelId: z.string().uuid().optional(),
  branchPurpose: z.string().max(500).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const channelCreateHandler: BuiltinVerbHandler = async (params, ctx) => {
  const input = channelCreateParams.parse(params);

  // Channels are workspace-scoped (createChannel is a workspaceProcedure): a
  // builtin channel.create needs an acting workspace lens, not a pod-wide run.
  if (!ctx.workspaceId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "channel.create requires a workspace context (workspaceId).",
    });
  }

  // Rebuild the operator's governed caller context exactly like the proposal
  // approve-executors do (getWorkspaceMembership → role), so the workspaceProcedure
  // membership guard passes and the write is attributed to the operator.
  const membership = await getWorkspaceMembership(
    db,
    ctx.workspaceId,
    ctx.userId
  );
  if (!membership) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "No access to the acting workspace.",
    });
  }

  const { channelsRouter } = await import("../../routers/channels.js");
  const caller = channelsRouter.createCaller({
    db,
    authenticated: true as const,
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    workspaceRole: membership.role,
  } as unknown as Context);

  const result = await caller.createChannel({
    title: input.title,
    agentSlug: input.agentSlug,
    parentChannelId: input.parentChannelId,
    branchPurpose: input.branchPurpose,
    metadata: input.metadata,
  });

  return { channelId: result.channelId };
};

/** feed.post — post a message into a channel via the mirror-preserving writer. */
const feedPostParams = z.object({
  channelId: z.string().uuid(),
  content: z.string().min(1).max(10000),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const feedPostHandler: BuiltinVerbHandler = async (params, ctx) => {
  const input = feedPostParams.parse(params);

  // Lightweight existence guard — a clean 404 instead of a downstream FK error,
  // and (when the channel is workspace-scoped) confine posting to the operator's
  // acting workspace. The capability gate already governs THAT this operator may
  // run feed.post; this only bounds WHICH channel the run may target.
  const [channel] = await db
    .select({ id: channels.id, workspaceId: channels.workspaceId })
    .from(channels)
    .where(eq(channels.id, input.channelId))
    .limit(1);
  if (!channel) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Channel not found." });
  }
  if (
    channel.workspaceId &&
    ctx.workspaceId &&
    channel.workspaceId !== ctx.workspaceId
  ) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Channel is not in the acting workspace.",
    });
  }

  // insertChannelMessage is THE shared channel writer: hash-chain insert + Discord
  // mirror if the channel is bound. Do NOT reimplement posting — reuse it, exactly
  // as the mail-feed / event-sync feed producers do.
  const result = await insertChannelMessage({
    channelId: input.channelId,
    content: input.content,
    userId: ctx.userId,
    metadata: input.metadata,
  });

  return {
    messageId: result.messageId,
    mirrored: result.mirrored,
  };
};

/**
 * output.generate — place a multi-slide artboard deck (carousel/deck) onto a
 * whiteboard, IN-PROCESS, through the SAME `placeArtboardDeck` emit the Hub REST
 * `POST /whiteboards/:viewId/place` route calls. This is the governed, discoverable
 * capability surface for "generate output": any client finds it via
 * list_capabilities and runs it via run_capability, while the existing IS-tool →
 * /whiteboards/place path keeps working unchanged (hybrid, not a migration).
 *
 * The args mirror the existing place resource: a board id (viewId) + workspace
 * lens + the artboard-deck fields (preset, title, slides[{html,title?}]). The
 * emit itself is NOT reimplemented here — it delegates to the shared function so
 * the socket event shape has exactly one home.
 */
const outputGenerateParams = z.object({
  /** The whiteboard view id (board) to place the deck onto. */
  boardId: z.string().uuid(),
  /** Deck preset (e.g. a layout/style key the board client understands). */
  preset: z.string().min(1),
  /** Optional deck title. */
  title: z.string().max(500).optional(),
  /** One or more slides, each with HTML content + optional title. */
  slides: z.array(ArtboardDeckSlideSchema).min(1),
  /** Optional layout hints forwarded to the board client verbatim. */
  options: BoardPlacementOptionsSchema.optional(),
});

const outputGenerateHandler: BuiltinVerbHandler = async (params, ctx) => {
  const input = outputGenerateParams.parse(params);

  // Placing onto a whiteboard is a workspace-scoped operation (the Hub route
  // membership-checks the board's workspace); a builtin output.generate needs an
  // acting workspace lens, not a pod-wide run. Bound WHICH workspace the run
  // targets — the capability gate already governs THAT this operator may run it.
  if (!ctx.workspaceId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "output.generate requires a workspace context (workspaceId).",
    });
  }

  // Confirm the operator is a member of the acting workspace — the same guard the
  // Hub route applies via verifyWorkspaceAccess before emitting a placement.
  const membership = await getWorkspaceMembership(
    db,
    ctx.workspaceId,
    ctx.userId
  );
  if (!membership) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "No access to the acting workspace.",
    });
  }

  // Delegate to the SHARED emit — the SAME function the /whiteboards/:id/place
  // route uses. No duplicated event logic.
  const result = placeArtboardDeck({
    viewId: input.boardId,
    deck: { preset: input.preset, title: input.title, slides: input.slides },
    options: input.options,
  });

  return { boardId: result.viewId, slideCount: result.slideCount };
};

/**
 * ai.triage — batch-classify emails (relevance + category + summary) via the IS
 * `mail_triage` tool. AI-backed: unlike the pure first-party pilots above, its
 * handler DOES call the IS internally (that's the classification) — but the verb
 * itself still runs in-process + governed, so it's a builtin, not an IS-executed
 * code skill. Reuses the exact triage call the mail-feed runner uses.
 */
const aiTriageParams = z.object({
  emails: z.array(
    z.object({
      id: z.string(),
      subject: z.string().optional(),
      from: z.string().optional(),
      date: z.string().optional(),
      snippet: z.string().optional(),
    })
  ),
  mutedCategories: z.array(z.string()).optional(),
});

const aiTriageHandler: BuiltinVerbHandler = async (params) => {
  const input = aiTriageParams.parse(params);
  const results = await triageEmails(input.emails, input.mutedCategories ?? []);
  return { results };
};

/**
 * verbName (= skill.name = verbId) → in-process handler. Populated by W5.
 * Keep names namespaced (`channel.create`, `feed.post`) to mirror the
 * `connector.action` convention used for external verbs.
 */
export const BUILTIN_VERBS: Record<string, BuiltinVerbHandler> = {
  "channel.create": channelCreateHandler,
  "feed.post": feedPostHandler,
  "output.generate": outputGenerateHandler,
  "ai.triage": aiTriageHandler,
};
