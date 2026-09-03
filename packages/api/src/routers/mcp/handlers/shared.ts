/**
 * MCP tool handlers — shared helpers.
 *
 * Split out of `adapter.ts` (router-decomposition Wave 7): the shared
 * building blocks every domain handler file (`read.ts`, `entity.ts`,
 * `capture.ts`, `capability.ts`, `workspace.ts`, `session.ts`, `build.ts`)
 * imports from — the hub-protocol caller factory, the `ok`/`requireScope`
 * response shapers, focus-session handle resolution, and the capture-door
 * precheck helpers. Content is byte-identical to the original
 * `adapter.ts` lines 86-721 — only `export` was added where a helper
 * crossed a new file boundary, plus the new `McpToolContext` /
 * `McpToolHandler` / `McpHandlerMap` types the dispatch-map refactor needs.
 */

export type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { hubProtocolRouter } from "../../hub-protocol/index.js";
import { resolveConfinedWorkspace } from "../../hub-protocol/confine-workspace.js";
import {
  getObjectGraph,
  type GraphNeighbor,
  type GraphEnvelope,
} from "../../../services/object-graph/graph-service.js";
import { entityDataNeighbors } from "../../../services/object-graph/entity-data-graph.js";
import type { LinkEndpointType } from "@synap/playbooks";
import { getDb } from "@synap/database";
import {
  db,
  entities,
  focusSessions,
  eq,
  and,
  isNull,
  desc,
  inArray,
  PropertyValueType,
} from "@synap/database";
import {
  logger,
  getUserMemberWorkspaceIds,
} from "../../hub-protocol/rest/_shared.js";
import { listMemberWorkspaces } from "../../../utils/workspace-membership.js";
import { openLink } from "../../../utils/deep-links.js";
import type { Context } from "../../../types/context.js";

// ── tRPC caller factory ───────────────────────────────────────────────────────

export async function createHubProtocolCaller(
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
): Promise<ReturnType<typeof hubProtocolRouter.createCaller>> {
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
 *   proposalId → id → entityId → wrapped view.id → documentId → viewId →
 *   channelId → sessionId → knowledgeKey.id → nested data.id → wrapped
 *   channel.id / document.id
 * First string hit wins; returns undefined when none is present.
 * `view` is unwrapped before `documentId` so views.create { view, documentId }
 * (canvas) links to the view, not the backing document.
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
    "viewId",
    "channelId",
    "sessionId",
  ] as const;
  for (const key of keys) {
    const v = d[key];
    if (typeof v === "string" && v) return v;
  }
  const createdView = d.view as Record<string, unknown> | undefined;
  if (
    createdView &&
    typeof createdView === "object" &&
    typeof createdView.id === "string" &&
    createdView.id
  ) {
    return createdView.id;
  }
  const documentId = d.documentId;
  if (typeof documentId === "string" && documentId) return documentId;
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
  // { document: { id } }. views.create is handled above (before documentId).
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

export function ok(data: unknown): CallToolResult {
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

/**
 * ADVISORY WORKSPACE FOCUS precedence (WORKSPACE-PLACEMENT-AGENT-FOCUS-PLAN.md,
 * Layer 2) — pulled out as a pure function so the priority rule is unit-testable
 * without a database: explicit-per-call / service-key pin (`confinedWorkspaceId`)
 * ALWAYS wins; the agent's live focus is consulted ONLY when that resolved to
 * nothing. Never a 403 — a stale focus is just another lens candidate the
 * caller's `verifyWorkspaceAccess` check may still drop.
 */
export function pickAdvisoryWorkspaceId(
  confinedWorkspaceId: string | undefined,
  agentFocusWorkspaceId: string | null | undefined
): string | undefined {
  return confinedWorkspaceId ?? agentFocusWorkspaceId ?? undefined;
}

export interface EntityWorkspaceResolution {
  workspaceId: string | undefined;
  /** True when no entity workspace could be resolved and we fell back to an
   * arbitrary member workspace — the caller MUST disclose this, not just use it. */
  autoPicked: boolean;
  /** Member-workspace count at the moment of the fallback pick (0 when autoPicked is false). */
  memberCount: number;
}

/**
 * Resolve the workspace lens for a tool call that names an entity but was
 * given no explicit `workspaceId`: the entity's OWN workspace is the right
 * lens (not an arbitrary member workspace), so a "no results" answer
 * reflects the entity's real home instead of whichever workspace happened to
 * sort first. Falls back to the first member workspace — and says so via
 * `autoPicked`/`memberCount` — only when the entity's workspace can't be
 * resolved (missing entityId, deleted, pod-global/no workspaceId, or not
 * visible to this caller). Extracted from `synap_get_relations` (Wave: third
 * arbitrary-workspace-pick fix) so `synap_match_playbooks` shares the same
 * floor instead of re-deriving it.
 */
export async function resolveEntityWorkspaceId(
  userId: string,
  entityId: string | undefined
): Promise<EntityWorkspaceResolution> {
  if (entityId) {
    const entityRow = await db.query.entities.findFirst({
      columns: { workspaceId: true },
      where: and(eq(entities.id, entityId), isNull(entities.deletedAt)),
    });
    if (entityRow?.workspaceId) {
      return {
        workspaceId: entityRow.workspaceId,
        autoPicked: false,
        memberCount: 0,
      };
    }
  }
  const ids = await getUserMemberWorkspaceIds(userId);
  return { workspaceId: ids[0], autoPicked: true, memberCount: ids.length };
}

export function requireScope(
  scopes: string[],
  scope: string,
  toolName: string
): void {
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
export async function buildGraphEnvelope(
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
 * READ-ONLY tools that skip focus-session resolution — the INVERSE of the
 * allow-list this used to be.
 *
 * Resolving a handle costs a DB round-trip, so a tool that could never use one
 * (every read door: get/list/ask/orient/diagnose) still must not pay for it.
 * But an ALLOW-list fails CLOSED against itself: it has to be extended by hand
 * for every new governed write door, and it wasn't — `synap_create_workspace`,
 * `synap_create_skill`, `synap_create_automation`, `synap_run_capability`,
 * `synap_post_message`, `synap_create_cell`, `synap_define_role`,
 * `synap_trigger_automation` and others all wrote `sessionId: undefined` even
 * with an open session, so their proposals carried no session provenance.
 *
 * Inverted, the default is "a write belongs to the session that produced it"
 * and a NEW write door is attributed automatically. The failure mode of a miss
 * flips from "silently loses provenance" to "one extra indexed SELECT on a
 * read" — and a read that resolves a handle is harmless: it is only ever passed
 * to the hub caller as a grouping hint.
 *
 * A prefix rule covers the bulk (`synap_get_*` / `synap_list_*`); the rest are
 * named. Ownership is still enforced downstream (`ownsFocusSession`), so this
 * list is a performance boundary, never an authorization one.
 */
export const READ_ONLY_TOOL_PREFIXES = ["synap_get_", "synap_list_"] as const;

export const READ_ONLY_TOOLS = new Set([
  "synap_ask",
  "synap_orient",
  "synap_diagnose",
  "synap_load_skill",
  "synap_match_playbooks",
  "synap_resolve_identity",
  "synap_template_health",
]);

/** True when the tool only reads — no write to group under a session. */
export function isReadOnlyTool(toolName: string): boolean {
  return (
    READ_ONLY_TOOLS.has(toolName) ||
    READ_ONLY_TOOL_PREFIXES.some((p) => toolName.startsWith(p))
  );
}

/** Non-terminal statuses — a session still "in flight" for its owner. */
export const OPEN_SESSION_STATUSES = [
  "active",
  "paused",
  "forming",
  "scheduled",
] as const;

/**
 * Every `focus_sessions.status` value (mirrors the schema's column enum). Used
 * to validate the model-supplied `status` filter — see synap_list_sessions.
 */
export const SESSION_STATUSES = [
  ...OPEN_SESSION_STATUSES,
  "closed",
  "failed",
  "cancelled",
  // Added by the focus-session reaper (a long-idle `running` session is marked
  // stale rather than deleted). Must be listable, or list_sessions({status:
  // "stale"}) rejects a status the schema legitimately produces.
  "stale",
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
/**
 * Ambient open sessions for a user (newest first). Used for single-session
 * attach and multi-session ambiguity guardrails.
 */
export async function listOpenFocusSessions(
  userId: string,
  limit = 5
): Promise<Array<{ id: string; goal: string | null; startedAt: Date | null }>> {
  try {
    return await db
      .select({
        id: focusSessions.id,
        goal: focusSessions.goal,
        startedAt: focusSessions.startedAt,
      })
      .from(focusSessions)
      .where(
        and(
          eq(focusSessions.userId, userId),
          inArray(focusSessions.status, [...OPEN_SESSION_STATUSES])
        )
      )
      .orderBy(desc(focusSessions.startedAt))
      .limit(limit);
  } catch (err) {
    logger.warn({ err, userId }, "mcp: list open focus sessions failed");
    return [];
  }
}

/**
 * How `ctx.sessionId` was arrived at — carried so a GUESS can announce itself.
 *
 * There was a third rung, `"url"` (the MCP URL's `?sessionId=`). It is gone:
 * nothing in the monorepo ever set that query param (server URLs are registered
 * once per client), so it was permanently `undefined` while threading a
 * parameter through four files — and MCP's SEP-2567 points at tool ARGUMENTS,
 * not transport-adjacent state, for exactly this job.
 */
export type SessionAttribution = "explicit" | "derived";

export interface ResolvedSession {
  sessionId: string;
  attribution: SessionAttribution;
  /**
   * More than one session was open and the newest was chosen. Only ever set on
   * `derived` — an explicit id is never a guess.
   */
  ambiguous?: boolean;
  /** Open-session count at resolution time; present only when `ambiguous`. */
  openCount?: number;
}

/**
 * The user's most recently STARTED open session.
 *
 * This used to REFUSE whenever more than one session was open, on the reasoning
 * that mis-grouping a write is worse than not grouping it. Measurement said
 * otherwise: the refusal is unrecoverable (the write lands with no session and
 * nothing can ever reattach it), while a wrong guess is visible and repairable.
 * In practice the refusal was the 100% case — two abandoned verification
 * sessions latched ambient attach off pod-wide — and the mis-grouping it
 * protected against stayed hypothetical.
 *
 * So it now picks the newest and SAYS SO (`ambiguous`), which the caller
 * surfaces. A hint that is usually right and discloses itself beats a hint that
 * is absent every time; the explicit `sessionId` arg on the write doors is the
 * override when the guess is wrong.
 */
export async function resolveAmbientSession(
  userId: string
): Promise<
  { sessionId: string; ambiguous: boolean; openCount: number } | undefined
> {
  // Fetch >2 so `openCount` is informative rather than clamped at the old
  // "is there more than one" boundary.
  const open = await listOpenFocusSessions(userId, 10);
  const newest = open[0]?.id;
  if (!newest) return undefined;
  const ambiguous = open.length > 1;
  if (ambiguous) {
    logger.info(
      {
        userId,
        openCount: open.length,
        chosenSessionId: newest,
        sessionIds: open.map((s) => s.id),
      },
      "mcp: multiple open focus sessions — attributing to the most recently started; pass sessionId to override"
    );
  }
  return { sessionId: newest, ambiguous, openCount: open.length };
}

/**
 * Resolve the focus-session handle for THIS tool call.
 *
 * Precedence: explicit `args.sessionId` > derived (most recent open session).
 * The explicit id is ownership-checked before it becomes `ctx.sessionId`; a
 * handle that isn't the caller's is dropped rather than rejected — it is a
 * grouping hint, and failing the whole tool call over it would be a worse
 * outcome than losing the grouping.
 */
export async function resolveSessionHandle(
  toolName: string,
  args: Record<string, unknown>,
  userId: string
): Promise<ResolvedSession | undefined> {
  if (isReadOnlyTool(toolName)) return undefined;
  // Normalize: sessionId flows to a `uuid` DB column, so a non-string arg is
  // dropped here rather than `as`-cast blindly. (Malformed UUID *strings* are
  // still rejected downstream by the mutation inputs' zod `.uuid()` schemas.)
  const explicit =
    typeof args.sessionId === "string" && args.sessionId.trim() !== ""
      ? args.sessionId
      : undefined;
  if (explicit) {
    if (await ownsFocusSession(userId, explicit)) {
      return { sessionId: explicit, attribution: "explicit" };
    }
    logger.warn(
      {
        userId,
        sessionId: explicit,
        toolName,
        source: "arg",
      },
      "mcp: focus-session handle does not belong to the caller — ignoring"
    );
    return undefined;
  }
  const ambient = await resolveAmbientSession(userId);
  if (!ambient) return undefined;
  return {
    sessionId: ambient.sessionId,
    attribution: "derived",
    ...(ambient.ambiguous
      ? { ambiguous: true, openCount: ambient.openCount }
      : {}),
  };
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
export interface CaptureScope {
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
export interface CaptureWriteReceipt {
  state: "applied" | "rejected";
  effectiveWorkspaceId: string | null;
  projectId?: string;
  /**
   * Per-requested-coordinate PROJECT outcome — intent measured against what
   * ACTUALLY happened, so a dropped pin is never silent (the false-success bug).
   * `linked` = a deterministic rung stamped `belongs_to_project`; `not_linked` =
   * a coordinate the caller requested that did NOT happen (with a `reason`, e.g.
   * `project-not-found` for a pin to a project this user can't see, or
   * `inferred-not-pinned` for an unconfirmed AI guess); `proposed` = an AI
   * suggestion awaiting confirmation. Omitted only when no project was requested.
   */
  project?: {
    status: "linked" | "not_linked" | "proposed";
    projectId?: string;
    rung?: number | null;
    reason?: string;
  };
  source: string;
}

/**
 * Reject reasons the door emits. §2.3's fourth reason, `recall-loop`
 * (re-ingesting content the pod itself just served), is deliberately NOT built —
 * it needs per-caller read-receipt provenance that does not exist yet; see the
 * capture-door design doc §2.3.
 */
export type CaptureRejectReason =
  | "already-known"
  | "no-durable-content"
  | "structuring-unavailable"
  /** Domain write had no explicit/advisory workspace — refuse silent membership[0]. */
  | "workspace-required";

/**
 * Minimum durable text. Deliberately tiny: the guard exists to stop empty /
 * whitespace / punctuation-only writes (mem0's 97.8%-junk failure mode), NOT to
 * judge whether a short fact is worth keeping — "Ada left" is durable.
 */
export const CAPTURE_MIN_DURABLE_CHARS = 3;

/**
 * How many structured entities still get the advisory cross-kind pre-check.
 * One `resolveIdentity` is 2-3 queries, so a large batch skips it entirely — the
 * core's OWN dedup (inside `submitCaptureGraph`) runs either way; only the
 * advisory link suggestions are dropped.
 */
export const CAPTURE_CROSSKIND_PRECHECK_MAX = 8;

/**
 * The `property_defs.value_type` PG enum, read off the schema SSOT
 * (`PropertyValueType`, packages/database/src/schema/property-defs.ts) rather
 * than re-listed here. `synap_define_kind` validates against it because the hub
 * door types the field as a bare string and casts — an unknown value would only
 * fail at INSERT with an opaque Postgres enum error.
 */
export const PROPERTY_VALUE_TYPES: string[] = Object.values(PropertyValueType);

export function normalizeCaptureText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

/** Whitespace / punctuation-only, or shorter than a word → nothing to store. */
export function hasDurableText(normalized: string): boolean {
  return (
    normalized.length >= CAPTURE_MIN_DURABLE_CHARS &&
    /[\p{L}\p{N}]/u.test(normalized)
  );
}

/** Does this entity element carry something storable (or name something real)? */
export function hasDurableEntity(e: Record<string, unknown>): boolean {
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
export function captureRejected(params: {
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

/**
 * Caller's member workspaces (id + name) for write-placement error messages.
 * Cheap: membership ids + one name query. Same shape as set_workspace_focus.
 */
export async function listMemberWorkspacesForAgent(
  userId: string
): Promise<Array<{ id: string; name: string }>> {
  // Delegates to the one implementation, shared with the tRPC membership
  // denial in `trpc.ts` — never a second copy of "list this user's workspaces".
  return listMemberWorkspaces(userId);
}

/**
 * WRITE placement must not silently land on membership[0] (the wrong-placement
 * bug — data filed into whichever workspace happened to sort first). When
 * neither an explicit/confined `workspaceId` nor an advisory agent focus
 * resolved, fail loud with the accessible list so the agent can pass one or
 * call orient / set_workspace_focus. Same philosophy as `synap_link_entities`.
 *
 * Capture uses the uniform `captureRejected` envelope; other write tools use
 * a bare `{ error, availableWorkspaces }` ok-shaped reject.
 */
export async function rejectMissingWriteWorkspace(
  userId: string,
  opts?: { captureScope?: CaptureScope }
): Promise<CallToolResult> {
  const available = await listMemberWorkspacesForAgent(userId);
  const list =
    available.length === 0
      ? "none yet — create or join a workspace first"
      : available.map((w) => `${w.name} (${w.id})`).join("; ");
  const message =
    `No workspace resolved for this write — refusing to pick an arbitrary membership. ` +
    `Pass workspaceId (process home / list lens), call synap_set_workspace_focus(workspace), or call synap_orient() to list domains. ` +
    `Pod-scope kinds (person, company, knowledge, note…) can omit workspaceId on create/capture — server places them pod-wide; ambient is a read lens, not a silent dump. ` +
    `Available workspaces: ${list}.`;

  if (opts?.captureScope) {
    return captureRejected({
      reason: "workspace-required",
      scope: { ...opts.captureScope, workspaceId: null },
      message,
      extra: { availableWorkspaces: available },
    });
  }
  return ok({
    error: message,
    availableWorkspaces: available,
  });
}

// ── MCP tool dispatch types (router-decomposition Wave 7) ─────────────────

/**
 * Everything a handler needs to execute a tool call — the values
 * `executeMCPToolViaHubProtocol`'s setup phase (adapter.ts) used to close
 * over as bare locals inside the giant switch. One object, one shape, so
 * every domain handler file destructures only the fields it actually uses.
 */
export interface McpToolContext {
  toolName: string;
  args: Record<string, unknown>;
  userId: string;
  apiKeyScopes: string[];
  agentUserId?: string;
  sessionId?: string;
  keyType?: string | null;
  keyWorkspaceId?: string | null;
  /** Hub Protocol caller with NO ambient workspace lens (governance falls back to membership). */
  caller: Awaited<ReturnType<typeof createHubProtocolCaller>>;
  /** Hub Protocol caller with the resolved `?workspaceId=` lens as ambient governance workspace. */
  lensCaller: Awaited<ReturnType<typeof createHubProtocolCaller>>;
  /** Advisory workspace id (explicit/service-key-pin > agent focus), NOT yet access-checked. */
  requestedWorkspaceId?: string;
  /** `requestedWorkspaceId`, but only when `workspaceAccessible` — the actual governance lens. */
  lensWorkspaceId?: string;
  /** Service-key-confined workspace id (see `resolveConfinedWorkspace`). */
  confinedWorkspaceId?: string;
  /** Whether `requestedWorkspaceId` is accessible to the caller. */
  workspaceAccessible: boolean;
}

export type McpToolHandler = (ctx: McpToolContext) => Promise<CallToolResult>;

/** A domain handler file's exported slice of the full tool → handler map. */
export type McpHandlerMap = Partial<Record<string, McpToolHandler>>;
