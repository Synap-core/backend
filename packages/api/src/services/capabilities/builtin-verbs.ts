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
  capabilities,
  tools,
  getWorkspaceMembership,
  insertChannelMessage,
  getEffectiveFacets,
  profileSlugScopeConditionFromRows,
  MessageRole,
  MessageAuthorType,
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
import { resolveFacetVisibilityScope } from "../../utils/workspace-membership.js";
import { assertKnownProfileSlug } from "../../utils/assert-known-profile-slug.js";
import {
  placeArtboardDeck,
  ArtboardDeckSlideSchema,
  BoardPlacementOptionsSchema,
} from "./place-artboard-deck.js";
import { triageEmails } from "../mail-feed/triage.js";
import { generateViaIS } from "../mail-feed/generate.js";
// catalog-cache-query.ts imports FROM this module (BUILTIN_VERB_PARAM_SCHEMAS,
// via capability-registry.ts's scoreTextMatch dependency) and marketplace-
// install.ts pulls in the full router graph (create-from-definition.ts imports
// playbooksRouter/automationsRouter/toolsRouter/skillsRouter at top level) —
// BOTH are lazy-imported inside the two handlers below, exactly like every
// other router import in this file, so this module's own load graph stays
// light AND the catalog-cache-query circular reference never resolves eagerly.

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

/** entity.query — READ entities of a profile, scoped by the caller's floor. */
const entityQueryParams = z.object({
  /** Entity profile slug (e.g. "task", "deal") — the `type` discriminator. */
  profileSlug: z.string().min(1).max(200),
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

  // Polymorphic (Kind + Facets): a role slug (client/partner/…) matches via
  // the facet EXISTS, a kind slug via entities.type — same one-door routing
  // as entities.list, so agents querying by role get rows post-conversion.
  //
  // Fail closed first: an agent that invents a slug ("crm-lead" where the pod
  // says "lead") must get a typed "unknown profile" it can act on, not an
  // empty result set it will report as "you have none".
  const slugRows = await assertKnownProfileSlug(db, input.profileSlug);
  const conditions: SQL[] = [
    profileSlugScopeConditionFromRows(
      db,
      input.profileSlug,
      slugRows,
      facetVisibilityScope
    ),
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
  const result = await caller.delete({ id: input.entityId });
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
    .enum(["capability", "automation", "template", "cell", "skill", "view"])
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
        "Nothing matched the marketplace either. Tell the user exactly what's missing — never fabricate a result. You can offer to capture the gap as a note/observation for later.",
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
});

const marketInstallHandler: BuiltinVerbHandler = async (params, ctx) => {
  const input = marketInstallParams.parse(params);
  const { runMarketInstall } = await import("./marketplace-install.js");
  return runMarketInstall({
    slug: input.slug,
    kind: input.kind,
    version: input.version,
    params: input.params,
    userId: ctx.userId,
    workspaceId: ctx.workspaceId,
    agentUserId: ctx.agentUserId ?? null,
  });
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
  //    live on the pod's discord tool (same row run-mail-feed uses).
  const discordTool = await db.query.tools.findFirst({
    where: eq(tools.name, "discord"),
    columns: { id: true, createdBy: true, workspaceId: true, metadata: true },
  });
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
  "entity.delete": entityDeleteHandler,
  "document.create": documentCreateHandler,
  "document.update": documentUpdateHandler,
  "document.read": documentReadHandler,
  // Kind + Facets — role attach/update/detach/list over the one facet door.
  "entity_facet.attach": entityFacetAttachHandler,
  "entity_facet.update": entityFacetUpdateHandler,
  "entity_facet.detach": entityFacetDetachHandler,
  "entity_facet.list": entityFacetListHandler,
  // Marketplace (Wave 3b) — search/install over cp_catalog_cache.
  "market.search": marketSearchHandler,
  "market.install": marketInstallHandler,
  // Connection health — probe a connector + nudge the operator if it's dead, so
  // a config feed doesn't go silently dead on an expired token.
  "connector.health_check": connectorHealthCheckHandler,
  // Inbound sink — record a generic inbound message onto its external channel
  // via the shared recordInboundMessage (the one composition seam so provider
  // ingest can be driven from outside the pod as config/automation).
  "channel.ingest": channelIngestHandler,
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
  "entity.delete": entityDeleteParams,
  "document.create": documentCreateParams,
  "document.update": documentUpdateParams,
  "document.read": documentReadParams,
  "entity_facet.attach": entityFacetAttachParams,
  "entity_facet.update": entityFacetUpdateParams,
  "entity_facet.detach": entityFacetDetachParams,
  "entity_facet.list": entityFacetListParams,
  "market.search": marketSearchParams,
  "market.install": marketInstallParams,
  "connector.health_check": connectorHealthCheckParams,
  "channel.ingest": channelIngestParams,
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
]);
