/**
 * Hub Protocol REST — shared helpers
 *
 * Imported by every per-resource route file under `rest/*.ts`.
 * Mirror the original helpers from hub-protocol-rest.ts so behavior is preserved.
 */

import type { OpenAPIHono } from "@hono/zod-openapi";
import { createLogger } from "@synap-core/core";
import { db, users, workspaceMembers, eq, and } from "@synap/database";

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
 * Get all workspace IDs a user is a member of.
 */
export async function getUserAccessibleWorkspaceIds(
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
  }
): Promise<HubProtocolCaller> {
  const userId = options?.userId ?? (c.get("userId") as string);
  const scopes = c.get("scopes") as string[];
  const ctx = await createHubProtocolCallerContext(
    userId,
    scopes,
    options?.workspaceId,
    options?.sourceMessageId
  );
  return hubProtocolRouter.createCaller(ctx as any);
}
