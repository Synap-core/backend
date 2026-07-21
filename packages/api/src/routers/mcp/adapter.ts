/**
 * MCP to Hub Protocol Adapter
 *
 * This adapter allows MCP to use the existing Hub Protocol API,
 * ensuring all operations go through the same event sourcing,
 * validation, security, and worker infrastructure.
 */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { hubProtocolRouter } from "../hub-protocol/index.js";
import { entitiesRouter as regularEntitiesRouter } from "../entities.js";
import { skillsRouter as regularSkillsRouter } from "../skills.js";
import { projectsRouter } from "../projects.js";
import { playbooksRouter } from "../playbooks.js";
import { createHubProtocolCallerContext } from "../hub-protocol/utils.js";
import { resolveConfinedWorkspace } from "../hub-protocol/confine-workspace.js";
import { validateCreateVerbInput } from "./validate-create-verb.js";
import {
  getObjectGraph,
  resolveByName,
  resolveProfileByName,
  type GraphNeighbor,
  type GraphEnvelope,
} from "../../services/object-graph/graph-service.js";
import { entityDataNeighbors } from "../../services/object-graph/entity-data-graph.js";
import type { LinkEndpointType } from "@synap/playbooks";
import { ask } from "../../services/knowledge/ask.js";
// Type-only: keeps `remember-fact.js` lazily imported at the call site while
// letting the `category` arg be narrowed to the seeded `uo_category` enum.
// (The enum's VALUES ride along on that same lazy import, so the model-supplied
// `category` is validated against the SSOT instead of being blindly cast.)
import type { UserObservationCategory } from "../../services/knowledge/remember-fact.js";
import { synthesizeAnswer } from "../../services/knowledge/synthesize.js";
import {
  type ProfileCatalogEntry,
  toProfileCatalogEntry,
} from "../../services/retrieval/index.js";
import { getDb } from "@synap/database";
import {
  db,
  knowledgeKeysRepository,
  entities,
  focusSessions,
  tools as toolsTable,
  eq,
  and,
  or,
  desc,
  inArray,
  isNull,
  resolveIdentity,
  extractIdentitySignals,
  signalsFromExplicit,
  IDENTITY_SIGNAL_PROPERTY_KEYS,
  type IdentitySignal,
  type ProviderVerbSpec,
} from "@synap/database";
import {
  getUserWorkspaceIds,
  logger,
  verifyWorkspaceAccess,
} from "../hub-protocol/rest/_shared.js";
import { userVisibleWhere } from "../../utils/user-visible-where.js";
import { validateCaptureGraphRefs } from "../hub-protocol/rest/_capture-graph-dedup.js";
import { buildIdentityResolveResponse } from "../../utils/identity-resolve-response.js";
import { openLink } from "../../utils/deep-links.js";
import type { Context } from "../../types/context.js";

// ── tRPC caller factory ───────────────────────────────────────────────────────

async function createHubProtocolCaller(
  userId: string,
  scopes: string[],
  agentUserId?: string,
  sessionId?: string | null,
  workspaceId?: string | null,
  // SERVICE-KEY CONFINEMENT: pins a bound `service` key's ambient workspace to
  // its binding via the shared primitive (no-op for other keys). Defence in
  // depth — callers already confine the value they pass, but this guarantees a
  // bound key's ctx lens can never be another workspace.
  keyType?: string | null,
  keyWorkspaceId?: string | null
) {
  await getDb();

  const confinedWorkspaceId = resolveConfinedWorkspace(
    keyType,
    keyWorkspaceId,
    workspaceId
  );

  // MCP keys use mcp.read / mcp.write scopes. Hub Protocol procedures require
  // hub-protocol.read / hub-protocol.write. Translate at the boundary so callers
  // only need to mint mcp.* keys — no hub-protocol.* knowledge required.
  const hubScopes = Array.from(
    new Set([
      ...scopes,
      ...(scopes.includes("mcp.read") ? ["hub-protocol.read"] : []),
      ...(scopes.includes("mcp.write")
        ? ["hub-protocol.read", "hub-protocol.write"]
        : []),
    ])
  );

  const ctx: Context & {
    scopes?: string[];
    apiKeyId?: string;
    apiKeyName?: string;
  } = {
    db,
    authenticated: true,
    userId,
    // When set (agent-key remap), `userId` is the operator and `agentUserId` is
    // the acting agent — write procs gate on agentUserId so they propose.
    agentUserId: agentUserId ?? null,
    // Link every write in this MCP call to the agent's active focus session so
    // its proposals/entities group under the run. The hub routers propagate
    // ctx.sessionId downward (see hub-protocol/entities.ts createEntity).
    sessionId: sessionId ?? null,
    // AMBIENT governance lens (the MCP URL's `?workspaceId=`). Hub write procs
    // read `ctx.workspaceId` as the caller's ambient workspace; when it is null
    // they fall back to the user's most-recently-updated membership — a random
    // governance lens the acting agent may not even belong to (which is what
    // turned entity proposals into `workspace.join` proposals). NEVER an
    // explicit placement pin: pod-scope kinds must still land pod-wide.
    workspaceId: confinedWorkspaceId ?? null,
    scopes: hubScopes,
    apiKeyId: "mcp",
    apiKeyName: "MCP Server",
    req: undefined,
    user: null,
    session: null,
  };

  return hubProtocolRouter.createCaller(ctx);
}

// ── Tool result helpers ───────────────────────────────────────────────────────

/**
 * Extract the primary object id from a tool result, in field-priority order:
 *   proposalId → id → entityId → documentId → viewId → channelId →
 *   sessionId → knowledgeKey.id → nested data.id → wrapped channel.id /
 *   document.id
 * First string hit wins; returns undefined when none is present.
 *
 * `messageId` is intentionally excluded — messages aren't openable, and
 * post_message already resolves via `channelId` (which precedes it here).
 */
function primaryObjectId(data: unknown): string | undefined {
  if (!data || typeof data !== "object" || Array.isArray(data))
    return undefined;
  const d = data as Record<string, unknown>;
  const keys = [
    "proposalId",
    "id",
    "entityId",
    "documentId",
    "viewId",
    "channelId",
    "sessionId",
  ] as const;
  for (const key of keys) {
    const v = d[key];
    if (typeof v === "string" && v) return v;
  }
  const kk = d.knowledgeKey as Record<string, unknown> | undefined;
  if (kk && typeof kk.id === "string" && kk.id) return kk.id;
  const nested = d.data as Record<string, unknown> | undefined;
  if (
    nested &&
    typeof nested === "object" &&
    typeof nested.id === "string" &&
    nested.id
  ) {
    return nested.id;
  }
  // Wrapped detail shapes: get_channel → { channel: { id } }, get_document →
  // { document: { id } }. Both wrappers are openable, so their nested id yields a
  // valid link. Only these known wrappers — never a generic deep scan.
  for (const wrapper of ["channel", "document"] as const) {
    const w = d[wrapper] as Record<string, unknown> | undefined;
    if (w && typeof w === "object" && typeof w.id === "string" && w.id) {
      return w.id;
    }
  }
  return undefined;
}

/**
 * AI Teaching Substrate: the one reinforcement line every 'proposed' write
 * result carries — added HERE (the one response shaper every handler already
 * flows through), never per-case, so it can't be forgotten on a new door.
 */
const PROPOSAL_REINFORCEMENT_HINT =
  "Tell the user why you proposed this and give them this link.";

/**
 * The hint a DEDUPED write carries: an identical proposal was already pending, so
 * the door returned it instead of creating a second. Tells the agent to stop
 * re-proposing and point the user at the existing review instead.
 */
const PROPOSAL_DUPLICATE_HINT =
  "An identical proposal is already pending review — this did NOT create a new one. Do not re-propose; give the user this link to the existing proposal.";

function ok(data: unknown): CallToolResult {
  // Best-effort: inject the canonical clickable `link` (`${PUBLIC_URL}/open/<id>`)
  // ONLY when the result carries an id that resolves to an openable object
  // (proposal / entity / view / document / channel — see primaryObjectId). Every
  // handler flows through this one shaper, so no per-handler edits are needed;
  // arrays, id-less objects, and non-openable ids simply get no link.
  const id = primaryObjectId(data);
  let payload =
    id && data && typeof data === "object" && !Array.isArray(data)
      ? { ...(data as Record<string, unknown>), link: openLink(id) }
      : data;
  if (
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    // Two proposed shapes flow through here: governed writes ({status:
    // "proposed"}) and executeCapability outcomes ({kind: "proposed"}).
    ((payload as Record<string, unknown>).status === "proposed" ||
      (payload as Record<string, unknown>).kind === "proposed")
  ) {
    // DUPLICATE surfacing (one place, every governed-write door): when the write
    // was deduped at the DB door (`deduped: true` rode up on the result), rewrite
    // the outcome to `status: "duplicate"` + a stop-re-proposing hint so the agent
    // learns an identical proposal is already pending. Otherwise keep the normal
    // "proposed" reinforcement hint (respecting a hint a handler already set).
    const p = payload as Record<string, unknown>;
    const deduped = p.deduped === true;
    payload = {
      ...p,
      ...(deduped ? { status: "duplicate" } : {}),
      hint: deduped
        ? PROPOSAL_DUPLICATE_HINT
        : "hint" in p
          ? p.hint
          : PROPOSAL_REINFORCEMENT_HINT,
    };
  }
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

function requireScope(scopes: string[], scope: string, toolName: string): void {
  if (!scopes.includes(scope)) {
    // Reachable over HTTP only since the door started honouring the key's own
    // scopes (http-handler.ts deriveMcpScopes); it previously received a
    // hardcoded read+write and could never fail. Name the recovery, not just
    // the denial — this surfaces to the model as recoverable text.
    throw new Error(
      `Tool '${toolName}' requires the '${scope}' scope, which your API key does not grant (it has: ${scopes.length ? scopes.join(", ") : "none"}). ` +
        `Mint a key with the '${scope}' scope in Synap settings → Intelligence → API Keys, or use a read-only tool instead.`
    );
  }
}

// ── Tool execution ────────────────────────────────────────────────────────────

/**
 * Build the uniform graph envelope for any object — the shared core behind both
 * `synap_get_graph` and the `neighbors` embedded in detail fetches (get_entity).
 * Folds in the entity-data graph (relations + property + channel) for
 * entity-backed kinds via the shared `entityDataNeighbors`. `cap` truncates the
 * neighbour list for embedding (counts stay full — honest "showing N of M").
 */
async function buildGraphEnvelope(
  userId: string,
  scopes: string[],
  kind: string,
  id: string,
  cap?: number
): Promise<GraphEnvelope> {
  const extra: GraphNeighbor[] =
    kind === "entity" || kind === "project"
      ? await entityDataNeighbors(userId, scopes, id)
      : [];
  const envelope = await getObjectGraph(
    userId,
    kind as LinkEndpointType,
    id,
    extra
  );
  if (cap && envelope.neighbors.length > cap) {
    return { ...envelope, neighbors: envelope.neighbors.slice(0, cap) };
  }
  return envelope;
}

// ── Focus-session handle resolution (server-side, never a tool schema) ────────

/**
 * The tools whose writes are worth GROUPING under a focus session (proposal
 * grouping + `produced` links), plus the session tools themselves. Resolving a
 * handle costs a DB round-trip, so a tool that would never use one — every read
 * door, orient, diagnose — must not pay for it. Keep this list in sync when a
 * new governed write door is added here.
 */
const SESSION_LINKED_TOOLS = new Set([
  "synap_create_entity",
  "synap_update_entity",
  "synap_create_document",
  "synap_remember_fact",
  "synap_link_entities",
  "synap_attach_facet",
  "synap_detach_facet",
  "synap_capture",
  "synap_capture_graph",
  "synap_create_project",
  "synap_create_playbook",
  "synap_create_view",
  "synap_create_verb",
  "synap_start_session",
  "synap_update_session",
  "synap_complete_session",
  "synap_promote_session_to_playbook",
]);

/** Non-terminal statuses — a session still "in flight" for its owner. */
const OPEN_SESSION_STATUSES = [
  "active",
  "paused",
  "forming",
  "scheduled",
] as const;

/**
 * Every `focus_sessions.status` value (mirrors the schema's column enum). Used
 * to validate the model-supplied `status` filter — see synap_list_sessions.
 */
const SESSION_STATUSES = [
  ...OPEN_SESSION_STATUSES,
  "closed",
  "failed",
  "cancelled",
] as const;

/**
 * Does this `focus_sessions` row belong to the effective user?
 *
 * `?sessionId=` arrives on the MCP URL and is caller-supplied — nothing upstream
 * validates it. Left unchecked it would point proposal grouping and `produced`
 * links at somebody else's session. This is a SCOPE HINT, not authorization, so
 * a mismatch is ignored (and logged), never thrown.
 */
async function ownsFocusSession(
  userId: string,
  sessionId: string
): Promise<boolean> {
  try {
    const [row] = await db
      .select({ id: focusSessions.id })
      .from(focusSessions)
      .where(
        and(eq(focusSessions.id, sessionId), eq(focusSessions.userId, userId))
      )
      .limit(1);
    return Boolean(row);
  } catch (err) {
    // A lookup failure must not silently widen the handle's reach.
    logger.warn(
      { err, sessionId },
      "mcp: focus-session ownership check failed"
    );
    return false;
  }
}

/**
 * The user's most recent still-open focus session — the ambient "what I'm
 * working on" handle when no explicit/URL one was supplied. Without this the
 * whole session-handle feature is inert: MCP URLs are registered once per
 * client, so nothing ever populates `?sessionId=`.
 *
 * NOT memoized. `synap_start_session` is itself session-linked, so this runs
 * BEFORE the session it opens exists — a memo would cache that pre-session
 * answer and the writes belonging to the just-opened session are exactly the
 * ones that would fail to group. The query is a single indexed lookup.
 */
export async function resolveAmbientSession(
  userId: string
): Promise<string | undefined> {
  let sessionId: string | undefined;
  try {
    const [row] = await db
      .select({ id: focusSessions.id })
      .from(focusSessions)
      .where(
        and(
          eq(focusSessions.userId, userId),
          inArray(focusSessions.status, [...OPEN_SESSION_STATUSES])
        )
      )
      .orderBy(desc(focusSessions.startedAt))
      .limit(1);
    sessionId = row?.id;
  } catch (err) {
    logger.warn(
      { err, userId },
      "mcp: ambient focus-session derivation failed"
    );
    sessionId = undefined;
  }
  return sessionId;
}

/**
 * Resolve the focus-session handle for THIS tool call.
 *
 * Precedence: explicit `args.sessionId` > validated ambient (`?sessionId=`) >
 * derived (most recent open session). Every candidate is ownership-checked
 * before it becomes `ctx.sessionId`; a handle that isn't the caller's is dropped
 * rather than rejected — it is a grouping hint, and refusing the whole tool call
 * over it would be a worse failure than losing the grouping.
 */
async function resolveSessionHandle(
  toolName: string,
  args: Record<string, unknown>,
  userId: string,
  ambientSessionId?: string
): Promise<string | undefined> {
  if (!SESSION_LINKED_TOOLS.has(toolName)) return undefined;
  // Normalize: sessionId flows to a `uuid` DB column, so a non-string arg is
  // dropped here rather than `as`-cast blindly. (Malformed UUID *strings* are
  // still rejected downstream by the mutation inputs' zod `.uuid()` schemas.)
  const explicit =
    typeof args.sessionId === "string" && args.sessionId.trim() !== ""
      ? args.sessionId
      : undefined;
  const candidate = explicit ?? ambientSessionId;
  if (candidate) {
    if (await ownsFocusSession(userId, candidate)) return candidate;
    logger.warn(
      {
        userId,
        sessionId: candidate,
        toolName,
        source: explicit ? "arg" : "url",
      },
      "mcp: focus-session handle does not belong to the caller — ignoring"
    );
    return undefined;
  }
  return resolveAmbientSession(userId);
}

// ── THE ONE CAPTURE DOOR — shared helpers (design doc §2.2 / §2.3) ────────────
//
// `synap_capture` is the AI-facing write door: ONE tool whose PAYLOAD is a
// gradient — `text` (unstructured) → `entities[]` (structured) → `entities[] +
// relations[]` (graph). An agent never has to classify its own input first,
// which is exactly the classification that broke a real agent against the old
// capture / create_entity / remember_fact split.
//
// Nothing below is a new core. The routing dispatches to the EXISTING capture
// structure→execute pipeline or the EXISTING `submitCaptureGraph`; these helpers
// only carry the uniform receipt and the door-level REJECT guard. The guard runs
// BEFORE governance — a rejected call never reaches `checkPermissionOrPropose`,
// so this is not a governance change.

/** The scope every capture receipt echoes back — where the write actually landed. */
interface CaptureScope {
  workspaceId: string | null;
  projectId: string | null;
  sessionId: string | null;
}

/**
 * The receipt this file constructs — the door-level REJECT outcome (nothing
 * written, nothing even proposed) and its `applied` twin. The graph branch does
 * NOT use this type: it forwards `submitCaptureGraph`'s own receipt verbatim,
 * which carries the proposal fields.
 *
 * Deliberately NOT modelled (no data behind them on this path — never invent
 * receipt fields): §2.3's `items[]`, `properties`, `next[]`.
 */
interface CaptureWriteReceipt {
  state: "applied" | "rejected";
  effectiveWorkspaceId: string | null;
  projectId?: string;
  source: string;
}

/**
 * Reject reasons the door emits. §2.3's fourth reason, `recall-loop`
 * (re-ingesting content the pod itself just served), is deliberately NOT built —
 * it needs per-caller read-receipt provenance that does not exist yet; see the
 * capture-door design doc §2.3.
 */
type CaptureRejectReason =
  "already-known" | "no-durable-content" | "structuring-unavailable";

/**
 * Minimum durable text. Deliberately tiny: the guard exists to stop empty /
 * whitespace / punctuation-only writes (mem0's 97.8%-junk failure mode), NOT to
 * judge whether a short fact is worth keeping — "Ada left" is durable.
 */
const CAPTURE_MIN_DURABLE_CHARS = 3;

/**
 * How many structured entities still get the advisory cross-kind pre-check.
 * One `resolveIdentity` is 2-3 queries, so a large batch skips it entirely — the
 * core's OWN dedup (inside `submitCaptureGraph`) runs either way; only the
 * advisory link suggestions are dropped.
 */
const CAPTURE_CROSSKIND_PRECHECK_MAX = 8;

function normalizeCaptureText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

/** Whitespace / punctuation-only, or shorter than a word → nothing to store. */
function hasDurableText(normalized: string): boolean {
  return (
    normalized.length >= CAPTURE_MIN_DURABLE_CHARS &&
    /[\p{L}\p{N}]/u.test(normalized)
  );
}

/** Does this entity element carry something storable (or name something real)? */
function hasDurableEntity(e: Record<string, unknown>): boolean {
  if (typeof e.existingEntityId === "string" && e.existingEntityId) return true;
  if (hasDurableText(normalizeCaptureText(e.title))) return true;
  if (hasDurableText(normalizeCaptureText(e.description))) return true;
  if (hasDurableText(normalizeCaptureText(e.content))) return true;
  const props = e.properties;
  if (props && typeof props === "object" && !Array.isArray(props)) {
    if (Object.keys(props as Record<string, unknown>).length > 0) return true;
  }
  return Array.isArray(e.facets) && e.facets.length > 0;
}

/** The uniform rejection envelope — same `scope` + `writeReceipt` as a success. */
function captureRejected(params: {
  reason: CaptureRejectReason;
  message: string;
  scope: CaptureScope;
  extra?: Record<string, unknown>;
}): CallToolResult {
  const receipt: CaptureWriteReceipt = {
    state: "rejected",
    effectiveWorkspaceId: params.scope.workspaceId,
    ...(params.scope.projectId ? { projectId: params.scope.projectId } : {}),
    source: "agent",
  };
  // `extra` is spread FIRST on purpose: it carries branch-specific passthrough
  // (the structurer's preview, degraded flags) and must never be able to
  // overwrite the canonical `status` / `reason` / `scope` / receipt fields.
  return ok({
    ...(params.extra ?? {}),
    status: "rejected",
    reason: params.reason,
    message: params.message,
    scope: params.scope,
    writeReceipt: receipt,
  });
}

export async function executeMCPToolViaHubProtocol(
  toolName: string,
  args: Record<string, unknown>,
  userId: string,
  apiKeyScopes: string[],
  _sessionUserId?: string,
  agentUserId?: string,
  /**
   * AMBIENT focus-session handle from the MCP URL's `?sessionId=` — injected
   * server-side by the transport, never advertised on a tool schema. An explicit
   * `args.sessionId` wins over it; both are ownership-checked before use.
   */
  ambientSessionId?: string,
  /**
   * SERVICE-KEY CONFINEMENT: the authenticating key's `keyType` + workspace
   * binding. When it is a bound `service` key, EVERY workspace this call would
   * touch (the injected `?workspaceId=` lens and every `args.workspaceId` a
   * write reads) is clamped to the binding via `resolveConfinedWorkspace` — the
   * SAME primitive the Hub REST door uses. Non-service/unbound keys pass through
   * unchanged.
   */
  keyType?: string | null,
  keyWorkspaceId?: string | null
): Promise<CallToolResult> {
  const sessionId = await resolveSessionHandle(
    toolName,
    args,
    userId,
    ambientSessionId
  );

  const caller = await createHubProtocolCaller(
    userId,
    apiKeyScopes,
    agentUserId,
    sessionId,
    null,
    keyType,
    keyWorkspaceId
  );

  // The MCP server auto-injects the URL lens (`?workspaceId=`) into every tool
  // call that accepts it. Entity writes ignored it entirely, so the hub fell
  // back to the user's most-recently-updated workspace membership. `lensCaller`
  // is the same hub caller with that lens as the AMBIENT governance workspace —
  // used by the entity write tools below. Normalized like `sessionId`: a
  // non-string arg is dropped rather than blindly cast.
  //
  // SECURITY: the URL lens is injected ONLY when the model didn't send one
  // (mcp/index.ts), so `args.workspaceId` here can be a MODEL-supplied id. It
  // becomes `ctx.workspaceId`, which the hub write procs consume as the ambient
  // governance workspace WITHOUT re-validating it (`entities.create` only
  // membership-checks `input.targetWorkspaceId`). Gate it here — the same
  // `verifyWorkspaceAccess` the capture-graph branch uses.
  const rawRequestedWorkspaceId =
    typeof args.workspaceId === "string" && args.workspaceId.trim() !== ""
      ? args.workspaceId
      : undefined;
  // SERVICE-KEY CONFINEMENT (the one clamp for the whole call): resolve the
  // requested workspace through the shared primitive BEFORE it becomes any lens
  // or write input. A bound `service` key targeting another workspace throws 403
  // HERE (before the switch → every read/write handler is covered); a bound key
  // with no target is positively pinned to its binding; non-service/unbound keys
  // return the requested value unchanged. Downstream reads `requestedWorkspaceId`
  // (the confined value) everywhere it previously read the raw `args.workspaceId`.
  const requestedWorkspaceId =
    resolveConfinedWorkspace(
      keyType,
      keyWorkspaceId,
      rawRequestedWorkspaceId
    ) ?? undefined;
  const workspaceAccessible = requestedWorkspaceId
    ? await verifyWorkspaceAccess(userId, requestedWorkspaceId)
    : false;
  if (requestedWorkspaceId && !workspaceAccessible) {
    // DROPPED, not rejected — like the session handle, the ambient lens is a
    // governance HINT, and falling back to no lens is exactly the (safe)
    // behaviour that predates it. Failing the whole call would also punish the
    // legitimate owner-without-member-row case. Placement PINS still fail loud:
    // the capture-graph branch below reuses this verdict to return Forbidden.
    logger.warn(
      { userId, workspaceId: requestedWorkspaceId, toolName },
      "mcp: workspace lens is not accessible to the caller — ignoring"
    );
  }
  const lensWorkspaceId = workspaceAccessible
    ? requestedWorkspaceId
    : undefined;
  const lensCaller = lensWorkspaceId
    ? await createHubProtocolCaller(
        userId,
        apiKeyScopes,
        agentUserId,
        sessionId,
        lensWorkspaceId,
        keyType,
        keyWorkspaceId
      )
    : caller;

  switch (toolName) {
    // ── Recall: THE one door ──────────────────────────────────────────────────
    // `synap_ask` is the unified recall verb — it replaces the old fragmented
    // search / search_entities / recall_facts / get_knowledge / list_knowledge
    // tools. It routes by query intent across all three substrates (semantic
    // entities, procedural knowledge_keys, episodic facts) and returns ONE
    // provenance-tagged answer. Fewer tools = better selection = the AI actually
    // reaches for recall before acting.
    case "synap_ask": {
      requireScope(apiKeyScopes, "mcp.read", toolName);
      if (typeof args.query !== "string" || args.query.trim() === "") {
        return ok({ error: "query is required" });
      }
      const workspaceId = args.workspaceId as string | undefined;
      // The semantic engine's catalog (type inference) needs a concrete
      // workspace; resolve the user's first accessible one when no lens is
      // pinned. Recall itself keeps the caller's lens (undefined = pod-wide).
      let catalogWs = workspaceId;
      if (!catalogWs) {
        const wsIds = await getUserWorkspaceIds(userId);
        catalogWs = wsIds[0];
      }
      let catalog: ProfileCatalogEntry[] = [];
      if (catalogWs) {
        const { profiles: profileRows } = await caller.profiles.listProfiles({
          userId,
          workspaceId: catalogWs,
        });
        catalog = profileRows.flatMap((p) => {
          const entry = toProfileCatalogEntry(p);
          return entry ? [entry] : [];
        });
      }
      const compare = args.compare === true;
      // Retrieve across all substrates (same call as /knowledge/search).
      const retrieved = await ask({
        query: args.query as string,
        userId,
        workspaceId: workspaceId ?? null,
        projectId: (args.projectId as string | undefined) ?? null,
        limit: (args.limit as number) || undefined,
        catalog,
        compare: compare || undefined,
      });

      // A/B DIAGNOSTIC — when `compare` is set, return the ranker comparison
      // (baseline vs Horizon on the same pool) directly, skipping IS synthesis.
      // Read-only: this is a ranking diff, not an answer.
      if (compare) {
        return ok({
          mode: "compare",
          query: args.query,
          understanding: retrieved.understanding,
          comparison: retrieved.comparison ?? null,
        });
      }

      // Build context + sources, then synthesize via IS.
      const synthesis = await synthesizeAnswer(
        retrieved.answers,
        args.query as string,
        retrieved.routedTo,
        workspaceId ?? null
      );
      // Surface synthesis outages loudly instead of returning a null answer that
      // looks like "no results". Retrieval/sources still stand.
      if ((synthesis as { error?: string }).error === "synthesis_unavailable") {
        return ok({
          ...synthesis,
          message:
            "⚠️ AI synthesis is temporarily unavailable. The matched sources below are real; tell the user the AI answer layer is degraded (not that nothing was found).",
        });
      }
      return ok(synthesis);
    }

    case "synap_get_entities": {
      requireScope(apiKeyScopes, "mcp.read", toolName);
      const profileSlug =
        (args.profileSlug as string | undefined) ||
        (args.type as string | undefined);
      const result = await caller.entities.getEntities({
        userId,
        profileSlug: profileSlug || undefined,
        ...(args.workspaceId
          ? { workspaceId: args.workspaceId as string }
          : {}),
        // Project-pinned MCP URL (?projectId=) auto-injects args.projectId, so a
        // focused agent's entity reads narrow to its project — same lens as ask.
        ...(args.projectId ? { projectId: args.projectId as string } : {}),
        // Kind + Facets: narrow to entities carrying a live facet of this role.
        ...(args.facetSlug ? { facetSlug: args.facetSlug as string } : {}),
        limit: (args.limit as number) || 50,
      });
      return ok(result);
    }

    case "synap_get_document": {
      requireScope(apiKeyScopes, "mcp.read", toolName);
      const result = await caller.documents.getDocument({
        userId,
        documentId: args.documentId as string,
      });
      return ok(result);
    }

    case "synap_get_thread_context": {
      requireScope(apiKeyScopes, "mcp.read", toolName);
      const result = await caller.context.getThreadContext({
        threadId: args.threadId as string,
      });
      return ok(result);
    }

    case "synap_list_proposals": {
      requireScope(apiKeyScopes, "mcp.read", toolName);
      const { listCreatedProposals } =
        await import("../../services/proposals/proposals-service.js");
      const result = await listCreatedProposals({
        // `createdBy` is the ONLY user floor this service applies — a
        // model-supplied `args.userId` would list a foreign user's proposals.
        createdBy: userId,
        workspaceId: args.workspaceId as string | undefined,
        status: args.status as string | undefined,
        limit: (args.limit as number) || undefined,
      });
      return ok(result);
    }

    case "synap_diagnose": {
      requireScope(apiKeyScopes, "mcp.read", toolName);
      const { listRuns, getRun } = await import("../../services/runs/index.js");
      const flowType = args.flowType as
        "automation" | "playbook" | "capture" | "session" | undefined;
      // With a runId → that run's activity timeline (a capture's decision + trace
      // events: what happened and WHY, each with a fixHint). Without → the feed.
      if (args.runId) {
        if (!flowType) {
          return ok({ error: "flowType is required when runId is given" });
        }
        const detail = await getRun({
          userId,
          flowType,
          id: args.runId as string,
        });
        return ok(detail ?? { error: "Run not found" });
      }
      const runs = await listRuns({
        userId,
        flowType,
        flowId: args.flowId as string | undefined,
        limit: (args.limit as number) || undefined,
      });
      return ok({ runs });
    }

    // ── Write tools ─────────────────────────────────────────────────────────
    case "synap_create_entity": {
      requireScope(apiKeyScopes, "mcp.write", toolName);
      // `lensCaller` carries the injected `?workspaceId=` lens as the AMBIENT
      // governance workspace (see above) — without it the hub picked a random
      // membership and the caller got a `workspace.join` proposal instead of an
      // entity proposal. It is deliberately NOT passed as the input's explicit
      // `workspaceId` (that is a rung-1 placement pin and would workspace-pin
      // pod-scope kinds — the four-door bug).
      const profileSlug =
        (args.profileSlug as string | undefined) ||
        (args.type as string | undefined);
      const result = await lensCaller.entities.createEntity({
        userId,
        profileSlug,
        title: args.title as string,
        description: args.description as string | undefined,
        // Long-form body → a versioned linked document (resolveContentTarget).
        // The hub input has always accepted `content`; the MCP schema could not
        // SEND it, so an agent had to make a second create_document call and
        // wire it up by hand. Forwarded here = long-text → document in ONE call.
        ...(typeof args.content === "string" && args.content
          ? { content: args.content }
          : {}),
        properties: args.properties as Record<string, unknown> | undefined,
        // A project-pinned MCP URL (?projectId=) auto-injects args.projectId, so
        // entities the agent creates are filed into its project focus.
        ...(args.projectId ? { projectId: args.projectId as string } : {}),
        // Kind + Facets: attach role-profiles in the same create call (governed
        // via entities.attachFacet on the created entity).
        ...(Array.isArray(args.facets)
          ? {
              facets: args.facets as Array<{
                slug: string;
                properties?: Record<string, unknown>;
              }>,
            }
          : {}),
        // agent-key remap: the write is OWNED by the operator (userId) but
        // AUTHORED by the agent — pass agentUserId so governance proposes.
        ...(agentUserId ? { agentUserId } : {}),
        aiMetadata: { model: "mcp", reasoning: `MCP tool: ${toolName}` },
      });

      // ── The write receipt (the thing MCP callers never got) ────────────────
      // REST callers have long received `writeReceipt` (truthful pending /
      // applied / partial + per-facet outcomes + warnings) and `resolution`
      // (what already exists under this name). MCP calls the tRPC procedure
      // directly, so it returned a bare id. Same shared builder, same blocks —
      // one receipt shape for every transport.
      //
      // NOT wrapped in try/catch on purpose: buildCreateEntityReceipt never
      // throws (resolution failures come back as `resolution: undefined`), and a
      // catch here would swallow the receipt it is meant to deliver.
      //
      // It also has an INTENDED side effect: same-name/different-profile matches
      // are auto-connected with a governed `same_subject` relation.
      const { buildCreateEntityReceipt } =
        await import("../hub-protocol/write-receipt.js");
      const created = result as Record<string, unknown>;
      // The hub procedure echoes the AMBIENT governance lens it resolved (which
      // may be the membership fallback, not our injected lens) — prefer it, and
      // fall back to the URL lens. Not the entity's placement: a pod-scope kind
      // still lands pod-wide. Same caveat as the hub's own echo.
      const receiptWorkspaceId =
        (typeof created.workspaceId === "string"
          ? created.workspaceId
          : null) ??
        lensWorkspaceId ??
        null;
      const { writeReceipt, resolution } = await buildCreateEntityReceipt({
        result: created,
        profileSlug: profileSlug ?? "",
        effectiveWorkspaceId: receiptWorkspaceId,
        userId,
        scopes: apiKeyScopes,
        title: args.title as string,
        ...(args.projectId ? { projectId: args.projectId as string } : {}),
        source: "agent",
        ...(agentUserId ? { resolvedAgentUserId: agentUserId } : {}),
      });
      return ok({
        ...created,
        effectiveWorkspaceId: receiptWorkspaceId,
        writeReceipt,
        ...(resolution ? { resolution } : {}),
      });
    }

    case "synap_update_entity": {
      requireScope(apiKeyScopes, "mcp.write", toolName);
      // Same omission as create: hub `updateEntity` derives its governance lens
      // from `ctx.workspaceId`, which was always null for MCP callers.
      const result = await lensCaller.entities.updateEntity({
        entityId: args.entityId as string,
        userId,
        title: args.title as string | undefined,
        preview: args.description as string | undefined,
        // properties merges into the JSONB column; metadata is a legacy alias
        metadata: (args.properties ?? args.metadata) as
          Record<string, unknown> | undefined,
        ...(agentUserId ? { agentUserId } : {}),
      });
      return ok(result);
    }

    case "synap_create_document": {
      requireScope(apiKeyScopes, "mcp.write", toolName);
      const result = await caller.documents.createDocument({
        userId,
        // Confined workspace (service-key clamp) — not the raw model-supplied id.
        workspaceId: requestedWorkspaceId as string,
        title: args.title as string,
        content: (args.content as string) || "",
        reasoning: "Created via MCP",
        ...(agentUserId ? { agentUserId } : {}),
      });
      // ATTACHMENT (the description used to claim it without doing it). The
      // link lives on `entities.documentId` — `documents.entityId` was removed —
      // so it is a separate GOVERNED entity update through the regular entities
      // router, not a side effect of the document write.
      const attachEntityId = args.entityId as string | undefined;
      if (!attachEntityId) return ok(result);
      const doc = result as Record<string, unknown>;
      // A proposal-gated document has no row yet: `documentId` is only the id it
      // WILL get. Linking to it now would leave a dangling reference, so say so
      // instead of pretending the attach happened.
      if (doc.status === "proposed") {
        return ok({
          ...doc,
          attached: {
            entityId: attachEntityId,
            status: "skipped",
            reason:
              "The document itself is awaiting review — approve it first, then attach it with synap_update_entity.",
          },
        });
      }
      const documentId =
        typeof doc.documentId === "string"
          ? doc.documentId
          : typeof doc.id === "string"
            ? doc.id
            : undefined;
      if (!documentId) return ok(result);
      const attachCtx = await createHubProtocolCallerContext(
        userId,
        apiKeyScopes,
        // Membership-gated lens, never the raw model-supplied id — this ctx
        // drives a GOVERNED entity update (see the SECURITY note on lensCaller).
        lensWorkspaceId,
        undefined,
        sessionId,
        agentUserId
      );
      const attachCaller = regularEntitiesRouter.createCaller(attachCtx);
      const attached = await attachCaller.update({
        id: attachEntityId,
        documentId,
        reasoning: `Attach document created via MCP tool: ${toolName}`,
        ...(agentUserId ? { agentUserId } : {}),
      });
      return ok({
        ...doc,
        attached: {
          entityId: attachEntityId,
          documentId,
          // Governed like every other entity update: an agent may get a
          // proposal here even though the document itself was auto-approved.
          ...(attached as Record<string, unknown>),
        },
      });
    }

    case "synap_remember_fact": {
      requireScope(apiKeyScopes, "mcp.write", toolName);
      // GOVERNED: a fact about the user is a `user_observation` entity now, not
      // an ungoverned `knowledge_facts` row. AI-INFERRED → proposed;
      // `userStated: true` → auto-approved (the policy rung reads
      // `uo_validated`). `lensCaller` carries the workspace lens + agent
      // identity + session handle, exactly like create_entity.
      const { rememberFact, USER_OBSERVATION_CATEGORIES } =
        await import("../../services/knowledge/remember-fact.js");
      // Off-enum categories were written unchecked. Validate against the SSOT
      // and fall back to the service's own default rather than failing the write.
      const factCategory =
        typeof args.category === "string" &&
        (USER_OBSERVATION_CATEGORIES as readonly string[]).includes(
          args.category
        )
          ? (args.category as UserObservationCategory)
          : undefined;
      const result = await rememberFact({
        caller: lensCaller,
        // NEVER `args.userId`: the hub `createEntity` trusts `input.userId`, so a
        // model-supplied one would mint an entity + proposal owned by another
        // user. The API key already identifies the caller.
        userId,
        fact: args.fact as string,
        ...(typeof args.confidence === "number"
          ? { confidence: args.confidence }
          : {}),
        ...(factCategory ? { category: factCategory } : {}),
        ...(args.userStated === true ? { userStated: true } : {}),
        ...(agentUserId ? { agentUserId } : {}),
      });
      return ok(result);
    }

    case "synap_get_entity": {
      requireScope(apiKeyScopes, "mcp.read", toolName);
      // Hub protocol doesn't expose a single-entity get; use regular entities router
      const entityCallerCtx = await createHubProtocolCallerContext(
        userId,
        apiKeyScopes,
        (args.workspaceId as string) || undefined,
        undefined,
        undefined,
        agentUserId
      );
      const entityCaller = regularEntitiesRouter.createCaller(entityCallerCtx);
      const entityResult = await entityCaller.get({
        id: args.entityId as string,
        includeProfile: true,
      });
      // Graph by default: embed a capped typed-neighbour summary so the agent
      // sees the entity's place in the pod without a second call. Additive +
      // best-effort — never let the graph half break the entity read.
      let graph: GraphEnvelope | undefined;
      try {
        graph = await buildGraphEnvelope(
          userId,
          apiKeyScopes,
          "entity",
          args.entityId as string,
          20
        );
      } catch {
        graph = undefined;
      }
      return ok(
        graph
          ? { ...(entityResult as Record<string, unknown>), graph }
          : entityResult
      );
    }

    case "synap_list_profiles": {
      requireScope(apiKeyScopes, "mcp.read", toolName);
      const wsId = args.workspaceId as string | undefined;
      const wantFull = (args.detail as string | undefined) === "full";

      /** Map a raw profile row to the lightweight digest shape. */
      const toDigest = (
        p: Record<string, unknown>,
        workspaceId?: string
      ): Record<string, unknown> => {
        const base: Record<string, unknown> = {
          id: p.id,
          slug: p.slug,
          displayName: p.displayName,
          entityScope: p.entityScope,
          // Visibility axis (who can use this profile type) — distinct from
          // entityScope (placement: where its entities live).
          scope: p.scope ?? null,
          description: p.description ?? null,
          icon: p.icon ?? null,
          // Kind + Facets discriminator — lets an agent tell a primary type
          // (kind) from an attachable facet (role) before creating entities.
          profileKind: p.profileKind ?? "kind",
          applicableKinds: p.applicableKinds ?? null,
        };
        if (workspaceId !== undefined) base.workspaceId = workspaceId;
        return base;
      };

      if (wsId) {
        const result = await caller.profiles.listProfiles({
          userId,
          workspaceId: wsId,
        });
        if (wantFull) return ok(result);
        const profiles = Array.isArray(result)
          ? result
          : ((result as unknown as { profiles: unknown[] }).profiles ?? []);
        return ok(
          (profiles as Array<Record<string, unknown>>).map((p) => toDigest(p))
        );
      }
      const wsIds = await getUserWorkspaceIds(userId);
      if (wsIds.length === 0) return ok([]);
      const perWs = await Promise.all(
        wsIds.map((id) =>
          caller.profiles
            .listProfiles({ userId, workspaceId: id })
            .then((res) =>
              res.profiles.map(
                (p) =>
                  ({
                    ...(p as Record<string, unknown>),
                    workspaceId: id,
                  }) as Record<string, unknown>
              )
            )
            .catch(() => [] as Array<Record<string, unknown>>)
        )
      );
      const seen = new Set<string>();
      const merged: Array<Record<string, unknown>> = [];
      for (const profiles of perWs) {
        for (const p of profiles) {
          const slug = p.slug as string;
          if (!seen.has(slug)) {
            seen.add(slug);
            merged.push(wantFull ? p : toDigest(p, p.workspaceId as string));
          }
        }
      }
      return ok(merged);
    }

    case "synap_get_relations": {
      requireScope(apiKeyScopes, "mcp.read", toolName);
      let relWsId = args.workspaceId as string | undefined;
      if (!relWsId) {
        const ids = await getUserWorkspaceIds(userId);
        relWsId = ids[0];
      }
      if (!relWsId) return ok({ error: "No accessible workspace found" });
      const result = await caller.relations.listRelations({
        userId,
        workspaceId: relWsId,
        entityId: args.entityId as string,
      });
      return ok(result);
    }

    case "synap_resolve_identity": {
      requireScope(apiKeyScopes, "mcp.read", toolName);
      // Read-only identity pre-check via the ONE matcher. Same call the REST
      // /identity/resolve route makes — resolved here directly (no HTTP hop),
      // mirroring how synap_get_entity uses the entities router in-process.
      // Explicit atoms via the ONE shared mapper (same as the REST route), plus
      // any mined from the draft property bag (richest lookup).
      const signals: IdentitySignal[] = [
        ...signalsFromExplicit(
          args.signals as Parameters<typeof signalsFromExplicit>[0]
        ),
        ...extractIdentitySignals(
          args.properties as Record<string, unknown> | undefined
        ),
      ];

      const resolution = await resolveIdentity(db, {
        userId,
        kindSlug: args.kindSlug as string | undefined,
        name: args.title as string | undefined,
        signals,
        // Identity is global (a subject exists once pod-wide) → scope the weak
        // path to the user's visible rows, not a single workspace.
        userScope: userVisibleWhere(entities.workspaceId, userId),
        limit: 10,
      });

      // Cross-user content scoping lives in the shared response builder (the
      // one door for both this tool and the Hub REST /identity/resolve route).
      return ok(await buildIdentityResolveResponse(resolution, userId));
    }

    case "synap_get_graph": {
      requireScope(apiKeyScopes, "mcp.read", toolName);
      const gKind = (args.type as string | undefined) ?? "entity";
      let gId = args.id as string | undefined;
      // Name-addressing: fetch the graph by NAME instead of id. Resolve the name
      // to an object first; ambiguous names return the candidates to pick from.
      if (!gId && args.name) {
        const matches = await resolveByName(
          userId,
          gKind,
          args.name as string,
          args.subtype as string | undefined
        );
        if (matches.length === 0) {
          // The name matched no entity of this kind — but it may be a
          // profile/role type name. Probe profiles and route the caller to the
          // right tool instead of dead-ending.
          const profileHits = await resolveProfileByName(
            userId,
            args.name as string
          );
          if (profileHits.length > 0) {
            return ok({
              error: `'${args.name}' is a profile/role, not a ${gKind}. get_graph resolves entities, not types.`,
              candidates: profileHits,
              hint: profileHits.some((p) => p.profileKind === "role")
                ? "This is a role (facet). Use synap_list_profiles to inspect it, synap_attach_facet to attach it to an entity, or synap_define_role to edit it."
                : "This is a kind. Use synap_list_profiles to inspect its schema, or synap_get_entities to list entities of this type.",
            });
          }
          return ok({ error: `No ${gKind} named '${args.name}'` });
        }
        if (matches.length > 1)
          return ok({
            ambiguous: true,
            message: `Multiple ${gKind}s named '${args.name}' — pass id`,
            matches,
          });
        gId = matches[0].id;
      }
      if (!gId) return ok({ error: "id or name is required" });
      const envelope = await buildGraphEnvelope(
        userId,
        apiKeyScopes,
        gKind,
        gId
      );
      return ok(envelope);
    }

    case "synap_link_entities": {
      requireScope(apiKeyScopes, "mcp.write", toolName);
      // Confined workspace (service-key clamp) before the first-ws fallback, so a
      // bound key never writes a relation into a non-bound workspace.
      let linkWsId = requestedWorkspaceId;
      if (!linkWsId) {
        const ids = await getUserWorkspaceIds(userId);
        linkWsId = ids[0];
      }
      if (!linkWsId) return ok({ error: "No accessible workspace found" });
      const result = await caller.relations.createRelation({
        userId,
        workspaceId: linkWsId,
        sourceEntityId: args.sourceEntityId as string,
        targetEntityId: args.targetEntityId as string,
        type: (args.type as string) || "related",
        ...(agentUserId ? { agentUserId } : {}),
      });
      return ok(result);
    }

    // ── Kind + Facets: attach/detach a role-profile ─────────────────────────
    // Both go through the SAME governed door as the tRPC/Hub REST facet routes
    // (hub-protocol entities.attachFacet/detachFacet → regular entities.*Facet,
    // which run checkPermissionOrPropose). The agent-key remap (agentUserId)
    // makes governance propose for agent callers, exactly like create_entity.
    case "synap_attach_facet": {
      requireScope(apiKeyScopes, "mcp.write", toolName);
      // lensCaller: the hub facet procs derive their governance workspace from
      // ctx.workspaceId, which was always null for MCP callers (same omission
      // as create/update — the explicit `workspaceId` below is the FACET lens,
      // not the governance one).
      const result = await lensCaller.entities.attachFacet({
        userId,
        entityId: args.entityId as string,
        profileSlug: args.facetSlug as string,
        ...(args.properties
          ? { properties: args.properties as Record<string, unknown> }
          : {}),
        // Confined facet lens (service-key clamp) — a bound key can only scope
        // the facet to its own workspace.
        ...(requestedWorkspaceId ? { workspaceId: requestedWorkspaceId } : {}),
        ...(args.contextEntityId
          ? { contextEntityId: args.contextEntityId as string }
          : {}),
        ...(agentUserId ? { agentUserId } : {}),
      });
      return ok(result);
    }

    case "synap_detach_facet": {
      requireScope(apiKeyScopes, "mcp.write", toolName);
      // The one-door detach is keyed by facetId. Accept a facetId directly (the
      // handle attach returns), or resolve entityId + facetSlug → facetId via the
      // entity's live facets (the ergonomic form an agent knows), then detach
      // through the SAME governed door — a lookup before the door, not a bypass.
      let facetId = args.facetId as string | undefined;
      if (!facetId) {
        const entityId = args.entityId as string | undefined;
        const facetSlug = args.facetSlug as string | undefined;
        if (!entityId || !facetSlug) {
          return ok({
            error:
              "Provide facetId, or entityId + facetSlug, to detach a facet",
          });
        }
        const entityCallerCtx = await createHubProtocolCallerContext(
          userId,
          apiKeyScopes,
          (args.workspaceId as string) || undefined,
          undefined,
          undefined,
          agentUserId
        );
        const entityCaller =
          regularEntitiesRouter.createCaller(entityCallerCtx);
        const entityResult = await entityCaller.get({
          id: entityId,
          includeProfile: true,
          ...(args.workspaceId
            ? { workspaceId: args.workspaceId as string }
            : {}),
        });
        const facets =
          (
            entityResult as {
              facets?: Array<{
                facet: { id: string; workspaceId: string | null };
                profile: { slug?: string };
              }>;
            }
          ).facets ?? [];
        const matches = facets.filter((f) => f.profile?.slug === facetSlug);
        if (matches.length === 0) {
          return ok({
            error: `No live '${facetSlug}' facet on entity ${entityId}`,
          });
        }
        if (matches.length > 1) {
          // Same role attached in more than one workspace lens — picking the
          // first would detach a nondeterministic one, and the proposal card
          // keys on the opaque facetId so a reviewer wouldn't catch it. Make
          // the caller choose: pass workspaceId to narrow the lens, or the
          // exact facetId.
          return ok({
            error: `Entity ${entityId} carries ${matches.length} live '${facetSlug}' facets — pass workspaceId or an explicit facetId`,
            candidates: matches.map((f) => ({
              facetId: f.facet.id,
              workspaceId: f.facet.workspaceId,
            })),
          });
        }
        facetId = matches[0].facet.id;
      }
      // lensCaller: same governance-lens omission as attachFacet above.
      const result = await lensCaller.entities.detachFacet({
        userId,
        facetId,
        ...(agentUserId ? { agentUserId } : {}),
      });
      return ok(result);
    }

    // Mint a NEW role type (Kind + Facets). Goes through the SAME governed door
    // as tRPC/Hub profile creation (hub-protocol profiles.createProfile →
    // regular profiles.create → checkPermissionOrPropose). profileKind:'role'
    // + a non-empty applicableKinds is what makes it an attachable facet type
    // rather than a primary entity kind.
    case "synap_define_role": {
      requireScope(apiKeyScopes, "mcp.write", toolName);
      const applicableKinds =
        Array.isArray(args.applicableKinds) && args.applicableKinds.length > 0
          ? (args.applicableKinds as string[])
          : ["company", "person"];
      const uiHints: Record<string, unknown> = {};
      if (typeof args.icon === "string") uiHints.icon = args.icon;
      if (typeof args.description === "string")
        uiHints.description = args.description;
      const result = await caller.profiles.createProfile({
        userId,
        // Confined workspace (service-key clamp) — not the raw model-supplied id.
        workspaceId: requestedWorkspaceId as string,
        slug: args.slug as string,
        displayName: args.displayName as string,
        profileKind: "role",
        applicableKinds,
        ...(Object.keys(uiHints).length > 0 ? { uiHints } : {}),
        ...(args.properties
          ? { defaultValues: args.properties as Record<string, unknown> }
          : {}),
        reasoning: "Role type defined via MCP synap_define_role",
        ...(agentUserId ? { agentUserId } : {}),
      });
      return ok(result);
    }

    // (synap_send_message removed — synap_post_message supersedes it: it handles
    // thread creation from a channelId and can trigger an AI response. One
    // messaging tool, not two.)

    // ── Session bootstrap & governance ──────────────────────────────────────
    // Canonical lens map — delegates to the shared `discover()` service (the ONE
    // place that shapes orient output; the REST /orient route + CLI `orient` go
    // through the same function). ZERO bespoke data fetching here. `scope`
    // subsumes the former synap_list_projects tool (scope:['projects']).
    case "synap_orient": {
      requireScope(apiKeyScopes, "mcp.read", toolName);
      const { discover } = await import("../../services/discover/discover.js");
      const result = await discover({
        caller,
        userId,
        authScopes: apiKeyScopes,
        detail: (args.detail as "light" | "full" | undefined) ?? "light",
        scope: args.scope as
          Array<"workspaces" | "projects" | "profiles"> | undefined,
        workspaceId: args.workspaceId as string | undefined,
        projectId: args.projectId as string | undefined,
      });
      return ok(result);
    }

    // ── Focus sessions (work tracking) ──────────────────────────────────────
    case "synap_start_session": {
      requireScope(apiKeyScopes, "mcp.write", toolName);
      const { createFocusSession } =
        await import("../../services/focus-sessions/create-session.js");
      const result = await createFocusSession({
        userId,
        workspaceId: args.workspaceId as string | undefined,
        projectId: args.projectId as string | undefined,
        subjectEntityId: args.subjectEntityId as string | undefined,
        goal: args.goal as string,
        agentUserId,
        correlationId: args.correlationId as string | undefined,
        channelId: args.channelId as string | undefined,
        agentIds: args.agentIds as string[] | undefined,
        templateId: args.templateId as string | undefined,
        expectedOutputs: args.expectedOutputs as
          | Array<{
              kind: string;
              label: string;
              icon?: string;
              status?: "pending" | "done";
            }>
          | undefined,
      });
      return ok(result);
    }

    case "synap_complete_session": {
      requireScope(apiKeyScopes, "mcp.write", toolName);
      const { completeFocusSession } =
        await import("../../services/focus-sessions/complete-session.js");
      const session = await completeFocusSession({
        sessionId: args.sessionId as string,
        userId,
        agentUserId,
        summary: args.summary as string | undefined,
        verificationReport: args.verificationReport as
          Record<string, unknown> | undefined,
      });
      if (!session) {
        return ok({ error: `Focus session ${args.sessionId} not found` });
      }
      return ok({ status: "closed", session });
    }

    // Re-find a session. Without these an agent that lost the id returned by
    // start_session could never reach its own session again — it could only
    // start a second one. Read-only, and floored on the caller's userId (the
    // same floor the REST focus-session routes enforce), so no workspace param
    // is needed and project-scoped sessions (workspaceId NULL) stay visible.
    case "synap_get_session": {
      requireScope(apiKeyScopes, "mcp.read", toolName);
      const wantedId =
        typeof args.sessionId === "string" && args.sessionId.trim() !== ""
          ? args.sessionId
          : await resolveAmbientSession(userId);
      if (!wantedId) {
        return ok({
          session: null,
          message:
            "You have no open focus session. Start one with synap_start_session.",
        });
      }
      const [session] = await db
        .select()
        .from(focusSessions)
        .where(
          and(eq(focusSessions.id, wantedId), eq(focusSessions.userId, userId))
        )
        .limit(1);
      if (!session) {
        return ok({ error: `Focus session ${wantedId} not found` });
      }
      return ok({ session });
    }

    case "synap_list_sessions": {
      requireScope(apiKeyScopes, "mcp.read", toolName);
      const statusArg = (args.status as string | undefined) ?? "open";
      const conditions = [eq(focusSessions.userId, userId)];
      if (statusArg === "open") {
        conditions.push(
          inArray(focusSessions.status, [...OPEN_SESSION_STATUSES])
        );
      } else if (statusArg !== "all") {
        // MCP schemas are ADVISORY — nothing validates `status` server-side, so
        // an off-enum value ("done", "completed") would silently match zero rows
        // instead of telling the agent what it may ask for.
        if (!(SESSION_STATUSES as readonly string[]).includes(statusArg)) {
          return ok({
            error: `Unknown session status '${statusArg}'. Valid values: ${SESSION_STATUSES.join(", ")}, plus 'open' (any non-terminal) and 'all'.`,
          });
        }
        conditions.push(
          eq(
            focusSessions.status,
            statusArg as (typeof focusSessions.$inferSelect)["status"]
          )
        );
      }
      // The URL lens auto-injects workspaceId/projectId — honoured as filters,
      // never as an authorization boundary (userId above is the floor).
      if (typeof args.workspaceId === "string" && args.workspaceId) {
        conditions.push(eq(focusSessions.workspaceId, args.workspaceId));
      }
      if (typeof args.projectId === "string" && args.projectId) {
        conditions.push(eq(focusSessions.projectId, args.projectId));
      }
      if (typeof args.subjectEntityId === "string" && args.subjectEntityId) {
        conditions.push(
          eq(focusSessions.subjectEntityId, args.subjectEntityId)
        );
      }
      const rawLimit =
        typeof args.limit === "number" && Number.isFinite(args.limit)
          ? args.limit
          : 20;
      const sessions = await db
        .select()
        .from(focusSessions)
        .where(and(...conditions))
        .orderBy(desc(focusSessions.startedAt))
        .limit(Math.min(Math.max(Math.trunc(rawLimit), 1), 50));
      return ok({ sessions, count: sessions.length });
    }

    case "synap_update_session": {
      requireScope(apiKeyScopes, "mcp.write", toolName);
      const { updateFocusSession } =
        await import("../../services/focus-sessions/update-session.js");
      const result = await updateFocusSession({
        sessionId: args.sessionId as string,
        userId,
        agentUserId,
        goal: args.goal as string | undefined,
        status: args.status as "active" | "paused" | undefined,
        progress: args.progress as number | undefined,
        currentStage: args.currentStage as string | undefined,
        addOutput: args.addOutput as
          { kind: string; label: string; icon?: string } | undefined,
        completeOutput: args.completeOutput as string | undefined,
        expectedOutputs: args.expectedOutputs as
          | Array<{
              kind: string;
              label: string;
              icon?: string;
              status?: "pending" | "done";
            }>
          | undefined,
      });
      switch (result.status) {
        case "not_found":
          return ok({
            error: `Focus session ${args.sessionId as string} not found`,
          });
        case "denied":
          return ok({ error: result.reason });
        case "proposed":
          return ok({
            status: "proposed",
            message: "Focus session update proposed for review",
            proposalId: result.proposalId,
            summary: result.summary,
            reviewPath: result.reviewPath,
            reviewUrl: result.reviewUrl,
            session: null,
          });
        case "updated":
          return ok({ status: "updated", session: result.session });
      }
      // Defensive: an unhandled decision must NOT fall through into the next
      // switch case (synap_create_cell) — break out of the outer switch.
      break;
    }

    // ── Cell authoring & renderer binding (external-agent surface) ──────────
    case "synap_create_cell": {
      requireScope(apiKeyScopes, "mcp.write", toolName);
      // Validate the shape before trusting the cast args (defineCell handles the
      // npm-dep allowlist itself — this only guards the required primitives).
      const parsed = z
        .object({
          name: z.string().min(1),
          rendererSource: z.string().min(1),
          workspaceId: z.string().optional(),
          description: z.string().optional(),
        })
        .safeParse(args);
      if (!parsed.success) {
        throw new Error(
          `Invalid synap_create_cell args: ${parsed.error.issues
            .map((i) => i.message)
            .join(", ")}`
        );
      }
      const cellWorkspaceId = parsed.data.workspaceId ?? null;
      // Gate the workspace-scoped write exactly as the REST door does
      // (rest/cells.ts) — defineCell trusts its caller, so the door must verify
      // the acting user is a member of the target workspace.
      if (cellWorkspaceId) {
        const { verifyWorkspaceAccess } =
          await import("../hub-protocol/rest/_shared.js");
        if (!(await verifyWorkspaceAccess(userId, cellWorkspaceId))) {
          throw new Error(
            `Forbidden: no access to workspace ${cellWorkspaceId}`
          );
        }
      }
      const { defineCell } =
        await import("../../services/cells/define-cell.js");
      const result = await defineCell({
        name: parsed.data.name,
        rendererSource: parsed.data.rendererSource,
        workspaceId: cellWorkspaceId,
        description: parsed.data.description,
        userId,
      });
      return ok({ status: result.changeType, ...result });
    }

    case "synap_promote_cell_to_renderer": {
      requireScope(apiKeyScopes, "mcp.write", toolName);
      // Governed: for an AI agent this returns `status: 'proposed'` (binding an
      // AI-generated cell as a durable renderer is consequential); an operator
      // auto-applies.
      const result = await caller.profiles.setRenderer({
        userId,
        workspaceId: args.workspaceId as string | undefined,
        profileSlug: args.profileSlug as string,
        slot: args.slot as "list" | "detail" | "dashboard",
        cellKey: args.cellKey as string,
        props: args.props as Record<string, unknown> | undefined,
        scope: args.scope as "workspace" | "pod" | undefined,
        ...(agentUserId ? { agentUserId } : {}),
      });
      return ok(result);
    }

    case "synap_promote_session_to_playbook": {
      requireScope(apiKeyScopes, "mcp.write", toolName);
      // Governed via the regular `playbooks.promote` — agent → proposed,
      // operator → promoted.
      const result = await caller.playbooks.promote({
        userId,
        sessionId: args.sessionId as string,
        ...(agentUserId ? { agentUserId } : {}),
      });
      return ok(result);
    }

    // ── Playbooks (reusable session templates) ──────────────────────────────
    case "synap_list_playbooks": {
      requireScope(apiKeyScopes, "mcp.read", toolName);
      let playbookWsId = args.workspaceId as string | undefined;
      if (!playbookWsId) {
        const wsIds = await getUserWorkspaceIds(userId);
        playbookWsId = wsIds[0];
      }
      if (!playbookWsId) return ok({ error: "No accessible workspace found" });
      const playbookCtx = await createHubProtocolCallerContext(
        userId,
        apiKeyScopes,
        playbookWsId,
        undefined,
        undefined,
        agentUserId
      );
      const playbookCaller = playbooksRouter.createCaller(playbookCtx);
      const result = await playbookCaller.list({
        status: args.status as
          "draft" | "active" | "paused" | "archived" | undefined,
      });
      return ok(result);
    }

    case "synap_match_playbooks": {
      requireScope(apiKeyScopes, "mcp.read", toolName);
      let matchWsId = args.workspaceId as string | undefined;
      if (!matchWsId) {
        const wsIds = await getUserWorkspaceIds(userId);
        matchWsId = wsIds[0];
      }
      if (!matchWsId) return ok({ error: "No accessible workspace found" });
      const matchCtx = await createHubProtocolCallerContext(
        userId,
        apiKeyScopes,
        matchWsId,
        undefined,
        undefined,
        agentUserId
      );
      const matchCaller = playbooksRouter.createCaller(matchCtx);
      const result = await matchCaller.matchForEntity({
        profileSlug: args.profileSlug as string,
        entityId: args.entityId as string | undefined,
        workspaceId: matchWsId,
      });
      return ok(result);
    }

    case "synap_governance": {
      requireScope(apiKeyScopes, "mcp.read", toolName);
      const wsId = args.workspaceId as string;
      // Membership floor: getEffectiveGovernance reads ANY workspace's policy by
      // id, so gate on the caller actually belonging to it (a bound service key
      // is already clamped upstream; this closes the read for ordinary keys too).
      if (wsId && !(await verifyWorkspaceAccess(userId, wsId))) {
        return ok({ error: `Forbidden: no access to workspace ${wsId}` });
      }
      const { getEffectiveGovernance } =
        await import("../../utils/permission-check.js");
      const { countPendingProposals } =
        await import("../../services/proposals/proposals-service.js");
      const policy = await getEffectiveGovernance(wsId);
      const pendingCount = await countPendingProposals(wsId);
      return ok({ ...policy, pendingProposals: pendingCount });
    }

    // ── THE ONE CAPTURE DOOR (design doc §2.2) ───────────────────────────────
    // `synap_capture` and its DEPRECATED alias `synap_capture_graph` share ONE
    // body. Routing is by PAYLOAD, never by tool name — an agent must never have
    // to classify "is this a loose fact, a structured object, or a graph?":
    //
    //   entities[] present  → the composite core (`submitCaptureGraph`), with or
    //                         without relations[] → ONE reviewable proposal.
    //   text only           → the existing capture structure→execute pipeline.
    //   global:true + text  → the pod-wide runbook lane (knowledge_keys).
    //   neither             → REJECT (no-durable-content).
    //
    // Nothing here reimplements a core. The only door-level logic is the REJECT
    // guard, which runs BEFORE governance (a rejected call never reaches
    // `checkPermissionOrPropose`), and the uniform receipt.
    case "synap_capture":
    case "synap_capture_graph": {
      requireScope(apiKeyScopes, "mcp.write", toolName);

      const captureRawText = typeof args.text === "string" ? args.text : "";
      const captureNormalizedText = normalizeCaptureText(captureRawText);
      const captureEntities = Array.isArray(args.entities)
        ? (args.entities as Array<Record<string, unknown>>)
        : [];
      const captureRelations = Array.isArray(args.relations)
        ? (args.relations as Array<Record<string, unknown>>)
        : [];
      const captureProjectId =
        typeof args.projectId === "string" && args.projectId
          ? args.projectId
          : null;
      // Project NAME-ref (piece D): an agent may name a project instead of
      // knowing its UUID (`projectName`, or `project: { name }`). Resolved at the
      // submitCaptureGraph boundary via an EXACT slug match on the caller's OWN
      // projects — no match is NEVER auto-linked (widening-access law).
      const captureProjectName =
        typeof args.projectName === "string" && args.projectName
          ? args.projectName
          : args.project &&
              typeof args.project === "object" &&
              typeof (args.project as { name?: unknown }).name === "string"
            ? (args.project as { name: string }).name
            : null;

      // `global` is the pod-wide RUNBOOK lane — a keyed text doc, not entities.
      // Mixing it with a structured payload has no meaning; say so rather than
      // silently dropping one of the two.
      if (args.global === true && captureEntities.length > 0) {
        return ok({
          error:
            "global:true is the pod-wide runbook lane and takes `text` only. Send the runbook text on its own call, or drop `global` to capture entities[].",
        });
      }

      // ══ STRUCTURED / GRAPH BRANCH ═══════════════════════════════════════════
      // Reaches the SAME core `POST /api/hub/capture/graph` calls — the mature,
      // idempotent `submitCaptureGraph` (within-batch collapse → identity dedup →
      // one `import.graph` proposal). The adapter-side work is only the ref
      // validation the HTTP door does in its handler (the core documents that
      // callers MUST have validated refs) and the membership check
      // `resolveActingContext` performs there.
      //
      // `text` sent ALONGSIDE `entities[]` is not dropped: the structured payload
      // wins (it is the precise one) and the raw text rides along as `rawSource`
      // provenance on the proposal, where the reviewer can see it.
      if (captureEntities.length > 0) {
        // Refs must be unique, and every relation ref must name an entity in
        // this call — fail loud, exactly like the HTTP door: a dangling ref would
        // silently drop the link at materialization time.
        //
        // DRIFT vs the old `synap_capture_graph`: `ref` is now OPTIONAL. A single
        // structured entity should not have to invent a local id. Auto-assign is
        // DOOR-LOCAL (it runs before the shared uniqueness/dangling validation);
        // `explicitRefs` only guards the minted ids against collision (a
        // duplicate EXPLICIT ref is caught by `validateCaptureGraphRefs` below).
        const explicitRefs = new Set<string>();
        for (const e of captureEntities) {
          if (typeof e.ref === "string" && e.ref) explicitRefs.add(e.ref);
        }
        let autoRefSeq = 0;
        const graphEntities: Array<Record<string, unknown> & { ref: string }> =
          captureEntities.map((e) => {
            if (typeof e.ref === "string" && e.ref) return { ...e, ref: e.ref };
            let candidate = `e${autoRefSeq++}`;
            while (explicitRefs.has(candidate)) candidate = `e${autoRefSeq++}`;
            explicitRefs.add(candidate);
            return { ...e, ref: candidate };
          });
        for (const e of graphEntities) {
          if (typeof e.profileSlug !== "string" || !e.profileSlug) {
            return ok({
              error: `entity '${e.ref}' needs a \`profileSlug\` — discover slugs with synap_list_profiles`,
            });
          }
        }
        // Relation SHAPE (sourceRef/targetRef/type presence) stays door-local —
        // MCP-specific message with the field names the agent must supply.
        for (const r of captureRelations) {
          if (
            typeof r.sourceRef !== "string" ||
            typeof r.targetRef !== "string" ||
            typeof r.type !== "string" ||
            !r.type
          ) {
            return ok({
              error: "each relation needs `sourceRef`, `targetRef` and `type`",
            });
          }
        }
        // SHARED: ref-uniqueness + dangling-relation (the one door both surfaces
        // run). Rendered here with MCP's own wording (the extra "same call" hint).
        const refIssue = validateCaptureGraphRefs(
          graphEntities,
          captureRelations as Array<{ sourceRef: string; targetRef: string }>
        );
        if (refIssue) {
          return ok({
            error:
              refIssue.kind === "duplicate-ref"
                ? `duplicate entity ref: ${refIssue.ref}`
                : `relation references an unknown ref: ${refIssue.sourceRef} -> ${refIssue.targetRef}. Every ref must belong to an entity in the same call.`,
          });
        }

        // The RAW requested id, not the dropped-on-failure lens: a placement pin
        // must fail loud (Forbidden, below) rather than silently land pod-wide.
        const graphWsId = requestedWorkspaceId ?? null;
        const graphScope: CaptureScope = {
          workspaceId: graphWsId,
          projectId: captureProjectId,
          sessionId: sessionId ?? null,
        };

        // ── REJECT: no-durable-content ───────────────────────────────────────
        if (!graphEntities.some((e) => hasDurableEntity(e))) {
          return captureRejected({
            reason: "no-durable-content",
            scope: graphScope,
            message:
              "Nothing storable was sent — every entity was empty. Give each one at least a `title`, or `properties` (email / phone / website are strongest: they also dedup), or a `content` body, or an `existingEntityId` to link to.",
          });
        }

        // ── REJECT: already-known ────────────────────────────────────────────
        // Fires ONLY when the call would be a pure no-op: a SINGLE entity, no
        // relations, carrying nothing beyond its own identity signals, whose
        // strong signal (email/phone/website/handle/external-id — `extractIdentitySignals`
        // reads `website`, never a bare `url`) already resolves to
        // an existing entity. Anything richer is an ENRICHMENT or a LINK and is
        // let through — `submitCaptureGraph` reuses the existing row instead of
        // minting a duplicate, so there is nothing left to guard there.
        //
        // TITLE SIMILARITY NEVER REJECTS: no `name`/`userScope` is passed here,
        // so only the strong (globally-unique) path of the resolver runs.
        // Same-title-across-kinds stays advisory (crossKindCandidates, below).
        if (graphEntities.length === 1 && captureRelations.length === 0) {
          const only = graphEntities[0];
          const onlyProps =
            only.properties &&
            typeof only.properties === "object" &&
            !Array.isArray(only.properties)
              ? (only.properties as Record<string, unknown>)
              : {};
          const onlySignals = extractIdentitySignals(onlyProps);
          // `IdentitySignal.type` is a plain string upstream — index the
          // strong-signal key map through a widened view rather than casting the
          // signal type, so an unknown atom yields no keys instead of throwing.
          const signalKeyMap = IDENTITY_SIGNAL_PROPERTY_KEYS as Record<
            string,
            string[] | undefined
          >;
          const signalKeys = new Set(
            onlySignals.flatMap((s) => signalKeyMap[s.type] ?? [])
          );
          const carriesOnlyIdentity =
            !only.existingEntityId &&
            Object.keys(onlyProps).every((k) => signalKeys.has(k)) &&
            !hasDurableText(normalizeCaptureText(only.content)) &&
            !hasDurableText(normalizeCaptureText(only.description)) &&
            !(Array.isArray(only.facets) && only.facets.length > 0);
          if (onlySignals.length > 0 && carriesOnlyIdentity) {
            try {
              const known = await resolveIdentity(db, {
                userId,
                kindSlug: only.profileSlug as string,
                signals: onlySignals,
              });
              if (known.match === "strong" && known.entity) {
                // A BETTER TITLE is new information. The existing row may be
                // titled by its own signal ("ada@acme.com"); rejecting a call
                // that supplies "Ada Lovelace" would discard the improvement.
                const incomingTitle = normalizeCaptureText(only.title);
                const titleIsNew =
                  hasDurableText(incomingTitle) &&
                  incomingTitle !==
                    normalizeCaptureText(known.entity.title ?? "");
                if (!titleIsNew) {
                  // SECURITY: the STRONG path is deliberately pod-GLOBAL and
                  // unscoped (frozen policy: one subject per email/phone), so
                  // `known.entity` may belong to another user. Dedup still
                  // applies pod-wide, but the matched row's CONTENT must not
                  // leak — the same rule `buildIdentityResolveResponse` encodes.
                  // Probe visibility here; when invisible, reject WITHOUT the
                  // title/kind/id (no id ⇒ `ok()` emits no `/open/` link).
                  const visible = await db.query.entities.findFirst({
                    columns: { id: true },
                    where: and(
                      eq(entities.id, known.entity.id),
                      isNull(entities.deletedAt),
                      userVisibleWhere(entities.workspaceId, userId)
                    ),
                  });
                  if (!visible) {
                    return captureRejected({
                      reason: "already-known",
                      scope: graphScope,
                      message:
                        "An entity with this exact identity already exists in this pod and the call carried nothing new, so nothing was written. " +
                        "This is a correct outcome, not an error — do not retry it. To add information, send it here as content / extra properties / relations.",
                    });
                  }
                  return captureRejected({
                    reason: "already-known",
                    scope: graphScope,
                    message:
                      `A ${known.entity.type} with this exact identity already exists ("${known.entity.title ?? known.entity.id}") and the call carried nothing new, so nothing was written. ` +
                      "This is a correct outcome, not an error — do not retry it. To add information, either send it here as content / extra properties / relations (it will enrich the existing entity, not duplicate it) or call synap_update_entity on the id below.",
                    extra: {
                      entityId: known.entity.id,
                      existing: {
                        id: known.entity.id,
                        title: known.entity.title,
                        profileSlug: known.entity.type,
                      },
                    },
                  });
                }
              }
            } catch (err) {
              // Best-effort: a lookup failure must never block a write.
              logger.warn({ err }, "capture: already-known pre-check failed");
            }
          }
        }

        // ── ADVISORY (never a reject): Wave-0 crossKindCandidates ────────────
        // Same title under a DIFFERENT kind — §2.3's `links.proposed` slot. A
        // link SUGGESTION for the agent/reviewer, never an auto-merge.
        const crossKindLinks: Array<{
          ref: string;
          candidateId: string;
          title: string | null;
          profileSlug: string;
          reason: string;
        }> = [];
        if (graphEntities.length <= CAPTURE_CROSSKIND_PRECHECK_MAX) {
          const visibleScope = userVisibleWhere(entities.workspaceId, userId);
          for (const e of graphEntities) {
            if (e.existingEntityId) continue;
            const candidateTitle = normalizeCaptureText(e.title);
            if (!candidateTitle) continue;
            try {
              const res = await resolveIdentity(db, {
                userId,
                kindSlug: e.profileSlug as string,
                name: candidateTitle,
                signals: extractIdentitySignals(
                  e.properties as Record<string, unknown> | undefined
                ),
                userScope: visibleScope,
              });
              for (const cand of res.crossKindCandidates) {
                crossKindLinks.push({
                  ref: e.ref,
                  candidateId: cand.id,
                  title: cand.title,
                  profileSlug: cand.type,
                  reason: "same title across kinds",
                });
              }
            } catch (err) {
              logger.warn({ err }, "capture: cross-kind pre-check failed");
            }
          }
        }

        // Membership gate — the HTTP door does this via resolveActingContext.
        // Without it an MCP key could queue a proposal in a foreign lens. The
        // verdict was already computed once at the top of this function.
        if (graphWsId && !workspaceAccessible) {
          return ok({
            error: `Forbidden: no access to workspace ${graphWsId}`,
          });
        }
        const { submitCaptureGraph } =
          await import("../../services/capture-agent/submit-capture-graph.js");

        // AGENT-MODE routing (piece A): submitCaptureGraph derives the terminal
        // from identity + policy. We pass the acting `agentUserId` so the core
        // scores the graph against the ONE agent policy evaluator: when EVERY op
        // is auto-approvable it MATERIALIZES the graph now (a direct operator
        // write it builds itself, the same one the approve loop performs) and
        // records an `auto_approved` proposal; otherwise it files a pending one.
        const graphResult = await submitCaptureGraph({
          userId,
          ...(agentUserId ? { agentUserId } : {}),
          workspaceId: graphWsId,
          ...(captureProjectId ? { projectId: captureProjectId } : {}),
          ...(captureProjectName ? { projectName: captureProjectName } : {}),
          // Origin is the door, not a caller claim: an MCP caller is an agent.
          source: "agent",
          ...(sessionId ? { sessionId } : {}),
          // Shape-validated above (profileSlug present, refs unique and
          // resolvable) — the remaining fields are optional and pass straight
          // through to the same core the HTTP door feeds.
          entities: graphEntities as unknown as Parameters<
            typeof submitCaptureGraph
          >[0]["entities"],
          relations: captureRelations as unknown as Parameters<
            typeof submitCaptureGraph
          >[0]["relations"],
          ...(typeof args.summary === "string" && args.summary
            ? { summary: args.summary }
            : {}),
          // Provenance for a mixed text+entities payload (bounded by the core to
          // proposal data — reviewable, never silently discarded).
          ...(captureNormalizedText
            ? { rawSource: { rawText: captureRawText.slice(0, 8000) } }
            : {}),
        });
        // The terminal is policy-derived: `applied` (materialized now, whitelisted
        // graph) or `proposed` (pending review). `graphResult.writeReceipt`
        // already conforms to the uniform receipt (state applied|pending).
        return ok({
          status: graphResult.applied ? "applied" : "proposed",
          scope: graphScope,
          ...graphResult,
          ...(crossKindLinks.length
            ? { links: { proposed: crossKindLinks } }
            : {}),
          ...(captureNormalizedText
            ? {
                provenance:
                  "Both `text` and `entities[]` were sent: the structured payload was used, and the raw text is kept on the proposal as provenance for the reviewer.",
              }
            : {}),
        });
      }

      // ══ TEXT BRANCH ═════════════════════════════════════════════════════════
      const { captureRouter } = await import("../capture.js");
      // Resolve workspace: use the confined workspace (service-key clamp) or fall
      // back to user's first workspace. Feeds both the global-lane knowledge_keys
      // write and the captureCtx below, so a bound key never writes elsewhere.
      let captureWsId = requestedWorkspaceId;
      if (!captureWsId) {
        const wsIds = await getUserWorkspaceIds(userId);
        captureWsId = wsIds[0];
      }
      if (!captureWsId) {
        return ok({ error: "No accessible workspace found for this user" });
      }
      const textScope: CaptureScope = {
        workspaceId: captureWsId,
        projectId: captureProjectId,
        sessionId: sessionId ?? null,
      };
      // ── REJECT: no-durable-content ─────────────────────────────────────────
      // Also the "empty payload" branch: neither `text` nor `entities[]`.
      if (!hasDurableText(captureNormalizedText)) {
        return captureRejected({
          reason: "no-durable-content",
          scope: textScope,
          message:
            "Nothing storable was sent. Pass `text` with something worth remembering (a fact, a decision, a person, a task, a document body), or pass `entities[]` when you already know the kind and its fields.",
        });
      }
      // GLOBAL lane — mirror the CLI's `capture --global`: a pod-wide procedural
      // runbook goes to knowledge_keys (a keyed doc upsert), NOT the entity
      // structuring pipeline. This folds the former synap_write_knowledge tool
      // into capture so there is ONE write door; the lane is the routing signal.
      if (args.global === true) {
        const text = args.text as string;
        const key =
          (args.key as string | undefined) ||
          `note:${text
            .slice(0, 48)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")}`;
        const record = await knowledgeKeysRepository.upsert(key, {
          key,
          value: text,
          status: "active",
          workspaceId: captureWsId,
          author: userId,
        });
        const globalReceipt: CaptureWriteReceipt = {
          state: "applied",
          effectiveWorkspaceId: captureWsId,
          ...(captureProjectId ? { projectId: captureProjectId } : {}),
          source: "agent",
        };
        return ok({
          status: "applied",
          lane: "global",
          scope: textScope,
          writeReceipt: globalReceipt,
          knowledgeKey: record,
        });
      }
      const captureCtx = await createHubProtocolCallerContext(
        userId,
        apiKeyScopes,
        captureWsId,
        undefined,
        sessionId,
        agentUserId
      );
      const captureCaller = captureRouter.createCaller(
        captureCtx as Parameters<typeof captureRouter.createCaller>[0]
      );
      // Step 1 — structure the free text into entity proposals.
      const structured = await captureCaller.structure({
        text: args.text as string,
        context: args.profileSlug
          ? `Hint: profile is ${args.profileSlug}`
          : undefined,
        dedupMode: args.dedupMode as "title" | "semantic" | "both" | undefined,
      });
      // Step 2 — ACTUALLY WRITE. structure() only previews; without execute()
      // the capture tool returns proposals that are never materialized — the
      // "write door" wrote nothing. Mirror the CLI's smart-capture (structure →
      // execute). First-party capture writes DIRECTLY and records an
      // auto-approved, revertible proposal — it does NOT return 'proposed' /
      // wait for review. The materialized entities come back in the result.
      const captureProposals =
        (structured as { proposals?: unknown[] }).proposals ?? [];
      // DEGRADED GUARD: when the IS structurer is down, structure() returns a
      // single raw-note fallback with `degraded: true`. Do NOT silently execute
      // that note — it looks like a normal capture but is an outage artifact the
      // user doesn't want. Surface the degradation loudly and create nothing;
      // the caller tells the user the AI service is temporarily unavailable.
      if ((structured as { degraded?: boolean }).degraded === true) {
        const reason = (structured as { degradedReason?: string })
          .degradedReason;
        return captureRejected({
          reason: "structuring-unavailable",
          scope: textScope,
          message:
            "⚠️ AI structuring is temporarily unavailable, so nothing was created. " +
            "Tell the user their capture was NOT structured (the AI service is degraded) and to try again shortly — do not present this as a normal capture or save a raw note.",
          extra: {
            degraded: true,
            ...(reason ? { degradedReason: reason } : {}),
            executed: false,
          },
        });
      }
      if (captureProposals.length === 0) {
        return captureRejected({
          reason: "no-durable-content",
          scope: textScope,
          message:
            "The text was read but nothing durable could be extracted from it. Say what the thing IS (a person, a task, a decision, a note) — or send `entities[]` directly when you already know the kind.",
          extra: {
            ...structured,
            executed: false,
            note: "Nothing to capture.",
          },
        });
      }
      // Dedup → merge: when structure found a high-confidence SAME-PROFILE
      // duplicate, point the proposal at the existing entity so execute MERGES
      // into it (via existingEntityId) instead of creating a near-duplicate.
      // The same-profileSlug guard is load-bearing — the dedup search is
      // cross-profile (semantic), so without it a `person` could merge into a
      // `note`. ≥0.95 auto-merges; anything lower is left to create (the
      // candidates are still surfaced to the caller in `structured`).
      const dedup =
        (
          structured as {
            dedupCandidates?: Record<
              string,
              Array<{ entityId: string; profileSlug: string; score: number }>
            >;
          }
        ).dedupCandidates ?? {};
      const mergedProposals = (
        captureProposals as Array<{
          tempId: string;
          profileSlug: string;
          existingEntityId?: string;
        }>
      ).map((p) => {
        const top = dedup[p.tempId]?.[0];
        if (
          top &&
          top.score >= 0.95 &&
          top.profileSlug === p.profileSlug &&
          !p.existingEntityId
        ) {
          return { ...p, existingEntityId: top.entityId };
        }
        return p;
      });
      // Workspace routing is centralized in captureCaller.execute (see
      // resolveCaptureRouting): the adapter just forwards the AI's structure
      // hints + the caller's mode, so MCP routes identically to every other door.
      const executed = await captureCaller.execute({
        entities: mergedProposals as Parameters<
          typeof captureCaller.execute
        >[0]["entities"],
        relations:
          ((structured as { relations?: unknown[] }).relations as Parameters<
            typeof captureCaller.execute
          >[0]["relations"]) ?? [],
        workspaceRouting: args.workspaceRouting as
          "auto" | "ask" | "locked" | undefined,
        aiWorkspaceId: (structured as { targetWorkspaceId?: string | null })
          .targetWorkspaceId,
        aiWorkspaceConfidence: (
          structured as { targetWorkspaceConfidence?: number | null }
        ).targetWorkspaceConfidence,
        aiWorkspaceReason: (
          structured as { targetWorkspaceReason?: string | null }
        ).targetWorkspaceReason,
        // Explicit caller-provided projectId is a deliberate pin (rung 1) and
        // still auto-links. The AI's structure-RESOLVED target, however, must NOT
        // silently become an auto-link: `belongs_to_project` WIDENS cross-workspace
        // access, so the AI's guess rides the SAME propose/advisory lane as every
        // other surface — execute records it as a suggestion (chip), never links
        // it, unless a DETERMINISTIC rung (explicit / session / relational)
        // independently resolves the same project.
        ...(args.projectId ? { projectId: args.projectId as string } : {}),
        aiProjectId: (structured as { targetProjectId?: string | null })
          .targetProjectId,
        aiProjectConfidence: (
          structured as { targetProjectConfidence?: number | null }
        ).targetProjectConfidence,
        aiProjectReason: (structured as { targetProjectReason?: string | null })
          .targetProjectReason,
      });
      // execute() returns movedToWorkspace / pendingWorkspaceSwitch when routing
      // engaged — surface them at the top level for the caller.
      const ex = executed as {
        movedToWorkspace?: string;
        pendingWorkspaceSwitch?: unknown;
        project?: {
          projectId: string;
          rung: number | null;
          status: "linked" | "proposed";
        };
      };
      // The scope echo must be what the write ACTUALLY landed in: routing may
      // have moved it (movedToWorkspace), and a project only counts when it was
      // LINKED — a `proposed` project is an unconfirmed suggestion, not placement.
      const landedWsId = ex.movedToWorkspace ?? captureWsId;
      const landedProjectId =
        ex.project?.status === "linked"
          ? ex.project.projectId
          : captureProjectId;
      const textReceipt: CaptureWriteReceipt = {
        state: "applied",
        effectiveWorkspaceId: landedWsId,
        ...(landedProjectId ? { projectId: landedProjectId } : {}),
        source: "agent",
      };
      return ok({
        // First-party capture writes DIRECTLY (auto-approved + revertible), so
        // the uniform status here is "applied", never "proposed".
        status: "applied",
        scope: {
          workspaceId: landedWsId,
          projectId: landedProjectId,
          sessionId: sessionId ?? null,
        },
        writeReceipt: textReceipt,
        structured,
        executed,
        ...(ex.movedToWorkspace
          ? { movedToWorkspace: ex.movedToWorkspace }
          : {}),
        ...(ex.pendingWorkspaceSwitch
          ? { pendingWorkspaceSwitch: ex.pendingWorkspaceSwitch }
          : {}),
        // State what happened on the project axis: linked-by-context (which rung)
        // vs proposed (AI suggestion awaiting confirmation) vs nothing (omitted).
        ...(ex.project
          ? {
              project: ex.project,
              projectDisposition:
                ex.project.status === "linked"
                  ? `linked by context (rung ${ex.project.rung})`
                  : "proposed (AI suggestion — confirm to file)",
            }
          : {}),
      });
    }

    // ── Workspace & view creation ─────────────────────────────────────────────
    // GOVERNED: workspace invent is a durable surface — agents always propose
    // (workspace.create ∉ DEFAULT_AUTO_APPROVE). Operators (no agentUserId) are
    // the authority and grant inline. On propose, the full definition rides in
    // gate `data` so the workspace/create executor can materialize on approval.
    case "synap_create_workspace": {
      requireScope(apiKeyScopes, "mcp.write", toolName);
      const name = args.name as string | undefined;
      if (typeof name !== "string" || name.trim() === "") {
        return ok({ error: "name is required" });
      }
      const definition = (args.definition ?? {}) as object;
      const idempotencyKey = args.proposalId as string | undefined;
      const { checkPermissionOrPropose } =
        await import("../../utils/permission-check.js");
      const perm = await checkPermissionOrPropose({
        userId,
        agentUserId: agentUserId ?? undefined,
        subjectType: "workspace",
        action: "create",
        source: "api",
        data: {
          name,
          definition,
          workspaceName: name,
          proposalId: idempotencyKey,
          createdBy: "provisioning",
          source: "mcp.synap_create_workspace",
        },
      });
      if ("denied" in perm && perm.denied) {
        return ok({ error: perm.reason, denied: true });
      }
      if (
        "proposalId" in perm &&
        perm.proposalId &&
        !("granted" in perm && perm.granted)
      ) {
        return ok({
          status: "proposed",
          message:
            "Workspace creation proposed for review (workspace invent is governed) — it materializes on approval.",
          proposalId: perm.proposalId,
          summary: perm.summary,
          reviewPath: perm.reviewPath,
          reviewUrl: perm.reviewUrl,
          ...(perm.deduped ? { deduped: true } : {}),
        });
      }
      // Granted (operator authority) → same materialize door as approve
      // (deps/compose aware). Do NOT use createWorkspaceFromDefinitionIdempotent
      // alone — it diverges from packages.apply / workspace/create approve.
      const { materializeWorkspaceCore } =
        await import("../../services/workspace-materialization-service.js");
      const core = await materializeWorkspaceCore({
        definition: definition as Parameters<
          typeof materializeWorkspaceCore
        >[0]["definition"],
        userId,
        agentUserId: agentUserId ?? undefined,
        proposalId: idempotencyKey,
        workspaceName: name,
        createdBy: "provisioning",
      });
      if (core.status === "resolved") {
        return ok({
          error:
            "Workspace materialize returned resolved-without-create (unexpected)",
        });
      }
      return ok({
        status: "created",
        workspaceId: core.workspaceId,
        materializeStatus: core.status,
        created: core.status === "created",
      });
    }

    // Agnostic edge-declaration door (Enterprise-OS Wave 0). Set/merge the two
    // workspace-EDGE fields — `sourceRoles` (domain → provider|consumer|
    // provider-consumer) + `defaultSources` (domain → source workspace) — on an
    // EXISTING workspace, so an agent can DECLARE an edge (e.g. "Marketing
    // consumes Comms") without touching template authoring or the tRPC UI door.
    // Tightly scoped: ONLY these two edge fields are agent-writable here — no
    // other settings key (aiGovernance/visibility/…) is reachable. MERGES
    // per-domain via the canonical mergeSettings path — never clobbers.
    case "synap_declare_workspace_source": {
      requireScope(apiKeyScopes, "mcp.write", toolName);
      const workspaceId = args.workspaceId as string | undefined;
      if (typeof workspaceId !== "string" || workspaceId.trim() === "") {
        return ok({ error: "workspaceId is required" });
      }
      const { WorkspaceSourceEdgeInputSchema, mergeWorkspaceSourceEdges } =
        await import("../../services/workspace-edge-service.js");
      const parsed = WorkspaceSourceEdgeInputSchema.safeParse({
        sourceRoles: args.sourceRoles,
        defaultSources: args.defaultSources,
      });
      if (!parsed.success) {
        return ok({
          error: "Invalid edge fields",
          details: parsed.error.issues,
        });
      }
      if (!parsed.data.sourceRoles && !parsed.data.defaultSources) {
        return ok({
          error: "Provide at least one of: sourceRoles, defaultSources",
        });
      }
      // GOVERNED write (Enterprise-OS Wave 0): declaring a data edge rewires
      // pod-wide cross-workspace read routing, so it goes through the review
      // membrane, not immediate apply. `checkPermissionOrPropose` runs the
      // canonical RBAC floor (action `declare_source` → "write" permission =
      // the same editor+ floor `assertWorkspaceWrite` enforced) and then the
      // agent-governance ladder: an agent-remapped key routes to a PROPOSAL
      // (declare_source is not auto-approved), while a plain operator (no
      // agentUserId, source "api") is the authority and is GRANTED. On grant we
      // apply immediately via `mergeWorkspaceSourceEdges` (byte-identical to the
      // pre-governance path); the proposed branch returns the proposal and does
      // NOT apply — the `workspace/declare_source` executor materializes it on
      // approval.
      const { checkPermissionOrPropose } =
        await import("../../utils/permission-check.js");
      const perm = await checkPermissionOrPropose({
        userId,
        agentUserId: agentUserId ?? undefined,
        workspaceId,
        subjectType: "workspace",
        action: "declare_source",
        source: "api",
        data: {
          sourceRoles: parsed.data.sourceRoles,
          defaultSources: parsed.data.defaultSources,
        },
      });
      if ("denied" in perm && perm.denied) {
        return ok({ error: perm.reason });
      }
      if ("proposalId" in perm) {
        return ok({
          status: "proposed",
          message:
            "Workspace edge declaration proposed for review (rewiring cross-workspace reads is governed) — it applies on approval.",
          proposalId: perm.proposalId,
          summary: perm.summary,
          reviewPath: perm.reviewPath,
          reviewUrl: perm.reviewUrl,
          workspaceId,
          ...(perm.deduped ? { deduped: true } : {}),
        });
      }
      // Granted (operator authority) → apply immediately. Attribute on the same
      // acting identity (agent when remapped, else operator).
      const actingUserId = agentUserId ?? userId;
      const result = await mergeWorkspaceSourceEdges(
        workspaceId,
        parsed.data,
        actingUserId
      );
      return ok({ status: "updated", workspaceId, ...result });
    }

    case "synap_create_project": {
      requireScope(apiKeyScopes, "mcp.write", toolName);
      if (typeof args.name !== "string" || args.name.trim() === "") {
        return ok({ error: "name is required" });
      }
      // Resolve the HOME workspace: use the confined workspace (service-key
      // clamp) or fall back to the user's first workspace (same fallback
      // synap_capture uses).
      let projectWsId = requestedWorkspaceId;
      if (!projectWsId) {
        const wsIds = await getUserWorkspaceIds(userId);
        projectWsId = wsIds[0];
      }
      if (!projectWsId) {
        return ok({ error: "No accessible workspace found for this user" });
      }
      const projectCtx = await createHubProtocolCallerContext(
        userId,
        apiKeyScopes,
        projectWsId,
        undefined,
        sessionId,
        agentUserId
      );
      const projectCaller = projectsRouter.createCaller(projectCtx);
      const result = await projectCaller.create({
        name: args.name as string,
        description: args.description as string | undefined,
        // Provenance: this create came through the MCP door.
        door: "mcp",
        // Gravity evidence — the tRPC create enforces ≥5 caller-visible ids for
        // agent callers (projectCtx carries the agent identity).
        evidenceEntityIds: Array.isArray(args.evidenceEntityIds)
          ? (args.evidenceEntityIds as string[])
          : undefined,
      });
      return ok(result);
    }

    case "synap_create_playbook": {
      requireScope(apiKeyScopes, "mcp.write", toolName);
      if (typeof args.name !== "string" || args.name.trim() === "") {
        return ok({ error: "name is required" });
      }
      if (
        typeof args.goalTemplate !== "string" ||
        args.goalTemplate.trim() === ""
      ) {
        return ok({ error: "goalTemplate is required" });
      }
      // Confined workspace (service-key clamp) before the first-ws fallback.
      let pbWsId = requestedWorkspaceId;
      if (!pbWsId) {
        const wsIds = await getUserWorkspaceIds(userId);
        pbWsId = wsIds[0];
      }
      if (!pbWsId) {
        return ok({ error: "No accessible workspace found for this user" });
      }
      const pbCtx = await createHubProtocolCallerContext(
        userId,
        apiKeyScopes,
        pbWsId,
        undefined,
        sessionId,
        agentUserId
      );
      const pbCaller = playbooksRouter.createCaller(pbCtx);
      const result = await pbCaller.create({
        name: args.name as string,
        goalTemplate: args.goalTemplate as string,
        description: args.description as string | undefined,
        stages: args.stages as Record<string, unknown>[] | undefined,
        // Default to `active` so a created template is immediately runnable via
        // synap_start_session(templateId) — a draft would be invisible to run.
        status:
          (args.status as
            "draft" | "active" | "paused" | "archived" | undefined) ?? "active",
        agentUserId,
      });
      return ok(result);
    }

    case "synap_create_view": {
      requireScope(apiKeyScopes, "mcp.write", toolName);
      const result = await caller.views.createView({
        userId,
        // Confined workspace (service-key clamp) — not the raw model-supplied id.
        workspaceId: requestedWorkspaceId as string,
        name: args.name as string,
        type: args.type as string,
        profileId: args.profileId as string | undefined,
        config: args.config as Record<string, unknown> | undefined,
        ...(agentUserId ? { agentUserId } : {}),
      });
      return ok(result);
    }

    // ── Channel & messaging ───────────────────────────────────────────────────
    case "synap_get_channel": {
      requireScope(apiKeyScopes, "mcp.read", toolName);
      const mode = args.mode as string;
      const wsId = args.workspaceId as string;
      if (mode === "personal") {
        const result = await caller.channels.ensurePersonal({
          userId,
          workspaceId: wsId,
        });
        return ok(result);
      }
      if (!args.contextObjectType || !args.contextObjectId) {
        return ok({
          error:
            "contextObjectType and contextObjectId are required for mode 'by-context'",
        });
      }
      const result = await caller.channels.resolveOrCreateChannel({
        userId,
        workspaceId: wsId,
        channelType: "thread" as const,
        contextObjectType: args.contextObjectType as "entity" | "document",
        contextObjectId: args.contextObjectId as string,
      });
      return ok(result);
    }

    case "synap_post_message": {
      requireScope(apiKeyScopes, "mcp.write", toolName);
      const { postChannelMessage } =
        await import("../../services/messaging/post-message.js");
      const result = await postChannelMessage({
        channelId: args.channelId as string,
        content: args.content as string,
        role: args.role as string | undefined,
        triggerAI: Boolean(args.triggerAI),
        userId,
      });
      return ok(result);
    }

    // ── Proposals & knowledge ─────────────────────────────────────────────────
    case "synap_revise_proposal": {
      requireScope(apiKeyScopes, "mcp.write", toolName);
      const proposalId = args.proposalId as string;
      if (args.summary === undefined && args.reasoning === undefined) {
        return ok({ error: "Provide at least one of: summary, reasoning" });
      }
      const { reviseProposal } =
        await import("../../services/proposals/proposals-service.js");
      await reviseProposal({
        proposalId,
        summary: args.summary as string | undefined,
        reasoning: args.reasoning as string | undefined,
        actorId: userId,
      });
      return ok({ success: true, proposalId });
    }

    // (synap_write_knowledge folded into synap_capture's `global` lane — one
    // write door. A pod-wide runbook is `capture` with global:true.)

    // ── Capabilities (connected-service verbs) ─────────────────────────────────
    case "synap_list_capabilities": {
      requireScope(apiKeyScopes, "mcp.read", toolName);
      const wsId = args.workspaceId as string;
      const query =
        typeof args.query === "string" && args.query.trim().length > 0
          ? args.query
          : undefined;
      const kind = typeof args.kind === "string" ? args.kind : undefined;
      const limit = typeof args.limit === "number" ? args.limit : undefined;
      const { listCapabilities } =
        await import("../../services/capabilities/capability-registry.js");
      const { projectRunnableActions } =
        await import("../../services/capabilities/action-projection.js");
      const capabilities = await listCapabilities(
        { workspaceId: wsId, userId },
        query || kind || limit !== undefined
          ? {
              query,
              kind: kind as never,
              limit,
            }
          : undefined
      );

      // MCP and Hub REST intentionally share this projection: never expose a
      // catalog-only, draft, or disconnected action as executable on one
      // surface while hiding it on the other.
      const runnable = projectRunnableActions(capabilities);

      // Response size discipline: with a query, drop the full verb catalog dump
      // (grant/govDefault noise) — the compact projection carries name/kind/
      // description/governance + a slim verb list, `runnable` above already
      // carries the paramsSchema for anything actually callable.
      const responseCapabilities = query
        ? capabilities.map((cap) => ({
            kind: cap.kind,
            id: cap.id,
            name: cap.name,
            governance: cap.governance,
            ...(cap.connection ? { connection: cap.connection } : {}),
            verbs: cap.verbs?.map((v) => ({ id: v.id, label: v.label })),
          }))
        : capabilities;

      return ok({ capabilities: responseCapabilities, runnable });
    }

    case "synap_run_capability": {
      requireScope(apiKeyScopes, "mcp.write", toolName);
      // Confined workspace (service-key clamp) — not the raw model-supplied id.
      const wsId = requestedWorkspaceId as string;
      const { executeCapability } =
        await import("../../services/capabilities/execute-capability.js");
      const outcome = await executeCapability({
        verbId: args.verbId as string | undefined,
        skillId: args.skillId as string | undefined,
        parameters: args.parameters as Record<string, unknown> | undefined,
        workspaceId: wsId,
        userId,
        // Thread the acting agent (set on agent-key remap) so an agent WRITE verb
        // is governed by grant/propose — consistent with every other write proc
        // in this adapter. Omitting it laundered agent writes into operator runs.
        agentUserId: agentUserId ?? null,
      });
      // Surface the same discriminated outcome the hub door returns, in a shape
      // the agent reads naturally (proposed is NOT an error).
      return ok(outcome);
    }

    case "synap_create_verb": {
      requireScope(apiKeyScopes, "mcp.write", toolName);

      // Hard constraints 1 (declarative-only) + 2's field shape are enforced
      // in a pure, unit-tested helper — see validate-create-verb.test.ts.
      const validated = validateCreateVerbInput(args);
      if (!validated.ok) {
        return ok({ error: validated.error });
      }
      const input = validated.data;

      // Hard constraint 2: toolName must ALREADY be installed/credentialed for
      // the caller (pod-wide, or the given workspace) — this door only ADDS a
      // verb to an existing tool. It never creates a tool/connection as a
      // side effect.
      const wsLens = input.workspaceId
        ? or(
            isNull(toolsTable.workspaceId),
            eq(toolsTable.workspaceId, input.workspaceId)
          )
        : isNull(toolsTable.workspaceId);
      const [existingTool] = await db
        .select({ id: toolsTable.id, name: toolsTable.name })
        .from(toolsTable)
        .where(
          and(
            eq(toolsTable.name, input.toolName),
            wsLens,
            userVisibleWhere(toolsTable.workspaceId, userId)
          )
        )
        .limit(1);
      if (!existingTool) {
        return ok({
          error:
            `Tool '${input.toolName}' is not installed` +
            `${input.workspaceId ? ` for workspace ${input.workspaceId}` : ""}. ` +
            `synap_create_verb only adds a verb to an ALREADY-installed, credentialed tool — ` +
            `install/connect '${input.toolName}' first, or check the exact name via synap_list_capabilities.`,
        });
      }

      // Hard constraint 4: reuse the canonical ProviderVerbSpec shape
      // verbatim (@synap/database schema/skills.ts) — no invented field names.
      const providerSpec: ProviderVerbSpec = {
        tool: input.toolName,
        method: input.method,
        pathTemplate: input.pathTemplate,
        ...(input.query ? { query: input.query } : {}),
        ...(input.body ? { body: input.body } : {}),
        ...(input.responseShape ? { responseShape: input.responseShape } : {}),
      };

      // Hard constraint 3: reuse the SAME governed door POST /skills uses
      // (skillsRouter.create) — checkPermissionOrPropose runs INSIDE it. No
      // bypass flag, no direct db.insert here.
      const skillsCtx = await createHubProtocolCallerContext(
        userId,
        apiKeyScopes,
        input.workspaceId ?? null,
        undefined,
        sessionId,
        agentUserId ?? null
      );
      const skillsCaller = regularSkillsRouter.createCaller(skillsCtx as never);
      const result = await skillsCaller.create({
        workspaceId: input.workspaceId,
        kind: "declarative",
        scope: input.workspaceId ? "workspace" : "pod",
        name: input.verbName,
        description: input.description,
        providerSpec: providerSpec as unknown as Record<string, unknown>,
        parameters: input.parameters,
        // Fixed alongside this tool: skills.create's own checkPermissionOrPropose
        // call was missing agentUserId entirely (no input field for it existed),
        // so an agent-initiated create was evaluated as if the human owner did
        // it directly. Now threaded through, mirroring entities.ts's pattern.
        agentUserId: agentUserId ?? undefined,
      });

      return ok(result);
    }

    default:
      throw new Error(
        `Unknown MCP tool: ${toolName}. Call synap_load_skill("catalog") for skills or synap_list_capabilities({query}) to find capabilities.`
      );
  }
}

/**
 * Read MCP resource by calling Hub Protocol API
 */
export async function readMCPResourceViaHubProtocol(
  uri: string,
  userId: string,
  apiKeyScopes: string[]
): Promise<{
  contents: Array<{ uri: string; mimeType: string; text?: string }>;
}> {
  if (!apiKeyScopes.includes("mcp.read")) {
    throw new Error("Insufficient permissions: mcp.read required");
  }

  const caller = await createHubProtocolCaller(userId, apiKeyScopes);

  const match = uri.match(/^synap:\/\/(\w+)(?:\/(.+))?$/);
  if (!match) throw new Error(`Invalid resource URI: ${uri}`);

  const [, resourceType, resourcePath] = match;

  if (resourceType === "entities") {
    const parts = resourcePath?.split("/") || [];
    const entityType = parts[0]?.replace(/s$/, "");
    const entityId = parts[1];

    if (entityId) {
      const all = await caller.entities.getEntities({ userId, limit: 1 });
      const entity = all.find((e: { id: string }) => e.id === entityId);
      if (!entity) throw new Error(`Entity not found: ${uri}`);
      return {
        contents: [
          { uri, mimeType: "application/json", text: JSON.stringify(entity) },
        ],
      };
    }

    const entities = await caller.entities.getEntities({
      userId,
      profileSlug: entityType || undefined,
      limit: 100,
    });
    return {
      contents: [
        { uri, mimeType: "application/json", text: JSON.stringify(entities) },
      ],
    };
  }

  if (resourceType === "threads") {
    const parts = resourcePath?.split("/") || [];
    const threadId = parts[0];
    if (!threadId)
      throw new Error("Thread ID required: synap://threads/{id}/context");
    const context = await caller.context.getThreadContext({ threadId });
    return {
      contents: [
        { uri, mimeType: "application/json", text: JSON.stringify(context) },
      ],
    };
  }

  throw new Error(`Unknown resource type: ${resourceType}`);
}
