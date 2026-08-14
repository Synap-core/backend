/**
 * Hub Protocol REST — agent setup endpoint.
 *
 * Creates an agent user + Hub Protocol API key for external services
 * (e.g. OpenClaw). Mounted at POST /setup/agent and skip-listed from
 * the regular API-key auth middleware (it does its own auth here).
 */

import { randomUUID } from "crypto";
import jwt from "jsonwebtoken";

import {
  db,
  sql,
  eq,
  and,
  inArray,
  count,
  apiKeys,
  apiKeyExternalUsers,
  workspaces,
  workspaceMembers,
  invites,
  users,
  EventRepository,
  ApiKeyRepository,
  TrustedIssuerService,
  type ApiKeyScope,
} from "@synap/database";

import { resolveKeyIdentity } from "../../../access/key-identity.js";
import { apiKeyService } from "../../../services/api-keys.js";
import { assertPodAdmin } from "../../../trpc.js";
import {
  createAdminUser,
  ensureUserRow,
} from "../../../scripts/create-admin-user.js";
import {
  isSubTokenFeatureEnabled,
  lookupExternalUserMapping,
  resolveExternalUserMapping,
} from "../../../services/external-user-mapping.js";
import { NotificationService } from "../../../notifications/NotificationService.js";
import { verifyIssuerJwt } from "../../../utils/jwks-client.js";
import { normalizeIssuerUrl } from "../../../utils/issuer-url-safety.js";
import { integrationHubIdFromIssuerUrl } from "../../../services/hub-integration-registration.js";
import {
  createAndVerifyServiceKey,
  toRegistrationTrace,
} from "../../../services/external-registration.js";
import { provisionSurfaceAgentKey } from "../../../services/agent-identity-service.js";
import { API_KEY_SCOPES, isValidScope } from "@synap/database/schema";

import { kratosAdmin, safeTokenEqual } from "@synap/auth";
import type { Context } from "hono";
import { logger, type HubHono, type HubVariables } from "./_shared.js";

/** Escape a user-derived value before interpolating it into an HTML string. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const SURFACE_AGENT_TYPES = [
  "claude-code",
  "claude-desktop",
  "cursor",
  "raycast",
  "codex",
  "openwebui",
  "discord",
  "proton",
  "generic",
] as const;

/** Check Kratos admin API for any identities. */
async function checkKratosIdentity(): Promise<boolean> {
  try {
    const { data: identities } = await kratosAdmin.listIdentities({
      pageSize: 1,
    });
    return Array.isArray(identities) && identities.length > 0;
  } catch {
    return false;
  }
}

/**
 * Probe the pod-admin invariant. Returns a structured result the operator
 * (or eve's post-update probe) can act on.
 *
 *   { healthy: true, … }            — pod-admin owner exists, all rows present.
 *   { healthy: false, kind: 'fresh' } — no users yet, install pre-bootstrap.
 *   { healthy: false, kind: 'broken_no_workspace' }   — users exist, no pod-admin workspace.
 *   { healthy: false, kind: 'broken_no_owner' }        — workspace exists, no owners.
 *   { healthy: false, kind: 'broken_orphan_member' }   — owner row points at missing user.
 */
async function computePodAdminInvariant(): Promise<{
  healthy: boolean;
  kind: string;
  reason: string;
}> {
  try {
    const podAdminWorkspace = await db.query.workspaces.findFirst({
      where: eq(workspaces.systemSlug, "pod-admin"),
      columns: { id: true },
    });

    if (!podAdminWorkspace) {
      const anyUser = await db.query.users.findFirst({
        columns: { id: true },
      });
      if (!anyUser) {
        return {
          healthy: false,
          kind: "fresh",
          reason: "no users yet — pre-bootstrap install",
        };
      }
      return {
        healthy: false,
        kind: "broken_no_workspace",
        reason: "users exist but no pod-admin system workspace",
      };
    }

    const owner = await db.query.workspaceMembers.findFirst({
      where: and(
        eq(workspaceMembers.workspaceId, podAdminWorkspace.id),
        inArray(workspaceMembers.role, ["owner", "admin"])
      ),
      columns: { userId: true },
    });

    if (!owner) {
      return {
        healthy: false,
        kind: "broken_no_owner",
        reason: `pod-admin workspace ${podAdminWorkspace.id} has no owner/admin`,
      };
    }

    const userRow = await db.query.users.findFirst({
      where: eq(users.id, owner.userId),
      columns: { id: true, email: true },
    });

    if (!userRow) {
      return {
        healthy: false,
        kind: "broken_orphan_member",
        reason: `pod-admin owner ${owner.userId} has no users row`,
      };
    }

    return {
      healthy: true,
      kind: "ok",
      reason: `pod-admin owned by ${userRow.email}`,
    };
  } catch (err) {
    return {
      healthy: false,
      kind: "probe_failed",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Map a pod API origin to its pod-admin app origin (`pod.<root>` →
 * `pod-admin.<root>`). Mirrors the `/admin/connect` redirect host-swap in
 * `apps/api/src/index.ts` so the agent-approval review URL lands in the
 * pod-admin SPA — where the operator is already Kratos-authed — instead of a
 * bare REST page on the API host. Dev (localhost/127.0.0.1) → pod-admin :4040.
 */
function toPodAdminOrigin(origin: string): string {
  try {
    const u = new URL(origin);
    const host = u.host; // host:port
    if (host.startsWith("localhost") || host.startsWith("127.0.0.1")) {
      return "http://localhost:4040";
    }
    if (host.startsWith("pod.")) {
      const root = host.slice("pod.".length).replace(/:\d+$/, "");
      return `${u.protocol}//pod-admin.${root}`;
    }
    // `<sub>.<root>` → swap the leading label for `pod-admin`.
    const dot = host.indexOf(".");
    const root =
      dot > 0
        ? host.slice(dot + 1).replace(/:\d+$/, "")
        : host.replace(/:\d+$/, "");
    return `${u.protocol}//pod-admin.${root}`;
  } catch {
    return origin;
  }
}

/**
 * Provisioning auth for the product-neutral `/setup/service` door.
 *
 * Mirrors the auth preamble of `/setup/agent` (trusted-issuer JWT OR
 * PROVISIONING_TOKEN OR a Hub API key with `setup.agent` scope OR a human-owned
 * `hub-protocol.write` surface key). Kept as a standalone helper so `/setup/service`
 * reuses the exact same gate WITHOUT touching `/setup/agent`.
 *
 * Returns either `{ ok: true, ... }` or `{ ok: false, response }` (a fully-formed
 * 401/202/403 the caller should return verbatim).
 */
async function authenticateServiceSetupRequest(
  c: Context<{ Variables: HubVariables }>
): Promise<
  | {
      ok: true;
      authMethod: "jwt" | "provisioning_token" | "api_key" | "api_key_surface";
      jwtIssuerUrl: string | null;
      surfaceKeyUserId?: string;
    }
  | { ok: false; response: Response }
> {
  const authHeader = c.req.header("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : null;

  if (!token) {
    return {
      ok: false,
      response: c.json({ error: "Missing Authorization header" }, 401),
    };
  }

  let jwtIssuerUrl: string | null = null;
  const adminUrl = `${process.env.PUBLIC_URL ?? ""}/admin/trusted-issuers`;

  // Try 1: generic issuer JWT verified against the Pod-local issuer registry.
  try {
    const decoded = jwt.decode(token);
    if (decoded && typeof decoded === "object") {
      const rawIssuer = (decoded as Record<string, unknown>).iss;
      const iss =
        typeof rawIssuer === "string" ? normalizeIssuerUrl(rawIssuer) : null;
      if (iss && rawIssuer === iss) {
        const issuerSvc = new TrustedIssuerService();
        let issuer = await issuerSvc.getByUrl(iss);

        if (!issuer) {
          const derivedDisplayName = new URL(iss).hostname;
          issuer = await issuerSvc.registerPending(iss, derivedDisplayName, {
            requestedVia: "setup-service",
          });
          logger.warn(
            { issuerUrl: iss, adminUrl },
            "setup/service: unknown JWT issuer registered as pending — admin approval required"
          );
          return {
            ok: false,
            response: c.json(
              { code: "ISSUER_PENDING_APPROVAL", adminUrl, issuerUrl: iss },
              202
            ),
          };
        }

        if (issuer.status === "pending") {
          return {
            ok: false,
            response: c.json(
              { code: "ISSUER_PENDING_APPROVAL", adminUrl, issuerUrl: iss },
              202
            ),
          };
        }

        if (issuer.status === "rejected" || issuer.status === "revoked") {
          return {
            ok: false,
            response: c.json(
              { error: "This issuer is not authorized on this pod." },
              403
            ),
          };
        }

        if (issuer.status === "approved") {
          if (!issuer.allowedScopes.includes("setup.agent")) {
            return {
              ok: false,
              response: c.json(
                { error: "This issuer is not authorized on this pod." },
                403
              ),
            };
          }
          try {
            const payload = await verifyIssuerJwt<{
              type: string;
              email?: string;
              name?: string;
            }>(token, iss);
            if (
              payload &&
              (payload.type === "agent_setup" ||
                payload.type === "addon_activate")
            ) {
              return { ok: true, authMethod: "jwt", jwtIssuerUrl: iss };
            }
          } catch {
            // JWT verification failed — fall through to other auth methods
          }
        }
      }
    }
  } catch {
    // Not a valid JWT or issuer lookup failed — fall through
  }

  // Try 2: PROVISIONING_TOKEN (self-hosted pods — env var known only to operator)
  const provisioningToken = process.env.PROVISIONING_TOKEN;
  if (provisioningToken && token === provisioningToken) {
    return { ok: true, authMethod: "provisioning_token", jwtIssuerUrl };
  }

  // Try 3: Hub Protocol API key with `setup.agent` scope (generic provisioning scope).
  {
    const keyRecord = await apiKeyService.validateApiKey(token);
    if (keyRecord?.isActive && keyRecord.scope.includes("setup.agent")) {
      return { ok: true, authMethod: "api_key", jwtIssuerUrl };
    }
    // Path 4: any human-owned `hub-protocol.write` key can mint a service key
    // owned by itself (the key's userId becomes the service key's owner).
    if (keyRecord?.isActive && keyRecord.scope.includes("hub-protocol.write")) {
      return {
        ok: true,
        authMethod: "api_key_surface",
        jwtIssuerUrl,
        surfaceKeyUserId: keyRecord.userId,
      };
    }
  }

  return {
    ok: false,
    response: c.json(
      {
        error:
          "Invalid credentials. Accepted: a trusted-issuer JWT, PROVISIONING_TOKEN, a Hub API key with `setup.agent` scope, or a human-owned `hub-protocol.write` key.",
      },
      401
    ),
  };
}

export function registerSetupRoutes(app: HubHono): void {
  app.post("/setup/agent", async (c) => {
    const flowId = randomUUID();
    // ── Auth: trusted-issuer JWT or Pod-local provisioning credential ────────
    const authHeader = c.req.header("authorization") ?? "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : null;

    if (!token) {
      return c.json({ error: "Missing Authorization header" }, 401);
    }

    let authenticated = false;
    let authMethod:
      "jwt" | "provisioning_token" | "api_key" | "api_key_surface" =
      "provisioning_token";
    let jwtIssuerUrl: string | null = null;

    // Try 1: generic issuer JWT verified against the Pod-local issuer registry.
    const adminUrl = `${process.env.PUBLIC_URL ?? ""}/admin/trusted-issuers`;
    try {
      const decoded = jwt.decode(token);
      if (decoded && typeof decoded === "object") {
        const rawIssuer = (decoded as Record<string, unknown>).iss;
        const iss =
          typeof rawIssuer === "string" ? normalizeIssuerUrl(rawIssuer) : null;
        if (iss && rawIssuer === iss) {
          const issuerSvc = new TrustedIssuerService();
          let issuer = await issuerSvc.getByUrl(iss);

          if (!issuer) {
            // Unknown issuer — register as pending and ask admin to approve
            const derivedDisplayName = new URL(iss).hostname;
            issuer = await issuerSvc.registerPending(iss, derivedDisplayName, {
              requestedVia: "setup-agent",
            });
            try {
              const podAdminWorkspace = await db.query.workspaces.findFirst({
                where: eq(workspaces.systemSlug, "pod-admin"),
                columns: { id: true },
              });
              if (podAdminWorkspace) {
                const admins = await db.query.workspaceMembers.findMany({
                  where: and(
                    eq(workspaceMembers.workspaceId, podAdminWorkspace.id),
                    inArray(workspaceMembers.role, ["admin", "owner"])
                  ),
                  columns: { userId: true },
                });
                for (const admin of admins) {
                  await NotificationService.create({
                    type: "system.issuer_pending_approval",
                    workspaceId: podAdminWorkspace.id,
                    userId: admin.userId,
                    sourceType: "system",
                    sourceId: issuer.id,
                    data: {
                      issuerUrl: iss,
                      displayName: derivedDisplayName,
                    },
                  });
                }
              }
            } catch (notifyErr) {
              logger.warn(
                { err: notifyErr, issuerUrl: iss },
                "setup/agent: failed to notify admins about pending issuer"
              );
            }
            logger.warn(
              { issuerUrl: iss, adminUrl },
              "setup/agent: unknown JWT issuer registered as pending — admin approval required"
            );
            return c.json(
              { code: "ISSUER_PENDING_APPROVAL", adminUrl, issuerUrl: iss },
              202
            );
          }

          if (issuer.status === "pending") {
            return c.json(
              { code: "ISSUER_PENDING_APPROVAL", adminUrl, issuerUrl: iss },
              202
            );
          }

          if (issuer.status === "rejected" || issuer.status === "revoked") {
            return c.json(
              { error: "This issuer is not authorized on this pod." },
              403
            );
          }

          if (issuer.status === "approved") {
            if (!issuer.allowedScopes.includes("setup.agent")) {
              return c.json(
                { error: "This issuer is not authorized on this pod." },
                403
              );
            }

            try {
              const payload = await verifyIssuerJwt<{
                type: string;
                email?: string;
                name?: string;
              }>(token, iss);
              if (
                payload &&
                (payload.type === "agent_setup" ||
                  payload.type === "addon_activate")
              ) {
                authenticated = true;
                authMethod = "jwt";
                jwtIssuerUrl = iss;
              }
            } catch {
              // JWT verification failed — fall through to other auth methods
            }
          }
        }
      }
    } catch {
      // Not a valid JWT or issuer lookup failed — fall through
    }

    // Try 2: PROVISIONING_TOKEN (self-hosted pods — env var known only to operator)
    if (!authenticated) {
      const provisioningToken = process.env.PROVISIONING_TOKEN;
      if (provisioningToken && token === provisioningToken) {
        authenticated = true;
        authMethod = "provisioning_token";
      }
    }

    // Try 3: Hub Protocol API key with `setup.agent` scope.
    if (!authenticated) {
      const keyRecord = await apiKeyService.validateApiKey(token);
      if (keyRecord?.isActive && keyRecord.scope.includes("setup.agent")) {
        authenticated = true;
        authMethod = "api_key";
      }
    }

    // Path 4: any hub-protocol.write key can self-provision a surface agent type.
    // Attribute to the HUMAN principal: if this is already an agent key, use
    // linkedUserId (the human it acts for); if human-owned PAT, userId is the human.
    // Human-owned = the key PRINCIPAL is not an agent (`!isAgent`, via the one
    // identity door `resolveKeyIdentity`) — NOT `linkedUserId == null`. A
    // pod-wide agent key also has no `linkedUserId`, so that check alone would
    // misclassify it as human-owned and let it mint arbitrary named agents.
    let surfaceAgentLinkedUserId: string | undefined;
    let surfaceKeyIsHumanOwned = false;
    if (!authenticated) {
      const keyRecord = await apiKeyService.validateApiKey(token);
      if (
        keyRecord?.isActive &&
        keyRecord.scope.includes("hub-protocol.write")
      ) {
        authenticated = true;
        authMethod = "api_key_surface";
        const identity = await resolveKeyIdentity(keyRecord);
        surfaceKeyIsHumanOwned = !identity.isAgent;
        surfaceAgentLinkedUserId =
          keyRecord.linkedUserId ?? keyRecord.userId ?? undefined;
      }
    }

    if (!authenticated) {
      return c.json(
        {
          error:
            "Invalid credentials. Accepted: a trusted-issuer JWT, PROVISIONING_TOKEN, or a Hub API key with `setup.agent` scope.",
        },
        401
      );
    }

    logger.info({ authMethod }, "setup/agent: authenticated");

    // ── Parse body ──────────────────────────────────────────────────────────────
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return c.json({ error: "Invalid request body" }, 400);
    }

    // REQUIRED — no server-side default. This endpoint is the real enforcement
    // point behind the TS wrappers (`auth-bootstrap/setup.ts`, `hub-rest-client/
    // setup.ts`), which now demand `agentType` at compile time. A silent
    // `"openclaw"` default here would re-open the "stale/foreign singleton"
    // hazard for any caller NOT going through those wrappers (curl, a foreign
    // SDK) — so a missing/blank `agentType` is a 400, never a guessed default.
    const agentType: string | null =
      typeof body.agentType === "string" && body.agentType.trim()
        ? body.agentType.trim()
        : null;
    if (!agentType) {
      return c.json(
        {
          error:
            "Missing required field `agentType`. Every agent-user must declare its type explicitly — it is no longer defaulted.",
        },
        400
      );
    }
    const requestedWorkspaceId: string | undefined =
      typeof body.workspaceId === "string" ? body.workspaceId : undefined;
    const linkedUserId: string | undefined =
      typeof body.linkedUserId === "string" && body.linkedUserId.trim()
        ? body.linkedUserId.trim()
        : undefined;
    // Optional per-runtime instance label. When set, concurrent instances of the
    // same agent coexist: the sibling-revoke and idempotency below scope to THIS
    // instance instead of the whole agent-user. Omitted → legacy single-key model.
    const instanceId: string | undefined =
      typeof body.instanceId === "string" && body.instanceId.trim()
        ? body.instanceId.trim()
        : undefined;
    // OPT-IN — mint a POD-WIDE agent key (key.linkedUserId = null), governed as
    // its OWN agent-user principal rather than acting for a human. Default
    // false: absent/false keeps the fail-closed linked-human resolution below. A
    // creator (createdByUserId) is still resolved and required; only the key's
    // linked human is deliberately dropped.
    const podWide: boolean = body.podWide === true;
    // Surface installs can request a pending-approval flow: key is created inactive
    // until the human owner approves it at the review URL.
    const requireApproval: boolean =
      authMethod === "api_key_surface" && body.requireApproval === true;

    // Surface-key path: SURFACE_AGENT_TYPES are always allowed (claude-code, cursor, …).
    // Non-surface types (twin, custom slug, assistant, …) are only allowed when the
    // authenticating key is human-owned (PAT: linkedUserId null). Agent keys may
    // only mint further surface adjuncts — not arbitrary named agents.
    if (authMethod === "api_key_surface") {
      const isSurfaceType = (SURFACE_AGENT_TYPES as readonly string[]).includes(
        agentType
      );
      if (!isSurfaceType && !surfaceKeyIsHumanOwned) {
        return c.json(
          {
            error:
              "Agent keys may only provision surface agent types. " +
              "Named agents (non-surface agentType) require a human-owned hub-protocol.write key.",
            code: "SURFACE_AGENT_TYPE_REQUIRED",
            allowedSurfaceTypes: SURFACE_AGENT_TYPES,
          },
          400
        );
      }
    }

    const agentLabel = agentType.charAt(0).toUpperCase() + agentType.slice(1);

    try {
      // ── Resolve linkedUserId (human the agent acts for) ─────────────────────
      // - api_key_surface: always the human principal of the authenticating key
      //   (linkedUserId ?? userId). Caller body.linkedUserId is ignored here.
      // - Other auth (JWT / PROVISIONING_TOKEN / setup.agent key):
      //   explicit body.linkedUserId wins; single-human pods may default to that
      //   human; multi-human pods FAIL CLOSED without an explicit link (never
      //   warn-and-continue to oldest-human — that mis-attributes agents).
      // Agent user singleton is (createdByUserId × agentType), not pod-wide type.
      let resolvedLinkedUserId: string | undefined = linkedUserId;
      if (podWide) {
        // Pod-wide agent: the KEY carries NO linked human (governed as its own
        // agent-user principal). We still need a human CREATOR to attribute
        // the agent-user row + own the (creator × agentType) singleton — resolved
        // below as ownerUserId (pod owner / oldest human) and passed as
        // createdByUserId. Skip the linked-human fail-closed guards; provision-
        // SurfaceAgentKey({ podWide: true }) forces linkedUserId null at the mint.
        resolvedLinkedUserId = undefined;
      } else if (authMethod === "api_key_surface") {
        resolvedLinkedUserId = surfaceAgentLinkedUserId;
      } else if (resolvedLinkedUserId === undefined) {
        const humans = await db.query.users.findMany({
          where: (u, { eq: eqFn }) => eqFn(u.userType, "human"),
          orderBy: (u, { asc }) => [asc(u.createdAt)],
          columns: { id: true },
          limit: 2,
        });
        if (humans.length > 1) {
          // ── FAIL CLOSED: multi-human pod without explicit linkedUserId ────
          // JWT / OpenClaw / provisioning must name the human. Silently picking
          // the oldest human mis-attributes memory dual-writes and creator×type
          // singleton ownership on multi-user pods.
          logger.warn(
            { agentType, authMethod, humanCount: humans.length },
            "setup/agent: refusing auto-link on multi-human pod without linkedUserId"
          );
          return c.json(
            {
              error:
                "Multiple humans on this pod — pass an explicit linkedUserId",
              code: "LINKED_USER_REQUIRED",
              detail:
                "This pod has more than one human. Agent keys act on behalf of a specific " +
                "human (creator × agentType singleton). Pass body.linkedUserId to bind the " +
                "agent to the intended human. Single-human pods may omit it.",
            },
            409
          );
        }
        if (humans[0]) {
          // Single-human pod: safe default to that human.
          resolvedLinkedUserId = humans[0].id;
        } else {
          // ── FAIL CLOSED: no human on this pod yet ──────────────────────────
          // With zero human rows, resolvedLinkedUserId stays undefined and the
          // key would be minted with `linkedUserId: null` (below) WITHOUT the
          // caller having opted into `podWide`. `resolveKeyIdentity`
          // (access/key-identity.ts) derives `effectiveUserId` as
          // `linkedUserId ?? userId` — with no linked human the agent's own
          // userId becomes the data floor, so it reads/writes as itself rather
          // than as a human's second brain, with no error and no signal — and
          // nothing repairs it once a human appears.
          //
          // Reachable via the PROVISIONING_TOKEN door during pod bootstrap,
          // which is exactly the window where no human exists yet.
          //
          // Failing closed is correct on the merits too: an agent key is minted
          // to act ON BEHALF OF a human, so "no human yet" is not a state in
          // which a meaningful agent key can exist.
          logger.error(
            { agentType, authMethod },
            "setup/agent: refusing to mint an agent key on a pod with no human " +
              "owner — a key with no linkedUserId would bypass governance permanently"
          );
          return c.json(
            {
              error: "Pod has no human owner yet",
              code: "NO_HUMAN_OWNER",
              detail:
                "An agent key must be linked to a human (it acts on their behalf, and that link is " +
                "what routes its writes through governance). Create the pod owner first, then " +
                "provision agents — or pass an explicit linkedUserId.",
            },
            409
          );
        }
      }

      // ── Find target workspace (optional — agent exists at pod level) ─────────
      // Workspace is NOT required for provisioning. The agent user and API key
      // are pod-wide resources. Workspace membership is granted only when the
      // caller explicitly requests a workspaceId — no silent fallback to
      // agent-os or any-first-workspace, so the caller controls scope precisely.
      const ws = requestedWorkspaceId
        ? await db.query.workspaces.findFirst({
            where: (w, { eq }) => eq(w.id, requestedWorkspaceId),
          })
        : undefined;

      if (requestedWorkspaceId && !ws) {
        return c.json(
          { error: `Workspace ${requestedWorkspaceId} not found` },
          404
        );
      }

      // ── Find pod owner (any human user) ────────────────────────────────────
      // Used to attribute the agent user and, when a workspace exists, to repair
      // missing workspace membership.
      let ownerUserId: string | null = null;

      if (ws) {
        const ownerMember = await db.query.workspaceMembers.findFirst({
          where: and(
            eq(workspaceMembers.workspaceId, ws.id),
            eq(workspaceMembers.role, "owner")
          ),
          columns: { userId: true },
        });
        ownerUserId = ownerMember?.userId ?? null;
      }

      if (!ownerUserId) {
        // Workspace membership repair only — oldest human is fine as a
        // fallback inviter. Agent attribution (createdByUserId / linkedUserId)
        // already resolved above and fails closed on multi-human without link.
        const humanUser = await db.query.users.findFirst({
          where: (u, { eq }) => eq(u.userType, "human"),
          orderBy: (u, { asc }) => [asc(u.createdAt)],
          columns: { id: true },
        });
        if (humanUser) {
          ownerUserId = humanUser.id;
          // Self-repair: ensure the human user is a member of the workspace.
          if (ws) {
            const existingMembership =
              await db.query.workspaceMembers.findFirst({
                where: and(
                  eq(workspaceMembers.userId, humanUser.id),
                  eq(workspaceMembers.workspaceId, ws.id)
                ),
                columns: { id: true },
              });
            if (!existingMembership) {
              await db.insert(workspaceMembers).values({
                id: randomUUID(),
                workspaceId: ws.id,
                userId: humanUser.id,
                role: "owner",
              });
              logger.info(
                { workspaceId: ws.id, userId: humanUser.id },
                "setup/agent: assigned human user as workspace owner (self-repair)"
              );
            }
          }
        }
      }

      // ── Provision the agent Hub key via the ONE door ───────────────────────
      // Singleton is (createdByUserId × agentType) — per human creator, not
      // pod-wide by agentType alone. createdByUserId MUST be the resolved human
      // (resolvedLinkedUserId); ownerUserId is only a last-resort fallback and
      // for workspace membership repair.
      const agentCreatorId = resolvedLinkedUserId ?? ownerUserId ?? null;
      const provisioned = await provisionSurfaceAgentKey({
        agentType,
        createdByUserId: agentCreatorId,
        linkedUserId: resolvedLinkedUserId ?? agentCreatorId,
        // OPT-IN pod-wide: forces the minted key's linkedUserId to null (governed
        // as the agent-user's own principal). Ignored when false.
        podWide,
        instanceId,
        agentLabel,
        // Only the surface-key path provisions a genuine local CLI adjunct
        // (claude-code / codex / cursor). NEVER for jwt/issuer (cloud) agents:
        // an agentCommand on the row makes the renderer try to launch a local
        // terminal, which is wrong for a remote agent.
        ensureRegistryRow: authMethod === "api_key_surface",
        agentDescription: `${agentLabel} — external agent (${authMethod === "jwt" ? "issuer-managed" : "Pod-local"} setup)`,
        keyName: `${agentLabel} Hub Key`,
        keyDescription: `Hub Protocol auth token for ${agentLabel} agent — created via ${authMethod === "jwt" ? "issuer-managed" : "Pod-local"} setup`,
        hubId: jwtIssuerUrl
          ? integrationHubIdFromIssuerUrl(jwtIssuerUrl)
          : undefined,
        // Idempotent path (Eve's workspace-membership repair): skip revoke+mint
        // if a valid (non-revoked) key already exists for THIS instance.
        idempotent: body.idempotent === true,
        logger,
        // Grant workspace membership at the SAME point it ran inline — after the
        // agent user is resolved, before the idempotent short-circuit.
        onAgentUserResolved: async (agentUserId) => {
          if (ws) {
            const existingMembership =
              await db.query.workspaceMembers.findFirst({
                where: and(
                  eq(workspaceMembers.userId, agentUserId),
                  eq(workspaceMembers.workspaceId, ws.id)
                ),
                columns: { id: true },
              });

            if (!existingMembership) {
              await db.insert(workspaceMembers).values({
                id: randomUUID(),
                workspaceId: ws.id,
                userId: agentUserId,
                role: "editor",
                invitedBy: ownerUserId ?? undefined,
              });
              logger.info(
                { agentUserId, workspaceId: ws.id },
                "setup/agent: workspace membership granted"
              );
            }
          }
        },
      });

      const agentUserId = provisioned.agentUserId;

      if (provisioned.alreadyValid) {
        return c.json({
          agentUserId,
          workspaceId: ws?.id ?? null,
          alreadyValid: true,
        });
      }

      const { registration, apiKey, plainKey } = provisioned;
      const registrationTrace = toRegistrationTrace(flowId, registration);
      if (registration.outcome !== "CONNECTED_VERIFIED") {
        logger.error(
          {
            flowId,
            agentUserId,
            agentType,
            authMethod,
            verificationError: registration.verificationError,
          },
          "setup/agent: key minted but verification failed"
        );
        return c.json(
          {
            error: "Key minted but verification failed",
            code: "KEY_MINTED_BUT_VERIFICATION_FAILED",
            registration: registrationTrace,
          },
          500
        );
      }

      logger.info(
        {
          agentUserId,
          keyId: apiKey.id,
          workspaceId: ws?.id ?? null,
          agentType,
          authMethod,
          registration: registrationTrace,
        },
        "setup/agent: Hub API key created"
      );

      if (requireApproval) {
        // Mark the key inactive until the human owner approves it at the review URL.
        // CLI holds the plainKey in memory; writes it only after approval confirmed.
        await db
          .update(apiKeys)
          .set({ isActive: false })
          .where(eq(apiKeys.id, apiKey.id));
        // Reverse-proxy-safe: prefer the pod's PUBLIC_URL, fall back to request
        // origin. c.req.url picks up the internal (often http://) URL behind nginx.
        const origin = process.env.PUBLIC_URL || new URL(c.req.url).origin;
        // Approval lives in the pod-admin app (operator is already Kratos-authed
        // there), NOT a bare REST page on the API origin. Swap pod.<root> →
        // pod-admin.<root>, mirroring the /admin/connect redirect. The CLI just
        // opens whatever reviewUrl we return, so no client change is needed.
        const reviewUrl = `${toPodAdminOrigin(origin)}/approve-agent/${apiKey.id}?agentType=${encodeURIComponent(agentType)}`;
        return c.json({
          agentUserId,
          workspaceId: ws?.id ?? null,
          hubApiKey: plainKey,
          pendingToken: apiKey.id,
          reviewUrl,
          requiresApproval: true,
          registration: registrationTrace,
        });
      }

      return c.json({
        agentUserId,
        workspaceId: ws?.id ?? null,
        hubApiKey: plainKey,
        keyId: apiKey.id,
        registration: registrationTrace,
      });
    } catch (err) {
      // provisionSurfaceAgentKey throws code NO_HUMAN_OWNER when creator missing
      if (
        err &&
        typeof err === "object" &&
        (err as { code?: string }).code === "NO_HUMAN_OWNER"
      ) {
        return c.json(
          {
            error: "Pod has no human owner yet",
            code: "NO_HUMAN_OWNER",
            detail:
              "An agent key must be linked to a human creator (singleton is creator × agentType).",
          },
          409
        );
      }
      logger.error({ err, agentType, flowId }, "setup/agent: failed");
      return c.json({ error: "Internal server error", flowId }, 500);
    }
  });

  /**
   * POST /setup/service — mint a product-neutral `service` identity.
   *
   * Parallel to /setup/agent but WITHOUT any agent shaping: no `agentType`, no
   * synthetic agent user, no forced scope bundle, no sibling revocation. The
   * minted key is owned directly by a human (the pod owner, or a caller-named
   * human via `linkedUserId`) and authenticates AS that owner — writes are
   * operator-direct (whitelisted verbs apply direct; destructive/non-whitelisted
   * still auto-queue as proposals via the existing governance gate).
   *
   * Body: { workspaceId: string, scopes?: string[], name?: string, linkedUserId?: string }
   * Returns: { serviceKey, keyId, workspaceId, scopes, keyType: "service" }
   */
  app.post("/setup/service", async (c) => {
    const flowId = randomUUID();

    // ── Auth: same gate as /setup/agent (JWT / provisioning token / API key) ──
    const auth = await authenticateServiceSetupRequest(c);
    if (!auth.ok) return auth.response;
    logger.info(
      { authMethod: auth.authMethod },
      "setup/service: authenticated"
    );

    // ── Parse body ────────────────────────────────────────────────────────────
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return c.json({ error: "Invalid request body" }, 400);
    }

    const workspaceId: string | undefined =
      typeof body.workspaceId === "string" && body.workspaceId.trim()
        ? body.workspaceId.trim()
        : undefined;
    if (!workspaceId) {
      return c.json({ error: "workspaceId is required" }, 400);
    }

    const name: string =
      typeof body.name === "string" && body.name.trim()
        ? body.name.trim()
        : "Service Key";

    // body.linkedUserId NAMES the owning human (→ the key's `userId`). It is NOT
    // written to the key's `linkedUserId` column — that stays NULL so no agent
    // remap fires (createAndVerifyServiceKey forces it null).
    const namedOwnerUserId: string | undefined =
      typeof body.linkedUserId === "string" && body.linkedUserId.trim()
        ? body.linkedUserId.trim()
        : undefined;

    // ── Scopes: caller-declared, validated; default MINIMAL (never the agent bundle) ──
    let scopes: ApiKeyScope[];
    if (body.scopes === undefined) {
      scopes = ["hub-protocol.read"];
    } else if (
      Array.isArray(body.scopes) &&
      body.scopes.every((s: unknown) => typeof s === "string")
    ) {
      const invalid = (body.scopes as string[]).filter((s) => !isValidScope(s));
      if (invalid.length > 0) {
        return c.json(
          {
            error: `Invalid scope(s): ${invalid.join(", ")}. Valid scopes: ${API_KEY_SCOPES.join(", ")}`,
          },
          400
        );
      }
      scopes =
        body.scopes.length > 0
          ? (body.scopes as ApiKeyScope[])
          : ["hub-protocol.read"];
    } else {
      return c.json({ error: "scopes must be an array of strings" }, 400);
    }

    try {
      // ── Verify the workspace exists ────────────────────────────────────────
      const ws = await db.query.workspaces.findFirst({
        where: (w, { eq: eqFn }) => eqFn(w.id, workspaceId),
        columns: { id: true },
      });
      if (!ws) {
        return c.json({ error: `Workspace ${workspaceId} not found` }, 404);
      }

      // ── Resolve the owning human ───────────────────────────────────────────
      // Priority: an explicit surface-key caller owns the key it mints; else a
      // caller-named human (body.linkedUserId); else the pod owner.
      let ownerUserId: string | null = null;
      if (auth.authMethod === "api_key_surface" && auth.surfaceKeyUserId) {
        ownerUserId = auth.surfaceKeyUserId;
      } else if (namedOwnerUserId) {
        const named = await db.query.users.findFirst({
          where: eq(users.id, namedOwnerUserId),
          columns: { id: true, userType: true },
        });
        if (!named) {
          return c.json(
            { error: `linkedUserId ${namedOwnerUserId} is not a known user` },
            400
          );
        }
        ownerUserId = named.id;
      } else {
        const humanUser = await db.query.users.findFirst({
          where: (u, { eq: eqFn }) => eqFn(u.userType, "human"),
          columns: { id: true },
        });
        ownerUserId = humanUser?.id ?? null;
      }

      if (!ownerUserId) {
        return c.json(
          { error: "Could not resolve an owning user for the service key" },
          400
        );
      }

      // ── Owner must be a member of the bound workspace ──────────────────────
      const membership = await db.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.userId, ownerUserId),
          eq(workspaceMembers.workspaceId, ws.id)
        ),
        columns: { id: true },
      });
      if (!membership) {
        return c.json(
          {
            error: `User ${ownerUserId} is not a member of workspace ${workspaceId}`,
          },
          403
        );
      }

      // ── Mint the service key — NO sibling revocation (K1 fix) ──────────────
      const eventRepo = new EventRepository(sql);
      const apiKeyRepo = new ApiKeyRepository(db, eventRepo);
      const registration = await createAndVerifyServiceKey(
        apiKeyRepo,
        {
          keyName: name,
          scope: scopes,
          userId: ownerUserId,
          workspaceId: ws.id,
          description: `Product-neutral service key for workspace ${ws.id} — created via ${auth.authMethod}`,
        },
        ownerUserId,
        ownerUserId
      );
      const registrationTrace = toRegistrationTrace(flowId, registration);
      const { apiKey, plainKey } = registration;

      if (registration.outcome !== "CONNECTED_VERIFIED") {
        logger.error(
          {
            flowId,
            ownerUserId,
            workspaceId: ws.id,
            authMethod: auth.authMethod,
            verificationError: registration.verificationError,
          },
          "setup/service: key minted but verification failed"
        );
        return c.json(
          {
            error: "Key minted but verification failed",
            code: "KEY_MINTED_BUT_VERIFICATION_FAILED",
            registration: registrationTrace,
          },
          500
        );
      }

      logger.info(
        {
          ownerUserId,
          keyId: apiKey.id,
          workspaceId: ws.id,
          authMethod: auth.authMethod,
          registration: registrationTrace,
        },
        "setup/service: service key created"
      );

      return c.json({
        serviceKey: plainKey,
        keyId: apiKey.id,
        workspaceId: ws.id,
        scopes,
        keyType: "service" as const,
        registration: registrationTrace,
      });
    } catch (err) {
      logger.error({ err, flowId }, "setup/service: failed");
      return c.json({ error: "Internal server error", flowId }, 500);
    }
  });

  /**
   * Provision an external-service user identity against a parent Hub API key.
   *
   * Mode 1 (header-based): Just call this to pre-provision the mapping.
   *   External service sends X-External-User-Id header on each request.
   *
   * Mode 2 (sub-token): Pass mintSubToken: true.
   *   Returns a one-time plaintext token. Store it per external user.
   *   Use that token directly for all subsequent API calls — no header needed.
   *
   * Idempotent: same (parentKeyId, externalUserId) always returns the same mapping.
   * The token is only returned in plaintext on first mint; subsequent calls return
   * the mapping ID only (retrieve the token from your own storage).
   */
  app.post("/setup/external-user", async (c) => {
    if (!isSubTokenFeatureEnabled()) {
      return c.json(
        {
          error:
            "Per-user sub-token system is disabled on this pod. Set HUB_PROTOCOL_SUB_TOKENS=true to enable.",
        },
        404
      );
    }

    const scopes = (c.get("scopes") as string[] | undefined) ?? [];
    if (
      !scopes.includes("hub-protocol.write") &&
      !scopes.includes("hub-protocol.admin")
    ) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }

    // We need the parent key ID. The middleware only stashes `parentKeyId`
    // when an X-External-User-Id header was forwarded — for the bare
    // /setup/external-user call there's no header, so we recover the parent
    // key ID from the bearer directly. Re-validating the token here is cheap
    // (bcrypt compare is cached at the OS level for a hot key) and keeps the
    // route self-contained.
    const authHeader = c.req.header("authorization") ?? "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : null;
    if (!token) {
      return c.json({ error: "Missing bearer token" }, 401);
    }
    const keyRecord = await apiKeyService.validateApiKey(token);
    if (!keyRecord || !keyRecord.isActive) {
      return c.json({ error: "Invalid or inactive API key" }, 401);
    }
    // Prevent grandchild token minting: sub-tokens (depth≥1) cannot mint further sub-tokens.
    if (keyRecord.parentKeyId !== null && keyRecord.parentKeyId !== undefined) {
      return c.json(
        {
          error:
            "Sub-tokens cannot mint child tokens. Use the root API key to provision external users.",
        },
        403
      );
    }
    const effectiveParentKeyId = keyRecord.id;

    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return c.json({ error: "Invalid request body" }, 400);
    }

    const externalUserId =
      typeof body.externalUserId === "string" ? body.externalUserId.trim() : "";
    if (!externalUserId) {
      return c.json({ error: "externalUserId is required" }, 400);
    }

    const wantsSubToken = body.mintSubToken === true;

    const name =
      typeof body.name === "string" && body.name.trim()
        ? body.name.trim()
        : undefined;
    const email =
      typeof body.email === "string" && body.email.trim()
        ? body.email.trim()
        : undefined;
    // Optional caller-supplied narrower scopes (least-privilege). When
    // omitted, the child inherits the parent's scopes verbatim.
    const requestedScopesRaw = Array.isArray(body.scopes) ? body.scopes : [];
    const requestedScopes = requestedScopesRaw.filter(
      (s: unknown): s is ApiKeyScope => typeof s === "string"
    ) as ApiKeyScope[];

    // ── Mode 2 — mint a real child API key bound to (parent, external user).
    if (wantsSubToken) {
      // 1. Resolve / create the mapping FIRST so we have a synapUserId to
      //    bind the child key to. The mapping row is the canonical link
      //    between the parent and the external user; the child key just
      //    rides on top of it.
      const mapping = await resolveExternalUserMapping(
        effectiveParentKeyId,
        externalUserId,
        {
          parentOwnerUserId: keyRecord.userId,
          source: "setup/external-user",
          displayName: name,
          email,
        }
      );

      if (!mapping) {
        return c.json(
          { error: "Failed to resolve external user mapping" },
          500
        );
      }

      // 2. Idempotent re-mint: if the mapping already has a child key,
      //    return its id WITHOUT a fresh plaintext. The plaintext is
      //    one-shot and only ever returned on first mint — caller is
      //    responsible for persisting it then. Returning `reused: true`
      //    so the caller knows not to expect a `subToken` field.
      const existingMapping = await lookupExternalUserMapping(
        effectiveParentKeyId,
        externalUserId
      );
      if (existingMapping?.childApiKeyId) {
        return c.json({
          synapUserId: mapping.synapUserId,
          externalUserId,
          mappingId: mapping.mappingId,
          subTokenId: existingMapping.childApiKeyId,
          reused: true,
          warning:
            "A sub-token was already minted for this mapping. Plaintext is " +
            "only returned on first mint — if it was lost, revoke the existing " +
            "child key (DELETE on api_keys) and re-call this endpoint.",
        });
      }

      // 3. Mint the child key. Inherits parent's scopes by default, or the
      //    caller can request narrower scopes for least-privilege. Wider
      //    scopes than the parent are rejected by generateApiKey().
      let child: { key: string; keyId: string };
      try {
        child = await apiKeyService.generateApiKey(
          mapping.synapUserId,
          `external:${externalUserId}`,
          requestedScopes, // empty array → inherit parent's scopes
          undefined, // hubId inherited from parent inside generateApiKey
          undefined, // expiresInDays — children expire when the parent does (cascade)
          effectiveParentKeyId
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : "unknown error";
        // Most likely cause: caller asked for scopes wider than parent.
        // Rest of the surface is auth/active-state which we already
        // guarded above — surface the message verbatim, it's safe.
        return c.json({ error: `Sub-token mint failed: ${msg}` }, 400);
      }

      // 4. Link the child key id back onto the mapping row so future
      //    /setup/external-user calls hit the idempotent path above.
      await db
        .update(apiKeyExternalUsers)
        .set({ childApiKeyId: child.keyId })
        .where(eq(apiKeyExternalUsers.id, mapping.mappingId));

      // 5. Return the plaintext ONCE. Caller MUST persist it now — it
      //    cannot be recovered later.
      return c.json({
        synapUserId: mapping.synapUserId,
        externalUserId,
        mappingId: mapping.mappingId,
        subTokenId: child.keyId,
        subToken: child.key,
        reused: false,
        created: mapping.created,
        warning:
          "Plaintext sub-token is returned ONCE. Store it securely now — it " +
          "cannot be retrieved later. Subsequent calls return only the id.",
      });
    }

    // ── Mode 1 (header-based remap) — just provision the mapping ───────────

    // Idempotent: if a mapping already exists, return it.
    const existing = await lookupExternalUserMapping(
      effectiveParentKeyId,
      externalUserId
    );
    if (existing) {
      return c.json({
        synapUserId: existing.synapUserId,
        externalUserId: existing.externalUserId,
        created: false,
        mapping: {
          id: existing.id,
          parentKeyId: existing.parentApiKeyId,
          childApiKeyId: existing.childApiKeyId,
          createdAt: existing.createdAt,
        },
      });
    }

    const mapping = await resolveExternalUserMapping(
      effectiveParentKeyId,
      externalUserId,
      {
        parentOwnerUserId: keyRecord.userId,
        source: "setup/external-user",
        displayName: name,
        email,
      }
    );

    if (!mapping) {
      return c.json(
        { error: "Failed to provision external user mapping" },
        500
      );
    }

    return c.json({
      synapUserId: mapping.synapUserId,
      externalUserId,
      created: mapping.created,
      mapping: {
        id: mapping.mappingId,
        parentKeyId: effectiveParentKeyId,
        childApiKeyId: null,
      },
    });
  });

  // ── GET /setup/status ──────────────────────────────────────────────────────
  //
  // No auth required — safe to expose so the CLI and setup page can detect
  // whether the pod has been bootstrapped yet.
  app.get("/setup/status", async (c) => {
    try {
      // Primary check: Kratos identities (source of truth for auth).
      const kratosHasIdentity = await checkKratosIdentity();

      const [humanResult] = await db
        .select({ count: count() })
        .from(users)
        .where(eq(users.userType, "human"));
      const [wsResult] = await db.select({ count: count() }).from(workspaces);

      const humanCount = Number(humanResult?.count ?? 0);
      const workspaceCount = Number(wsResult?.count ?? 0);

      // Pod-admin invariant — true when there exists a pod-admin system
      // workspace AND at least one owner/admin member with a backing users
      // row. Distinct from `needsSetup`: a pod can have Kratos identities
      // and synap users but a broken pod-admin invariant (e.g. partial
      // wipe), in which case `/admin/*` surfaces 403 even though sign-in
      // works. Eve's post-update probe reads this to surface a recovery
      // command.
      const invariant = await computePodAdminInvariant();

      return c.json({
        hasAdmin: kratosHasIdentity || humanCount > 0,
        workspaceCount,
        needsSetup: !kratosHasIdentity && humanCount === 0,
        podAdminInvariant: invariant,
      });
    } catch (err) {
      logger.error({ err }, "setup/status: failed");
      return c.json({ error: "Internal server error" }, 500);
    }
  });

  // ── POST /setup/magic-link ─────────────────────────────────────────────────
  //
  // Auth: PROVISIONING_TOKEN only.
  // Generates a short-lived JWT the operator pastes into their browser.
  // Guard: if a human user already exists → 409.
  app.post("/setup/magic-link", async (c) => {
    // Auth
    const provisioningToken = process.env.PROVISIONING_TOKEN;
    const authHeader = c.req.header("authorization") ?? "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : null;
    if (!token || !provisioningToken || token !== provisioningToken) {
      return c.json(
        { error: "Unauthorized — PROVISIONING_TOKEN required" },
        401
      );
    }

    // Guard: already has admin? (check Kratos first, then Synap DB fallback)
    const kratosHasIdentity = await checkKratosIdentity();
    const dbHasHuman = Number(
      (
        await db
          .select({ count: count() })
          .from(users)
          .where(eq(users.userType, "human"))
      )?.[0]?.count ?? 0
    );
    if (kratosHasIdentity || dbHasHuman > 0) {
      return c.json({ error: "Admin already exists" }, 409);
    }

    const magicToken = jwt.sign(
      { purpose: "first_admin_setup" },
      provisioningToken,
      { expiresIn: "1h" }
    );

    const publicUrl = process.env.PUBLIC_URL ?? "";
    const url = `${publicUrl}/setup?token=${magicToken}`;
    return c.json({ token: magicToken, url });
  });

  // ── POST /setup/first-admin ────────────────────────────────────────────────
  //
  // Auth: PROVISIONING_TOKEN in header OR magicToken in body.
  // Body: { email, password, name?, magicToken? }
  // Guard: if human users already exist → 409.
  app.post("/setup/first-admin", async (c) => {
    const provisioningToken = process.env.PROVISIONING_TOKEN;

    // Parse body first
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return c.json({ error: "Invalid request body" }, 400);
    }

    const email = typeof body.email === "string" ? body.email.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const name =
      typeof body.name === "string" && body.name.trim()
        ? body.name.trim()
        : email.split("@")[0];
    const magicToken =
      typeof body.magicToken === "string" ? body.magicToken : null;

    if (!email || !password) {
      return c.json({ error: "email and password are required" }, 400);
    }

    // Auth: magic token OR PROVISIONING_TOKEN header
    let authenticated = false;

    if (magicToken) {
      if (!provisioningToken) {
        return c.json(
          { error: "PROVISIONING_TOKEN not configured on pod" },
          500
        );
      }
      try {
        const decoded = jwt.verify(magicToken, provisioningToken, {
          algorithms: ["HS256"],
        }) as Record<string, unknown>;
        if (decoded.purpose === "first_admin_setup") {
          authenticated = true;
        }
      } catch {
        return c.json({ error: "Invalid or expired magic token" }, 401);
      }
    } else {
      const authHeader = c.req.header("authorization") ?? "";
      const token = authHeader.startsWith("Bearer ")
        ? authHeader.slice(7).trim()
        : null;
      if (
        token &&
        provisioningToken &&
        safeTokenEqual(token, provisioningToken)
      ) {
        authenticated = true;
      }
    }

    if (!authenticated) {
      return c.json(
        {
          error:
            "Unauthorized — PROVISIONING_TOKEN or valid magic token required",
        },
        401
      );
    }

    // Guard: admin already exists? (check Kratos first, then Synap DB fallback)
    const kratosHasIdentity = await checkKratosIdentity();
    const dbHasHuman = Number(
      (
        await db
          .select({ count: count() })
          .from(users)
          .where(eq(users.userType, "human"))
      )?.[0]?.count ?? 0
    );
    if (kratosHasIdentity || dbHasHuman > 0) {
      return c.json({ error: "Admin already exists" }, 409);
    }

    try {
      const result = await createAdminUser(email, password, name, {
        createWorkspace: true,
      });

      logger.info(
        { userId: result.userId, workspaceId: result.workspaceId, email },
        "setup/first-admin: first human admin created"
      );

      return c.json({
        userId: result.userId,
        workspaceId: result.workspaceId,
        email,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, email }, "setup/first-admin: createAdminUser failed");
      if (msg.includes("already exists") || msg.includes("duplicate")) {
        return c.json({ error: "Admin user already exists" }, 409);
      }
      return c.json(
        { error: "Failed to create admin user", detail: msg.slice(0, 200) },
        500
      );
    }
  });

  // ── POST /setup/accept-invite ──────────────────────────────────────────────
  //
  // Public endpoint — no auth required. Validates an invite token, creates a
  // Kratos identity + users row for the invitee, accepts the invite (adds
  // workspace membership), and deletes the used token.
  //
  // On success the caller should redirect to /login so the user can sign in.
  app.post("/setup/accept-invite", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return c.json({ error: "Invalid request body" }, 400);
    }

    const email =
      typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const name =
      typeof body.name === "string" && body.name.trim()
        ? body.name.trim()
        : email.split("@")[0];
    const inviteToken =
      typeof body.inviteToken === "string" ? body.inviteToken.trim() : "";

    if (!email || !password || !inviteToken) {
      return c.json(
        { error: "email, password, and inviteToken are required" },
        400
      );
    }
    if (password.length < 8) {
      return c.json({ error: "Password must be at least 8 characters" }, 400);
    }

    const invite = await db.query.invites.findFirst({
      where: eq(invites.token, inviteToken),
    });
    if (!invite)
      return c.json({ error: "Invite not found or already used" }, 404);
    if (invite.expiresAt < new Date())
      return c.json({ error: "Invite has expired" }, 410);
    if (invite.email && invite.email.toLowerCase() !== email) {
      return c.json(
        { error: "This invite was sent to a different email address" },
        403
      );
    }

    // Create Kratos identity. On 409, tell the user to sign in — do NOT reuse
    // an existing identity as that would let an attacker accept an invite on
    // behalf of a user who owns that email.
    let identityId: string;
    try {
      const { data: identity } = await kratosAdmin.createIdentity({
        createIdentityBody: {
          schema_id: "default",
          traits: { email, name },
          credentials: { password: { config: { password } } },
          verifiable_addresses: [
            { value: email, verified: true, via: "email", status: "completed" },
          ],
        },
      });
      identityId = identity.id;
      logger.info(
        { identityId, email },
        "accept-invite: Kratos identity created"
      );
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response
        ?.status;
      if (status === 409) {
        // Identity already exists. Two stale cases we can safely clean up:
        //   A) users row exists + no workspace memberships (removed without cleanup)
        //   B) orphaned Kratos identity with no users row at all
        // Active accounts (has memberships) keep the security guard.
        const existingUser = await db.query.users.findFirst({
          where: eq(users.email, email),
          columns: { id: true },
        });

        let kratosIdentityId: string | null = existingUser?.id ?? null;

        if (!existingUser) {
          // Orphaned identity — look it up in Kratos directly.
          const { data: matches } = await kratosAdmin.listIdentities({
            credentialsIdentifier: email,
            pageSize: 1,
          });
          kratosIdentityId = matches?.[0]?.id ?? null;
        }

        const hasActiveMembership =
          existingUser &&
          !!(await db.query.workspaceMembers.findFirst({
            where: eq(workspaceMembers.userId, existingUser.id),
            columns: { workspaceId: true },
          }));

        const isStale = kratosIdentityId && !hasActiveMembership;

        if (isStale) {
          try {
            await kratosAdmin.deleteIdentity({ id: kratosIdentityId! });
            if (existingUser) {
              await db.delete(users).where(eq(users.id, existingUser.id));
            }
          } catch (cleanupErr) {
            logger.warn(
              { cleanupErr, email },
              "accept-invite: stale identity cleanup failed"
            );
            return c.json({ error: "Failed to clean up stale account" }, 500);
          }
          // Retry identity creation with the new credentials.
          try {
            const { data: identity } = await kratosAdmin.createIdentity({
              createIdentityBody: {
                schema_id: "default",
                traits: { email, name },
                credentials: { password: { config: { password } } },
                verifiable_addresses: [
                  {
                    value: email,
                    verified: true,
                    via: "email",
                    status: "completed",
                  },
                ],
              },
            });
            identityId = identity.id;
            logger.info(
              { identityId, email },
              "accept-invite: stale identity replaced"
            );
          } catch (retryErr) {
            const msg =
              retryErr instanceof Error ? retryErr.message : String(retryErr);
            logger.error(
              { retryErr, email },
              "accept-invite: createIdentity retry failed"
            );
            return c.json(
              { error: "Failed to create account", detail: msg.slice(0, 200) },
              500
            );
          }
        } else {
          return c.json(
            {
              error:
                "An account with this email already exists. Use the Sign in tab to accept the invite.",
            },
            409
          );
        }
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error({ err, email }, "accept-invite: createIdentity failed");
        return c.json(
          { error: "Failed to create account", detail: msg.slice(0, 200) },
          500
        );
      }
    }

    await ensureUserRow(identityId, email, name);

    // Accept invite: add workspace membership (workspace or all-pod).
    if (invite.type === "workspace" && invite.workspaceId) {
      const alreadyMember = await db.query.workspaceMembers.findFirst({
        where: and(
          eq(workspaceMembers.workspaceId, invite.workspaceId),
          eq(workspaceMembers.userId, identityId)
        ),
      });
      if (!alreadyMember) {
        await db.insert(workspaceMembers).values({
          workspaceId: invite.workspaceId,
          userId: identityId,
          role: invite.role as "owner" | "editor" | "viewer",
        });
      }
    } else {
      const allWorkspaces = await db.query.workspaces.findMany({
        columns: { id: true },
      });
      for (const ws of allWorkspaces) {
        const alreadyMember = await db.query.workspaceMembers.findFirst({
          where: and(
            eq(workspaceMembers.workspaceId, ws.id),
            eq(workspaceMembers.userId, identityId)
          ),
        });
        if (!alreadyMember) {
          await db.insert(workspaceMembers).values({
            workspaceId: ws.id,
            userId: identityId,
            role: invite.role as "owner" | "editor" | "viewer",
          });
        }
      }
    }

    await db.delete(invites).where(eq(invites.id, invite.id));
    logger.info(
      { identityId, email, inviteId: invite.id },
      "accept-invite: account created and invite accepted"
    );

    return c.json({ userId: identityId, success: true });
  });

  // ─── Pending-approval flow (requireApproval: true in POST /setup/agent) ──────
  // CLI creates key as isActive=false, opens browser to /review, polls for status.

  /**
   * Resolve the Kratos browser session to a POD user id (or null). The
   * pending-agent decider is authorized against this — not merely "someone is
   * signed in".
   */
  async function resolveKratosPodUserId(c: {
    req: { header(name: string): string | undefined };
  }): Promise<string | null> {
    try {
      const { getSession } = await import("@synap/auth");
      const headers = new Headers();
      const cookie = c.req.header("cookie");
      const sessionToken = c.req.header("x-session-token");
      if (cookie) headers.set("cookie", cookie);
      if (sessionToken) headers.set("x-session-token", sessionToken);
      const session = await getSession(headers);
      const kratosId = session?.identity?.id;
      if (!kratosId) return null;
      const user = await db.query.users.findFirst({
        where: eq(users.kratosIdentityId, kratosId),
        columns: { id: true },
      });
      return user?.id ?? null;
    } catch {
      return null;
    }
  }

  /**
   * GOVERNANCE gate for deciding a pending agent connection: only the human the
   * connection acts for (its `linkedUserId`) OR a pod admin may approve/reject —
   * NOT any signed-in member. Reuses the canonical `assertPodAdmin` door.
   */
  async function canDecidePendingConnection(
    approverId: string,
    linkedUserId: string | null
  ): Promise<boolean> {
    if (linkedUserId && linkedUserId === approverId) return true;
    try {
      await assertPodAdmin(approverId);
      return true;
    } catch {
      return false;
    }
  }

  /** Poll for approval status — authenticated with the human hub-protocol key. */
  app.get("/setup/agent/pending/:keyId", async (c) => {
    const keyId = c.req.param("keyId");
    const authHeader = c.req.header("authorization") ?? "";
    const token = authHeader.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : null;
    if (!token) return c.json({ error: "Unauthorized" }, 401);
    const keyRecord = await apiKeyService.validateApiKey(token);
    if (!keyRecord) return c.json({ error: "Unauthorized" }, 401);

    const key = await db.query.apiKeys.findFirst({
      where: eq(apiKeys.id, keyId),
      columns: { id: true, isActive: true, revokedAt: true },
    });
    if (!key) return c.json({ error: "Not found" }, 404);
    if (key.revokedAt) return c.json({ status: "rejected" });
    if (key.isActive) return c.json({ status: "active" });
    return c.json({ status: "pending" });
  });

  /** HTML review page opened by the CLI in the user's browser. */
  app.get("/setup/agent/pending/:keyId/review", async (c) => {
    const keyId = c.req.param("keyId");
    const agentType = escapeHtml(c.req.query("agentType") ?? "agent");
    const keyShort = escapeHtml(keyId.slice(0, 8));

    const html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Approve Agent Access — Synap</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#0a0a0a;color:#e2e2e2;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
.card{background:#111;border:1px solid #222;border-radius:14px;padding:36px;max-width:460px;width:100%}
h1{font-size:18px;font-weight:600;margin-bottom:6px}
.sub{color:#777;font-size:14px;line-height:1.5;margin-bottom:24px}
.detail{background:#161616;border:1px solid #222;border-radius:8px;padding:16px;margin-bottom:24px}
.row{display:flex;justify-content:space-between;align-items:center;font-size:13px;padding:5px 0;border-bottom:1px solid #1c1c1c}
.row:last-child{border:none}
.label{color:#666}.value{color:#e2e2e2;font-family:ui-monospace,monospace;font-size:12px}
.scopes{font-size:11px;color:#555;margin-top:10px;line-height:1.6}
.actions{display:flex;gap:10px}
button{flex:1;padding:11px;border-radius:8px;border:none;font-size:14px;font-weight:500;cursor:pointer;transition:opacity .15s}
button:hover{opacity:.85}.approve{background:#059669;color:#fff}.reject{background:#1a1a1a;color:#e2e2e2;border:1px solid #2a2a2a}
.msg{text-align:center;padding:14px 0;font-size:14px;display:none}
.ok{color:#059669}.err{color:#dc2626}
</style></head><body>
<div class="card">
  <h1>Approve Agent Access</h1>
  <p class="sub">A <code>synap connect</code> session is requesting to register <strong>${agentType}</strong> as an agent on your pod.</p>
  <div class="detail">
    <div class="row"><span class="label">Surface</span><span class="value">${agentType}</span></div>
    <div class="row"><span class="label">Key ID</span><span class="value">${keyShort}…</span></div>
    <div class="scopes">Scopes: hub-protocol.read · hub-protocol.write · mcp.read · mcp.write</div>
  </div>
  <div class="actions" id="actions">
    <button class="approve" onclick="act('approve')">Approve</button>
    <button class="reject" onclick="act('reject')">Reject</button>
  </div>
  <div class="msg ok" id="ok">Approved — you can close this tab. The CLI will continue automatically.</div>
  <div class="msg err" id="err"></div>
</div>
<script>
async function act(action){
  try{
    const r=await fetch(location.pathname.replace('/review','/'+action),{method:'POST',headers:{'Content-Type':'application/json'}});
    if(r.ok){document.getElementById('actions').style.display='none';document.getElementById('ok').style.display='block';}
    else{const d=await r.json().catch(()=>({}));show('err',d.error||'Error ('+r.status+')');}
  }catch(e){show('err',e.message);}
}
function show(id,msg){const el=document.getElementById(id);el.textContent=msg;el.style.display='block';}
</script></body></html>`;
    return c.html(html);
  });

  /** Approve a pending key — only the connection's linked human, or a pod admin. */
  app.post("/setup/agent/pending/:keyId/approve", async (c) => {
    const keyId = c.req.param("keyId");
    const approverId = await resolveKratosPodUserId(c);
    if (!approverId) return c.json({ error: "Sign in to your pod first" }, 401);

    const key = await db.query.apiKeys.findFirst({
      where: and(eq(apiKeys.id, keyId), eq(apiKeys.isActive, false)),
      columns: { id: true, revokedAt: true, linkedUserId: true },
    });
    if (!key || key.revokedAt)
      return c.json(
        { error: "Pending key not found or already processed" },
        404
      );

    if (!(await canDecidePendingConnection(approverId, key.linkedUserId)))
      return c.json({ error: "Not authorized to decide this connection" }, 403);

    await db
      .update(apiKeys)
      // Only flip a still-PENDING key — guard against a concurrent reject
      // resurrecting a revoked key (matches the reject handler's compound where).
      .set({ isActive: true })
      .where(and(eq(apiKeys.id, keyId), eq(apiKeys.isActive, false)));
    logger.info({ keyId, approverId }, "setup/agent/pending: approved");
    return c.json({ ok: true });
  });

  /** Reject a pending key — only the connection's linked human, or a pod admin. */
  app.post("/setup/agent/pending/:keyId/reject", async (c) => {
    const keyId = c.req.param("keyId");
    const approverId = await resolveKratosPodUserId(c);
    if (!approverId) return c.json({ error: "Sign in to your pod first" }, 401);

    const key = await db.query.apiKeys.findFirst({
      where: and(eq(apiKeys.id, keyId), eq(apiKeys.isActive, false)),
      columns: { id: true, revokedAt: true, linkedUserId: true },
    });
    if (!key || key.revokedAt)
      return c.json(
        { error: "Pending key not found or already processed" },
        404
      );

    if (!(await canDecidePendingConnection(approverId, key.linkedUserId)))
      return c.json({ error: "Not authorized to decide this connection" }, 403);

    await db
      .update(apiKeys)
      .set({ isActive: false, revokedAt: new Date() })
      .where(and(eq(apiKeys.id, keyId), eq(apiKeys.isActive, false)));
    logger.info({ keyId, approverId }, "setup/agent/pending: rejected");
    return c.json({ ok: true });
  });
}
