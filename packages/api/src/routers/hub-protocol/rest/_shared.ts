/**
 * Hub Protocol REST — shared helpers
 *
 * Imported by every per-resource route file under `rest/*.ts`.
 * Mirror the original helpers from hub-protocol-rest.ts so behavior is preserved.
 */

import type { OpenAPIHono } from "@hono/zod-openapi";
import { createLogger } from "@synap-core/core";
import {
  db,
  users,
  workspaces,
  workspaceMembers,
  eq,
  and,
  drizzleSql,
  getWorkspaceMembership,
} from "@synap/database";

import { hubProtocolRouter } from "../index.js";
import { createHubProtocolCallerContext } from "../utils.js";

/**
 * Module-scoped pino logger.
 *
 * Type-erased via `: any` to keep the package self-contained — exporting a typed
 * Logger value forces tsc to emit a path back to pino in `.d.ts`, which breaks
 * the `--declaration` portability check (TS2742). Internal callers infer the
 * pino API correctly at use sites.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
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
 * omitted, the user's first accessible workspace is used.
 *
 * Returns the bound `{ userId, workspaceId, role }` or a `{ status, error }` to
 * return directly. Use this instead of reading `body.userId` / `body.workspaceId`.
 */
export async function resolveActingContext(
  c: { get: (k: string) => unknown },
  body: { userId?: string; workspaceId?: string }
): Promise<
  | { ok: true; userId: string; workspaceId: string; role: string }
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

  let workspaceId = body.workspaceId;
  if (!workspaceId) {
    const wsIds = await getUserAccessibleWorkspaceIds(userId);
    workspaceId = wsIds[0];
    if (!workspaceId) {
      return {
        ok: false,
        status: 400,
        error: "No accessible workspace found for this user",
      };
    }
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
 */
export async function getUserAccessibleWorkspaceIds(
  userId: string
): Promise<string[]> {
  const rows = await db
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId));
  const ids = new Set(rows.map((r) => r.workspaceId));

  const podReadable = await db
    .select({ workspaceId: workspaces.id })
    .from(workspaces)
    .where(
      drizzleSql`${workspaces.settings}->>'workspaceVisibility' IN ('pod_visible', 'pod_joinable')`
    );
  for (const row of podReadable) ids.add(row.workspaceId);

  return Array.from(ids);
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
  // resolved by the auth middleware (agent-key → linkedUserId, sub-token → mapped
  // user, Kratos → identity). A caller-supplied options.userId is IGNORED —
  // honoring it would let a hub key act as (and read/write the data of) another
  // user. We don't THROW on a mismatch (a redundant/legacy userId in the body
  // shouldn't break first-party tools like the CLI) — we simply never honor it
  // and log the discrepancy.
  const userId = c.get("userId") as string;
  if (options?.userId && options.userId !== userId) {
    logger.warn(
      { passedUserId: options.userId, resolvedUserId: userId },
      "getCaller: ignoring caller-supplied userId; acting as the resolved owner"
    );
  }
  const scopes = c.get("scopes") as string[];
  const ctx = await createHubProtocolCallerContext(
    userId,
    scopes,
    options?.workspaceId,
    options?.sourceMessageId,
    options?.sessionId
  );
  return hubProtocolRouter.createCaller(ctx as any);
}
