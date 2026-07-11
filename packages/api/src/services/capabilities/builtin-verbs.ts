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
  getWorkspaceMembership,
  insertChannelMessage,
  getEffectiveFacets,
  profileSlugScopeCondition,
} from "@synap/database";
import type { SQL } from "drizzle-orm";
import type { Context } from "../../context.js";
// Type-only imports (erased at runtime). The heavy access layer + the channel
// util are LAZY-imported inside the read/write handlers (mirroring how
// channelCreateHandler lazy-imports channelsRouter), so this module's load graph
// stays light — the visibility registry is never dragged into callers that only
// touch the pilot verbs.
import type { ScopedDb } from "../../access/scoped-db.js";
import type { ContextObjectType } from "../../utils/resolve-or-create-channel.js";
import {
  placeArtboardDeck,
  ArtboardDeckSlideSchema,
  BoardPlacementOptionsSchema,
} from "./place-artboard-deck.js";
import { triageEmails } from "../mail-feed/triage.js";
import { generateViaIS } from "../mail-feed/generate.js";

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
  maxTokens: z.coerce.number().int().min(1).max(2000).optional(),
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

/** entity.query — READ entities of a profile, scoped by the caller's floor. */
const entityQueryParams = z.object({
  /** Entity profile slug (e.g. "task", "deal") — the `type` discriminator. */
  profileSlug: z.string().min(1).max(200),
  /** Optional JSONB property equality filter: { key: value } pairs. */
  filter: z.record(z.string(), z.unknown()).optional(),
  /** Optional workspace lens; omit for the full user floor (pod-wide). */
  workspaceId: z.string().uuid().optional(),
  // coerce: the CLI + automation engine pass params as strings ("50").
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const entityQueryHandler: BuiltinVerbHandler = async (params, ctx) => {
  const input = entityQueryParams.parse(params);
  const limit = input.limit ?? 20;

  // The lens is the query's explicit workspaceId, else the acting lens.
  const scoped = await getReadScope(
    ctx.userId,
    input.workspaceId ?? ctx.workspaceId ?? undefined
  );

  // Polymorphic (Kind + Facets): a role slug (client/partner/…) matches via
  // the facet EXISTS, a kind slug via entities.type — same one-door routing
  // as entities.list, so agents querying by role get rows post-conversion.
  const conditions: SQL[] = [
    await profileSlugScopeCondition(db, input.profileSlug, {
      userId: ctx.userId,
      workspaceId: input.workspaceId ?? ctx.workspaceId ?? undefined,
    }),
  ];
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
        eq(channels.contextObjectId, input.contextObjectId)
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
  const result = await caller.create({
    profileSlug: input.profileSlug,
    title: input.title,
    description: input.description,
    properties: input.properties,
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
  const result = await caller.update({
    id: input.entityId,
    title: input.title,
    description: input.description,
    properties: input.properties,
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

/** entity_facet.detach — soft-delete a facet via the governed detachFacet door. */
const entityFacetDetachParams = z.object({
  /** The facet's own id (the handle entity_facet.attach returns). */
  facetId: z.string().uuid(),
});

const entityFacetDetachHandler: BuiltinVerbHandler = async (params, ctx) => {
  const input = entityFacetDetachParams.parse(params);

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
  const result = await caller.detachFacet({ facetId: input.facetId });

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
  "document.create": documentCreateHandler,
  "document.update": documentUpdateHandler,
  "document.read": documentReadHandler,
  // Kind + Facets — role attach/detach/list over the one facet door.
  "entity_facet.attach": entityFacetAttachHandler,
  "entity_facet.detach": entityFacetDetachHandler,
  "entity_facet.list": entityFacetListHandler,
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
  "entity.query": entityQueryParams,
  "channel.resolve": channelResolveParams,
  "channel.ensure": channelEnsureParams,
  "channel.bind": channelBindParams,
  "graph.relations": graphRelationsParams,
  "graph.link": graphLinkParams,
  "entity.create": entityCreateParams,
  "entity.update": entityUpdateParams,
  "document.create": documentCreateParams,
  "document.update": documentUpdateParams,
  "document.read": documentReadParams,
  "entity_facet.attach": entityFacetAttachParams,
  "entity_facet.detach": entityFacetDetachParams,
  "entity_facet.list": entityFacetListParams,
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
  // document.read — pure access-layer read (see handler doc above).
  "document.read",
  // entity_facet.list — floor-scoped facet read (see handler doc above).
  "entity_facet.list",
]);
