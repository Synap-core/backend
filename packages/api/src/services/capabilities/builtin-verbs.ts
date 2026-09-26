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
// Static, NOT part of the dynamic `submit-capture-graph` import below: it is a
// pure helper, and tests that `vi.mock` that module would otherwise stub the
// honesty derivation away along with the door.
import { captureStatusForReceiptState } from "../capture-agent/capture-receipt-state.js";
import {
  buildDegradedNextStep,
  describeDegradedForAgent,
  isDegradedReasonRetryable,
} from "../capture-agent/capture-degraded-guidance.js";
import {
  db,
  eq,
  and,
  or,
  desc,
  drizzleSql,
  channels,
  views,
  entities,
  relations,
  messages,
  documents,
  capabilities,
  getWorkspaceMembership,
  insertChannelMessage,
  getEffectiveFacets,
  profileSlugScopeConditionFromRows,
  profileScopeConditions,
  profilesByRoleCategory,
  MessageRole,
  MessageAuthorType,
  getActingAgentUserId,
} from "@synap/database";
import { widgetDefinitions } from "@synap/database/schema";
import type { SQL } from "drizzle-orm";
import type { CatalogKind } from "@synap/jobs";
import type { Context } from "../../context.js";
// Type-only imports (erased at runtime). The heavy access layer + the channel
// util are LAZY-imported inside the read/write handlers (mirroring how
// channelCreateHandler lazy-imports channelsRouter), so this module's load graph
// stays light — the visibility registry is never dragged into callers that only
// touch the pilot verbs.
import type { ScopedDb } from "../../access/scoped-db.js";
import type { ContextObjectType } from "../../utils/resolve-or-create-channel.js";
import type { CaptureStructureLike } from "../capture-agent/capture-structure-to-graph.js";
import { resolveFacetVisibilityScope } from "../../utils/workspace-membership.js";
import { assertKnownProfileSlug } from "../../utils/assert-known-profile-slug.js";
import {
  placeArtboardDeck,
  ArtboardDeckSlideSchema,
  BoardPlacementOptionsSchema,
} from "./place-artboard-deck.js";
import { triageEmails } from "../mail-feed/triage.js";
import { freezeChartEmbeds } from "../document-charts/freeze-chart-embeds.js";
import { liveChartReader } from "../document-charts/freeze-charts-verb.js";
import {
  RUN_TIME_DIAGNOSTIC_CODES,
  stampRunDiagnostics,
} from "../document-charts/stamp-run-diagnostics.js";
import { generateViaIS } from "../mail-feed/generate.js";
import { resolveTool } from "../tools/resolve-tool.js";
import { recommendTightenForAllAgents } from "../proposals/recommend-tighten.js";
import { recommendRaiseCeilingForAllAgents } from "../proposals/recommend-raise-ceiling.js";
import { recommendRaiseProposalCapForAllAgents } from "../proposals/recommend-raise-proposal-cap.js";
import { recommendTightenPostureForAllChannels } from "../proposals/recommend-tighten-posture.js";
import { scanAutomationHealth } from "../proposals/automation-health.js";
import { assertPodAdmin } from "../../trpc.js";
import { openLink } from "../../utils/deep-links.js";
import {
  buildPackageSkeleton,
  SCAFFOLDABLE_CATEGORIES,
} from "./market-scaffold.js";
// marketplace-install.ts pulls in the full router graph (create-from-definition.ts
// imports playbooksRouter/automationsRouter/toolsRouter/skillsRouter at top
// level) — it and catalog-cache-query.ts are lazy-imported inside the two
// handlers below, exactly like every other router import in this file, so this
// module's own load graph stays light.

export interface BuiltinVerbContext {
  /** The acting operator (bearer's user id). */
  userId: string;
  /** Acting workspace lens, or null for a pod-wide run. */
  workspaceId: string | null;
  /**
   * The acting AGENT (agent-user id), when this run originates from an agent.
   * Only a couple of handlers (market.install) consume this — most builtin
   * verbs are governed entirely by the outer capability gate and don't need
   * to know agent-vs-operator themselves. NOT populated by every call site
   * today (see marketplace-install.ts's runMarketInstall doc for the known gap).
   */
  agentUserId?: string | null;
  /**
   * The VERB being executed — the `skills` row id + name resolved one frame up
   * in `execute-capability.ts`. Handlers that create durable objects stamp it
   * as the producer (e.g. `channel.ingest` writes a
   * `skill --produced--> channel` origin edge), so a channel created by a
   * capability run is attributable to the exact verb that made it. Optional:
   * a handler must still work when the caller did not supply it.
   */
  verbId?: string | null;
  verbName?: string | null;
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

  // Confirm the operator is a member of the acting workspace — an equivalent
  // membership check to the Hub route's verifyWorkspaceAccess.
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

  // Confirm the target board actually lives in the acting workspace. Without
  // this a member of workspace A could emit a board:place onto a board in
  // workspace B by passing its viewId. (The verb is emit-only, no read leak,
  // but this closes the cross-workspace placement surface the review flagged.)
  const [board] = await db
    .select({ id: views.id })
    .from(views)
    .where(
      and(eq(views.id, input.boardId), eq(views.workspaceId, ctx.workspaceId))
    )
    .limit(1);
  if (!board) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "Board not found in the acting workspace.",
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

// pod-wide by design: triage is workspace-agnostic (triageEmails uses the pod's
// default IS via getDefaultActiveService), so `ctx` is intentionally unused.
const aiTriageHandler: BuiltinVerbHandler = async (params) => {
  const input = aiTriageParams.parse(params);
  const results = await triageEmails(input.emails, input.mutedCategories ?? []);
  return { results };
};

/**
 * ai.generate — synchronous single-shot LLM completion via the IS `generate`
 * tool. The keystone sync-AI step for automations: an automation's AI node (e.g.
 * classify-then-gate, summarize) runs THIS in-process and reads its output
 * directly, unlike the fire-and-forget task path. AI-backed like ai.triage — its
 * handler calls the IS internally, but the verb still runs in-process + governed.
 *
 * OUTPUT CONTRACT: the handler returns the IS `output` value directly, and the
 * automation engine stores every node's result flat — so from a template the
 * value lives at `steps.<id>.output.<field>` (ONE `.output`, same rule for every
 * node type; capability/skill nodes no longer double-wrap). With `json:true` the
 * model output is parsed IS-side, so e.g. `steps.detect.output.reviewNeeded`
 * resolves.
 *
 * COERCION: the automation engine stringifies every inputMapping value (String()),
 * so `json` arrives as the string "true"/"false" and `maxTokens` as a numeric
 * string. `json` is coerced with an explicit "true" check (z.coerce.boolean would
 * treat "false" as truthy); `maxTokens` via z.coerce.number.
 *
 * pod-wide by design: like ai.triage, it uses the pod's default IS
 * (getDefaultActiveService), so `ctx` is intentionally unused.
 */
const aiGenerateParams = z.object({
  system: z.string().optional(),
  prompt: z.string().min(1),
  // Engine passes "true"/"false" strings — coerce explicitly (z.coerce.boolean
  // would map "false" → true). Accept a real boolean too (direct callers).
  json: z
    .union([z.boolean(), z.enum(["true", "false"])])
    .optional()
    .transform((v) => v === true || v === "true"),
  // Ceiling raised 2000 → 8000 to match the IS `/generate` route's own bound
  // (tools-v1.ts caps output at 8000, ~proportionate to its 24000-char input;
  // matches EXTRACTION_MAX_TOKENS). 2000 was the end-to-end truncation floor:
  // even after the IS default rose to 2000/ceiling 8000, this mirror still
  // clamped any caller here to 2000, so a report round could never reach the
  // headroom it needs. `maxTokens` is a truncation point, never a length
  // control — billing is on tokens USED, so headroom is free when unused.
  maxTokens: z.coerce.number().int().min(1).max(8000).optional(),
});

const aiGenerateHandler: BuiltinVerbHandler = async (params) => {
  const input = aiGenerateParams.parse(params);
  // Return the IS output value DIRECTLY — no wrapping envelope (see contract).
  return generateViaIS({
    system: input.system,
    prompt: input.prompt,
    json: input.json,
    maxTokens: input.maxTokens,
  });
};

/**
 * message.interpret — the proactive keystone (agnostic message → governed proposals).
 *
 * Runs the EXISTING extraction engine (`client.structure` — the SAME Hub-client
 * call the capture path uses, reached via `resolveIntelligenceService`) on a
 * message's `content`, then files ONE governed `import.graph` proposal through the
 * SAME door capture uses (`submitCaptureGraph` → `insertPendingProposal`). Nothing
 * here reimplements extraction or a second proposal door. An automation/playbook
 * `capability` node with `verbId:'message.interpret'` dispatches this through the
 * canonical capability router (`dispatchViaCapabilityRouter`), so an inbound
 * message can be interpreted into a review-inbox proposal with no new step type
 * and no second dispatch path.
 *
 * GUIDELINES → INSTRUCTIONS: the optional `guidelines` string is natural-language
 * prompt-shaping, injected as the structure pass's `instructions` (the same field
 * interactive capture threads its intake bias through). It biases extraction; it
 * is NOT a routing or permission control.
 *
 * DEFAULT POSTURE = PROPOSE: no `agentUserId` is threaded into `submitCaptureGraph`,
 * so the graph is ALWAYS filed as a PENDING proposal (never agent-mode
 * auto-applied) — the honest default for a proactive suggestion, and what keeps
 * this verb READ-ONLY w.r.t. graph data (it files a human-governed review item,
 * never a direct write). It is therefore in READ_ONLY_BUILTIN_VERBS so the outer
 * capability gate AUTO-RUNS it inside an automation (a propose verdict would stall
 * the flow), exactly like `governance.recommend_tighten` — governance lives on the
 * proposal it emits, not on running the interpretation.
 *
 * AGNOSTIC: operates on `content` + optional channel/entity/workspace context,
 * never on a provider. `workspaceId` scopes the proposal lens. `channelId` /
 * `entityId` are accepted as the stable context contract for the follow-up wave
 * (provenance / anchoring) and are not yet consumed by the write.
 */
const messageInterpretParams = z.object({
  // Capped to match the inbound-message event's own bound (see
  // inbound-recorder.ts's `content: args.text.slice(0, 4000)`): that `data`
  // blob is what typically feeds this verb, and an uncapped `content` here
  // would let a pathological payload ride unbounded into the IS structure
  // call and the eventual proposal record.
  content: z.string().min(1).max(4000),
  channelId: z.string().optional(),
  entityId: z.string().optional(),
  workspaceId: z.string().optional(),
  guidelines: z.string().optional(),
  /**
   * The `messages.id` being interpreted, when the caller has it — stamped on
   * the raw as `intakeSource.sourceMessageId`. Never derived: the inbound
   * event's `messageId` is the PROVIDER's id, not ours.
   */
  sourceMessageId: z.string().uuid().optional(),
});

const messageInterpretHandler: BuiltinVerbHandler = async (params, ctx) => {
  const input = messageInterpretParams.parse(params);
  const workspaceId = input.workspaceId ?? ctx.workspaceId ?? null;

  // The RAW door FIRST: the message is staged as a capture source before any
  // structuring, so EVERY outcome below — degraded, clarifying, nothing
  // durable, proposed — keeps it. This verb takes `content`, not a messages
  // row, so the source is kind `text` with door `message.interpret`. A failed
  // staging does not stop the interpret; it rides the result as `sourceErrors`.
  const { stageCaptureSources } =
    await import("../intake/record-structure-intake.js");
  const rawStaged = await stageCaptureSources({
    database: db,
    userId: ctx.userId,
    workspaceId,
    sessionId: null,
    door: "message.interpret",
    ...(input.sourceMessageId
      ? { sourceMessageId: input.sourceMessageId }
      : {}),
    source: { text: input.content },
  });
  const rawSourceEcho = {
    ...(rawStaged.sourceDocumentIds.length
      ? { sourceDocumentIds: rawStaged.sourceDocumentIds }
      : {}),
    ...(rawStaged.errors.length ? { sourceErrors: rawStaged.errors } : {}),
  };

  // Routing self-improvement memory — the SAME hint the capture path threads
  // into structure(). Best-effort: a memory hiccup degrades to "no memory",
  // never fails the interpret.
  const { fetchRoutingMemory } = await import("../routing-memory.js");
  let routingMemory: Awaited<ReturnType<typeof fetchRoutingMemory>> | undefined;
  try {
    routingMemory = await fetchRoutingMemory(ctx.userId);
  } catch {
    routingMemory = undefined;
  }

  // Extraction quality hints — the SAME hints the interactive capture path
  // (routers/capture.ts's `structure` procedure) threads into structure():
  // accessible profiles (with property schemas), candidate workspaces, and
  // existing-entity names for dedup. `availableProfiles` reuses capture.ts's
  // OWN exported builders (`buildAvailableProfiles` + `withEffectiveProperties`)
  // rather than re-deriving the profile/property queries. The workspace list
  // and existing-entity search have no shared helper to import — they live
  // inline in that procedure — so they're re-derived here, minimally (no
  // roster/anchor/degraded-fallback machinery this verb doesn't need). Each
  // hint is independently best-effort: a lookup failure degrades to "no hint",
  // never fails the interpret (mirrors routingMemory above).
  let availableProfiles:
    | ReturnType<
        (typeof import("../../routers/capture.js"))["buildAvailableProfiles"]
      >
    | undefined;
  try {
    const { ProfileResolutionService } = await import("@synap/database");
    const { buildAvailableProfiles, withEffectiveProperties } =
      await import("../../routers/capture.js");
    const profileService = new ProfileResolutionService(db);
    const accessibleProfiles = await profileService.getAccessibleProfiles(
      ctx.userId,
      workspaceId ?? ""
    );
    availableProfiles = buildAvailableProfiles(
      await withEffectiveProperties(
        profileService,
        accessibleProfiles as unknown as Parameters<
          typeof withEffectiveProperties
        >[1],
        workspaceId
      )
    );
  } catch {
    availableProfiles = undefined;
  }

  let availableWorkspaces:
    Array<{ id: string; name: string; description?: string }> | undefined;
  try {
    const { workspaces, workspaceMembers } = await import("@synap/database");
    const { isDomainHomeWorkspace } =
      await import("../../lib/routing-candidates.js");
    const rows = await db
      .select({
        id: workspaces.id,
        name: workspaces.name,
        description: workspaces.description,
        workspaceType: workspaces.workspaceType,
        systemSlug: workspaces.systemSlug,
        settings: workspaces.settings,
      })
      .from(workspaces)
      .innerJoin(
        workspaceMembers,
        eq(workspaceMembers.workspaceId, workspaces.id)
      )
      .where(
        and(
          eq(workspaceMembers.userId, ctx.userId),
          drizzleSql`${workspaces.archivedAt} IS NULL`
        )
      )
      .orderBy(desc(workspaces.updatedAt))
      .limit(30);
    availableWorkspaces = rows
      .filter((w) => isDomainHomeWorkspace(w))
      .map((w) => ({
        id: w.id,
        name: w.name,
        description: w.description ?? undefined,
      }));
  } catch {
    availableWorkspaces = undefined;
  }

  let existingEntityNames: string[] | undefined;
  try {
    const { searchService } = await import("@synap/search");
    const existing = await searchService.searchCollection(
      "entities",
      input.content.slice(0, 200),
      { userId: ctx.userId, workspaceId: workspaceId ?? undefined, limit: 30 }
    );
    existingEntityNames = Array.from(
      new Set(
        existing.results
          .map((r) => r.document?.title as string | undefined)
          .filter((t): t is string => Boolean(t && t.trim()))
      )
    );
  } catch {
    existingEntityNames = undefined;
  }

  // Scoped GUIDELINES — natural-language intent attached at any granularity
  // (default | workKind | sourceKind | entityKind | channelType | bridge |
  // channel | shape) via the `config_settings` store, assembled for THIS
  // message's context by THE ONE reading door `assembleStructureContext` (the
  // same door interactive capture uses) and injected as the structure pass's
  // `instructions`. Ordered most-general → most-specific; the caller's explicit
  // `guidelines` is appended LAST so it wins; the shared 2000-char budget drops
  // the least specific first. With no matching guideline this is a
  // byte-identical no-op (explicit only). A failed guideline READ does not fail
  // the interpret — it structures with the explicit text and says so in the
  // result (`guidelineStatus: "unavailable"`), never as "no guidelines".
  let mergedInstructions: string | undefined =
    input.guidelines?.trim() || undefined;
  let appliedGuidelines: Array<{ id: string; version: number }> = [];
  let guidelineStatus: "ok" | "unavailable" = "ok";
  {
    // channelType/bridgeId — derived from the channel's origin so the `bridge`
    // and `channelType` guideline scopes actually match at runtime (they are
    // stored granularities, previously never supplied here). Reuses
    // `getChannelOrigin` (the cheap channel-facts + `produced`-edge read
    // `getChannelStack` is built on, WITHOUT its automation-scan/capability
    // lookup — this runs on every interpret call, so the heavier assembly
    // would be pure overhead). Best-effort: a lookup failure just omits the
    // scope, never fails the interpret (mirrors routingMemory above).
    let channelType: string | undefined;
    let bridgeId: string | undefined;
    if (input.channelId) {
      try {
        const { getChannelOrigin } = await import("../signal/channel-stack.js");
        const originResult = await getChannelOrigin(
          ctx.userId,
          input.channelId
        );
        channelType = originResult.externalSource ?? undefined;
        // `bridge` scope's scopeRef is a toolId (config-settings.ts: "bridge —
        // a specific bridge/transport; scopeRef = toolId/bridgeId") — only a
        // "tool" producer qualifies; a bare `source` slug or non-tool producer
        // has no bridge to scope to.
        bridgeId =
          originResult.origin?.producerType === "tool"
            ? (originResult.origin.producerId ?? undefined)
            : undefined;
      } catch {
        channelType = undefined;
        bridgeId = undefined;
      }
    }

    const { assembleStructureContext } = await import("@synap/database");
    const structureContext = await assembleStructureContext({
      db,
      userId: ctx.userId,
      // The capability this interpret runs through (skills row id), when known —
      // lets a capability-scoped guideline match.
      capabilityId: ctx.verbId ?? undefined,
      channelId: input.channelId ?? undefined,
      channelType,
      bridgeId,
      workspaceId: workspaceId ?? undefined,
      // A message is text input. The kinds in play are the kinds the extractor
      // may produce (the same `availableProfiles` hint it is given).
      sourceKind: "text",
      entityKinds: availableProfiles?.map((p) => p.slug),
      envelope: {
        content: input.content,
        channelId: input.channelId ?? undefined,
        entityId: input.entityId ?? undefined,
        attachments: [],
      },
      instructions: [input.guidelines],
    });
    mergedInstructions = structureContext.instructions;
    appliedGuidelines = structureContext.guidelines;
    guidelineStatus = structureContext.guidelineStatus;
  }

  // Extraction — the SAME client.structure the capture path calls, reached the
  // SAME way (resolveIntelligenceService). The merged guidelines ride through as
  // the structure pass's `instructions` (natural-language extraction bias).
  const { resolveIntelligenceService } =
    await import("../../utils/intelligence-routing.js");
  const { client } = await resolveIntelligenceService({
    userId: ctx.userId,
    workspaceId: workspaceId ?? undefined,
    capability: "default",
  });
  const structured = await client.structure({
    text: input.content,
    ...(mergedInstructions ? { instructions: mergedInstructions } : {}),
    hints: {
      routingMemory,
      availableProfiles,
      availableWorkspaces,
      existingEntityNames,
    },
  });

  // Map the tempId-keyed plan → ref-keyed graph via the SHARED confirm-mode
  // bridge (tempId→ref, contextTempId→contextRef, dangling relations dropped).
  // `client.structure` returns `entities`; the bridge reads `proposals` — the
  // only shape difference, adapted here (cast mirrors capture.ts's own
  // `result as CaptureStructureLike`).
  const { shouldPersistCapturePlan, captureStructureToGraph } =
    await import("../capture-agent/capture-structure-to-graph.js");
  const plan: CaptureStructureLike = structured
    ? {
        proposals: structured.entities as Array<Record<string, unknown>>,
        relations: structured.relations as Array<Record<string, unknown>>,
        followUp: structured.followUp,
        degraded: structured.degraded,
      }
    : { degraded: true };

  // Honest no-op: the IS was unreachable/degraded, asked a clarifying question,
  // or found nothing durable — there is no graph to propose. Report it plainly
  // rather than filing an empty proposal.
  if (!shouldPersistCapturePlan(plan)) {
    const reason = !structured
      ? "structuring-unavailable"
      : structured.degraded
        ? "degraded"
        : structured.followUp != null
          ? "needs-clarification"
          : "nothing-durable";

    // `entityCount: 0` is and stays HONEST — this verb created nothing. What was
    // dishonest by omission is stopping there on the degraded branch: the IS
    // returns the user's raw text back as a single note entity, so
    // `structured.entities` was in hand and thrown away. An agent reading only
    // `{ no_proposal, entityCount: 0 }` concluded "nothing was written" and gave
    // up — correct, given what it was told. Report the salvage and what can be
    // done with it, WITHOUT claiming a write: filing it stays the caller's
    // explicit trip back through the governed door.
    const degradedReason =
      typeof (structured as { degradedReason?: unknown } | undefined)
        ?.degradedReason === "string"
        ? ((structured as { degradedReason?: string }).degradedReason as string)
        : undefined;
    const salvagedEntities =
      reason === "degraded" && Array.isArray(structured?.entities)
        ? (structured.entities as Array<Record<string, unknown>>)
        : undefined;

    return {
      status: "no_proposal",
      reason,
      entityCount: 0,
      // The message was kept as a raw capture even though nothing was proposed.
      ...rawSourceEcho,
      // Which guideline versions shaped this pass (for a run manifest), and
      // whether they could be read at all.
      guidelines: appliedGuidelines,
      guidelineStatus,
      ...(reason === "degraded" || reason === "structuring-unavailable"
        ? {
            degraded: true as const,
            ...(degradedReason ? { degradedReason } : {}),
            degradedMessage: describeDegradedForAgent(degradedReason),
            degradedRetryable: isDegradedReasonRetryable(degradedReason),
          }
        : {}),
      ...(salvagedEntities?.length
        ? {
            salvagedEntities,
            nextStep: buildDegradedNextStep("salvagedEntities"),
          }
        : {}),
    };
  }

  const { entities: graphEntities, relations } = captureStructureToGraph(plan);

  // File ONE governed proposal through the SAME door capture uses. No
  // `agentUserId` → the graph is ALWAYS filed PENDING (default propose); the
  // human approves it from the review inbox, which materializes the entities.
  const { submitCaptureGraph } =
    await import("../capture-agent/submit-capture-graph.js");
  const { buildCaptureNarrativeSummary } =
    await import("../capture-agent/capture-narrative.js");
  const interpretSummary = buildCaptureNarrativeSummary({
    sourceLabel: "Interpreted message",
    instruction: input.content,
  });
  const result = await submitCaptureGraph({
    ...(rawStaged.sourceDocumentIds.length
      ? { sourceDocumentIds: rawStaged.sourceDocumentIds }
      : {}),
    userId: ctx.userId,
    workspaceId,
    entities: graphEntities,
    relations,
    source: "agent",
    // Provenance back to the message/channel that produced this graph — the
    // ONLY genuine anchor available here: this verb takes raw `content`, not
    // a `messages` row id, so `sourceMessageId` is deliberately NOT set (no
    // message id to attach honestly). `channelId` maps to `proposals.
    // thread_id` (see the field's doc comment on SubmitCaptureGraphInput);
    // `rawSource.rawText` retains the original text so a rejected proposal
    // still carries what produced it.
    ...(input.channelId ? { channelId: input.channelId } : {}),
    // Bounded by `submitCaptureGraph` itself (RAW_SOURCE_MAX_CHARS) — this
    // path used to pass the message through UNSLICED while two sibling doors
    // sliced at two different numbers.
    rawSource: { rawText: input.content },
    // The MESSAGE is what was asked for; the entity count is the shape of the
    // answer. Quote the message so the reviewer reads the request, not the
    // response's arity. `?? undefined` keeps the core's count string as the
    // last-resort fallback for a message that is pure whitespace.
    ...(interpretSummary ? { summary: interpretSummary } : {}),
  });

  return {
    // Read off the receipt, not off `result.applied` — see
    // `captureStatusForReceiptState`. `applied` is the routing flag ("did this
    // terminal materialize?"), which stays true for a graph whose edges failed;
    // the honest outcome word is `writeReceipt.state`, so a `partial` graph
    // cannot report here as a clean success either. The failed edges are named
    // in `result.relationsFailed`, forwarded below.
    status: captureStatusForReceiptState(result.writeReceipt.state),
    ...rawSourceEcho,
    ...(result.proposalId ? { proposalId: result.proposalId } : {}),
    ...(result.reviewUrl ? { reviewUrl: result.reviewUrl } : {}),
    entityCount: result.entityCount,
    relationCount: result.relationCount,
    guidelines: appliedGuidelines,
    guidelineStatus,
    // Named, not left as a silent shortfall against the submitted count.
    ...(result.relationsFailed?.length
      ? { relationsFailed: result.relationsFailed }
      : {}),
  };
};

// ── Read/resolve half (W6) ────────────────────────────────────────────────────
//
// Six GENERIC primitives that READ or RESOLVE the pod substrate. They are
// deliberately feature-AGNOSTIC — every CRM/feature-shaped choice (which channel
// type, which relation type, which profile) is a PARAMETER, never a constant, so
// feature behavior lives in capability JSON (the CP catalog), not in these verbs.
//
// The four READ verbs (entity.query, channel.resolve, graph.relations, feed.read)
// read THROUGH the access layer: `scopedDb(AccessContext…).findMany(table, …)`
// AND-s each table's registered visibility predicate onto the query, so a read
// physically cannot return rows outside the caller's floor (own + member
// workspaces + pod-wide globals), narrowed by the acting workspace lens. They are
// marked read-only (READ_ONLY_BUILTIN_VERBS) so the capability gate auto-runs
// them without a grant/propose — their scope is enforced by the access layer, not
// the gate (see execute-capability.ts + the gate's `readOnly` short-circuit).
//
// The two WRITE verbs (channel.ensure, graph.link) delegate to the EXISTING
// governed write paths — `resolveOrCreateChannel` (the by-context find-or-create
// used by MCP `get_channel`) and the `relations.create` caller (which runs
// `checkPermissionOrPropose` internally) — so a write is governed IDENTICALLY to
// the hand-rolled routes: membership-checked + proposal-or-run. They are NOT
// read-only, so they flow through the full capability gate unchanged.
//
// The access layer is LAZY-imported (not top-level) so this module never drags
// the visibility registry into the pilot-verb callers — mirroring the
// channelsRouter lazy-import convention above.

/** Build a ScopedDb bound to the operator's floor, narrowed to a workspace lens.
 *  `undefined` lens = the full user floor (all member workspaces + globals); a
 *  workspace id narrows to it (+ globals). We use `undefined` (not `null`) when no
 *  workspace is active so a pod-wide read still returns the caller's own rows —
 *  the DATA-table floor, per the access layer's `accessFor` note. */
async function getReadScope(
  userId: string,
  lens: string | null | undefined
): Promise<ScopedDb> {
  const { AccessContext, scopedDb } = await import("../../access/index.js");
  const access = AccessContext.operator({ userId }).withLens(lens ?? undefined);
  return scopedDb(access);
}

/** Like getReadScope but pins the GLOBALS-ONLY (`null`) lens — pod-personal
 *  rows (`workspaceId IS NULL`, owner-gated). Kept SEPARATE from getReadScope
 *  because that helper maps null→undefined (the full user floor) for the
 *  no-workspace DATA-table case; the pod-wide opt-in needs the `null` lens
 *  preserved so the read returns exactly the caller's pod-wide entities and
 *  never a focused workspace's rows. */
async function getGlobalsReadScope(userId: string): Promise<ScopedDb> {
  const { AccessContext, scopedDb } = await import("../../access/index.js");
  return scopedDb(AccessContext.operator({ userId }).withLens(null));
}

/** entity.query — READ entities of a profile, scoped by the caller's floor.
 *
 * Selector: EXACTLY ONE of `profileSlug` (a single kind/role slug) or
 * `roleCategory` (every role in a category — dynamic, no enumeration). The
 * `roleCategory` form lets an automation query e.g. "providers" ONCE and have
 * every role-facet tagged that category qualify, extensible to future roles
 * with zero edits (migration 0222). */
const entityQueryParams = z
  .object({
    /** Entity profile slug (e.g. "task", "deal") — the `type` discriminator.
     *  Mutually exclusive with `roleCategory`. */
    profileSlug: z.string().min(1).max(200).optional(),
    /**
     * Role-category selector: match entities wearing ANY role-facet whose
     * profile carries this `role_category` (migration 0222). Resolves to the
     * cohort's profiles → the polymorphic facet-EXISTS scope predicate, ANDed
     * with the caller's floor exactly like `profileSlug`. An empty cohort (no
     * role tagged this category) returns zero entities — a legitimately open
     * set, not an error. Mutually exclusive with `profileSlug`.
     */
    roleCategory: z.string().min(1).max(200).optional(),
    /** Optional JSONB property equality filter: { key: value } pairs. */
    filter: z.record(z.string(), z.unknown()).optional(),
    /** Optional workspace lens; omit for the full user floor (pod-wide). */
    workspaceId: z.string().uuid().optional(),
    /**
     * Read scope. "workspace" (default) = today's behavior EXACTLY: the explicit
     * `workspaceId`, else the acting workspace lens, else the full user floor.
     * "pod" = the EXPLICIT opt-in to enumerate POD-WIDE entities (`workspaceId IS
     * NULL`, owner-gated) even when running under an active workspace lens — the
     * flagship "list my pod-wide clients/companies" case. This is an explicit
     * request, NOT the "globals silently bleed into a focused workspace" that the
     * default deliberately forbids. A specific `workspaceId` is IGNORED under
     * "pod". Plain string values survive the automation engine's String()
     * coercion, so no z.coerce is needed.
     */
    scope: z.enum(["workspace", "pod"]).optional(),
    // coerce: the CLI + automation engine pass params as strings ("50").
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .refine((v) => (v.profileSlug ? 1 : 0) + (v.roleCategory ? 1 : 0) === 1, {
    message: "Provide exactly one of `profileSlug` or `roleCategory`.",
  });

const entityQueryHandler: BuiltinVerbHandler = async (params, ctx) => {
  const input = entityQueryParams.parse(params);
  const limit = input.limit ?? 20;
  // "pod" scope pins the globals-only (`null`) lens: pod-wide entities
  // (`workspaceId IS NULL`, owner-gated). Default "workspace" is byte-for-byte
  // the prior behavior (explicit id → acting lens → full user floor).
  const podScope = input.scope === "pod";
  const workspaceId = podScope
    ? null
    : (input.workspaceId ?? ctx.workspaceId ?? undefined);
  const facetVisibilityScope = await resolveFacetVisibilityScope(
    ctx.userId,
    workspaceId
  );

  // The lens is the query's explicit workspaceId, else the acting lens. For
  // "pod" we pin the globals-only (`null`) lens via getGlobalsReadScope, since
  // getReadScope deliberately maps null→undefined (the full user floor).
  const scoped = podScope
    ? await getGlobalsReadScope(ctx.userId)
    : await getReadScope(ctx.userId, workspaceId);

  // Selector → scope predicate. Both forms are routed polymorphically (Kind +
  // Facets: role → facet-EXISTS, kind → entities.type — the same one-door
  // routing as entities.list) and ANDed with the caller's floor by
  // scoped.findMany below, so neither can return rows outside the access floor.
  //   • profileSlug  — one kind/role slug.
  //   • roleCategory — every profile tagged this category (0222); dynamic set,
  //     no enumeration. Lets an automation query "providers" once.
  // The schema's refine guarantees exactly one selector is present.
  let scopeCondition: SQL;
  if (input.roleCategory) {
    // Open cohort: an empty category (no role tagged it yet) is a legitimate
    // empty match — return zero entities without a DB round-trip, rather than
    // erroring the way an unknown single slug does.
    const cohort = await profilesByRoleCategory(db, input.roleCategory);
    const predicate = profileScopeConditions(db, cohort, facetVisibilityScope);
    if (!predicate) return { entities: [], count: 0 };
    scopeCondition = predicate;
  } else {
    // Fail closed first: an agent that invents a slug ("crm-lead" where the pod
    // says "lead") must get a typed "unknown profile" it can act on, not an
    // empty result set it will report as "you have none".
    const slugRows = await assertKnownProfileSlug(db, input.profileSlug!);
    scopeCondition = profileSlugScopeConditionFromRows(
      db,
      input.profileSlug!,
      slugRows,
      facetVisibilityScope
    );
  }
  const conditions: SQL[] = [scopeCondition];
  // JSONB property equality — mirror executeQueryStep's filter semantics.
  for (const [key, value] of Object.entries(input.filter ?? {})) {
    if (value !== undefined && value !== null) {
      conditions.push(
        drizzleSql`${entities.properties}->>${key} = ${String(value)}`
      );
    }
  }

  const rows = await scoped.findMany<{
    id: string;
    type: string;
    title: string | null;
    preview: string | null;
    properties: unknown;
    createdAt: Date;
    updatedAt: Date;
  }>(entities, {
    where: and(...conditions),
    columns: {
      id: true,
      type: true,
      title: true,
      preview: true,
      properties: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: desc(entities.updatedAt),
    limit,
  });

  return { entities: rows, count: rows.length };
};

/**
 * channel.resolve — READ the channel(s) bound to a context object, optionally
 * filtered by channelType. GENERIC: `channelType` is a PARAMETER (e.g. "thread",
 * "external", "feed") — this verb makes NO assumption about which type is the
 * "client" channel. Reads through the access layer (channels carry a custom
 * visibility rule), so it never returns a channel the caller may not see.
 *
 * FIREWALL: this verb only RESOLVES — it never posts. A resolved channel whose
 * type/purpose is client-comms (an external client conversation) MUST NEVER be
 * used as a post target by callers: AI/proactive output to a client-comms channel
 * is blocked downstream (delivery-router / insertChannelMessage). Resolve to READ
 * the conversation, not to write into it.
 */
const channelResolveParams = z.object({
  /** Context-object kind (entity/document/view/…), a generic string. */
  contextObjectType: z.string().min(1).max(50),
  contextObjectId: z.string().uuid(),
  /** Optional channelType filter (parameter, never a constant). */
  channelType: z.string().max(50).optional(),
  /** Optional branchPurpose filter (e.g. "team" | "client-comms") — the firewall
   *  ROLE, distinct from channelType (external/thread/feed). This is how team-vs-
   *  client channels are distinguished, so resolving "the client's TEAM channel"
   *  filters on this, not channelType. */
  branchPurpose: z.string().max(50).optional(),
});

const channelResolveHandler: BuiltinVerbHandler = async (params, ctx) => {
  const input = channelResolveParams.parse(params);
  const scoped = await getReadScope(ctx.userId, ctx.workspaceId ?? undefined);

  const conditions: SQL[] = [
    eq(channels.contextObjectType, input.contextObjectType),
    eq(channels.contextObjectId, input.contextObjectId),
  ];
  if (input.channelType) {
    // channelType is a GENERIC string param; the column is a typed enum, so
    // compare via a SQL literal rather than the enum-narrowed `eq` overload.
    conditions.push(drizzleSql`${channels.channelType} = ${input.channelType}`);
  }
  if (input.branchPurpose) {
    conditions.push(eq(channels.branchPurpose, input.branchPurpose));
  }

  const rows = await scoped.findMany<{
    id: string;
    channelType: string;
    title: string | null;
    workspaceId: string | null;
    branchPurpose: string | null;
    contextObjectType: string | null;
    contextObjectId: string | null;
    updatedAt: Date;
  }>(channels, {
    where: and(...conditions),
    columns: {
      id: true,
      channelType: true,
      title: true,
      workspaceId: true,
      branchPurpose: true,
      contextObjectType: true,
      contextObjectId: true,
      updatedAt: true,
    },
    orderBy: desc(channels.updatedAt),
    // Bound the read — a context object realistically has a handful of channels;
    // rows[0] (most-recent) is the resolved channel, the rest are returned for
    // callers that want the full set.
    limit: 50,
  });

  return { channelId: rows[0]?.id ?? null, channels: rows };
};

/**
 * channel.ensure — WRITE: find-or-create a THREAD channel bound to a context
 * object (delegates to the governed `resolveOrCreateChannel` find-or-create, the
 * same path MCP `get_channel` mode by-context uses). Membership-checked like
 * channel.create. `created` reports whether a new row was inserted.
 */
const channelEnsureParams = z.object({
  contextObjectType: z.string().min(1).max(50),
  contextObjectId: z.string().uuid(),
  title: z.string().max(500).optional(),
  agentSlug: z.string().max(100).optional(),
});

const channelEnsureHandler: BuiltinVerbHandler = async (params, ctx) => {
  const input = channelEnsureParams.parse(params);

  // A context-bound THREAD is workspace-scoped (resolveOrCreateChannel THREAD
  // requires a workspaceId) → needs an acting workspace lens, not a pod-wide run.
  if (!ctx.workspaceId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "channel.ensure requires a workspace context (workspaceId).",
    });
  }

  // Enforce membership before the write (mirror channel.create).
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

  // A session-context stamp is the session OWNER's to write (a forged stamp
  // looks like that session's room). NOT_FOUND: the id tells a stranger nothing.
  const { sessionContextStampRefusal } =
    await import("../focus-sessions/session-context-stamp.js");
  const stampRefusal = await sessionContextStampRefusal({
    userId: ctx.userId,
    contextObjectType: input.contextObjectType,
    contextObjectId: input.contextObjectId,
  });
  if (stampRefusal) {
    throw new TRPCError({ code: "NOT_FOUND", message: stampRefusal });
  }

  // Pre-existence probe (owner-scoped, same key resolveOrCreateChannel upserts on)
  // so we can report `created`. resolveOrCreateChannel is find-or-create but does
  // not itself signal which happened.
  const [existing] = await db
    .select({ id: channels.id })
    .from(channels)
    .where(
      and(
        eq(channels.userId, ctx.userId),
        eq(channels.workspaceId, ctx.workspaceId),
        eq(channels.contextObjectType, input.contextObjectType),
        eq(channels.contextObjectId, input.contextObjectId),
        // The caller's own thread (a THREAD, or since Documents v2 the private
        // SUB_THREAD under a document/entity's object room) — never the
        // object room itself, which the caller may happen to own.
        drizzleSql`${channels.channelType} in ('thread', 'sub_thread')`
      )
    )
    .limit(1);

  const { resolveOrCreateChannel } =
    await import("../../utils/resolve-or-create-channel.js");
  const channel = await resolveOrCreateChannel({
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    channelType: "thread",
    contextObjectType: input.contextObjectType as ContextObjectType,
    contextObjectId: input.contextObjectId,
    agentSlug: input.agentSlug,
  });

  return { channelId: channel.id, created: !existing };
};

/**
 * channel.bind — WRITE: bind an ALREADY-EXISTING channel to a context object
 * (the inbound-first case: channel.ensure CREATES, but an inbound Discord channel
 * already exists and just needs its contextObjectId set). Delegates the write to
 * the governed `channelsRouter.updateChannel` caller (which re-checks channel
 * ownership + emits channel:updated) — it does NOT raw-UPDATE the channels table.
 *
 * Membership floor: a caller may only bind a channel in a workspace they belong
 * to. We load the channel first to (a) 404 cleanly, (b) confine the bind to the
 * acting workspace lens (mirror feed.post), and (c) enforce workspace membership
 * before delegating. `branchPurpose` (the firewall role label) is passed through
 * when provided. This verb only SETS a binding — it never posts, so the delivery
 * firewall is untouched.
 */
const channelBindParams = z.object({
  channelId: z.string().uuid(),
  // Narrowed to what the channels binding column + updateChannel accept: a channel
  // binds to an entity/document/view — NOT the broad thread-context set.
  contextObjectType: z.enum(["entity", "document", "view"]),
  contextObjectId: z.string().uuid(),
  /** Optional firewall role label (e.g. "client-comms" | "team"). */
  branchPurpose: z.string().max(500).optional(),
});

const channelBindHandler: BuiltinVerbHandler = async (params, ctx) => {
  const input = channelBindParams.parse(params);

  // Load the target channel: a clean 404 instead of a downstream error, and the
  // seam for the acting-workspace + membership floors below. Only the acting
  // operator (channels.userId) can bind via updateChannel's ownership guard — for
  // the inbound-Discord case the channel is owned by that same operator.
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

  // Membership floor: a caller may only bind a channel in a workspace they belong
  // to. (A workspace-less channel has no membership to check — updateChannel's
  // ownership guard is then the sole floor.)
  let workspaceRole = "member";
  if (channel.workspaceId) {
    const membership = await getWorkspaceMembership(
      db,
      channel.workspaceId,
      ctx.userId
    );
    if (!membership) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "No access to the channel's workspace.",
      });
    }
    workspaceRole = membership.role;
  }

  // Delegate the write to the governed updateChannel caller — no raw UPDATE here.
  const { channelsRouter } = await import("../../routers/channels.js");
  const caller = channelsRouter.createCaller({
    db,
    authenticated: true as const,
    userId: ctx.userId,
    workspaceId: channel.workspaceId ?? ctx.workspaceId ?? null,
    workspaceRole,
  } as unknown as Context);

  await caller.updateChannel({
    channelId: input.channelId,
    contextObjectType: input.contextObjectType,
    contextObjectId: input.contextObjectId,
    ...(input.branchPurpose !== undefined
      ? { branchPurpose: input.branchPurpose }
      : {}),
  });

  return { bound: true as const, channelId: input.channelId };
};

/** graph.relations — READ typed edges touching an entity, scoped by caller floor. */
const graphRelationsParams = z.object({
  entityId: z.string().uuid(),
  /** "outbound" (entity is source), "inbound" (entity is target), or "both". */
  direction: z.enum(["outbound", "inbound", "both"]).optional(),
  /** Optional relation-type filter. */
  relationType: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const graphRelationsHandler: BuiltinVerbHandler = async (params, ctx) => {
  const input = graphRelationsParams.parse(params);
  const direction = input.direction ?? "both";
  const limit = input.limit ?? 100;
  const scoped = await getReadScope(ctx.userId, ctx.workspaceId ?? undefined);

  const endpoint =
    direction === "outbound"
      ? eq(relations.sourceEntityId, input.entityId)
      : direction === "inbound"
        ? eq(relations.targetEntityId, input.entityId)
        : or(
            eq(relations.sourceEntityId, input.entityId),
            eq(relations.targetEntityId, input.entityId)
          );

  const conditions: SQL[] = [endpoint as SQL];
  if (input.relationType) {
    conditions.push(eq(relations.type, input.relationType));
  }

  const rows = await scoped.findMany<{
    id: string;
    sourceEntityId: string | null;
    targetEntityId: string | null;
    type: string;
    metadata: unknown;
    createdAt: Date;
  }>(relations, {
    where: and(...conditions),
    columns: {
      id: true,
      sourceEntityId: true,
      targetEntityId: true,
      type: true,
      metadata: true,
      createdAt: true,
    },
    orderBy: desc(relations.createdAt),
    limit,
  });

  // Annotate each edge's direction relative to the queried entity.
  const annotated = rows.map((r) => ({
    ...r,
    direction: r.sourceEntityId === input.entityId ? "outbound" : "inbound",
  }));

  return { relations: annotated };
};

/**
 * graph.link — WRITE: create a typed relation via the governed relations.create
 * caller (which runs checkPermissionOrPropose internally), the same path MCP
 * link_entities uses. Governed IDENTICALLY: it may return a proposal.
 */
const graphLinkParams = z.object({
  fromEntityId: z.string().uuid(),
  toEntityId: z.string().uuid(),
  relationType: z.string().min(1).max(200),
});

const graphLinkHandler: BuiltinVerbHandler = async (params, ctx) => {
  const input = graphLinkParams.parse(params);

  // relations.create is workspace-scoped (needs a workspaceId for the permission
  // check + relation-def validation) → requires an acting workspace lens.
  if (!ctx.workspaceId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "graph.link requires a workspace context (workspaceId).",
    });
  }

  // Enforce membership before delegating (mirror channel.create).
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

  const { relationsRouter } = await import("../../routers/relations.js");
  const caller = relationsRouter.createCaller({
    db,
    authenticated: true as const,
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    workspaceRole: membership.role,
  } as unknown as Context);

  // relations.create governs the write (checkPermissionOrPropose): it returns
  // either the created relation OR { status: "proposed", proposalId }. Surface
  // that verbatim under `linked` so an unapproved link is not reported as done.
  const result = await caller.create({
    sourceEntityId: input.fromEntityId,
    targetEntityId: input.toEntityId,
    type: input.relationType,
    workspaceId: ctx.workspaceId,
  });

  return { linked: result };
};

/**
 * feed.read — READ a channel's messages (chronological). Resolution: an explicit
 * `channelId` wins; else the most-recent channel bound to `subjectEntityId`
 * (contextObjectType='entity'). GENERIC: unlike the CRM-shaped mail-feed reader,
 * it does NOT hardcode a channelType (e.g. EXTERNAL) when resolving by subject —
 * callers who need a specific type resolve it via channel.resolve first and pass
 * the channelId. Channel visibility is enforced through the access layer BEFORE
 * any message is read, so it never reads a channel outside the caller's floor.
 */
const feedReadParams = z
  .object({
    channelId: z.string().uuid().optional(),
    subjectEntityId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .refine((v) => v.channelId || v.subjectEntityId, {
    message: "feed.read requires channelId or subjectEntityId.",
  });

const feedReadHandler: BuiltinVerbHandler = async (params, ctx) => {
  const input = feedReadParams.parse(params);
  const limit = input.limit ?? 40;
  const scoped = await getReadScope(ctx.userId, ctx.workspaceId ?? undefined);

  // Resolve the target channel THROUGH the access layer so it is provably
  // visible to the caller before any message read (no cross-floor leak).
  let channelId: string | null = null;
  if (input.channelId) {
    const ch = await scoped.findFirst<{ id: string }>(channels, {
      where: eq(channels.id, input.channelId),
      columns: { id: true },
    });
    channelId = ch?.id ?? null;
  } else if (input.subjectEntityId) {
    const ch = await scoped.findFirst<{ id: string }>(channels, {
      where: and(
        eq(channels.contextObjectType, "entity"),
        eq(channels.contextObjectId, input.subjectEntityId)
      ),
      columns: { id: true },
      orderBy: desc(channels.updatedAt),
    });
    channelId = ch?.id ?? null;
  }

  if (!channelId) {
    return { messages: [], channelId: null };
  }

  // Reads through the ONE door (queryChannelMessages). The channel was already
  // resolved + authorized above THROUGH the access layer (getReadScope), so no
  // userId gate is passed here; the helper still owns isNull(deletedAt) +
  // ephemeral=false so recaps never enter agent history. Lazy-imported to keep
  // this module's load graph light, mirroring the other channel-util imports.
  const { queryChannelMessages } =
    await import("../../utils/query-channel-messages.js");
  const rows = await queryChannelMessages<
    Pick<
      typeof messages.$inferSelect,
      "role" | "content" | "metadata" | "timestamp"
    >
  >(db, {
    channelId,
    order: "desc",
    limit,
    columns: { role: true, content: true, metadata: true, timestamp: true },
  });

  // Re-order oldest → newest for downstream sequential reading.
  const ordered = rows.reverse().map((m) => ({
    role: m.role,
    content: m.content,
    authorName:
      (m.metadata as { sender?: { name?: string } } | null)?.sender?.name ??
      null,
    createdAt:
      m.timestamp instanceof Date ? m.timestamp.toISOString() : m.timestamp,
  }));

  return { messages: ordered, channelId };
};

// ── Entity/document write + read half (Spine-2) ──────────────────────────────
//
// Four GENERIC write verbs that let the capability substrate WRITE entities and
// documents (until now it could only read via entity.query), plus one READ verb
// for a single document. Same two shapes as above:
//   entity.create / entity.update  → delegate to the governed `entitiesRouter`
//     caller (`create` / `update`, both `podProcedure` — tolerant of a null
//     workspace for pod-scoped profiles), which runs `checkPermissionOrPropose`
//     internally. Its return is surfaced VERBATIM (it may be
//     `{ status: "proposed", proposalId }`).
//   document.create → delegates to the governed `documentsRouter.create`
//     caller (`workspaceProcedure` — requires an acting workspace lens),
//     mirroring channel.create / graph.link's membership pre-check.
//   document.update → delegates to `documentsRouter.update` (`protectedProcedure`
//     — its own gate is direct row ownership, not workspace membership, so
//     there is no workspace lens to pre-check here).
//   document.read   → READS through the access layer (`documents` already
//     carries a registered VisibilityRule), mirroring entity.query — metadata
//     only (not the MinIO-stored body), so it stays a pure access-layer read.

/** entity.create — create an entity through the governed `entitiesRouter.create` caller. */
const entityCreateParams = z.object({
  /** Entity profile slug (e.g. "task", "person") — the `type` discriminator. */
  profileSlug: z.string().min(1).max(200),
  title: z.string().min(1).max(500),
  description: z.string().max(5000).optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  /** Optional explicit workspace lens; defaults to the acting workspace (or
   *  pod-wide, for a pod-scoped profile, when neither is set). */
  workspaceId: z.string().uuid().optional(),
});

const entityCreateHandler: BuiltinVerbHandler = async (params, ctx) => {
  const input = entityCreateParams.parse(params);

  // entities.create is a podProcedure — unlike the workspace-scoped writes
  // above it tolerates a null workspace (pod-default profiles), so we only
  // enforce membership when a workspace lens IS in play.
  const workspaceId = input.workspaceId ?? ctx.workspaceId ?? null;
  let workspaceRole: string | undefined;
  if (workspaceId) {
    const membership = await getWorkspaceMembership(
      db,
      workspaceId,
      ctx.userId
    );
    if (!membership) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "No access to the acting workspace.",
      });
    }
    workspaceRole = membership.role;
  }

  const { entitiesRouter } = await import("../../routers/entities.js");
  const caller = entitiesRouter.createCaller({
    db,
    authenticated: true as const,
    userId: ctx.userId,
    workspaceId,
    workspaceRole,
  } as unknown as Context);

  // entities.create governs the write (checkPermissionOrPropose): it returns
  // either the created entity OR { status: "proposed", proposalId }. Surface
  // that verbatim so an unapproved create is not reported as done.
  //
  // THE ACTOR IS LOAD-BEARING, not decoration. `permission-check.ts` keys the
  // whole AI ladder on `if (agentUserId)` — by-kind floors,
  // AgentKindRequiresProposalError, the DEFAULT_AUTO_APPROVE classification.
  // Reaching that gate with `undefined` means the write is judged on the
  // OPERATOR path: gated in form, ungoverned in substance. The outer
  // capability gate still governs the RUN, but it cannot see the kind.
  // Ambient first — the ALS value is set server-side at every key-auth entry
  // point, so it survives a call site that forgot to populate `ctx`.
  const actingAgentUserId =
    getActingAgentUserId() ?? ctx.agentUserId ?? undefined;
  const result = await caller.create({
    profileSlug: input.profileSlug,
    title: input.title,
    description: input.description,
    properties: input.properties,
    ...(actingAgentUserId ? { agentUserId: actingAgentUserId } : {}),
  });

  return result;
};

/** entity.update — update an entity through the governed `entitiesRouter.update` caller. */
const entityUpdateParams = z.object({
  entityId: z.string().uuid(),
  title: z.string().max(500).optional(),
  description: z.string().max(5000).optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
});

const entityUpdateHandler: BuiltinVerbHandler = async (params, ctx) => {
  const input = entityUpdateParams.parse(params);

  // Mirror entity.create: entities.update is also a podProcedure, so only
  // enforce membership when the acting run carries a workspace lens.
  let workspaceRole: string | undefined;
  if (ctx.workspaceId) {
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
    workspaceRole = membership.role;
  }

  const { entitiesRouter } = await import("../../routers/entities.js");
  const caller = entitiesRouter.createCaller({
    db,
    authenticated: true as const,
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    workspaceRole,
  } as unknown as Context);

  // entities.update governs the write (checkPermissionOrPropose): it returns
  // either the updated entity OR { status: "proposed", proposalId }. Surface
  // that verbatim so an unapproved update is not reported as done.
  // Same reason as entity.create/entity.delete: `entities.update` keys its AI
  // ladder on `input.agentUserId`, so an unforwarded actor is judged on the
  // operator path.
  const actingAgentUserId =
    getActingAgentUserId() ?? ctx.agentUserId ?? undefined;
  const result = await caller.update({
    id: input.entityId,
    title: input.title,
    description: input.description,
    properties: input.properties,
    ...(actingAgentUserId ? { agentUserId: actingAgentUserId } : {}),
  });

  return result;
};

/** document.create — create a document through the governed `documentsRouter.create` caller. */
const documentCreateParams = z.object({
  title: z.string().min(1).max(500),
  content: z.string().max(200000).optional(),
});

const documentCreateHandler: BuiltinVerbHandler = async (params, ctx) => {
  const input = documentCreateParams.parse(params);

  // documents.create is workspaceProcedure — requires an acting workspace lens,
  // mirroring channel.create / graph.link.
  if (!ctx.workspaceId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "document.create requires a workspace context (workspaceId).",
    });
  }

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

  const { documentsRouter } = await import("../../routers/documents.js");
  const caller = documentsRouter.createCaller({
    db,
    authenticated: true as const,
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    workspaceRole: membership.role,
  } as unknown as Context);

  const result = await caller.create({
    title: input.title,
    content: input.content,
  });

  return result;
};

/** document.update — update a document through the governed `documentsRouter.update` caller. */
const documentUpdateParams = z.object({
  documentId: z.string().min(1),
  content: z.string().max(200000).optional(),
  title: z.string().max(500).optional(),
});

const documentUpdateHandler: BuiltinVerbHandler = async (params, ctx) => {
  const input = documentUpdateParams.parse(params);

  // documents.update is a protectedProcedure whose gate is direct row
  // ownership (documents.userId = ctx.userId), not workspace membership — it
  // takes no workspaceId input, so there is no workspace lens to pre-check
  // here (unlike the workspace-scoped writes above).
  const { documentsRouter } = await import("../../routers/documents.js");
  const caller = documentsRouter.createCaller({
    db,
    authenticated: true as const,
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  } as unknown as Context);

  const result = await caller.update({
    documentId: input.documentId,
    delta:
      input.content !== undefined ? [{ content: input.content }] : undefined,
    title: input.title,
  });

  return result;
};

/**
 * document.read — READ a document's metadata by id, scoped by the caller's
 * floor. Mirrors entity.query: reads THROUGH the access layer (`documents`
 * already carries a registered VisibilityRule), so it never returns a document
 * outside the caller's floor. Metadata only — the MinIO-stored body is NOT
 * fetched here (that's `documentsRouter.get`'s job); this verb stays a pure
 * access-layer read like its W6 siblings.
 */
/**
 * document.freeze_charts — D2: an AI-written report's charts are SNAPSHOTS. The
 * report flow runs this between the assembler and `create-report`: every live
 * chart embed in `markdown` gets `data` + `capturedAt` from its OWN live query
 * (`entities.list` as the acting user in the acting workspace — the exact door
 * the browser chart reads), shaped by the ONE shared shaper. A chart whose read
 * fails stays live (`diagnostics: freeze_failed`); zero rows is an empty
 * snapshot. Returns `{ markdown, frozen, diagnostics }` and writes NOTHING
 * (create-report does), so it is read-only and auto-runs inside the flow.
 */
const documentFreezeChartsParams = z.object({
  markdown: z.string().min(1),
});

const documentFreezeChartsHandler: BuiltinVerbHandler = async (params, ctx) => {
  const input = documentFreezeChartsParams.parse(params);
  return freezeChartEmbeds(input.markdown, liveChartReader(ctx));
};

/**
 * document.stamp_diagnostics — record RUN-TIME diagnostics (today
 * `freeze_failed`) on a document the caller owns, in W4b's ONE store
 * (`documents.metadata.diagnostics`, stamped for the current revision, the
 * content diagnostics re-run beside them). The report flow runs it after
 * `create-report` with `{{steps.freeze-charts.output.diagnostics}}`, so a chart
 * the freeze had to leave live says so ON the report. Content codes cannot be
 * asserted here (they are derived); only run-time codes are accepted.
 */
const documentStampDiagnosticsParams = z.object({
  documentId: z.string().optional().nullable(),
  items: z.array(
    z.object({
      code: z.enum(RUN_TIME_DIAGNOSTIC_CODES),
      severity: z.enum(["error", "warning", "info"]),
      message: z.string().min(1),
      fix: z.string().min(1),
      line: z.number().int().positive().optional(),
      directive: z.string().optional(),
      ref: z.record(z.string(), z.string()).optional(),
    })
  ),
});

const documentStampDiagnosticsHandler: BuiltinVerbHandler = async (
  params,
  ctx
) => {
  const input = documentStampDiagnosticsParams.parse(params);
  return stampRunDiagnostics({
    documentId: input.documentId,
    items: input.items,
    actingUserId: ctx.userId,
  });
};

const documentReadParams = z.object({
  documentId: z.string().min(1),
});

const documentReadHandler: BuiltinVerbHandler = async (params, ctx) => {
  const input = documentReadParams.parse(params);
  const scoped = await getReadScope(ctx.userId, ctx.workspaceId ?? undefined);

  const doc = await scoped.findFirst<{
    id: string;
    title: string;
    type: string;
    workspaceId: string | null;
    createdAt: Date;
    updatedAt: Date;
  }>(documents, {
    where: eq(documents.id, input.documentId),
    columns: {
      id: true,
      title: true,
      type: true,
      workspaceId: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!doc) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Document not found." });
  }

  return { document: doc };
};

// ── Kind + Facets (roles) ─────────────────────────────────────────────────────
//
// Three verbs over the ONE facet door. entity_facet.attach / .detach delegate to
// the governed `entitiesRouter.attachFacet` / `.detachFacet` callers (which run
// checkPermissionOrPropose internally), mirroring entity.create/update — their
// return is surfaced VERBATIM (it may be `{ status: "proposed", proposalId }`).
// entity_facet.list is a READ: it confirms the entity is in the caller's floor
// through the access layer (like entity.query) then resolves the entity's live
// facets via `getEffectiveFacets` (the canonical, floor-scoped facet resolver).

/** entity_facet.attach — attach a role-profile via the governed attachFacet door. */
const entityFacetAttachParams = z.object({
  entityId: z.string().uuid(),
  /** Role-profile slug to attach (profileKind='role'). */
  facetSlug: z.string().min(1).max(200),
  properties: z.record(z.string(), z.unknown()).optional(),
  /** Facet visibility lens; omit to inherit the parent entity's workspace. */
  workspaceId: z.string().uuid().optional(),
  /** Disambiguator when the same role attaches in multiple contexts. */
  contextEntityId: z.string().uuid().optional(),
});

const entityFacetAttachHandler: BuiltinVerbHandler = async (params, ctx) => {
  const input = entityFacetAttachParams.parse(params);

  // entities.attachFacet is a podProcedure — enforce membership only when the
  // acting run carries a workspace lens (mirror entity.create/update).
  let workspaceRole: string | undefined;
  if (ctx.workspaceId) {
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
    workspaceRole = membership.role;
  }

  const { entitiesRouter } = await import("../../routers/entities.js");
  const caller = entitiesRouter.createCaller({
    db,
    authenticated: true as const,
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    workspaceRole,
  } as unknown as Context);

  // attachFacet governs the write (checkPermissionOrPropose): it returns either
  // the attached facet OR { status: "proposed", proposalId }. Surface verbatim.
  const result = await caller.attachFacet({
    entityId: input.entityId,
    profileSlug: input.facetSlug,
    properties: input.properties,
    ...(input.workspaceId !== undefined
      ? { workspaceId: input.workspaceId }
      : {}),
    ...(input.contextEntityId !== undefined
      ? { contextEntityId: input.contextEntityId }
      : {}),
  });

  return result;
};

/**
 * Resolve a live facet's id on an entity by its role-profile slug, scoped to the
 * caller's floor via the canonical `getEffectiveFacets` resolver (the SAME
 * floor-scoped read `entity_facet.list` uses — never a re-derived
 * profileSlug::value match, the bug the scattered dedup implementations had).
 * Returns null when the entity carries no live facet for that role (e.g. already
 * detached); the callers decide whether that is a no-op or a NOT_FOUND.
 */
async function resolveFacetIdBySlug(
  entityId: string,
  facetSlug: string,
  ctx: BuiltinVerbContext
): Promise<string | null> {
  const facets = await getEffectiveFacets(db, entityId, {
    userId: ctx.userId,
    workspaceId: ctx.workspaceId ?? undefined,
  });
  const match = facets.find((f) => f.profile.slug === facetSlug);
  return match?.facet.id ?? null;
}

/**
 * entity_facet.update — update a facet's status/properties through the governed
 * `entitiesRouter.updateFacet` caller (which runs checkPermissionOrPropose
 * internally, then FacetRepository.update — the one facet door). Accepts the
 * facet's own id OR (entityId + facetSlug): capability nodes carry a facetId,
 * template/flow authors carry the role slug. Return surfaced VERBATIM (it may be
 * `{ status: "proposed", proposalId }`).
 */
const entityFacetUpdateParams = z.object({
  /** The facet's own id (wins over entityId+facetSlug). */
  facetId: z.string().uuid().optional(),
  /** Alternative to facetId: parent entity + role slug to resolve to the live facet. */
  entityId: z.string().uuid().optional(),
  facetSlug: z.string().min(1).max(200).optional(),
  status: z.string().max(100).optional(),
  properties: z.record(z.string(), z.unknown()).optional(),
  /** Overlay lens for property validation; omit to inherit the facet's stored ws. */
  workspaceId: z.string().uuid().nullable().optional(),
});

const entityFacetUpdateHandler: BuiltinVerbHandler = async (params, ctx) => {
  const input = entityFacetUpdateParams.parse(params);

  // Resolve the target facet id: explicit id wins; else (entityId + facetSlug)
  // resolves to the live facet through the floor-scoped resolver.
  let facetId = input.facetId;
  if (!facetId) {
    if (!input.entityId || !input.facetSlug) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          "entity_facet.update requires facetId, or entityId + facetSlug.",
      });
    }
    const resolved = await resolveFacetIdBySlug(
      input.entityId,
      input.facetSlug,
      ctx
    );
    if (!resolved) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: `No live facet '${input.facetSlug}' on entity ${input.entityId}.`,
      });
    }
    facetId = resolved;
  }

  // updateFacet is a podProcedure — enforce membership only under a ws lens.
  let workspaceRole: string | undefined;
  if (ctx.workspaceId) {
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
    workspaceRole = membership.role;
  }

  const { entitiesRouter } = await import("../../routers/entities.js");
  const caller = entitiesRouter.createCaller({
    db,
    authenticated: true as const,
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    workspaceRole,
  } as unknown as Context);

  // updateFacet governs the write (checkPermissionOrPropose). Surface verbatim.
  const result = await caller.updateFacet({
    facetId,
    status: input.status,
    properties: input.properties,
    ...(input.workspaceId !== undefined
      ? { workspaceId: input.workspaceId }
      : {}),
  });

  return result;
};

/** entity_facet.detach — soft-delete a facet via the governed detachFacet door.
 *  Accepts the facet's own id OR (entityId + facetSlug): template/flow authors
 *  know the role slug, not the facet id. */
const entityFacetDetachParams = z.object({
  /** The facet's own id (wins over entityId+facetSlug). */
  facetId: z.string().uuid().optional(),
  /** Alternative to facetId: parent entity + role slug to resolve to the live facet. */
  entityId: z.string().uuid().optional(),
  facetSlug: z.string().min(1).max(200).optional(),
});

const entityFacetDetachHandler: BuiltinVerbHandler = async (params, ctx) => {
  const input = entityFacetDetachParams.parse(params);

  // Resolve the target facet id: explicit id wins; else (entityId + facetSlug).
  let facetId = input.facetId;
  if (!facetId) {
    if (!input.entityId || !input.facetSlug) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message:
          "entity_facet.detach requires facetId, or entityId + facetSlug.",
      });
    }
    const resolved = await resolveFacetIdBySlug(
      input.entityId,
      input.facetSlug,
      ctx
    );
    if (!resolved) {
      // No live facet for that role — idempotent no-op (already detached, or the
      // entity never carried it). Do NOT throw: an at-least-once redelivery of a
      // flow's facet_detach must not fail after the facet is already gone.
      return { status: "detached" as const, noop: true as const };
    }
    facetId = resolved;
  }

  // Mirror entity.update: detachFacet is a podProcedure, so only enforce
  // membership when the acting run carries a workspace lens.
  let workspaceRole: string | undefined;
  if (ctx.workspaceId) {
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
    workspaceRole = membership.role;
  }

  const { entitiesRouter } = await import("../../routers/entities.js");
  const caller = entitiesRouter.createCaller({
    db,
    authenticated: true as const,
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    workspaceRole,
  } as unknown as Context);

  // detachFacet governs the write (checkPermissionOrPropose). Surface verbatim.
  const result = await caller.detachFacet({ facetId });

  return result;
};

/**
 * entity.delete — soft-delete an entity through the governed `entitiesRouter.delete`
 * caller (checkPermissionOrPropose). DESTRUCTIVE: the governance floor always
 * PROPOSES a delete for a non-owner agent, so the return is surfaced VERBATIM (it
 * may be `{ status: "proposed", proposalId }`). Never hard-deletes — the router
 * soft-deletes (sets deletedAt) exactly as MCP/tRPC delete does.
 */
const entityDeleteParams = z.object({
  entityId: z.string().uuid(),
});

const entityDeleteHandler: BuiltinVerbHandler = async (params, ctx) => {
  const input = entityDeleteParams.parse(params);

  // entities.delete is a podProcedure — enforce membership only under a ws lens
  // (mirror entity.update). The router itself re-checks the entity's visibility.
  let workspaceRole: string | undefined;
  if (ctx.workspaceId) {
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
    workspaceRole = membership.role;
  }

  const { entitiesRouter } = await import("../../routers/entities.js");
  const caller = entitiesRouter.createCaller({
    db,
    authenticated: true as const,
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    workspaceRole,
  } as unknown as Context);

  // delete governs the write (checkPermissionOrPropose). Surface verbatim so an
  // unapproved (proposed) delete is not reported as done.
  //
  // The ACTOR is what arms rung 2.5 DESTRUCTIVE. `entities.delete` reads
  // `input.agentUserId` and nothing else — no ambient read of its own — so a
  // verb run that forwards nothing reaches the gate on the OPERATOR path and
  // the destructive floor never fires. Ambient first: set server-side at every
  // key-auth entry point, so it survives a call site that never populated `ctx`.
  const deleteAgentUserId =
    getActingAgentUserId() ?? ctx.agentUserId ?? undefined;
  const result = await caller.delete({
    id: input.entityId,
    ...(deleteAgentUserId ? { agentUserId: deleteAgentUserId } : {}),
  });
  return result;
};

/** entity_facet.list — READ an entity's live facets, scoped by the caller's floor. */
const entityFacetListParams = z.object({
  entityId: z.string().uuid(),
  /** Optional workspace lens; omit for the acting/pod-wide lens. */
  workspaceId: z.string().uuid().optional(),
});

const entityFacetListHandler: BuiltinVerbHandler = async (params, ctx) => {
  const input = entityFacetListParams.parse(params);
  const lens = input.workspaceId ?? ctx.workspaceId ?? undefined;

  // Confirm the entity is in the caller's floor THROUGH the access layer before
  // reading its facets (mirror entity.query's scoping).
  const scoped = await getReadScope(ctx.userId, lens);
  const entity = await scoped.findFirst<{
    id: string;
    workspaceId: string | null;
  }>(entities, {
    where: eq(entities.id, input.entityId),
    columns: { id: true, workspaceId: true },
  });
  if (!entity) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Entity not found." });
  }

  // Resolve live facets through the canonical floor-scoped resolver (the same
  // one entities.get uses), under the entity's own lens when no lens is active.
  const facets = await getEffectiveFacets(db, input.entityId, {
    userId: ctx.userId,
    workspaceId: lens ?? entity.workspaceId ?? undefined,
  });

  return {
    facets: facets.map((f) => ({
      facetId: f.facet.id,
      profileSlug: f.profile.slug,
      status: f.facet.status,
      properties: f.facet.properties,
      workspaceId: f.facet.workspaceId,
      contextEntityId: f.facet.contextEntityId,
    })),
    count: facets.length,
  };
};

// ── Marketplace (Wave 3b) ─────────────────────────────────────────────────────
//
// market.search / market.install ride the SAME builtin-verb substrate as every
// other Tier-0 op (D2) — no new tool, no new door, just two more catalog
// entries. Both read/write the pod-local `cp_catalog_cache` (Wave 3a), never a
// live Control-Plane fetch on the hot path.

/** Resolve whether a catalog entry is already installed — HONEST per kind: a
 *  cheap natural-key check for capability/cell, `undefined` (never a fabricated
 *  guess) when the check would require scanning every workspace's provenance. */
async function resolveInstalledFlag(
  kind: CatalogKind,
  slug: string
): Promise<boolean | undefined> {
  if (kind === "capability") {
    const [row] = await db
      .select({ id: capabilities.id })
      .from(capabilities)
      .where(drizzleSql`${capabilities.metadata}->>'templateKey' = ${slug}`)
      .limit(1);
    return !!row;
  }
  if (kind === "cell") {
    // Cache slug scheme is `${packageSlug}/${cellKey}` (cp-catalog-sync.ts);
    // the installed typeKey scheme is `cell:${packageSlug}:${cellKey}` (the
    // SAME scheme POST /cells/install and defineCell use).
    if (!slug.includes("/")) return undefined;
    const [pkgSlug, cellKey] = slug.split("/");
    const [row] = await db
      .select({ id: widgetDefinitions.id })
      .from(widgetDefinitions)
      .where(eq(widgetDefinitions.typeKey, `cell:${pkgSlug}:${cellKey}`))
      .limit(1);
    return !!row;
  }
  // automation/template: no cheap natural-key check today (would require
  // scanning every workspace's provenance) — honest `undefined`, never faked.
  return undefined;
}

const marketSearchParams = z.object({
  query: z.string().max(200).optional(),
  kind: z
    .enum([
      "capability",
      "automation",
      "template",
      "cell",
      "skill",
      "view",
      // Alias of cache kind `template` (CP category `workspace`). Mapped in
      // queryCatalogCache; agents should still send `kind:template`.
      "workspace",
    ])
    .optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
});

const marketSearchHandler: BuiltinVerbHandler = async (params) => {
  const input = marketSearchParams.parse(params);
  const { queryCatalogCache } = await import("./catalog-cache-query.js");
  const entries = await queryCatalogCache({
    query: input.query,
    kind: input.kind,
    limit: input.limit ?? 20,
  });

  if (entries.length === 0) {
    return {
      entries: [],
      message:
        'Nothing matched the marketplace either. Tell the user exactly what\'s missing — never fabricate a result. If what\'s missing is a TOOL the user uses (an app or service Synap cannot connect yet), record it once with synap_run_capability({ verbId: "tool.request", parameters: { toolName: "<the tool\'s name>" } }): one deduped tool request per tool, reviewed by the user, which tells Synap what to integrate next. Do not capture it as a note.',
    };
  }

  const compact = await Promise.all(
    entries.map(async (e) => ({
      slug: e.slug,
      kind: e.kind,
      name: e.name,
      description: e.description,
      version: e.version,
      tier: e.tier,
      installed: await resolveInstalledFlag(e.kind, e.slug),
    }))
  );

  return { entries: compact, count: compact.length };
};

const marketInstallParams = z.object({
  slug: z.string().min(1).max(200),
  kind: z.enum([
    "capability",
    "automation",
    "template",
    "cell",
    "skill",
    "view",
  ]),
  version: z.string().max(100).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  /** Stamp uses-edges / seed filing onto this existing project. */
  projectId: z.string().uuid().optional(),
  /**
   * Human-typed engagement name. Mint/reuse Project then stamp uses.
   * Agents must pass projectId (gravity); projectName alone is refused for agents.
   */
  projectName: z.string().min(1).max(255).optional(),
  // RC4 payload-in: an already-CP-authenticated client can hand us the FULL
  // package definition so the pod installs a PRIVATE package WITHOUT re-fetching
  // the CP by slug (that fetch is unauthenticated → 404s for private packages).
  // When present it IS the resolved definition; when absent the fetch path is
  // unchanged (fallback).
  definition: z.record(z.string(), z.unknown()).optional(),
});

/**
 * tool.request — record demand for a tool Synap cannot connect yet, through the
 * ONE door `recordToolDemand` (normalize → resolve the existing tool_request →
 * governed create/update). An agent run carries `agentUserId`, so the entity
 * door proposes; an operator run writes. A WRITE verb: it flows through the
 * full capability gate (absent from READ_ONLY_BUILTIN_VERBS).
 */
// STRICT: a tool name and where the demand came from — any other field (e.g. a
// provider key or free text) is refused, never stored, since demand is forwarded.
const toolRequestParams = z
  .object({
    toolName: z.string().trim().min(1).max(200),
    source: z.enum(["market_search_miss", "blocked_agent"]).optional(),
  })
  .strict();

const toolRequestHandler: BuiltinVerbHandler = async (params, ctx) => {
  const input = toolRequestParams.parse(params);
  const { entitiesRouter } = await import("../../routers/entities.js");
  const { recordToolDemand } =
    await import("../tool-demand/record-tool-demand.js");
  // tool_request is a pod-scope kind: no workspace lens, so no membership read.
  const caller = entitiesRouter.createCaller({
    db,
    authenticated: true as const,
    userId: ctx.userId,
    workspaceId: null,
    workspaceRole: undefined,
  } as unknown as Context);
  return recordToolDemand({
    caller,
    userId: ctx.userId,
    toolName: input.toolName,
    source: input.source ?? "market_search_miss",
    ...(ctx.agentUserId ? { agentUserId: ctx.agentUserId } : {}),
  });
};

const marketInstallHandler: BuiltinVerbHandler = async (params, ctx) => {
  const input = marketInstallParams.parse(params);
  const { runMarketInstall } = await import("./marketplace-install.js");
  return runMarketInstall({
    slug: input.slug,
    kind: input.kind,
    version: input.version,
    params: input.params,
    definition: input.definition,
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    agentUserId: ctx.agentUserId ?? null,
    projectId: input.projectId,
    projectName: input.projectName,
  });
};

/**
 * market.scaffold — generate a marketplace package SKELETON and PERSIST it on
 * the pod as a `document` ENTITY, returning an id + URL rather than the
 * definition body.
 *
 * WHY IT EXISTS: `synap market scaffold <slug>` (the CLI) writes
 * `<slug>.template.yaml` to DISK. An agent door has no disk, so marketplace
 * authoring was unreachable from an agent. This verb keeps the SAME skeletons
 * (see `market-scaffold.ts` for why they are a copy rather than a shared
 * import) and swaps the destination: the pod.
 *
 * WHY THE `entity.create` DOOR AND NOT `document.create`: a document is not an
 * entity here (`documents.entityId` was REMOVED; the relationship is
 * `entities WHERE documentId = ?`), so a bare `documents.create` row has no
 * entity — nothing `ask` / `get_entities` / the graph can find, and nothing
 * `linkEntityToProject` (which takes an entityId) could ever be filed into a
 * project. `entitiesRouter.create` gives all three at once: it SYNTHESIZES the
 * document from `content` via `EntityBodyService.setBody`, it resolves PROJECT
 * placement itself (explicit `projectId` → producing session → the agent's
 * declared focus) and files `belongs_to_project` idempotently, and — unlike
 * `documents.create`, which carries no gate call at all — it runs
 * `checkPermissionOrPropose`. So a `proposed` verdict is now genuinely
 * reachable, and it is surfaced as SUCCESS.
 *
 * WHAT IT RETURNS: `{ status, entityId, url, proposalId?, slug, category,
 * fileName, summary }` — deliberately NOT the definition body. A skeleton is
 * hundreds to thousands of characters of boilerplate the agent does not need to
 * read back, and MCP responses are capped.
 *
 * NO PROPERTY BAG IS SENT, on purpose. The `document` kind models ZERO
 * properties (it has no entry in `SYSTEM_PROFILE_PROPERTY_LINKS`), so a
 * `packageSlug`/`category`/`status` bag would be stored unmodeled and stay
 * invisible to a schema-driven UI. Findability comes from the TITLE (which
 * carries the package name + category), the BODY (which carries `meta.slug`
 * verbatim), the PROJECT link, and the entity row itself.
 *
 * `category: "skill"` is NOT offered, matching the CLI: the Control Plane's
 * package schema has no standalone slot for a skill, so a skeleton for one
 * could never publish.
 *
 * This is a WRITE verb: it is absent from READ_ONLY_BUILTIN_VERBS and flows
 * through the full capability gate as well.
 */
const marketScaffoldParams = z
  .object({
    /** Package slug, e.g. `book-club`. Also names the file the CLI would write. */
    slug: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(
        /^[a-z0-9][a-z0-9-]*$/,
        "slug must be lowercase kebab-case (a-z, 0-9, '-')"
      ),
    /** Which package shape to scaffold. Defaults to a workspace template. */
    category: z.enum(SCAFFOLDABLE_CATEGORIES).default("workspace"),
    /** Optional explicit workspace lens; defaults to the acting workspace (or pod-wide). */
    workspaceId: z.string().uuid().optional(),
    /**
     * Optional explicit project lens. Omit it and `entities.create`'s own
     * placement ladder resolves one (producing session → the agent's declared
     * focus) — never hand-roll a `belongs_to_project` relation here.
     */
    projectId: z.string().uuid().optional(),
  })
  .strict();

const marketScaffoldHandler: BuiltinVerbHandler = async (params, ctx) => {
  // Honour the CLI's known refusal WITH ITS REASON rather than letting the enum
  // emit a generic "invalid value" — the caller is asking for something that
  // cannot exist, not something misspelled.
  if ((params as { category?: unknown }).category === "skill") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "A skill is not scaffoldable: the Control Plane's package schema has no standalone slot for one (skills only exist nested inside a capability's skills[]). Scaffold a capability instead and edit its skills[].",
    });
  }
  const input = marketScaffoldParams.parse(params);
  const skeleton = buildPackageSkeleton(input.slug, input.category);

  // Mirrors entityCreateHandler exactly: entities.create is a podProcedure, so
  // membership is pre-checked only when a workspace lens IS in play (a
  // pod-scoped profile — `document` is one — tolerates a null workspace).
  const workspaceId = input.workspaceId ?? ctx.workspaceId ?? null;
  let workspaceRole: string | undefined;
  if (workspaceId) {
    const membership = await getWorkspaceMembership(
      db,
      workspaceId,
      ctx.userId
    );
    if (!membership) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "No access to the acting workspace.",
      });
    }
    workspaceRole = membership.role;
  }

  const { entitiesRouter } = await import("../../routers/entities.js");
  const caller = entitiesRouter.createCaller({
    db,
    authenticated: true as const,
    userId: ctx.userId,
    workspaceId,
    workspaceRole,
  } as unknown as Context);

  const result = await caller.create({
    profileSlug: "document",
    title: skeleton.title,
    // The BODY. `EntityBodyService.setBody` materializes it as a real versioned
    // document when it reads as long-form (see `shouldMaterializeAsDocument`);
    // a short skeleton stays inline on the entity instead. Either way the whole
    // skeleton is stored and the caller never has to carry it.
    content: skeleton.body,
    // Explicit lens only; absent, the door's own placement ladder resolves it.
    ...(input.projectId ? { projectId: input.projectId } : {}),
    // Forwarded so an AGENT run is governed as an agent (the gate branches on
    // it). `entity.create` does not thread this today; market.install does, and
    // it is the stricter, correct direction — without it an agent write would
    // be judged on the operator path.
    ...(ctx.agentUserId ? { agentUserId: ctx.agentUserId } : {}),
  });

  // `status` is surfaced VERBATIM. "proposed" is SUCCESS: the skeleton is
  // queued for the owner's review, not lost.
  //
  // The router's return is a UNION whose arms widen `status` to `string`, so
  // TS cannot discriminate on it. Read the propose-only fields through a narrow
  // structural view rather than `any` — the shape below is exactly what the
  // `status: "proposed"` arm of `entities.create` returns.
  const proposedView = result as {
    status: string;
    proposalId?: string;
    reviewUrl?: string;
    proposedEntityId?: string;
  };
  if (proposedView.status === "proposed") {
    return {
      status: proposedView.status,
      // Allocated at propose-time so the caller can reference it before
      // approval; absent on a join gate, where no id was ever allocated.
      entityId: proposedView.proposedEntityId ?? null,
      proposalId: proposedView.proposalId,
      // The door already built the review link — never rebuild it here.
      url:
        proposedView.reviewUrl ??
        (proposedView.proposalId ? openLink(proposedView.proposalId) : null),
      slug: input.slug,
      category: input.category,
      fileName: skeleton.fileName,
      summary: `Skeleton for ${input.category} package "${input.slug}" (${skeleton.body.length} chars) is awaiting your review. Open the url to approve it, then edit and publish with \`synap market publish\`.`,
    };
  }

  return {
    status: result.status,
    entityId: result.id,
    // The ONE link builder (deep-links.ts), never a concatenated URL.
    url: openLink(result.id),
    slug: input.slug,
    category: input.category,
    fileName: skeleton.fileName,
    // ONE LINE. The body is deliberately not returned — open the url to edit it.
    summary: `Skeleton for ${input.category} package "${input.slug}" saved as a draft document entity (${skeleton.body.length} chars). Open the url to edit, then publish with \`synap market publish\`.`,
  };
};

/**
 * connector.health_check — probe a connector for a provider and, if its OAuth
 * connection is dead (refresh token expired / never connected), emit the operator
 * reconnect nudge — so a CONFIG feed nudges instead of going SILENTLY dead on an
 * expired token (the gap: run-mail-feed.ts had this inline, a config feed had no
 * verb for it).
 *
 * It mirrors exactly what run-mail-feed.ts does: run a cheap probe verb, inspect
 * the result with `capErrorMessage` + `isConnectionAuthError`, and on a real
 * auth error call the SHARED `notifyConnectorUnhealthy` helper (in-app notice +
 * firewall-safe Discord nudge, deduped per cooldown). The nudge is NOT
 * reimplemented here. A healthy connector is a no-op.
 *
 * The dedup watermark + notice channel live on the pod's `discord` tool (the same
 * row run-mail-feed uses), so repeated cron ticks nudge once per cooldown, not
 * every tick.
 */
const connectorHealthCheckParams = z.object({
  /** Stable connector key for dedup + display, e.g. "google". */
  provider: z.string().min(1).max(100),
  /** Human display name, e.g. "Google Workspace". */
  connectorName: z.string().min(1).max(200),
  /** One-line action for the operator (how to reconnect). */
  reconnectHint: z.string().min(1).max(1000),
  /** A cheap capability verb to probe with, e.g. "gmail_search". */
  probeVerbId: z.string().min(1).max(200),
  /** Optional params for the probe verb (default {}). */
  probeParameters: z.record(z.string(), z.unknown()).optional(),
  /** Optional 1-of-N connection id to pin the probe to. */
  connectionId: z.string().max(200).optional(),
});

const connectorHealthCheckHandler: BuiltinVerbHandler = async (params, ctx) => {
  const input = connectorHealthCheckParams.parse(params);

  // Lazy import to avoid the top-level cycle (execute-capability.ts imports
  // BUILTIN_VERBS from THIS module — the same reason marketInstall lazy-imports).
  const { executeCapability } = await import("./execute-capability.js");
  const {
    notifyConnectorUnhealthy,
    isConnectionAuthError,
    capErrorMessage,
    resolveNoticeChannelId,
    hasDiscordFeedbackChannel,
  } = await import("../connection-health/notify-connector-unhealthy.js");

  // 1. Probe. A dead connection surfaces as an error envelope inside a
  //    kind:"run" result (post masking-fix) — capErrorMessage extracts it.
  const cap = await executeCapability({
    verbId: input.probeVerbId,
    parameters: input.probeParameters ?? {},
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    connectionSelector: input.connectionId
      ? { connectionId: input.connectionId }
      : undefined,
  });

  const capErr = capErrorMessage(cap);
  // Healthy (or a non-auth transient) → no-op.
  if (!capErr || !isConnectionAuthError(capErr)) {
    return { unhealthy: false, nudged: false };
  }

  // 2. Unhealthy → nudge via the shared helper. The watermark + notice channel
  //    live on the pod's discord tool — the SAME singleton row run-mail-feed
  //    uses, deliberately UNSCOPED: this is a pod-wide ops-alert channel, not
  //    a per-workspace feature (a connector break in any workspace should
  //    reach the one Discord ops channel, not go silent because THAT
  //    workspace happens not to own the discord tool row). An earlier version
  //    of this call scoped to `ctx.workspaceId`, which silently stopped
  //    nudging for any workspace without its own discord row — a regression,
  //    reverted here. No sub-feature flag applies to this call site (unlike
  //    event-sync/mail-feed) — but "no sub-feature flag" is NOT "no question":
  //    what this call needs from the row is the notice channel, so it asks for
  //    a row that HAS one. `() => false` made the choice pure creation order,
  //    which meant configuring `discord.feedbackChannel` on the newer of this
  //    pod's two discord rows would have silenced the nudge with no error.
  //    Oldest-row remains the fallback when NO row is configured.
  const discordTool = await resolveTool("discord", hasDiscordFeedbackChannel);
  if (!discordTool) {
    // No watermark holder → can't dedup; report unhealthy without nudging.
    return { unhealthy: true, nudged: false, error: capErr };
  }

  const metadata = (discordTool.metadata ?? {}) as Record<string, unknown>;
  const nudged = await notifyConnectorUnhealthy({
    connectorKey: input.provider,
    connectorName: input.connectorName,
    reconnectHint: input.reconnectHint,
    userId: discordTool.createdBy,
    workspaceId: discordTool.workspaceId ?? null,
    watermarkToolId: discordTool.id,
    watermarkMetadata: metadata,
    discordTeamChannelId: resolveNoticeChannelId(metadata, undefined),
    errorMessage: capErr,
  });

  return { unhealthy: true, nudged, error: capErr };
};

/**
 * channel.ingest — WRITE: record a GENERIC inbound message onto its EXTERNAL
 * channel (resolve-or-create the channel, dedup-insert the message, emit
 * `external_message.received`). Delegates to the SHARED `recordInboundMessage`
 * service — the SAME sink every provider webhook (the inbound REST routes) calls
 * — so channel resolve + dedup + side-effects live in exactly one place and are
 * never reimplemented here.
 *
 * This is the composition seam: provider ingest can now be driven as
 * config/automation from OUTSIDE the pod (a config feed / automation node runs
 * this verb with the parsed message) instead of only from a hard-wired webhook
 * route. It carries NO provider-specific logic — `provider`/`externalId`/etc. are
 * all opaque PARAMETERS, exactly like the recorder itself.
 *
 * GOVERNED like the other write verbs: it is NOT in READ_ONLY_BUILTIN_VERBS, so
 * it flows through the full capability gate (approval + grant). The intended
 * caller is a workspace-owner-run automation — the owner passes straight through
 * the gate (same posture as the mail-feed / cal-backfill runners). We enforce
 * workspace membership when a workspace lens is in play (mirroring entity.create,
 * since recordInboundMessage is a service, not a self-governing router) and bound
 * the write to the operator (userId=ctx.userId).
 */
/**
 * Field-path map for BATCH mode. Each value is a dot-path INTO one raw message
 * row (e.g. `"text"`, `"sender.name"`), so the verb stays PROVIDER-AGNOSTIC —
 * the caller's CONFIG (an automation node) says where each field lives; the
 * substrate hardcodes no provider shape.
 */
const channelIngestMessageMap = z.object({
  /** Dot-path to the message body (required for batch). */
  text: z.string().min(1).max(200),
  /**
   * Dot-path to the message's STABLE external id — REQUIRED. It is the per-message
   * dedup key. It must NOT be positional: providers page newest-first, so a raw
   * array index shifts every time a new message arrives, which would collide seeds
   * and silently drop/duplicate history on re-run. If a row is missing this id at
   * runtime we fall back to a CONTENT key (sentAt+text), never the index.
   */
  id: z.string().min(1).max(200),
  /** Dot-path to the message timestamp (ISO). */
  sentAt: z.string().max(200).optional(),
  /** Dot-path to the sender display name. */
  participant: z.string().max(200).optional(),
  /** Dot-path to the sender external id. */
  participantExternalId: z.string().max(200).optional(),
  /**
   * Dot-path to a BOOLEAN in each raw row marking the message as OUTBOUND — the
   * operator's OWN sent message (e.g. Unipile's `"is_sender"`). PROVIDER-AGNOSTIC:
   * it is just a dot-path in the caller's config, no provider shape is hardcoded.
   * When the resolved value is truthy the row is recorded as HUMAN/ASSISTANT so
   * the inbox renders it right-aligned; otherwise it is a normal inbound (default).
   */
  isOutbound: z.string().max(200).optional(),
});

const channelIngestParams = z
  .object({
    /** Opaque provider key (channel dedup namespace), e.g. the connector name. */
    provider: z.string().min(1).max(200),
    /** External thread/channel id — the channel dedup key. */
    externalId: z.string().min(1).max(500),

    // ── Single-message mode ──────────────────────────────────────────────
    /** Message body (single mode). */
    text: z.string().min(1).max(100000).optional(),
    /** Stable idempotency seed for THIS message (single mode). */
    idempotencySeed: z.string().min(1).max(1000).optional(),

    // ── Batch mode (for pure-config automations that CANNOT loop per-message:
    //    the automation engine has no nested loops, so a whole thread's message
    //    array is ingested in ONE call). Each row is normalized server-side via
    //    `messageMap` field-paths — the provider shape stays in the caller's
    //    config, never in this verb. ──────────────────────────────────────
    /** Raw message rows (e.g. a thread's `messages[]` from a list verb). */
    messages: z.array(z.record(z.string(), z.unknown())).max(2000).optional(),
    /** Where each field lives inside a `messages[]` row. Required with `messages`. */
    messageMap: channelIngestMessageMap.optional(),

    // ── Common ───────────────────────────────────────────────────────────
    /** Participant display name (single mode, or batch fallback). */
    participant: z.string().max(500).optional(),
    /** Participant id in the external system. */
    participantExternalId: z.string().max(500).optional(),
    /** Account id in the external system. */
    accountExternalId: z.string().max(500).optional(),
    /** Channel title for a freshly-created row; defaults to participant/externalId. */
    title: z.string().max(500).optional(),
    /** Message timestamp (ISO); single mode, defaults to now server-side. */
    sentAt: z.string().max(100).optional(),
    /** Optional explicit workspace lens; falls back to the acting workspace, else pod-level. */
    workspaceId: z.string().uuid().optional(),
    /**
     * When true, SKIP the per-message `external_message.received` side-effect
     * (channel resolve + dedup insert still run). Threaded into every recorder
     * call. Use for a HISTORICAL backfill so replaying a whole thread does not
     * fan out through the webhook + automation-trigger reactors. Defaults to
     * false — live ingest keeps firing the event.
     */
    suppressSideEffects: z.boolean().optional(),
  })
  .refine(
    (v) => {
      // Exactly ONE mode (XOR) — not neither, not both — so a caller can never
      // supply conflicting single+batch inputs and silently get one discarded.
      const batch = v.messages !== undefined && v.messageMap !== undefined;
      const single = v.text !== undefined && v.idempotencySeed !== undefined;
      return batch !== single;
    },
    {
      message:
        "channel.ingest needs EITHER { messages[], messageMap } (batch) OR { text, idempotencySeed } (single) — exactly one.",
    }
  );

/** Read a dot-path (`"a.b.c"`) out of a plain object; undefined if any hop misses. */
function readPath(row: Record<string, unknown>, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (acc, key) =>
        acc && typeof acc === "object"
          ? (acc as Record<string, unknown>)[key]
          : undefined,
      row
    );
}

const channelIngestHandler: BuiltinVerbHandler = async (params, ctx) => {
  const input = channelIngestParams.parse(params);

  // recordInboundMessage tolerates a null workspace (records a pod-level
  // channel) — mirror entity.create: only enforce membership when a workspace
  // lens IS in play, so a workspace-pinned ingest is bounded to a workspace the
  // operator belongs to.
  const workspaceId = input.workspaceId ?? ctx.workspaceId ?? null;
  if (workspaceId) {
    const membership = await getWorkspaceMembership(
      db,
      workspaceId,
      ctx.userId
    );
    if (!membership) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "No access to the acting workspace.",
      });
    }
  }

  // Delegate to THE shared inbound sink — do NOT reimplement channel
  // resolve/dedup/side-effects. Lazy-imported to keep this module's load graph
  // light, mirroring every other service/router import in this file.
  const { recordInboundMessage } =
    await import("../connectors/inbound-recorder.js");

  // One call per inbound message; the recorder resolves-or-creates the ONE
  // channel keyed on (provider, externalId) and dedups each message by its
  // idempotencySeed — so a whole batch lands on a single thread, re-runs no-op.
  const recordOne = (args: {
    text: string;
    idempotencySeed: string;
    participant?: string;
    participantExternalId?: string;
    sentAt?: string;
    outbound?: boolean;
  }) =>
    recordInboundMessage({
      provider: input.provider,
      externalId: input.externalId,
      userId: ctx.userId,
      workspaceId,
      // ORIGIN: this channel was produced by the capability VERB that ran.
      ...(ctx.verbId
        ? {
            origin: {
              producerType: "capability" as const,
              producerId: ctx.verbId,
              ...(ctx.verbName ? { producerName: ctx.verbName } : {}),
            },
          }
        : {}),
      text: args.text,
      // An OUTBOUND row (the operator's own sent message) is recorded as
      // HUMAN/ASSISTANT so the inbox attributes it to the operator, not the
      // contact. Inbound rows omit both → the recorder defaults to EXTERNAL/USER.
      ...(args.outbound
        ? { authorType: MessageAuthorType.HUMAN, role: MessageRole.ASSISTANT }
        : {}),
      // Threaded from the top-level param: a historical backfill suppresses the
      // per-message event fan-out. Omitted (undefined) → recorder default false.
      ...(input.suppressSideEffects !== undefined
        ? { suppressSideEffects: input.suppressSideEffects }
        : {}),
      // recordInboundMessage requires a title for a freshly-created row; default
      // to the participant, else the external id, so a title-less call still names
      // the channel meaningfully.
      title:
        input.title ??
        args.participant ??
        input.participant ??
        input.externalId,
      ...(args.participant !== undefined
        ? { participant: args.participant }
        : {}),
      ...(args.participantExternalId !== undefined
        ? { participantExternalId: args.participantExternalId }
        : {}),
      ...(input.accountExternalId !== undefined
        ? { accountExternalId: input.accountExternalId }
        : {}),
      idempotencySeed: args.idempotencySeed,
      ...(args.sentAt !== undefined ? { sentAt: args.sentAt } : {}),
    });

  // ── Batch mode: normalize each raw row via messageMap (dot-paths) ─────────
  if (input.messages !== undefined && input.messageMap !== undefined) {
    const map = input.messageMap;
    let channelId: string | null = null;
    let contextObjectId: string | null = null;
    let recorded = 0;
    let skipped = 0;
    for (let i = 0; i < input.messages.length; i++) {
      const row = input.messages[i];
      const bodyRaw = readPath(row, map.text);
      const text = typeof bodyRaw === "string" ? bodyRaw : "";
      if (!text.trim()) {
        skipped++;
        continue; // empty/non-text row (e.g. a system event) — skip, don't fabricate.
      }
      const sentRaw = map.sentAt ? readPath(row, map.sentAt) : undefined;
      const partRaw = map.participant
        ? readPath(row, map.participant)
        : undefined;
      const partIdRaw = map.participantExternalId
        ? readPath(row, map.participantExternalId)
        : undefined;
      // Truthy `isOutbound` marks the operator's own sent message → record as
      // HUMAN/ASSISTANT (right-aligned in the inbox). Provider-agnostic: the
      // dot-path is caller config; any truthy JS value counts as outbound.
      const outbound = map.isOutbound
        ? Boolean(readPath(row, map.isOutbound))
        : false;
      // Stable per-message dedup key. Prefer the provider's native id (map.id is
      // required). If a row is missing it, fall back to a CONTENT key (sentAt +
      // body) — NEVER the array index, which shifts on newest-first pagination
      // and would collide seeds → silent drop/duplicate on re-run.
      const idRaw = readPath(row, map.id);
      const msgId =
        idRaw !== undefined && idRaw !== null && String(idRaw).length > 0
          ? String(idRaw)
          : `c:${typeof sentRaw === "string" ? sentRaw : ""}:${text.slice(0, 180)}`;
      const result = await recordOne({
        text,
        // Namespaced by the thread so the same message id in two threads never
        // collides; order-independent so re-runs are exactly idempotent.
        idempotencySeed: `${input.externalId}:${msgId}`,
        ...(typeof partRaw === "string" ? { participant: partRaw } : {}),
        ...(typeof partIdRaw === "string"
          ? { participantExternalId: partIdRaw }
          : {}),
        ...(typeof sentRaw === "string" ? { sentAt: sentRaw } : {}),
        outbound,
      });
      channelId = result.channelId;
      contextObjectId = result.contextObjectId;
      if (result.recorded) recorded++;
      else skipped++;
    }
    return {
      channelId,
      contextObjectId,
      recorded,
      skipped,
      total: input.messages.length,
      // Alias so a caller can read `.created` regardless of single/batch mode.
      created: recorded > 0,
    };
  }

  // ── Single-message mode (unchanged contract) ─────────────────────────────
  const result = await recordOne({
    // guaranteed present in single mode by the schema refine
    text: input.text!,
    idempotencySeed: input.idempotencySeed!,
    ...(input.participant !== undefined
      ? { participant: input.participant }
      : {}),
    ...(input.participantExternalId !== undefined
      ? { participantExternalId: input.participantExternalId }
      : {}),
    ...(input.sentAt !== undefined ? { sentAt: input.sentAt } : {}),
  });

  // Normalize the recorder's result. It exposes no messageId (the inbound row is
  // keyed by `inboundHash`, its deterministic dedup hash), so we surface that +
  // the context binding, and map `recorded` → `created` (false on a duplicate
  // delivery, which the recorder no-ops).
  return {
    channelId: result.channelId,
    contextObjectId: result.contextObjectId,
    inboundHash: result.inboundHash,
    created: result.recorded,
  };
};

/**
 * messaging.send — send a governed EXTERNAL message on a bound channel, on ANY
 * provider (email / LinkedIn / Discord / Proton …). This is the ONE builtin door
 * that lets a stored config (an automation/playbook `capability` node) emit an
 * outbound message that STILL passes the governance + client-comms firewall — it
 * routes through `sendExternalMessage`, the single governed send door, and never
 * reimplements or bypasses it.
 *
 * PROVIDER-AGNOSTIC: it resolves the channel's `externalSource` and lets
 * `getMessagingConnector` (inside `sendExternalMessage`) pick the connector — no
 * provider is special-cased here. The connector owns any header derivation (e.g.
 * Proton reads reply headers from the DB); this verb only carries the body.
 *
 * GOVERNANCE: `sendExternalMessage` gates an AGENT-initiated send
 * (`agentUserId` present) through `gateMessagingSend`, which PROPOSES rather than
 * auto-sends when there's no approving grant. An owner send (no agentUserId) goes
 * direct. A `proposed` verdict is a normal, non-error outcome — surfaced as
 * `{ proposed: true, proposalId }` so a flow can see it went to review.
 */
const messagingSendParams = z.object({
  /** The bound EXTERNAL channel to send on. */
  channelId: z.string().uuid(),
  /** Message body. */
  content: z.string().min(1).max(100000),
  /**
   * OPTIONAL reply headers — part of the frozen caller contract. NOT threaded
   * into the send today: `sendExternalMessage` carries only the body, and the
   * per-provider connector derives its own reply envelope from the DB (Proton) or
   * live thread (Stalwart/JMAP). Accepted here so a caller's config is stable and
   * a future explicit-override path has a home; changing that would mean a shared
   * connector-signature change, out of scope for this verb.
   */
  subject: z.string().max(2000).optional(),
  inReplyTo: z.string().max(1000).optional(),
});

const messagingSendHandler: BuiltinVerbHandler = async (params, ctx) => {
  const input = messagingSendParams.parse(params);

  // Resolve the channel: an EXTERNAL channel carries the routing identity the
  // send door needs (`externalId` = the thread key; `externalSource` = the
  // provider). Bound WHICH channel the run may target — the capability gate
  // already governs THAT this operator/agent may run messaging.send.
  const [channel] = await db
    .select({
      id: channels.id,
      workspaceId: channels.workspaceId,
      channelType: channels.channelType,
      externalId: channels.externalId,
      externalSource: channels.externalSource,
    })
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
  if (!channel.externalId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "messaging.send requires an EXTERNAL channel with an externalId (a bound external conversation).",
    });
  }

  // THE one governed send door. It resolves the connector from the channel's
  // externalSource, runs the governance + client-comms firewall INSIDE, mirrors
  // the outbound to `messages`, and emits `{provider}.send.completed`. An agent
  // send with no grant routes to a proposal (never auto-sent); an owner send goes
  // direct. Lazy-imported to keep this module's load graph light (mirrors the
  // other router/service imports in this file).
  const { sendExternalMessage } =
    await import("../../connectors/external-dispatch.js");
  const result = await sendExternalMessage({
    threadId: channel.externalId,
    // The connector resolves its own account (Discord/Proton ignore it; Unipile/
    // Stalwart resolve per-call from DB/vault/env).
    accountId: "",
    body: input.content,
    userId: ctx.userId,
    // Thread the agent identity so an agent-initiated send is GATED (propose when
    // ungranted); an owner run (no agentUserId) skips the gate byte-identically.
    agentUserId: ctx.agentUserId ?? null,
    workspaceId: ctx.workspaceId,
  });

  return {
    success: result.success,
    ...(result.messageId ? { messageId: result.messageId } : {}),
    // A gated agent send routed to review is NOT a failure — surface it distinctly
    // so a flow reads it as pending, not errored.
    ...(result.proposed ? { proposed: true } : {}),
    ...(result.proposalId ? { proposalId: result.proposalId } : {}),
    // A refused send says why ("Nothing ran …") and, for an agent on a
    // not-enabled messaging tool, carries the enable request it filed.
    ...(result.error ? { error: result.error } : {}),
    ...(result.enableProposal ? { enableProposal: result.enableProposal } : {}),
  };
};

/**
 * governance.recommend_tighten — scan recent REJECTED agent proposals, cluster
 * by shape, and file a pending `governance.tighten_lane` proposal for any shape
 * the humans reject consistently (the mirror of the trusted-lane WIDEN scanner).
 *
 * Takes NO params: it scans pod-wide agent behaviour, exactly like the widen
 * scanner job — the run's only side effect is filing PENDING review items via
 * the one door `insertPendingProposal`. The verb RUNS (files rows), it is not a
 * governed graph mutation, so it is READ-ONLY w.r.t. graph data and auto-runs
 * inside a cron automation (same rationale as connector.health_check — a propose
 * verdict on the verb itself would stall the flow).
 */
const governanceRecommendTightenParams = z.object({});

const governanceRecommendTightenHandler: BuiltinVerbHandler = async (
  _params,
  ctx
) => {
  // POD-ADMIN GATE. The widen mirror is a pg-boss CRON job — unreachable by a
  // user, so it needed no caller authorization. This one is an INVOKABLE verb,
  // and it scans every agent-user pod-wide and files proposals attributed to
  // OTHER users (`createdBy: agent.createdByUserId`) whose approval inserts
  // `governance_rules`. Read-only w.r.t. graph data ≠ unauthorized: without this
  // gate any workspace member (or any agent that can `run_capability`) could
  // file governance proposals in other people's names and fan notifications out
  // to every pod admin. Mirroring the scanner's SHAPE must not mean inheriting
  // the absence of a gate it never needed.
  await assertPodAdmin(ctx.userId);
  return recommendTightenForAllAgents();
};

/**
 * governance.recommend_raise_ceiling — the numeric-limit twin of
 * governance.recommend_tighten. Scans each agent's daily auto-write volume on the
 * events spine and files a pending `governance.raise_ceiling` proposal for any
 * agent that keeps hitting its per-UTC-day ceiling. Same pod-admin gate + no
 * params + read-only-w.r.t.-graph-data (files review items only) rationale as the
 * tighten recommender.
 */
const governanceRecommendRaiseCeilingParams = z.object({});

const governanceRecommendRaiseCeilingHandler: BuiltinVerbHandler = async (
  _params,
  ctx
) => {
  await assertPodAdmin(ctx.userId);
  return recommendRaiseCeilingForAllAgents();
};

/**
 * governance.recommend_raise_proposal_cap — the pending_proposal_cap twin of
 * governance.recommend_raise_ceiling. Scans each agent's CURRENT pending-proposal
 * count against its resolved pending_proposal_cap and files a pending
 * `settings.update` cap-raise proposal for any agent that is BLOCKED (at/over
 * its cap). Same pod-admin gate + no params + read-only-w.r.t.-graph-data
 * (files review items only) rationale.
 */
const governanceRecommendRaiseProposalCapParams = z.object({});

const governanceRecommendRaiseProposalCapHandler: BuiltinVerbHandler = async (
  _params,
  ctx
) => {
  await assertPodAdmin(ctx.userId);
  return recommendRaiseProposalCapForAllAgents();
};

/**
 * governance.recommend_tighten_posture — the channel-scoped twin of
 * governance.recommend_tighten. Scans rejected agent proposals GROUPED BY CHANNEL
 * (across all agents) and files a pending `governance.tighten_posture` proposal
 * for any channel the humans reject consistently. Same pod-admin gate + no params
 * + read-only-w.r.t.-graph-data rationale.
 */
const governanceRecommendTightenPostureParams = z.object({});

const governanceRecommendTightenPostureHandler: BuiltinVerbHandler = async (
  _params,
  ctx
) => {
  await assertPodAdmin(ctx.userId);
  return recommendTightenPostureForAllChannels();
};

/**
 * automation.recommend_health — the automation-health WARDEN.
 *
 * Scans every ENABLED, producer-backed automation older than the grace period
 * and files ONE grouped `automation.health_advisory` per OWNING HUMAN listing
 * the ones that have NEVER produced a run row.
 *
 * EFFECT-BASED, deliberately: the evidence is the ABSENCE of rows in the
 * `automation_runs` ledger, never a run's reported terminal status. The sibling
 * findings ("runs but always fails", "runs but does nothing") were left unbuilt
 * for exactly that reason — see the header of `automation-health-predicate.ts`.
 *
 * Same shape as the three governance recommenders: NO params (pod-wide scan),
 * pod-admin gated, and READ-ONLY w.r.t. graph data (its only side effect is
 * filing PENDING review items through the one door `insertPendingProposal`), so
 * it auto-runs inside the daily calibration cron.
 */
const automationRecommendHealthParams = z.object({});

const automationRecommendHealthHandler: BuiltinVerbHandler = async (
  _params,
  ctx
) => {
  // POD-ADMIN GATE — the same reasoning as the three recommenders above. This
  // verb reads EVERY user's automations pod-wide and files proposals attributed
  // to other people; read-only w.r.t. graph data is not the same as
  // unauthorized. (The findings themselves are then partitioned by owner, so no
  // proposal ever shows one person another person's automations.)
  await assertPodAdmin(ctx.userId);
  return scanAutomationHealth();
};

// ── Config REVISION half — playbook + automation ─────────────────────────────
//
// The substrate could BUILD config (playbook.create / automation.create) but
// never REVISE it: a live playbook whose `subjectProfile` pointed at a kind
// that no longer exists could not be repaired from any agent surface, and an
// agent-authored automation — which ALWAYS lands `draft`
// (`insertAutomationAfterGovernance`'s `forceDraft`) — could never be switched
// on. These four verbs close that, each delegating to the EXISTING governed
// tRPC procedure exactly like `entity.update` does. No logic is re-implemented
// here, and every return is surfaced VERBATIM so a `{ status: "proposed" }`
// outcome is reported as the success it is.
//
// WHY `automation.activate` IS ITS OWN VERB rather than `automation.update`
// with `status: "active"` — MEASURED, not stylistic. `automations.update`
// writes `status` straight into the row and computes NOTHING else;
// `automations.activate` additionally computes `nextRunAt` from the cron
// expression and clears `errorMessage`. Activating a cron automation through
// the update path therefore produces a row that reads "active" and is never
// scheduled — the silent dead-automation defect. So `automation.update` does
// NOT accept `status` at all (the parameter is deliberately absent, not
// forwarded-and-dropped), and the lifecycle lives on its own verbs.

/**
 * playbook.update — patch a playbook through the governed
 * `playbooksRouter.update` caller.
 *
 * `subjectProfile` is passed THROUGH, never pre-checked: `playbooks.update`
 * calls `assertSubjectProfileResolves`, which refuses a slug that does not
 * resolve. A second check here would be a fork of that rule.
 */
const playbookUpdateParams = z
  .object({
    playbookId: z.string().uuid(),
    name: z.string().min(1).max(500).optional(),
    description: z.string().max(5000).optional(),
    goalTemplate: z.string().min(1).max(5000).optional(),
    /** `{ profileSlug }` — validated against the live profiles by the door. */
    subjectProfile: z.record(z.string(), z.unknown()).optional(),
    /** REPLACES the stage list. Shape validated by `playbookStagesSchema`. */
    stages: z.array(z.record(z.string(), z.unknown())).optional(),
    /** REPLACES the criteria list. Shape validated by `sessionCriteriaSchema`. */
    criteria: z.array(z.record(z.string(), z.unknown())).optional(),
    status: z.enum(["draft", "active", "paused", "archived"]).optional(),
    executor: z.enum(["is-agent", "external-agent", "hybrid"]).optional(),
    /** Shown to the reviewer when the write lands as a proposal. */
    reasoning: z.string().max(2000).optional(),
    // STRICT, like `tool.request`: an unknown key is REFUSED, never accepted and
    // silently dropped. A dropped param on a write door reads to the caller as
    // "applied".
  })
  .strict();

const playbookUpdateHandler: BuiltinVerbHandler = async (params, ctx) => {
  const input = playbookUpdateParams.parse(params);

  // playbooks.update is a protectedProcedure that loads the row by id ALONE and
  // then gates on the LOADED row's workspace (`assertWorkspaceWrite`). There is
  // therefore no workspace lens to pre-check here — pre-checking `ctx.workspaceId`
  // would refuse a pod-wide run without making the real gate any stricter.
  const { playbooksRouter } = await import("../../routers/playbooks.js");
  const caller = playbooksRouter.createCaller({
    db,
    authenticated: true as const,
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  } as unknown as Context);

  const result = await caller.update({
    id: input.playbookId,
    ...(ctx.agentUserId ? { agentUserId: ctx.agentUserId } : {}),
    ...(input.reasoning !== undefined ? { reasoning: input.reasoning } : {}),
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined
      ? { description: input.description }
      : {}),
    ...(input.goalTemplate !== undefined
      ? { goalTemplate: input.goalTemplate }
      : {}),
    ...(input.subjectProfile !== undefined
      ? { subjectProfile: input.subjectProfile }
      : {}),
    ...(input.stages !== undefined
      ? {
          stages: input.stages as unknown as Parameters<
            ReturnType<typeof playbooksRouter.createCaller>["update"]
          >[0]["stages"],
        }
      : {}),
    ...(input.criteria !== undefined
      ? {
          criteria: input.criteria as unknown as Parameters<
            ReturnType<typeof playbooksRouter.createCaller>["update"]
          >[0]["criteria"],
        }
      : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.executor !== undefined ? { executor: input.executor } : {}),
  });

  return result;
};

/**
 * automation.update — patch an automation's DEFINITION through the governed
 * `automationsRouter.update` caller. Lifecycle is NOT here: see the section
 * note above and `automation.activate` / `automation.pause`.
 */
const automationUpdateParams = z
  .object({
    automationId: z.string().uuid(),
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(5000).optional(),
    triggerType: z.enum(["event", "cron", "webhook", "manual"]).optional(),
    /** REPLACES the trigger settings. Event patterns + filters re-validated by the door. */
    triggerConfig: z.record(z.string(), z.unknown()).optional(),
    /** REPLACES the flow. Capability steps re-validated against what the owner can see. */
    flowDefinition: z
      .object({
        nodes: z.array(z.record(z.string(), z.unknown())),
        edges: z.array(z.record(z.string(), z.unknown())),
      })
      .optional(),
    /** MERGED into the stored metadata bag by the door (never a wholesale replace). */
    metadata: z.record(z.string(), z.unknown()).optional(),
    // STRICT, and `status` is the reason. `automations.update` writes `status`
    // and computes nothing else, so activating a cron automation through it
    // yields a row that reads "active" and is never scheduled. Accepting-and-
    // dropping `status` here would tell the caller it activated something.
    // Refusing sends them to `automation.activate`, which computes `nextRunAt`.
  })
  .strict();

const automationUpdateHandler: BuiltinVerbHandler = async (params, ctx) => {
  const input = automationUpdateParams.parse(params);

  // automations.update loads by id alone and gates on the LOADED row's
  // workspace (`assertWorkspaceWrite`) — same reasoning as playbook.update.
  const { automationsRouter } = await import("../../routers/automations.js");
  const caller = automationsRouter.createCaller({
    db,
    authenticated: true as const,
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  } as unknown as Context);

  const result = await caller.update({
    id: input.automationId,
    // A LENS only: the door never gates on this value.
    workspaceId: ctx.workspaceId,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined
      ? { description: input.description }
      : {}),
    ...(input.triggerType !== undefined
      ? { triggerType: input.triggerType }
      : {}),
    ...(input.triggerConfig !== undefined
      ? { triggerConfig: input.triggerConfig }
      : {}),
    ...(input.flowDefinition !== undefined
      ? { flowDefinition: input.flowDefinition }
      : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  });

  return result;
};

/**
 * automation.activate — switch a draft/paused automation ON through the
 * governed `automationsRouter.activate` caller, which computes `nextRunAt` for
 * a cron trigger, clears `errorMessage`, and routes an AGENT activation through
 * `checkPermissionOrPropose` (rung 2.09 `automation/activate`, floored) so it
 * comes back `{ status: "proposed" }`. `{ status: "already_active" }` is also a
 * normal, non-error outcome.
 */
const automationActivateParams = z
  .object({
    automationId: z.string().uuid(),
  })
  .strict();

const automationActivateHandler: BuiltinVerbHandler = async (params, ctx) => {
  const input = automationActivateParams.parse(params);

  const { automationsRouter } = await import("../../routers/automations.js");
  const caller = automationsRouter.createCaller({
    db,
    authenticated: true as const,
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  } as unknown as Context);

  return caller.activate({
    id: input.automationId,
    workspaceId: ctx.workspaceId,
  });
};

/**
 * automation.pause — switch an active automation OFF through the governed
 * `automationsRouter.pause` caller. De-escalation: the door gates on the loaded
 * row's workspace (`assertWorkspaceWrite`) and deliberately does NOT propose —
 * stopping a runaway automation must not itself wait for review.
 */
const automationPauseParams = z
  .object({
    automationId: z.string().uuid(),
  })
  .strict();

const automationPauseHandler: BuiltinVerbHandler = async (params, ctx) => {
  const input = automationPauseParams.parse(params);

  const { automationsRouter } = await import("../../routers/automations.js");
  const caller = automationsRouter.createCaller({
    db,
    authenticated: true as const,
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  } as unknown as Context);

  return caller.pause({
    id: input.automationId,
    workspaceId: ctx.workspaceId,
  });
};

// ── Lifecycle REVISION half (Wave B) — view / cell / playbook / rule / kind ──
//
// Wave A closed config REVISION for playbook + automation. This wave closes the
// remaining lifecycle doors an agent could CREATE through but never REVISE or
// RETIRE. Same contract as Wave A: delegate to the EXISTING governed tRPC
// procedure, re-implement nothing, and surface a `{ status: "proposed" }`
// return VERBATIM as the success it is.
//
// WHAT WAS DELIBERATELY **NOT** PROJECTED, and why — a reasoned exclusion is
// worth more than a verb nobody should call. Every one of these was measured
// against the door's actual source, not its name:
//
//   view.delete / document.delete / property_def.delete / workspace.archive
//     — DESTRUCTIVE by `DESTRUCTIVE_ACTIONS` (rung 2.5), but their doors carry
//       NO `checkPermissionOrPropose` at all (`views.ts` gates only `create`;
//       `documents.ts` and `property-defs.ts` have zero gate calls;
//       `workspaces.archive` is owner/pod-admin RBAC only). The rung-2.5 floor
//       is invisible at the OUTER capability/run gate (see the tripwire
//       `synap-core-risky-verbs-reenter-a-governed-door.test.ts`), so a verb
//       over an ungated destructive door is an UNGOVERNED delete, not a
//       floored one. `view.delete` additionally drops the board's document +
//       every MinIO version blob via `deleteDocumentAndBlobs`. Gate the doors
//       first; then project them.
//
//   workspace.update / skill.delete / project.delete
//     — THE ATTRIBUTION TRAP, and the sharpest finding of this wave. All three
//       DO call `checkPermissionOrPropose`, so they read as governed. But none
//       of them accepts an `agentUserId` (or a `source`) on its input, and
//       `permission-check.ts` treats `agentUserId` as "the canonical signal
//       that this is an AI action". With it absent the gate takes the HUMAN
//       path and EXECUTES — so the rung-2 ADMIN floor that makes
//       `workspaces.update` look safe (it is in `ADMIN_ACTIONS_LIVE`) would
//       never fire for an agent. Wrapping them would ship an ungoverned admin
//       write behind a gate call that proves nothing. Thread `agentUserId`
//       through those three procedures first (the shape `playbooks.update` and
//       `playbooks.archive` already use), then they can be projected.
//
//   property_def.upsert — asked for as one verb; it cannot honestly be one.
//     `propertyDefs.create` gates at schema level "additive" and, on a slug
//     conflict, RETURNS THE EXISTING DEF (`{ existing: true }`) WITHOUT
//     applying the submitted valueType/constraints; `propertyDefs.update`
//     gates at level "editor" with `actingWorkspaceId: null` (a base def on a
//     system kind ⇒ pod admin) because a valueType change re-types every
//     entity of every profile that links the def. One "upsert" over those two
//     would report success for a change that silently did not happen AND blur
//     two different authority floors. Two verbs would be the right shape — but
//     neither door gates at all today, so both are excluded with the group
//     above.
//
//   cells.uninstall — no gate, no proposal; `requireAdminRole` only, which an
//     agent acting as the pod owner passes. Its action ("uninstall") is not in
//     `DESTRUCTIVE_ACTIONS`, so nothing would even flag it — an agent could
//     silently deactivate a workspace's installed cell type. Judgement, not
//     derivation: excluded.
//
//   skills.setApproved — excluded on principle, not plumbing. It IS the
//     approval act. An agent that can approve a skill can approve the prose it
//     just wrote, which turns any successful prompt injection into a durable,
//     self-certified capability. This one should stay unreachable even if the
//     door were gated.
//
//   profiles.delete — the hard-delete twin of `profile.propose_retire` below.
//     Retirement is the door with a review step by construction; deletion is
//     not, so only the former is projected.

/**
 * view.update — patch a view's DEFINITION through `viewsRouter.update`.
 *
 * WHY `update` AND NOT `save` — measured, the same class of trap as Wave A's
 * `automation.activate`/`nextRunAt`. They are not two spellings of one door:
 *   • `views.save` writes the view's CONTENT. For a whiteboard it uploads the
 *     tldraw snapshot to MinIO, then always mints a `document_versions` row and
 *     bumps `documents.currentVersion` / `lastSavedVersion`. Its `metadata`
 *     REPLACES the stored bag wholesale, and it runs NEITHER
 *     `validateViewConfig` NOR `assertValidRendererRef` NOR the workspace-Home
 *     admin floor.
 *   • `views.update` writes the view ROW. It validates `config` against the
 *     view type, refuses an invalid renderer ref, enforces that only a
 *     workspace admin/owner may edit the workspace Home, and MERGES `metadata`.
 * Routing a config patch through `save` would therefore skip every validation
 * and silently replace the metadata bag; routing content through `update` is
 * impossible (there is no content field). So this verb wraps `update`, and the
 * schema is `.strict()` so a caller reaching for `content` is REFUSED rather
 * than told a snapshot was saved that never was. Board CONTENT is deliberately
 * not reachable from a capability verb at all.
 */
const viewUpdateParams = z
  .object({
    viewId: z.string().uuid(),
    name: z.string().min(1).max(100).optional(),
    description: z.string().optional(),
    /** REPLACES the scope list. */
    scopeProfileIds: z.array(z.string().uuid()).optional(),
    scopeMode: z.enum(["explicit", "observed"]).optional(),
    /** REPLACES the stored query. */
    query: z.record(z.string(), z.unknown()).optional(),
    /** REPLACES render config; validated against the view type by the door. */
    config: z.record(z.string(), z.unknown()).optional(),
    /** REPLACES the embedded-view list (composite views). */
    embeddedViewIds: z.array(z.string().uuid()).optional(),
    /** MERGED onto the existing view metadata by the door. */
    metadata: z.record(z.string(), z.unknown()).optional(),
    /** Switch the view type; `config` is then validated against the NEW type. */
    type: z.string().min(1).optional(),
  })
  .strict();

const viewUpdateHandler: BuiltinVerbHandler = async (params, ctx) => {
  const input = viewUpdateParams.parse(params);

  // views.update is a protectedProcedure that loads the row by id alone and
  // gates on the LOADED row (`assertViewAccess(view, userId, "write")`), plus a
  // workspace-admin floor for the workspace Home. No lens to pre-check here.
  const { viewsRouter } = await import("../../routers/views.js");
  const caller = viewsRouter.createCaller({
    db,
    authenticated: true as const,
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    agentUserId: ctx.agentUserId,
  } as unknown as Context);

  return caller.update({
    id: input.viewId,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.description !== undefined
      ? { description: input.description }
      : {}),
    ...(input.scopeProfileIds !== undefined
      ? { scopeProfileIds: input.scopeProfileIds }
      : {}),
    ...(input.scopeMode !== undefined ? { scopeMode: input.scopeMode } : {}),
    ...(input.query !== undefined ? { query: input.query } : {}),
    ...(input.config !== undefined ? { config: input.config } : {}),
    ...(input.embeddedViewIds !== undefined
      ? { embeddedViewIds: input.embeddedViewIds }
      : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    ...(input.type !== undefined ? { type: input.type } : {}),
  } as unknown as Parameters<
    ReturnType<typeof viewsRouter.createCaller>["update"]
  >[0]);
};

/**
 * cell.update — patch a cell instance's config through
 * `cellInstancesRouter.updateConfig`.
 *
 * OWNER-SCOPED BY THE DOOR, which is what makes this safe without a gate: the
 * UPDATE's WHERE is `id = ? AND userId = ?`, so the acting identity can never
 * reach another member's placement — a miss surfaces as NOT_FOUND, not as a
 * cross-user write. Policy already agrees this need not be floored:
 * `AGENT_STRUCTURE_DOOR_CLASS` classifies `cell/update` as "widenable" ("config
 * patch of an existing placement"), in contrast to `cell/create` and
 * `cell/define`, which are "floored".
 *
 * `config` REPLACES the stored config wholesale — `updateConfig` does no merge.
 * Callers must read the instance first and send the full object.
 */
const cellUpdateParams = z
  .object({
    cellInstanceId: z.string().uuid(),
    /** REPLACES the stored config in full. Not a patch. */
    config: z.record(z.string(), z.unknown()),
  })
  .strict();

const cellUpdateHandler: BuiltinVerbHandler = async (params, ctx) => {
  const input = cellUpdateParams.parse(params);

  const { cellInstancesRouter } =
    await import("../../routers/cell-instances.js");
  const caller = cellInstancesRouter.createCaller({
    db,
    authenticated: true as const,
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    agentUserId: ctx.agentUserId,
  } as unknown as Context);

  return caller.updateConfig({
    id: input.cellInstanceId,
    config: input.config,
  });
};

/**
 * playbook.archive — retire a playbook through the governed
 * `playbooksRouter.archive` caller.
 *
 * FULLY GATED, and it is the destructive twin of Wave A's `playbook.update`:
 * the door runs `assertWorkspaceWrite` on the LOADED row and then
 * `checkPermissionOrPropose({ subjectType: "playbook", action: "archive" })`
 * with the `agentUserId` threaded from here — so rung 2.5
 * (`DESTRUCTIVE_ACTIONS` contains "archive") floors an agent to
 * `{ status: "proposed" }` and NO governance rule can widen it.
 *
 * This is the reason `status: "archived"` on `playbook.update` is not the same
 * act: that path reaches the gate as `playbook/update`, which rung 2.5 does not
 * match, so archiving through it would slip the destructive floor. The dedicated
 * verb is the one that gets floored.
 */
const playbookArchiveParams = z
  .object({
    playbookId: z.string().uuid(),
    /** Shown to the reviewer when the write lands as a proposal. */
    reasoning: z.string().max(2000).optional(),
  })
  .strict();

const playbookArchiveHandler: BuiltinVerbHandler = async (params, ctx) => {
  const input = playbookArchiveParams.parse(params);

  const { playbooksRouter } = await import("../../routers/playbooks.js");
  const caller = playbooksRouter.createCaller({
    db,
    authenticated: true as const,
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
  } as unknown as Context);

  return caller.archive({
    id: input.playbookId,
    ...(ctx.agentUserId ? { agentUserId: ctx.agentUserId } : {}),
    ...(input.reasoning !== undefined ? { reasoning: input.reasoning } : {}),
  });
};

/**
 * skill.update_rule — revise a standing RULE through `skillsRouter.updateRule`.
 *
 * GATED, but INDIRECTLY: `skillsRouter.updateRule` carries no inline
 * `checkPermissionOrPropose`. It delegates to `updateRuleGoverned`
 * (`services/rules/update.ts`), which gates at
 * `{ subjectType: "rule", action: "update" }` and threads `agentUserId`, and
 * whose own return type includes `{ status: "proposed"; proposalId }`. The
 * tripwire's AST hop cannot see through the dynamic import, so this verb is
 * classified `gatedVia` there — proven by parsing the delegate, never assumed.
 *
 * `agentUserId` REACHES THE DOOR THROUGH THE CONTEXT, not the input: the
 * procedure reads `ctx.agentUserId`. Omitting it from the synthesized caller
 * context would make an agent's rule edit look like the owner's own and
 * auto-execute — the same attribution trap that disqualified
 * `workspaces.update` above, avoided here only because this door reads the
 * context.
 *
 * THREE-STATE FIELDS ARE PRESERVED DELIBERATELY. `expiresAt` and `sentence`
 * each distinguish ABSENT (leave alone) from `null` (clear / remove) from a
 * value (set / replace). `z.nullish()` plus a `!== undefined` spread keeps all
 * three spellable; a truthiness check would collapse "make this rule
 * prose-only" into "leave the automation alone".
 */
const skillUpdateRuleParams = z
  .object({
    ruleId: z.string().uuid(),
    intent: z.string().min(1),
    scope: z.object({
      kind: z.enum(["pod", "workspace", "user"]),
      workspaceId: z.string().uuid().optional(),
      projectId: z.string().uuid().optional(),
    }),
    /** ISO instant SETS, `null` CLEARS, ABSENT leaves the review date alone. */
    expiresAt: z.string().datetime({ offset: true }).nullish(),
    factSkillId: z.string().uuid().optional(),
    /** REPLACES the bound automation list. */
    automationIds: z.array(z.string().uuid()).optional(),
    /** A sentence REPLACES the behaviour, `null` REMOVES it, ABSENT keeps it. */
    sentence: z.record(z.string(), z.unknown()).nullish(),
    /** `true` keeps/returns the rule to draft; `false`/absent ACTIVATES it. */
    draft: z.boolean().optional(),
  })
  .strict();

const skillUpdateRuleHandler: BuiltinVerbHandler = async (params, ctx) => {
  const input = skillUpdateRuleParams.parse(params);

  const { skillsRouter } = await import("../../routers/skills.js");
  const caller = skillsRouter.createCaller({
    db,
    authenticated: true as const,
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    // LOAD-BEARING: this door reads `ctx.agentUserId`, not an input field.
    agentUserId: ctx.agentUserId,
  } as unknown as Context);

  return caller.updateRule({
    id: input.ruleId,
    intent: input.intent,
    scope: input.scope,
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    ...(input.factSkillId !== undefined
      ? { factSkillId: input.factSkillId }
      : {}),
    automationIds: input.automationIds ?? [],
    ...(input.sentence !== undefined ? { sentence: input.sentence } : {}),
    draft: input.draft ?? false,
  } as unknown as Parameters<
    ReturnType<typeof skillsRouter.createCaller>["updateRule"]
  >[0]);
};

/**
 * profile.propose_retire — retire a kind/role through
 * `profilesRouter.proposeRetire`.
 *
 * THE ONE RETIREMENT DOOR AN AGENT MAY REACH, and the reason is structural, not
 * a policy preference: `proposeProfileRetire` files a PENDING proposal
 * unconditionally. The procedure has NO execute branch at all, so there is
 * nothing for `checkPermissionOrPropose` to decide and nothing an attribution
 * miss could turn into a direct write. Its only floor is
 * `assertProfileSchemaWrite(level: "editor")` on the LOADED row, i.e. who may
 * FILE the request. Contrast `profilesRouter.delete` (hard delete, no review
 * step), which is deliberately not projected.
 *
 * `workspaceProcedure`: an acting workspace lens is required, and the door
 * re-validates membership in that workspace itself.
 */
const profileProposeRetireParams = z
  .object({
    profileId: z.string().uuid(),
    /** Shown to the reviewer on the retirement proposal. */
    reason: z.string().max(2000).optional(),
  })
  .strict();

const profileProposeRetireHandler: BuiltinVerbHandler = async (params, ctx) => {
  const input = profileProposeRetireParams.parse(params);

  if (!ctx.workspaceId) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message:
        "profile.propose_retire requires an acting workspace — " +
        "profiles.proposeRetire is a workspaceProcedure and resolves the " +
        "profile through the caller's lens.",
    });
  }

  const { profilesRouter } = await import("../../routers/profiles.js");
  const caller = profilesRouter.createCaller({
    db,
    authenticated: true as const,
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    agentUserId: ctx.agentUserId,
  } as unknown as Context);

  return caller.proposeRetire({
    id: input.profileId,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
  });
};

/**
 * verbName (= skill.name = verbId) → in-process handler. Populated by W5 (the
 * write/emit pilots) + W6 (the read/resolve half) + Spine-2 (entity/document
 * write + read).
 * Keep names namespaced (`channel.create`, `feed.post`) to mirror the
 * `connector.action` convention used for external verbs.
 */
export const BUILTIN_VERBS: Record<string, BuiltinVerbHandler> = {
  "channel.create": channelCreateHandler,
  "feed.post": feedPostHandler,
  "output.generate": outputGenerateHandler,
  "ai.triage": aiTriageHandler,
  "ai.generate": aiGenerateHandler,
  // Proactive keystone — interpret a message's content into a governed proposal.
  "message.interpret": messageInterpretHandler,
  // W6 — read/resolve half.
  "entity.query": entityQueryHandler,
  "channel.resolve": channelResolveHandler,
  "channel.ensure": channelEnsureHandler,
  "channel.bind": channelBindHandler,
  "graph.relations": graphRelationsHandler,
  "graph.link": graphLinkHandler,
  "feed.read": feedReadHandler,
  // Spine-2 — entity/document write + read.
  "entity.create": entityCreateHandler,
  "entity.update": entityUpdateHandler,
  "entity.delete": entityDeleteHandler,
  "document.create": documentCreateHandler,
  "document.update": documentUpdateHandler,
  "document.read": documentReadHandler,
  // D2 — turn a report's live chart embeds into snapshots (the report flow's
  // step between the assembler and create-report).
  "document.freeze_charts": documentFreezeChartsHandler,
  "document.stamp_diagnostics": documentStampDiagnosticsHandler,
  // Kind + Facets — role attach/update/detach/list over the one facet door.
  "entity_facet.attach": entityFacetAttachHandler,
  "entity_facet.update": entityFacetUpdateHandler,
  "entity_facet.detach": entityFacetDetachHandler,
  "entity_facet.list": entityFacetListHandler,
  // Marketplace (Wave 3b) — search/install over cp_catalog_cache.
  "market.search": marketSearchHandler,
  "market.install": marketInstallHandler,
  // Marketplace AUTHORING — generate a package skeleton and persist it on the
  // pod as a draft document (the CLI writes it to disk; an agent door cannot).
  "market.scaffold": marketScaffoldHandler,
  // Tool demand — a tool the user needs that Synap cannot connect yet.
  "tool.request": toolRequestHandler,
  // Connection health — probe a connector + nudge the operator if it's dead, so
  // a config feed doesn't go silently dead on an expired token.
  "connector.health_check": connectorHealthCheckHandler,
  // Inbound sink — record a generic inbound message onto its external channel
  // via the shared recordInboundMessage (the one composition seam so provider
  // ingest can be driven from outside the pod as config/automation).
  "channel.ingest": channelIngestHandler,
  // Outbound send — emit a governed EXTERNAL message on ANY provider through the
  // ONE governed send door (sendExternalMessage). Agent sends propose; owner
  // sends go direct. Provider-agnostic (routes by the channel's externalSource).
  "messaging.send": messagingSendHandler,
  // Governance TIGHTEN recommender — mirror of the widen scanner. Scans rejected
  // agent proposals and files governance.tighten_lane review items. No params.
  "governance.recommend_tighten": governanceRecommendTightenHandler,
  // Governance RAISE-CEILING recommender — numeric-limit twin. Files
  // governance.raise_ceiling review items when an agent keeps hitting its cap.
  "governance.recommend_raise_ceiling": governanceRecommendRaiseCeilingHandler,
  // Governance RAISE-PROPOSAL-CAP recommender — pending_proposal_cap twin. Files
  // settings.update cap-raise items when an agent is blocked at its pending cap.
  "governance.recommend_raise_proposal_cap":
    governanceRecommendRaiseProposalCapHandler,
  // Governance TIGHTEN-POSTURE recommender — channel-scoped twin. Files
  // governance.tighten_posture review items for consistently-rejected channels.
  "governance.recommend_tighten_posture":
    governanceRecommendTightenPostureHandler,
  // Automation-health warden — the zero-run finding.
  "automation.recommend_health": automationRecommendHealthHandler,
  // Config REVISION (see the section above): the substrate could build a
  // playbook/automation but never revise one, and an agent-authored automation
  // always lands `draft` with no door to switch it on.
  "playbook.update": playbookUpdateHandler,
  "automation.update": automationUpdateHandler,
  "automation.activate": automationActivateHandler,
  "automation.pause": automationPauseHandler,
  // Lifecycle REVISION (Wave B): the remaining doors an agent could CREATE
  // through but never REVISE or RETIRE. See the section note above for the
  // FOUR groups deliberately left out (ungated destructive doors, the
  // agentUserId attribution trap, property_def, and skills.setApproved).
  "view.update": viewUpdateHandler,
  "cell.update": cellUpdateHandler,
  "playbook.archive": playbookArchiveHandler,
  "skill.update_rule": skillUpdateRuleHandler,
  "profile.propose_retire": profileProposeRetireHandler,
};

/**
 * Verb name → its Zod param schema (the SINGLE source of truth for what params a
 * handler accepts). Paired with BUILTIN_VERBS above. A CI coherence test
 * (`catalog-schema-coherence.tripwire.test.ts`) asserts every key here is
 * advertised in the seeded catalog (`ensure-synap-core.ts`), so the handler's
 * real contract and the discoverable catalog can never silently drift again
 * (the class of bug that left `channel.resolve.branchPurpose` +
 * `channel.create.metadata` + `feed.post.metadata` + `output.generate.options`
 * undiscoverable). feed.read parses its params inline and is intentionally
 * absent — the test skips verbs with no schema here.
 */
export const BUILTIN_VERB_PARAM_SCHEMAS: Record<
  string,
  { readonly shape: Record<string, unknown> }
> = {
  "channel.create": channelCreateParams,
  "feed.post": feedPostParams,
  "output.generate": outputGenerateParams,
  "ai.triage": aiTriageParams,
  "ai.generate": aiGenerateParams,
  "message.interpret": messageInterpretParams,
  "entity.query": entityQueryParams,
  "channel.resolve": channelResolveParams,
  "channel.ensure": channelEnsureParams,
  "channel.bind": channelBindParams,
  "graph.relations": graphRelationsParams,
  "graph.link": graphLinkParams,
  "entity.create": entityCreateParams,
  "entity.update": entityUpdateParams,
  "entity.delete": entityDeleteParams,
  "document.create": documentCreateParams,
  "document.update": documentUpdateParams,
  "document.read": documentReadParams,
  "document.freeze_charts": documentFreezeChartsParams,
  "document.stamp_diagnostics": documentStampDiagnosticsParams,
  "entity_facet.attach": entityFacetAttachParams,
  "entity_facet.update": entityFacetUpdateParams,
  "entity_facet.detach": entityFacetDetachParams,
  "entity_facet.list": entityFacetListParams,
  "market.search": marketSearchParams,
  "market.install": marketInstallParams,
  "market.scaffold": marketScaffoldParams,
  "tool.request": toolRequestParams,
  "connector.health_check": connectorHealthCheckParams,
  "channel.ingest": channelIngestParams,
  "messaging.send": messagingSendParams,
  "governance.recommend_tighten": governanceRecommendTightenParams,
  "governance.recommend_raise_ceiling": governanceRecommendRaiseCeilingParams,
  "governance.recommend_raise_proposal_cap":
    governanceRecommendRaiseProposalCapParams,
  "governance.recommend_tighten_posture":
    governanceRecommendTightenPostureParams,
  "automation.recommend_health": automationRecommendHealthParams,
  "playbook.update": playbookUpdateParams,
  "automation.update": automationUpdateParams,
  "automation.activate": automationActivateParams,
  "automation.pause": automationPauseParams,
  "view.update": viewUpdateParams,
  "cell.update": cellUpdateParams,
  "playbook.archive": playbookArchiveParams,
  "skill.update_rule": skillUpdateRuleParams,
  "profile.propose_retire": profileProposeRetireParams,
};

/**
 * The READ-ONLY builtin verbs — those whose execution only READS (no mutation).
 * executeCapability consults this set to mark the capability gate `readOnly`, so
 * a read auto-runs (no grant, no propose) once it clears the approval gate; its
 * scope is enforced by the access layer inside each handler, NOT by the gate.
 * WRITE verbs (channel.ensure, channel.bind, graph.link, channel.create,
 * feed.post, output.generate, entity.create, entity.update, document.create,
 * document.update) are intentionally ABSENT — they flow through the full gate.
 */
export const READ_ONLY_BUILTIN_VERBS: ReadonlySet<string> = new Set([
  "entity.query",
  "channel.resolve",
  "graph.relations",
  "feed.read",
  // ai.generate is PURE COMPUTE — it mutates nothing (calls the IS for a
  // completion). readOnly here means "no mutation → auto-run" so a classification
  // step inside an automation runs without spawning a proposal (which would stall
  // the flow, since a capability node refuses on a propose verdict). Scope is N/A:
  // it reads no DB rows, so there is no access-layer floor to enforce.
  "ai.generate",
  // message.interpret — files a human-governed PENDING proposal (never a direct
  // graph write: no agentUserId is threaded, so submitCaptureGraph always
  // proposes). Same "produces review items, not a data write → auto-run"
  // rationale as governance.recommend_tighten; the outer gate must auto-run it so
  // an automation node interpreting an inbound message isn't stalled by a propose
  // verdict. Governance lives on the proposal it emits, not on running interpret.
  "message.interpret",
  // document.read — pure access-layer read (see handler doc above).
  "document.read",
  // document.freeze_charts — reads through entities.list under the caller's
  // floor and RETURNS markdown; it writes nothing (create-report does). Must
  // auto-run inside the report flow (a propose verdict would stall it).
  "document.freeze_charts",
  // document.stamp_diagnostics — writes ONLY the advisory, revision-stamped
  // diagnostics on a document the caller OWNS (handler-enforced), never content
  // or graph data; same "annotation, not a data write → auto-run" rationale as
  // the review-item filers below, so the report flow is not stalled by it.
  "document.stamp_diagnostics",
  // entity_facet.list — floor-scoped facet read (see handler doc above).
  "entity_facet.list",
  // market.search — cache-only read (see handler doc above). market.install is
  // intentionally ABSENT: it always mutates (a proposal at minimum), so it
  // flows through the full gate like every other WRITE builtin.
  "market.search",
  // connector.health_check — auto-run so a CRON feed can call it unattended (a
  // propose verdict would stall the flow). It mutates NO graph data: it only
  // probes a connector and, when dead, emits a deduped operator-facing reconnect
  // NOTICE (in-app + Discord nudge) via the shared best-effort helper. Same
  // "no mutation → auto-run" rationale as ai.generate.
  "connector.health_check",
  // governance.recommend_tighten — auto-run so the daily calibration cron can
  // call it unattended (a propose verdict would stall the flow). It mutates NO
  // graph data: its only side effect is filing PENDING governance.tighten_lane
  // review items (themselves human-governed) via insertPendingProposal. Same
  // "produces review items / notices, not a data write → auto-run" rationale as
  // connector.health_check.
  "governance.recommend_tighten",
  // governance.recommend_raise_ceiling + governance.recommend_tighten_posture —
  // the two calibration twins. Same "files review items only → auto-run inside
  // the daily calibration cron" rationale as governance.recommend_tighten.
  "governance.recommend_raise_ceiling",
  "governance.recommend_raise_proposal_cap",
  "governance.recommend_tighten_posture",
  // automation.recommend_health — the automation-health warden. Same rationale
  // again: it mutates NO graph data (it files PENDING automation.health_advisory
  // review items, and their approval is acknowledgement-only), so the daily
  // calibration cron must be able to auto-run it. A propose verdict on the verb
  // ITSELF would stall the flow that exists to surface dead automations.
  "automation.recommend_health",
]);
