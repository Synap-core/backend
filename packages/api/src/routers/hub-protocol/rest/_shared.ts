/**
 * Hub Protocol REST — shared helpers
 *
 * Imported by every per-resource route file under `rest/*.ts`.
 * Mirror the original helpers from hub-protocol-rest.ts so behavior is preserved.
 */

import type { OpenAPIHono } from "@hono/zod-openapi";
import type { Context } from "hono";
import { createLogger } from "@synap-core/core";
import { TRPCError } from "@trpc/server";
import {
  db,
  users,
  workspaces,
  workspaceMembers,
  proposals,
  eq,
  and,
  drizzleSql,
  getWorkspaceMembership,
} from "@synap/database";

import { hubProtocolRouter } from "../index.js";
import { createHubProtocolCallerContext } from "../utils.js";
import { userVisibleWhere } from "../../../utils/user-visible-where.js";
import { getUserWorkspaceIds } from "../../../utils/workspace-membership.js";

/**
 * Module-scoped pino logger.
 *
 * Type-erased via `: any` to keep the package self-contained — exporting a typed
 * Logger value forces tsc to emit a path back to pino in `.d.ts`, which breaks
 * the `--declaration` portability check (TS2742). Internal callers infer the
 * pino API correctly at use sites.
 */

export const logger: any = createLogger({ module: "hub-protocol-rest" });

/**
 * Variables stored on the Hono request context by the auth middleware.
 *
 * `parentKeyId` and `externalUserId` are populated only when the per-user
 * sub-token feature is enabled (HUB_PROTOCOL_SUB_TOKENS=true) AND the
 * caller forwarded an `X-External-User-Id` header. They let downstream
 * code distinguish "remapped sub-token" from "direct user auth" — most
 * handlers can ignore them.
 */
export type HubVariables = {
  userId: string;
  scopes: string[];
  /**
   * The api_keys.id of the bearer that authenticated this request. Set ONLY
   * when the auth middleware accepted an `Authorization: Bearer` credential —
   * NOT set for `X-Session-Token` callers (Kratos sessions don't have an
   * api_keys row). Routes that need to introspect the bearer (e.g. the
   * `/auth/status` endpoint) must check for `undefined`.
   */
  apiKeyId?: string;
  parentKeyId?: string;
  externalUserId?: string;
  /** Human user the bearer key acts on behalf of (identity link). */
  linkedUserId?: string;
  /**
   * When the request uses an agent API key (key owner has userType='agent' and
   * the key has a linkedUserId), this is set to the key owner's userId so route
   * handlers can attribute proposals to the agent without the caller passing it
   * explicitly in the request body.
   */
  agentUserId?: string;
  /**
   * The authenticating key's `keyType` (e.g. "service", "hub_inbound"). Set by
   * the auth middleware for Bearer callers. Used for SERVICE-KEY WORKSPACE
   * CONFINEMENT (Item 3) — a bound `service` key is pinned to its workspace.
   */
  keyType?: string;
  /**
   * The `workspace_id` binding of the authenticating key (null if unbound). For
   * a `service` key this is the confinement boundary applied at the shared door.
   */
  keyWorkspaceId?: string | null;
};

/**
 * Typed Hono app — same shape as the root `app` in hub-protocol-rest.ts.
 * Pass this as the `app` argument to every `register*Routes` function so
 * `c.get("scopes")` returns `string[]` rather than `unknown`.
 *
 * This is an `OpenAPIHono` (drop-in superset of `Hono`) so per-resource files
 * can register OpenAPI metadata via `app.openAPIRegistry.registerPath(...)`
 * while keeping vanilla `app.get` / `app.post` handlers for incremental migration.
 */
export type HubHono = OpenAPIHono<{ Variables: HubVariables }>;

/**
 * Check whether the current API key holds a scope.
 */
export function hasScope(scopes: string[], required: string): boolean {
  return scopes.includes(required);
}

/**
 * SECURITY — reject a proposal REVIEW action (approve / revert) performed with
 * an AGENT credential. A Hub key linked to an agent user is remapped to its
 * human owner for entity ownership (see hub-protocol-rest.ts — `userId` becomes
 * the owner, `agentUserId` keeps the agent). Approval/revert is the HUMAN review
 * step. Without this an agent key could create-then-self-approve (or self-revert)
 * its own proposals — including destructive deletes — because the remap makes the
 * default `owner_and_admins` gate's `isOwner` check (`sourceId === userId`)
 * trivially pass. Human review must come from a human session, not an agent key.
 *
 * Returns a 403 `Response` to return from the handler when the caller is an agent
 * credential (and logs the blocked attempt — a meaningful security signal), else
 * `null` to continue. The SINGLE source of truth for this guard across every
 * review door. TODO: a future "trusted reviewer agent" could be an explicit,
 * audited opt-in that bypasses this.
 */
export function rejectAgentReviewer(
  c: Context<{ Variables: HubVariables }>,
  action: "approve" | "revert"
): Response | null {
  const agentUserId = c.get("agentUserId");
  if (!agentUserId) return null;
  logger.warn(
    { agentUserId, proposalId: c.req.param("id"), action },
    "agent credential attempted to review a proposal — blocked (human review required)"
  );
  const Verb = action[0].toUpperCase() + action.slice(1);
  return c.json(
    {
      error: `An agent credential cannot ${action} proposals — ${action} is human review. ${Verb} from a human session.`,
    },
    403
  );
}

const PROPOSAL_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A bare hex prefix (git-style short id) — the CLI shows `id.slice(0, 8)`. */
const PROPOSAL_PREFIX_RE = /^[0-9a-f]{4,35}$/i;

/**
 * Resolve a proposal handle into its full UUID.
 *
 * The CLI DISPLAYS and suggests 8-char id prefixes (git-style — `id.slice(0, 8)`
 * on every `proposals list` / approve line), but `proposals.id` is a `uuid`
 * column: feeding a bare prefix into the canonical `WHERE id = $1` lookup makes
 * Postgres throw on invalid-uuid syntax → HTTP 500 on EVERY approve/reject. This
 * turns a prefix into the unique full id it names, scoped to the caller's OWN
 * proposals, so the short ids the CLI prints are valid handles everywhere. A full
 * uuid passes straight through (no query).
 *
 * Throws TRPCError NOT_FOUND (no match / not a plausible id) or BAD_REQUEST
 * (ambiguous prefix) — handlers map both to the right HTTP status.
 */
export async function resolveProposalId(
  userId: string,
  raw: string
): Promise<string> {
  if (PROPOSAL_UUID_RE.test(raw)) return raw;
  if (!PROPOSAL_PREFIX_RE.test(raw)) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `No proposal matches "${raw}"`,
    });
  }
  // `raw` is validated to [0-9a-f] only — it carries no LIKE wildcards to escape.
  //
  // Scope with the SAME predicate `proposals.list` uses (`userVisibleWhere`) —
  // resolve exactly what we displayed. Scoping by `createdBy` instead would miss
  // the dominant review case: `checkPermissionOrPropose` stamps the human
  // (permission-check.ts:1254), but the agent-initiated paths stamp the AGENT
  // (:771, :1393) — so an AI proposal would list fine, print its short id, then
  // 404 on approve. `userVisibleWhere` also covers pod-wide (NULL workspace)
  // proposals. This is disambiguation, not authorization: approve/reject still
  // gate downstream.
  const rows = await db
    .select({ id: proposals.id })
    .from(proposals)
    .where(
      and(
        userVisibleWhere(proposals.workspaceId, userId),
        drizzleSql`${proposals.id}::text LIKE ${`${raw}%`}`
      )
    )
    .limit(2);
  if (rows.length === 0) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `No proposal matches "${raw}"`,
    });
  }
  if (rows.length > 1) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Ambiguous proposal id "${raw}" — provide more characters`,
    });
  }
  return rows[0].id;
}

/**
 * Build a short, DETERMINISTIC prose briefing from a digest's counts —
 * NO LLM call, pure string assembly. Shared by the workspace and project
 * digest endpoints so the two lines read identically.
 *
 * Examples:
 *   "Workspace 'CRM': 42 entities across deal (18), contact (15), company (9).
 *    Most recent: Acme renewal."
 *   "Project 'Q3 Launch': 12 entities across task (5), note (4), spanning
 *    2 workspaces. Most recent: Draft copy."
 */
export function buildDigestSummary(
  subject: string,
  total: number,
  counts: Record<string, number>,
  keyEntities: Array<{ title: string | null }>,
  extra?: string
): string {
  if (total === 0) return `${subject} is empty — no entities yet.`;
  const breakdown = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([slug, n]) => `${slug} (${n})`)
    .join(", ");
  const mostRecent = keyEntities[0]?.title?.trim() || "untitled";
  return `${subject}: ${total} entities across ${breakdown}${
    extra ? `, ${extra}` : ""
  }. Most recent: ${mostRecent}.`;
}

/**
 * Resolve the TRUSTED acting identity + workspace for a hub-protocol REST request.
 *
 * SECURITY — closes a cross-tenant IDOR. The auth middleware already resolves the
 * authoritative acting user into `c.get("userId")`: a Kratos session identity, or
 * an API-key's delegated user (X-External-User-Id mapping / child key). Handlers
 * MUST NOT let a body-supplied `userId` pick a different identity. Rules:
 *   - Session-token (human) callers — `c.get("apiKeyId")` is undefined: a body
 *     `userId`, if present, MUST equal the authenticated user, else 403. A human
 *     can never act as someone else by editing the request body.
 *   - API-key (service/infra) callers — `apiKeyId` set: may pass `body.userId`
 *     for on-behalf-of (trusted infra; workspace-scoped keys are header-pinned).
 * Then the workspace is bound to that identity: if `body.workspaceId` is given it
 * is membership-checked for the RESOLVED user (no cross-workspace write); if
 * omitted, the write is POD-PERSONAL — `workspaceId` is `null` (an owner-personal
 * resource), with NO first-workspace fallback. The security boundary is preserved:
 * a workspace write still requires membership; a no-workspace write is owner-personal.
 *
 * Returns the bound `{ userId, workspaceId, role }` (where `workspaceId` is `null`
 * for pod-personal writes) or a `{ status, error }` to return directly. Use this
 * instead of reading `body.userId` / `body.workspaceId`.
 */
export async function resolveActingContext(
  c: { get: (k: string) => unknown },
  body: { userId?: string; workspaceId?: string }
): Promise<
  | { ok: true; userId: string; workspaceId: string | null; role: string }
  | { ok: false; status: 400 | 403; error: string }
> {
  const authUserId = c.get("userId") as string | undefined;
  if (!authUserId) return { ok: false, status: 403, error: "Unauthenticated" };

  const isServiceKey = !!c.get("apiKeyId");
  let userId: string;
  if (isServiceKey) {
    userId = body.userId ?? authUserId;
  } else {
    if (body.userId && body.userId !== authUserId) {
      return {
        ok: false,
        status: 403,
        error: "userId does not match the authenticated session",
      };
    }
    userId = authUserId;
  }

  const workspaceId = body.workspaceId;
  if (!workspaceId) {
    // Founder decision: a write with NO workspace lands pod-personal (an
    // owner-personal resource) instead of being forced into the user's first
    // workspace. NO first-workspace fallback, NO 400.
    return { ok: true, userId, workspaceId: null, role: "owner" };
  }
  const membership = await getWorkspaceMembership(db, workspaceId, userId);
  if (!membership) {
    return { ok: false, status: 403, error: "Access denied to workspace" };
  }
  return { ok: true, userId, workspaceId, role: membership.role };
}

/**
 * Resolve the actor ID for a hub protocol write request.
 *
 * If `agentUserId` is provided, verify it refers to a real agent user
 * (userType = "agent") before trusting it.
 */
export async function resolveActorId(
  agentUserId: string | undefined,
  userId: string
): Promise<{ actorId: string } | { error: string }> {
  if (!agentUserId) return { actorId: userId };

  const agent = await db.query.users.findFirst({
    where: and(eq(users.id, agentUserId), eq(users.userType, "agent")),
    columns: { id: true },
  });

  if (!agent) {
    logger.warn(
      { agentUserId, userId },
      "Hub request rejected: invalid agentUserId (not an agent user)"
    );
    return {
      error: "Invalid agentUserId — must be a user with userType='agent'",
    };
  }

  return { actorId: agentUserId };
}

/**
 * Get all workspace IDs the user can read: explicit memberships plus
 * pod-visible/pod-joinable source workspaces.
 *
 * Thin re-export of `@synap/api`'s `utils/workspace-membership.ts`
 * `getUserWorkspaceIds` (same package, no import-cycle) — the ONE
 * member-∪-pod-visible implementation. Was a third hand-rolled copy of that
 * union; delegating removes the undeclared duplicate.
 */
export async function getUserAccessibleWorkspaceIds(
  userId: string
): Promise<string[]> {
  return getUserWorkspaceIds(userId);
}

/**
 * Get the workspace IDs the user is an explicit MEMBER of (memberships only —
 * NO pod-visible fallback). Used as the "first accessible workspace" lens
 * fallback by the MCP adapter (recall catalog, relations, linking, capture).
 * Kept distinct from {@link getUserAccessibleWorkspaceIds} so those callers
 * preserve their membership-only semantics.
 *
 * NOTE the name: this is the MEMBER-ONLY variant. `@synap/api`'s
 * `utils/workspace-membership.ts` exports a DIFFERENT `getUserWorkspaceIds`
 * (member ∪ pod-visible). Named `getUserMemberWorkspaceIds` here so an import
 * typo can never silently swap the two semantics.
 */
export async function getUserMemberWorkspaceIds(
  userId: string
): Promise<string[]> {
  const rows = await db
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId));
  return rows.map((r) => r.workspaceId);
}

/**
 * Verify a user has access to a specific workspace.
 */
export async function verifyWorkspaceAccess(
  userId: string,
  workspaceId: string
): Promise<boolean> {
  const row = await db.query.workspaceMembers.findFirst({
    where: and(
      eq(workspaceMembers.workspaceId, workspaceId),
      eq(workspaceMembers.userId, userId)
    ),
    columns: { id: true },
  });
  return !!row;
}

/**
 * Verify read access for a workspace.
 *
 * Membership always grants read access. Pod-visible/pod-joinable workspaces are
 * also readable by authenticated users on the same data pod, but this does not
 * grant mutation rights.
 */
export async function verifyWorkspaceReadAccess(
  userId: string,
  workspaceId: string
): Promise<boolean> {
  const hasMembership = await verifyWorkspaceAccess(userId, workspaceId);
  if (hasMembership) return true;

  const podReadable = await db.query.workspaces.findFirst({
    where: and(
      eq(workspaces.id, workspaceId),
      drizzleSql`${workspaces.settings}->>'workspaceVisibility' IN ('pod_visible', 'pod_joinable')`
    ),
    columns: { id: true },
  });
  return !!podReadable;
}

/**
 * Typed caller — the return type of createCaller is fully inferred from
 * the hub protocol router definition.
 */
export type HubProtocolCaller = ReturnType<
  typeof hubProtocolRouter.createCaller
>;

/**
 * Helper: get hub protocol caller for current request.
 * Pass workspaceId for workspace-scoped procedures (e.g. entities create/update).
 */
export async function getCaller(
  c: { get: (key: string) => unknown },
  options?: {
    workspaceId?: string | null;
    userId?: string;
    sourceMessageId?: string | null;
    sessionId?: string | null;
  }
): Promise<HubProtocolCaller> {
  // SECURITY KEYSTONE: the acting identity is ALWAYS the authenticated owner
  // resolved by the auth middleware. For the Intelligence Service this is the
  // OPERATOR — its `is_internal` key + `X-Delegated-Operator-Id` header is remapped
  // to the operator's userId in the auth middleware (hub-protocol-rest.ts), so
  // `c.get("userId")` already IS the operator floor here; no per-route delegation
  // is needed. A caller-supplied options.userId is IGNORED — honoring it would let
  // a hub key act as (and read/write the data of) another user. We don't THROW on a
  // mismatch (a redundant/legacy userId in the body shouldn't break first-party
  // tools like the CLI) — we simply never honor it and log the discrepancy.
  //
  // INTENTIONAL ASYMMETRY: the sibling `resolveActingContext` (used by WRITE
  // routes) DOES honor a service-key body.userId. Reads here do not — read
  // scoping rides on the auth middleware's identity remap (is_internal→operator,
  // agent-key→linkedUserId), already the correct floor, so a read never needs the
  // route to re-pick the user and allowing it would re-open the cross-user read
  // this revert closed. Writes still need it to attribute the mutation to the
  // specific operator the IS acts for.
  const userId = c.get("userId") as string;
  if (options?.userId && options.userId !== userId) {
    logger.warn(
      { passedUserId: options.userId, resolvedUserId: userId },
      "getCaller: ignoring caller-supplied userId; acting as the resolved owner"
    );
  }
  const scopes = c.get("scopes") as string[];
  // SERVICE-KEY CONFINEMENT (Item 3): thread the authenticating key's type +
  // workspace binding so the shared door pins a bound `service` key to its
  // workspace. Undefined for non-Bearer / non-service callers → passthrough.
  const keyType = c.get("keyType") as string | undefined;
  const keyWorkspaceId = c.get("keyWorkspaceId") as string | null | undefined;
  const ctx = await createHubProtocolCallerContext(
    userId,
    scopes,
    options?.workspaceId,
    options?.sourceMessageId,
    options?.sessionId,
    // agentUserId — getCaller deliberately never sets it (reads ride the auth
    // middleware's identity floor); pass undefined to reach the confinement args.
    undefined,
    keyType,
    keyWorkspaceId
  );
  return hubProtocolRouter.createCaller(ctx as any);
}
