/**
 * API Keys Router
 *
 * Synchronous CRUD with inline permission checks and bcrypt hashing.
 * SECURITY: Keys are displayed ONCE and never stored in plaintext.
 */

import {
  router,
  protectedProcedure,
  podAdminProcedure,
  workspaceProcedure,
  credentialProcedure,
  requireFreshAuthentication,
} from "../trpc.js";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { integrationKindSchema } from "@synap-core/types";
import { isAppPublicId } from "@synap-core/types/membrane";
import { API_KEY_SCOPES } from "@synap/database/schema";
import {
  db,
  and,
  eq,
  or,
  inArray,
  getDb,
  EventRepository,
  ApiKeyRepository,
  GrantRepository,
  GrantRoleRepository,
  isNull,
  type KeyReach,
  sql,
} from "@synap/database";
import { revokeApiKeys } from "@synap/database/api-key-revocation";
import { resolveKeyExpiry } from "@synap/governance-policy/grants";
import {
  ExpiresInDaysSchema,
  GrantInputSchema,
  assertGrantInput,
  attachFullAccessGrant,
  attachGrantOrRevoke,
  clipHostedAgentGrants,
} from "../services/key-grant.js";
import {
  apiKeys,
  grants,
  workspaceMembers,
  mcpConnectCodes,
  users,
  apps,
} from "@synap/database/schema";
import { MACHINE_AGENT_TYPE } from "@synap-core/types/agents";
import {
  checkPermissionOrPropose,
  proposedMessageFor,
} from "../utils/permission-check.js";
import { auditLog } from "../utils/audit-log.js";
import { emitSideEffects } from "@synap/events";
import { randomUUID, randomBytes, createHash } from "crypto";
import {
  INTEGRATION_HUB_SCOPES,
  integrationHubId,
} from "../services/hub-integration-registration.js";
import { createAndVerifyHubInboundKey } from "../services/external-registration.js";
import { toRegistrationTrace } from "../services/external-registration.js";
import {
  AuthorizeUserError,
  ReauthenticationRequiredError,
  PodCredentialRequiredError,
  decideOAuthAuthorization,
  getOAuthConsentContext,
} from "./oauth/consent.js";
import { OAuthError } from "./oauth/protocol.js";
import { logOAuthRefusal } from "./oauth/refusal-log.js";
import { isPodAdminOrigin } from "../utils/pod-admin-origin.js";
import { findUserDefaultWorkspaceId } from "../utils/user-default-workspace.js";
import { assertSignedInPerson } from "../utils/signed-in-person.js";
import {
  decideDeviceRequest,
  getDeviceRequest,
  readMachineDefaults,
  setMachineKeyTtlDays,
} from "../services/machine-connect.js";

/**
 * A device decision is a PERSON's, in their own session (cookie or session
 * token) — never a key's: an agent or computer key cannot approve a computer.
 */
const APPROVE_COMPUTER_SIGNED_IN = "Approve a computer while signed in.";

/**
 * The authorize parameters pod-admin's consent screen round-trips.
 *
 * Bounded lengths only — the SEMANTIC validation (does this client exist? is
 * this redirect_uri registered to it? is the challenge a well-formed S256
 * value?) deliberately lives in `oauth/consent.ts`, which re-derives everything
 * from the stored client. Duplicating those rules here as Zod refinements would
 * create a second place for them to drift.
 */
const oauthAuthorizeParamsSchema = z.object({
  // A DCR id (`dcr_…`) or a pod app's metadata-document URL (≤ 512, CIMD).
  clientId: z.string().min(1).max(512),
  redirectUri: z.string().min(1).max(2048),
  responseType: z.string().max(64).optional(),
  scope: z.string().max(1024).optional(),
  state: z.string().max(2048).optional(),
  codeChallenge: z.string().max(256).optional(),
  codeChallengeMethod: z.string().max(64).optional(),
  // RFC 8707; validated against this pod's resources in oauth/consent.ts.
  resource: z.string().max(2048).optional(),
  // OIDC step-up: `max_age` (seconds) and `prompt=login` ask for a FRESH
  // sign-in before the decision (oauth/consent.ts reauthenticationRequired).
  maxAge: z.union([z.number().int().min(0), z.string().max(16)]).optional(),
  prompt: z.string().max(32).optional(),
  // /authorize's signed request time (`auth_req`), for
  // `prompt=login` / `max_age=0`.
  authRequest: z.string().max(128).optional(),
});

/**
 * Map an OAuth-layer failure to a tRPC error the consent screen can render.
 *
 * `AuthorizeUserError` means the request itself is unusable (unknown client,
 * unregistered redirect_uri, non-human caller) — BAD_REQUEST. `OAuthError`
 * carries a protocol error code the screen shows verbatim. Anything else
 * propagates unchanged so a genuine bug is never disguised as a client error.
 * Each of the two is a refusal, logged once (review A6), as is a FORBIDDEN
 * refusal of who decides (the app is not for this person). A sign-in step-up
 * is no refusal: the screen sends the person to sign in again.
 */
function toConsentTrpcError(err: unknown, clientId: string): unknown {
  if (
    err instanceof ReauthenticationRequiredError ||
    err instanceof PodCredentialRequiredError
  ) {
    // The screen reads the code and sends the person to sign in again.
    return new TRPCError({
      code: "FORBIDDEN",
      message: err.message,
      cause: { reasonCode: err.reasonCode },
    });
  }
  if (err instanceof AuthorizeUserError) {
    logOAuthRefusal({
      phase: "consent",
      clientId,
      reason: err.reason,
      detail: err.message,
    });
    return new TRPCError({ code: "BAD_REQUEST", message: err.message });
  }
  if (err instanceof OAuthError) {
    logOAuthRefusal({
      phase: "consent",
      clientId,
      reason: err.code,
      code: err.code,
      detail: err.message,
    });
    return new TRPCError({
      code: "BAD_REQUEST",
      message: `${err.code}: ${err.message}`,
    });
  }
  if (err instanceof TRPCError && err.code === "FORBIDDEN") {
    logOAuthRefusal({
      phase: "consent",
      clientId,
      reason: "forbidden",
      detail: err.message,
    });
  }
  return err;
}

/**
 * Generate API key with proper prefix
 */
function generateApiKey(prefix: string): string {
  const randomPart = randomBytes(32).toString("hex");
  return `${prefix}${randomPart}`;
}

/**
 * What each key may touch, keyed by key id — ONE read for every key list
 * (personal + workspace), so both screens say the same thing.
 */
const UNGRANTED: KeyReach = { access: "ungranted", grants: [] };
async function loadKeyReach(keyIds: readonly string[]) {
  const reach = await new GrantRepository(db).reachForKeys(keyIds);
  return (keyId: string) => {
    const { access, grants } = reach.get(keyId) ?? UNGRANTED;
    return { access, grants };
  };
}

/**
 * WHO holds a key, as a key list names it. The key's own `keyType` cannot say:
 * an app key (`app-connect.ts`), a computer key (`machine-connect.ts`) and a
 * person's own token are ALL `user_pat` — only the holder tells them apart.
 *
 *   app      — the holder is some app's own agent principal (`apps.agent_user_id`,
 *              the same fact `notAnAppAgent` reads); `name` is the app's.
 *   computer — an agent user with `agent_type = 'machine'`.
 *   agent    — any other agent user.
 *   person   — a human.
 * `null` = the holder row is gone.
 */
export interface KeyHolder {
  kind: "app" | "computer" | "agent" | "person";
  name: string | null;
  /** An app holder's `public_id` — what its console page is keyed by. */
  appId?: string;
}

async function loadKeyHolders(userIds: readonly string[]) {
  const ids = [...new Set(userIds)];
  const [holders, appRows] = ids.length
    ? await Promise.all([
        db
          .select({
            id: users.id,
            name: users.name,
            userType: users.userType,
            agentType: users.agentType,
          })
          .from(users)
          .where(inArray(users.id, ids)),
        db
          .select({
            agentUserId: apps.agentUserId,
            name: apps.name,
            publicId: apps.publicId,
          })
          .from(apps)
          .where(inArray(apps.agentUserId, ids)),
      ])
    : [[], []];
  const appOf = new Map(appRows.map((a) => [a.agentUserId, a]));
  const byId = new Map<string, KeyHolder>();
  for (const u of holders) {
    const app = appOf.get(u.id);
    byId.set(
      u.id,
      app !== undefined
        ? { kind: "app", name: app.name, appId: app.publicId }
        : u.userType !== "agent"
          ? { kind: "person", name: u.name }
          : u.agentType === MACHINE_AGENT_TYPE
            ? { kind: "computer", name: u.name }
            : { kind: "agent", name: u.name }
    );
  }
  return (userId: string): KeyHolder | null => byId.get(userId) ?? null;
}

/**
 * An OLD CLI-style key that ACTS AS YOU (MACHINE-IDENTITY-PLAN §0: kept,
 * flagged, offered a replacement): a Hub key minted for an integration
 * (`connectIntegration` — `hub_inbound`, `hubId` `integration:<kind>`) that you
 * hold yourself. Its calls are yours, ungoverned; a computer connected through
 * the device flow writes as itself instead. Agent-held keys (a computer's, an
 * agent's) never qualify — they are not you.
 */
export function keyActsAsYou(
  key: { userId: string; keyType: string; hubId: string | null },
  viewerId: string
): boolean {
  return (
    key.userId === viewerId &&
    key.keyType === "hub_inbound" &&
    !!key.hubId?.startsWith("integration:")
  );
}

export const apiKeysRouter = router({
  /**
   * The canonical set of scopes a key may carry — the SAME `API_KEY_SCOPES` the
   * `create` mutation validates against. The key-creation UI renders its scope
   * options from this so it can never drift out of sync with the backend
   * validator (which is exactly how the phantom `sync` scope shipped).
   */
  availableScopes: protectedProcedure.query(() => {
    return { scopes: API_KEY_SCOPES as readonly string[] };
  }),

  /**
   * List API keys for the current user
   */
  list: protectedProcedure.query(async ({ ctx }) => {
    // The keys you hold AND the keys your agents hold for you (`linkedUserId`).
    // Agent keys are owned by the agent user, so a `userId`-only floor hid every
    // connected agent and OAuth client from /my-connections (D6, 2026-10-06).
    const keys = await db.query.apiKeys.findMany({
      where: or(
        eq(apiKeys.userId, ctx.userId),
        eq(apiKeys.linkedUserId, ctx.userId)
      ),
      orderBy: (apiKeys, { desc }) => [desc(apiKeys.createdAt)],
    });

    // W1 — what each key may touch, for the connections screen.
    const [reachOf, holderOf] = await Promise.all([
      loadKeyReach(keys.map((k) => k.id)),
      loadKeyHolders(keys.map((k) => k.userId)),
    ]);

    // Remove sensitive fields (keyHash)
    return keys.map((key) => ({
      id: key.id,
      keyName: key.keyName,
      keyPrefix: key.keyPrefix,
      keyType: key.keyType,
      hubId: key.hubId,
      linkedUserId: key.linkedUserId,
      /** True when an agent acting for you holds this key, not you. */
      heldByAgent: key.userId !== ctx.userId,
      /** Who holds it: you, or the agent user acting for you (its holder page). */
      holderUserId: key.userId,
      /** What holds it — an app, a computer, an agent or a person (`KeyHolder`). */
      holder: holderOf(key.userId),
      /** An old CLI key whose calls are yours (`keyActsAsYou`): replace it with a computer. */
      actsAsYou: keyActsAsYou(key, ctx.userId),
      /** What this key may touch: `access` + every live grant. */
      ...reachOf(key.id),
      scope: key.scope,
      isActive: key.isActive,
      expiresAt: key.expiresAt,
      lastUsedAt: key.lastUsedAt,
      usageCount: key.usageCount,
      createdAt: key.createdAt,
      /** Stamped by every revoke (`revokeApiKeys`); null = not revoked. */
      revokedAt: key.revokedAt,
      revokedReason: key.revokedReason,
      /**
       * Switched off but never revoked: an agent key waiting for the person's
       * approval (`setup/agent` with requireApproval). It cannot call yet.
       */
      awaitingApproval: !key.isActive && key.revokedAt === null,
    }));
  }),

  /**
   * Admin: list all API keys on the pod (pod-admin only).
   * When `workspaceId` is set, returns only the keys confined to that space
   * (their own `workspaceId`, set by `createForWorkspace` /
   * `adminCreateServiceKey`). A member's pod-wide key is not a key of the
   * space, even though it can reach it — it is listed on the Keys page.
   */
  adminListAll: podAdminProcedure
    .input(z.object({ workspaceId: z.string().uuid().optional() }).optional())
    .query(async ({ input }) => {
      const workspaceId = input?.workspaceId;
      const keys = await db.query.apiKeys.findMany({
        where: workspaceId ? eq(apiKeys.workspaceId, workspaceId) : undefined,
        orderBy: (apiKeys, { desc }) => [desc(apiKeys.createdAt)],
      });
      const holderOf = await loadKeyHolders(keys.map((k) => k.userId));

      return keys.map((key) => ({
        id: key.id,
        userId: key.userId,
        /** What holds it — an app, a computer, an agent or a person (`KeyHolder`). */
        holder: holderOf(key.userId),
        keyName: key.keyName,
        keyPrefix: key.keyPrefix,
        keyType: key.keyType,
        hubId: key.hubId,
        linkedUserId: key.linkedUserId,
        /** The space the key is confined to (`createForWorkspace`); null = pod-wide. */
        workspaceId: key.workspaceId,
        scope: key.scope,
        isActive: key.isActive,
        expiresAt: key.expiresAt,
        lastUsedAt: key.lastUsedAt,
        usageCount: key.usageCount,
        createdAt: key.createdAt,
        createdBy: key.createdBy,
        revokedAt: key.revokedAt,
        revokedReason: key.revokedReason,
      }));
    }),

  /**
   * Create a new API key
   *
   * SECURITY: The key is displayed ONCE and cannot be retrieved later.
   */
  create: credentialProcedure
    .input(
      z.object({
        keyName: z.string().min(1).max(100),
        scope: z
          .array(z.enum([...API_KEY_SCOPES] as [string, ...string[]]))
          .min(1),
        hubId: z.string().optional(),
        // Omitted → 90 days; a number → that many; null → never (W1f).
        expiresInDays: ExpiresInDaysSchema,
        workspaceId: z.string().uuid().optional(),
        /** What the key may touch. Required: a key without one touches nothing. */
        grant: GrantInputSchema,
      })
    )
    .mutation(async ({ input, ctx }) => {
      const id = randomUUID();
      assertGrantInput(input.grant);

      // 1. Permission check
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        subjectType: "apiKey",
        action: "create",
        // The approval half (`executors/workspace.ts`, key `apiKey/create`)
        // re-runs THIS mutation as the approver, so the gate must carry every
        // argument that shapes the minted key. Storing only `{ id, keyName }`
        // was the "approved create materializes an empty shell" defect in its
        // sharpest form: `scope` is REQUIRED by the input schema, so the
        // executor could not even call the door. `workspaceId` is not stored —
        // it is already the proposal row's own `workspace_id`.
        data: {
          id,
          keyName: input.keyName,
          scope: input.scope,
          ...(input.hubId ? { hubId: input.hubId } : {}),
          ...(input.expiresInDays !== undefined
            ? { expiresInDays: input.expiresInDays }
            : {}),
          grant: input.grant,
        },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return {
          id,
          key: null as unknown as string,
          keyPrefix: "",
          status: "proposed" as const,
          proposalId: perm.proposalId,
        };
      }

      // Determine key prefix
      const keyPrefix = input.hubId
        ? process.env.NODE_ENV === "production"
          ? "synap_hub_live_"
          : "synap_hub_test_"
        : "synap_user_";

      // Generate key (plaintext - will be hashed in repository)
      const key = generateApiKey(keyPrefix);

      // Expiration: omitted → 90 days, a number → that many, null → never.
      const expiresAt = resolveKeyExpiry(input.expiresInDays);

      // 2. Direct DB operation via repository (handles bcrypt hashing)
      const database = await getDb();
      const eventRepo = new EventRepository(sql);
      const apiKeyRepo = new ApiKeyRepository(database, eventRepo);

      const apiKey = await apiKeyRepo.create(
        {
          keyName: input.keyName,
          keyPrefix,
          key,
          hubId: input.hubId,
          scope: input.scope,
          expiresAt: expiresAt ?? undefined,
          userId: ctx.userId,
          keyType: input.hubId ? "hub_inbound" : "user_pat",
        },
        ctx.userId
      );

      await attachGrantOrRevoke({
        apiKeyId: apiKey.id,
        principalUserId: ctx.userId,
        onBehalfOf: ctx.userId,
        grant: input.grant,
        expiresAt,
        createdBy: ctx.userId,
      });

      // 3. Audit log
      auditLog({
        subjectType: "apiKey",
        action: "create",
        phase: "completed",
        subjectId: apiKey.id,
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        data: { keyName: input.keyName, keyPrefix },
      });

      // 4. Side-effects
      emitSideEffects({
        subjectType: "apiKey",
        action: "create",
        subjectId: apiKey.id,
        userId: ctx.userId,
        workspaceId: input.workspaceId,
      });

      // Return key ONLY once (never stored in plaintext)
      return {
        id: apiKey.id,
        key, // Displayed ONCE
        keyPrefix,
        status: "created" as const,
        message: "Save this key securely. It will not be displayed again.",
      };
    }),

  /**
   * Revoke an API key
   */
  revoke: protectedProcedure
    .input(
      z.object({
        keyId: z.string().uuid(),
        reason: z.string().optional(),
        workspaceId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Verify ownership
      const key = await db.query.apiKeys.findFirst({
        where: eq(apiKeys.id, input.keyId),
      });

      // Yours, or held by an agent acting for you (the keys `list` shows).
      if (
        !key ||
        (key.userId !== ctx.userId && key.linkedUserId !== ctx.userId)
      ) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "API key not found",
        });
      }

      // 1. Permission check
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        subjectType: "apiKey",
        action: "delete",
        data: { id: input.keyId },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return { status: "proposed" as const, proposalId: perm.proposalId };
      }

      // 2. Direct DB operation via repository
      const database = await getDb();
      const eventRepo = new EventRepository(sql);
      const apiKeyRepo = new ApiKeyRepository(database, eventRepo);

      await apiKeyRepo.revoke(input.keyId, ctx.userId, input.reason);

      // 3. Audit log
      auditLog({
        subjectType: "apiKey",
        action: "revoke",
        phase: "completed",
        subjectId: input.keyId,
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        data: { reason: input.reason },
      });

      // 4. Side-effects
      emitSideEffects({
        subjectType: "apiKey",
        action: "revoke",
        subjectId: input.keyId,
        userId: ctx.userId,
        workspaceId: input.workspaceId,
      });

      return {
        status: "revoked" as const,
      };
    }),

  /**
   * Rotate an API key (create new, revoke old)
   */
  rotate: credentialProcedure
    .input(
      z.object({
        keyId: z.string().uuid(),
        workspaceId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Verify ownership
      const oldKey = await db.query.apiKeys.findFirst({
        where: eq(apiKeys.id, input.keyId),
      });

      if (!oldKey || oldKey.userId !== ctx.userId) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "API key not found",
        });
      }

      // 1. Permission check
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        subjectType: "apiKey",
        action: "update",
        data: { id: input.keyId },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return {
          id: null as unknown as string,
          key: null as unknown as string,
          keyPrefix: "",
          status: "proposed" as const,
          proposalId: perm.proposalId,
        };
      }

      // Generate new key
      const newKey = generateApiKey(oldKey.keyPrefix);

      // 2. Direct DB operation via repository (handles bcrypt + revoke old)
      const database = await getDb();
      const eventRepo = new EventRepository(sql);
      const apiKeyRepo = new ApiKeyRepository(database, eventRepo);

      const newApiKey = await apiKeyRepo.rotate(
        input.keyId,
        newKey,
        ctx.userId
      );

      // 3. Audit log
      auditLog({
        subjectType: "apiKey",
        action: "rotate",
        phase: "completed",
        subjectId: newApiKey.id,
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        data: { rotatedFromId: input.keyId },
      });

      // 4. Side-effects
      emitSideEffects({
        subjectType: "apiKey",
        action: "rotate",
        subjectId: newApiKey.id,
        userId: ctx.userId,
        workspaceId: input.workspaceId,
      });

      return {
        id: newApiKey.id,
        key: newKey, // Displayed ONCE
        keyPrefix: oldKey.keyPrefix,
        status: "rotated" as const,
        message: "Save this new key securely. It will not be displayed again.",
      };
    }),

  /**
   * Replace what a LIVE key may touch — its owner, signed in, on the key's
   * own page. One grant set per key (`GrantRepository.attachMany` revokes the
   * previous set in the same transaction), and the key's bound is resolved per
   * request (`resolveKeyIdentity`), so a narrowing refuses the next call.
   *
   * Signed-in session only: a key cannot reshape its own access, and a
   * proposal replay (no session) cannot reach it. Owner = the key's holder or
   * the person an agent-held key acts for (the keys `list` shows). An app's
   * key is changed on the app's page, where its approved requests live.
   */
  setGrants: credentialProcedure
    .input(
      z.object({
        keyId: z.string().uuid(),
        grants: z.array(GrantInputSchema).min(1).max(64),
      })
    )
    .mutation(async ({ input, ctx }) => {
      if (!ctx.session || ctx.keyType || ctx.agentUserId || ctx.isHubProtocol) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Change a key's access while signed in.",
        });
      }
      const key = await db.query.apiKeys.findFirst({
        where: eq(apiKeys.id, input.keyId),
      });
      if (
        !key ||
        (key.userId !== ctx.userId && key.linkedUserId !== ctx.userId)
      ) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "API key not found",
        });
      }
      if (
        !key.isActive ||
        key.revokedAt ||
        (key.expiresAt && key.expiresAt.getTime() <= Date.now())
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This key no longer works — there is nothing to change.",
        });
      }
      const [appGrant] = await db
        .select({ clientId: grants.clientId })
        .from(grants)
        .where(and(eq(grants.apiKeyId, key.id), isNull(grants.revokedAt)))
        .limit(1);
      if (isAppPublicId(appGrant?.clientId)) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "This key belongs to an app — change its access on the app's page.",
        });
      }
      for (const grant of input.grants) {
        assertGrantInput(grant);
        if (
          grant.roleId &&
          !(await new GrantRoleRepository(db).findOwned(
            ctx.userId,
            grant.roleId
          ))
        ) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "That role is not one of yours.",
          });
        }
      }

      await new GrantRepository(db).attachMany(
        input.grants.map((grant) => ({
          apiKeyId: key.id,
          principalUserId: key.userId,
          onBehalfOf: key.linkedUserId ?? key.userId,
          permissions: grant.permissions,
          workspaceIds: grant.workspaceIds ?? null,
          projectIds: grant.projectIds ?? null,
          entityIds: grant.entityIds ?? null,
          expiresAt: key.expiresAt ?? null,
          label: grant.label ?? null,
          roleId: grant.roleId ?? null,
          createdBy: ctx.userId,
        }))
      );
      // A hosted agent's key stays within its computer; a computer's change
      // re-clips the agents it hosts (MACHINE-IDENTITY-PLAN §2c).
      await clipHostedAgentGrants(key.userId, ctx.userId);

      auditLog({
        subjectType: "apiKey",
        action: "update",
        phase: "completed",
        subjectId: key.id,
        userId: ctx.userId,
        data: {
          grants: input.grants.map((g) => ({
            permissions: g.permissions,
            workspaceIds: g.workspaceIds ?? null,
          })),
        },
      });
      emitSideEffects({
        subjectType: "apiKey",
        action: "update",
        subjectId: key.id,
        userId: ctx.userId,
      });

      const reach = await loadKeyReach([key.id]);
      return { status: "updated" as const, ...reach(key.id) };
    }),

  /**
   * DEVICE DOOR — review (MACHINE-IDENTITY-PLAN W2). pod-admin `/device`
   * (and Relay, with its session token) reads the waiting computer by the
   * code the terminal shows. Signed-in session only: a key never approves a
   * computer. A code that matches nothing counts against the person (5 per
   * 10 min, then TOO_MANY_REQUESTS).
   */
  getDeviceRequest: credentialProcedure
    .input(z.object({ userCode: z.string().min(4).max(32) }))
    .query(async ({ ctx, input }) => {
      assertSignedInPerson(ctx, APPROVE_COMPUTER_SIGNED_IN);
      return getDeviceRequest({
        userCode: input.userCode,
        personId: ctx.userId,
      });
    }),

  /**
   * DEVICE DOOR — the ONE decision: approve the computer AND its agents, or
   * deny ("This wasn't me"). The code must be the one bound to the request;
   * the fifth wrong code closes it. No key is minted here — the terminal
   * collects its keys once, at `POST /api/hub/setup/device/token`.
   */
  decideDeviceRequest: credentialProcedure
    .input(
      z.object({
        requestId: z.string().uuid(),
        userCode: z.string().min(4).max(32),
        decision: z.enum(["approve", "deny"]),
        agents: z.array(z.string().min(1).max(64)).max(8).optional(),
        reuseComputerId: z.string().min(1).nullish(),
        computerName: z.string().trim().min(1).max(80).nullish(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      assertSignedInPerson(ctx, APPROVE_COMPUTER_SIGNED_IN);
      return decideDeviceRequest({ ...input, personId: ctx.userId });
    }),

  /**
   * Pod defaults for COMPUTERS (founder decision 4): how long a computer's key
   * and its agents' keys last when the computer sets nothing itself. Pod admins
   * only — pod-admin settings, Trust & keys.
   */
  getMachineDefaults: podAdminProcedure.query(() => readMachineDefaults()),

  setMachineDefaults: podAdminProcedure
    .use(requireFreshAuthentication)
    .input(z.object({ keyTtlDays: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      await setMachineKeyTtlDays(input.keyTtlDays);
      void auditLog({
        subjectType: "apiKey",
        action: "update",
        phase: "completed",
        subjectId: "machine-defaults",
        userId: ctx.userId,
        workspaceId: null,
        data: { kind: "machine_defaults", keyTtlDays: input.keyTtlDays },
      });
      return readMachineDefaults();
    }),

  /**
   * Admin: revoke every active API key owned by the given user.
   *
   * Soft-revoke (sets is_active=false + revoked_at=NOW + revoked_reason).
   * Idempotent — already-inactive keys are skipped via the `is_active = true`
   * predicate so re-running returns `revokedCount: 0`. Pod admins cannot
   * revoke their own keys to avoid locking themselves out.
   */
  adminRevokeAllForUser: podAdminProcedure
    .input(
      z.object({
        userId: z.string().min(1),
        reason: z.string().max(500).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      if (input.userId === ctx.userId) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "You cannot revoke your own API keys via this admin endpoint.",
        });
      }

      const revokedRows = await revokeApiKeys(db, {
        where: and(
          eq(apiKeys.userId, input.userId),
          eq(apiKeys.isActive, true)
        ),
        revokedBy: ctx.userId,
        reason: input.reason ?? "Bulk revocation by pod admin",
      });

      auditLog({
        subjectType: "apiKey",
        action: "revoke",
        phase: "completed",
        subjectId: input.userId,
        userId: ctx.userId,
        data: {
          targetUserId: input.userId,
          revokedCount: revokedRows.length,
          reason: input.reason,
          bulk: true,
        },
      });

      return { revokedCount: revokedRows.length };
    }),

  /**
   * Permanently delete a single revoked key. Only allowed when isActive=false.
   * Use this to clean up the revoked-keys graveyard in the pod-admin UI.
   */
  adminDeleteRevoked: podAdminProcedure
    .input(z.object({ keyId: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const key = await db.query.apiKeys.findFirst({
        where: eq(apiKeys.id, input.keyId),
        columns: { id: true, isActive: true, keyName: true },
      });
      if (!key) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Key not found" });
      }
      if (key.isActive) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Cannot delete an active key — revoke it first.",
        });
      }
      await db.delete(apiKeys).where(eq(apiKeys.id, input.keyId));
      auditLog({
        subjectType: "apiKey",
        action: "delete",
        phase: "completed",
        subjectId: input.keyId,
        userId: ctx.userId,
        data: { keyId: input.keyId, keyName: key.keyName, permanent: true },
      });
      return { deleted: true };
    }),

  /**
   * List all API keys on the pod (metadata only). Pod-admin workspace only.
   */
  listSystemKeys: podAdminProcedure.query(async () => {
    const keys = await db.query.apiKeys.findMany({
      orderBy: (apiKeys, { desc }) => [desc(apiKeys.createdAt)],
      with: {
        user: true, // Include user details
      },
    });

    return keys.map((key) => ({
      id: key.id,
      keyName: key.keyName,
      keyPrefix: key.keyPrefix,
      keyType: key.keyType,
      hubId: key.hubId,
      linkedUserId: key.linkedUserId,
      scope: key.scope,
      isActive: key.isActive,
      expiresAt: key.expiresAt,
      lastUsedAt: key.lastUsedAt,
      usageCount: key.usageCount,
      createdAt: key.createdAt,
      user: key.user
        ? { id: key.user.id, email: key.user.email, name: key.user.name }
        : null,
    }));
  }),

  /**
   * Create a system-wide service key (synap_hub_live_ prefix, keyType=system).
   * Pod-admin only. Tied to the operator's userId for audit purposes.
   */
  createSystemKey: podAdminProcedure
    .use(requireFreshAuthentication)
    .input(
      z.object({
        keyName: z.string().min(1).max(100),
        scope: z
          .array(z.enum([...API_KEY_SCOPES] as [string, ...string[]]))
          .min(1),
        expiresInDays: z.number().int().min(1).max(365).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const keyPrefix =
        process.env.NODE_ENV === "production"
          ? "synap_hub_live_"
          : "synap_hub_test_";
      const key = generateApiKey(keyPrefix);
      const expiresAt = input.expiresInDays
        ? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000)
        : undefined;

      const database = await getDb();
      const eventRepo = new EventRepository(sql);
      const apiKeyRepo = new ApiKeyRepository(database, eventRepo);

      const apiKey = await apiKeyRepo.create(
        {
          keyName: input.keyName,
          keyPrefix,
          key,
          scope: input.scope,
          expiresAt,
          userId: ctx.userId,
          keyType: "system",
        },
        ctx.userId
      );
      await attachFullAccessGrant({
        apiKeyId: apiKey.id,
        principalUserId: ctx.userId,
        onBehalfOf: ctx.userId,
        expiresAt: expiresAt ?? null,
        createdBy: ctx.userId,
      });

      auditLog({
        subjectType: "apiKey",
        action: "create",
        phase: "completed",
        subjectId: apiKey.id,
        userId: ctx.userId,
        data: { keyName: input.keyName, keyPrefix, keyType: "system" },
      });

      return {
        id: apiKey.id,
        key,
        keyPrefix,
        status: "created" as const,
        message: "Save this key securely. It will not be displayed again.",
      };
    }),

  /**
   * Pod-admin: create a workspace-scoped service key (synap_hub_ prefix, keyType=hub_inbound).
   * Use this when provisioning credentials for external services via the connections UI.
   */
  adminCreateServiceKey: podAdminProcedure
    .use(requireFreshAuthentication)
    .input(
      z.object({
        keyName: z.string().min(1).max(100),
        scope: z
          .array(z.enum([...API_KEY_SCOPES] as [string, ...string[]]))
          .min(1),
        workspaceId: z.string().uuid(),
        expiresInDays: z.number().int().min(1).max(365).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const keyPrefix =
        process.env.NODE_ENV === "production"
          ? "synap_hub_live_"
          : "synap_hub_test_";
      const key = generateApiKey(keyPrefix);
      const expiresAt = input.expiresInDays
        ? new Date(Date.now() + input.expiresInDays * 24 * 60 * 60 * 1000)
        : undefined;

      const database = await getDb();
      const eventRepo = new EventRepository(sql);
      const apiKeyRepo = new ApiKeyRepository(database, eventRepo);

      const apiKey = await apiKeyRepo.create(
        {
          keyName: input.keyName,
          keyPrefix,
          key,
          scope: input.scope,
          expiresAt,
          userId: ctx.userId,
          keyType: "hub_inbound",
          workspaceId: input.workspaceId,
        },
        ctx.userId
      );
      await attachFullAccessGrant({
        apiKeyId: apiKey.id,
        principalUserId: ctx.userId,
        onBehalfOf: ctx.userId,
        expiresAt: expiresAt ?? null,
        createdBy: ctx.userId,
      });

      auditLog({
        subjectType: "apiKey",
        action: "create",
        phase: "completed",
        subjectId: apiKey.id,
        userId: ctx.userId,
        workspaceId: input.workspaceId,
        data: { keyName: input.keyName, keyPrefix, keyType: "hub_inbound" },
      });

      emitSideEffects({
        subjectType: "apiKey",
        action: "create",
        subjectId: apiKey.id,
        userId: ctx.userId,
        workspaceId: input.workspaceId,
      });

      return {
        id: apiKey.id,
        key,
        keyPrefix,
        status: "created" as const,
        message: "Save this key securely. It will not be displayed again.",
      };
    }),

  /**
   * Connect an integration — create a scoped Hub Protocol API key in one call.
   *
   * Called from the admin UI /connect page after the user authenticates.
   * Returns the key + podUrl + workspaceId so the caller can build a deeplink
   * or display a copy-paste flow — no separate agent provisioning required.
   */
  connectIntegration: credentialProcedure
    .input(
      z.object({
        integration: integrationKindSchema,
        workspaceId: z.string().uuid().optional(),
        strategy: z
          .enum(["create_new", "replace_existing"])
          .default("create_new"),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const flowId = randomUUID();
      const id = randomUUID();

      // Resolve workspace: use provided (verified) or fall back to user's first
      let resolvedWorkspaceId = input.workspaceId;
      if (resolvedWorkspaceId) {
        // Explicit workspace supplied — verify the caller is actually a member
        const membership = await db.query.workspaceMembers.findFirst({
          where: (m, { and, eq }) =>
            and(
              eq(m.userId, ctx.userId),
              eq(m.workspaceId, resolvedWorkspaceId!)
            ),
        });
        if (!membership) {
          throw new TRPCError({
            code: "FORBIDDEN",
            message: "You are not a member of the requested workspace",
          });
        }
      } else {
        // No workspace supplied — the caller's first DOMAIN workspace (never
        // the pod-admin console); none ⇒ an unscoped key, as before.
        resolvedWorkspaceId =
          (await findUserDefaultWorkspaceId(db, ctx.userId)) ?? undefined;
      }

      // Standard permission gate — same as `create`. Will auto-approve for
      // direct user actions on their own resources (DEFAULT_AUTO_APPROVE).
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        workspaceId: resolvedWorkspaceId,
        subjectType: "apiKey",
        action: "create",
        data: {
          id,
          keyName: input.integration,
          integration: input.integration,
        },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        // Shouldn't happen for direct user actions, but handle gracefully
        throw new TRPCError({
          code: "FORBIDDEN",
          message: proposedMessageFor(
            perm.proposalType,
            "Key creation requires approval on this pod"
          ),
        });
      }

      const integrationHub = integrationHubId(input.integration);
      const scope =
        INTEGRATION_HUB_SCOPES[input.integration] ??
        INTEGRATION_HUB_SCOPES.custom;
      const keyName = `${input.integration.charAt(0).toUpperCase() + input.integration.slice(1)} — ${new Date().toISOString().slice(0, 10)}`;

      if (input.strategy === "replace_existing") {
        await revokeApiKeys(db, {
          where: and(
            eq(apiKeys.userId, ctx.userId),
            eq(apiKeys.hubId, integrationHub),
            eq(apiKeys.keyType, "hub_inbound"),
            eq(apiKeys.isActive, true)
          ),
          revokedBy: ctx.userId,
          reason: `Replaced by ${input.integration} reconnect`,
        });
      }

      const database = await getDb();
      const eventRepo = new EventRepository(sql);
      const apiKeyRepo = new ApiKeyRepository(database, eventRepo);

      const registration = await createAndVerifyHubInboundKey(
        apiKeyRepo,
        {
          keyName,
          // hubId marks this as a Hub Protocol key (traceable in audit logs).
          hubId: integrationHub,
          scope,
          userId: ctx.userId,
        },
        ctx.userId,
        ctx.userId
      );
      const { apiKey, plainKey } = registration;
      // The person's own CLI/integration: their full reach, explicit.
      await attachFullAccessGrant({
        apiKeyId: apiKey.id,
        principalUserId: ctx.userId,
        onBehalfOf: ctx.userId,
        expiresAt: apiKey.expiresAt ?? null,
        createdBy: ctx.userId,
      });
      const registrationTrace = toRegistrationTrace(flowId, registration);
      if (registration.outcome !== "CONNECTED_VERIFIED") {
        auditLog({
          subjectType: "apiKey",
          action: "create",
          phase: "failed",
          subjectId: apiKey.id,
          userId: ctx.userId,
          workspaceId: resolvedWorkspaceId,
          data: {
            keyName,
            integration: input.integration,
            strategy: input.strategy,
            ...registrationTrace,
          },
        });
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Key was issued but verification failed. Flow: ${flowId}`,
        });
      }

      auditLog({
        subjectType: "apiKey",
        action: "create",
        phase: "completed",
        subjectId: apiKey.id,
        userId: ctx.userId,
        workspaceId: resolvedWorkspaceId,
        data: {
          keyName,
          integration: input.integration,
          strategy: input.strategy,
          ...registrationTrace,
        },
      });

      emitSideEffects({
        subjectType: "apiKey",
        action: "create",
        subjectId: apiKey.id,
        userId: ctx.userId,
        workspaceId: resolvedWorkspaceId,
      });

      const podUrl =
        process.env.PUBLIC_URL?.replace(/\/$/, "") || "http://localhost:4000";

      return {
        apiKey: plainKey, // plaintext, shown once
        keyId: apiKey.id,
        podUrl,
        workspaceId: resolvedWorkspaceId ?? null,
        integration: input.integration,
        strategy: input.strategy,
        registration: registrationTrace,
      };
    }),

  /**
   * beginMcpConnect — mint a one-time CONSENT CODE for the CP-MCP pod-accept gate.
   *
   * MCP-OAUTH-AND-CONNECT-PLAN §2-3. Session-authed: the caller is the human who
   * clicked "Allow" on pod-admin `/connect`. This does NOT mint the agent key —
   * it only records consent as a short-lived, single-use code (stored as a
   * sha256 hash, like api_keys.key_lookup_hash) and returns the RAW code once.
   * pod-admin then top-level-navigates to the CP callback with `?code=<code>`
   * (only the code, never a key). The CP later redeems it server-to-server at
   * POST /api/hub/mcp/redeem, where the pod mints the `claude-web` agent key.
   * Minting on redeem (not here) means no plaintext key touches the browser.
   */
  beginMcpConnect: credentialProcedure
    .input(
      z.object({
        agentType: z.literal("claude-web"),
        // CP-grammar scopes (e.g. ["mcp:read","mcp:write"]); mapped to pod grammar
        // at redeem. Stored verbatim so the redeem side owns the translation.
        scopes: z.array(z.string()).max(32).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // Validate the caller is a real human — a consent code binds the acting
      // human to the CP grant; an agent user must never author its own consent.
      const caller = await db.query.users.findFirst({
        where: eq(users.id, ctx.userId),
        columns: { id: true, userType: true },
      });
      if (!caller || caller.userType !== "human") {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Only a human pod user can authorize an MCP connection.",
        });
      }

      // High-entropy one-time code — returned raw ONCE, only its hash is stored.
      const code = randomBytes(32).toString("base64url");
      const codeHash = createHash("sha256").update(code).digest("hex");

      // ~10 minute TTL — long enough for the CP callback round-trip, short enough
      // to bound replay exposure.
      const MCP_CONNECT_CODE_TTL_MS = 10 * 60 * 1000;
      const expiresAt = new Date(Date.now() + MCP_CONNECT_CODE_TTL_MS);

      await db.insert(mcpConnectCodes).values({
        codeHash,
        podUserId: ctx.userId,
        scopes: input.scopes ?? [],
        agentType: input.agentType,
        expiresAt,
      });

      auditLog({
        subjectType: "apiKey",
        action: "create",
        phase: "completed",
        subjectId: codeHash.slice(0, 12),
        userId: ctx.userId,
        data: {
          kind: "mcp_connect_code",
          agentType: input.agentType,
          scopes: input.scopes ?? [],
        },
      });

      return { code, expiresAt: expiresAt.toISOString() };
    }),

  /**
   * getOAuthConsentContext — what pod-admin's `/oauth/consent` screen renders.
   *
   * Path B (pod-as-authorization-server). The pod's own `GET /authorize` bounced
   * the browser here; this resolves the registered client so the screen shows
   * the client's REAL name, REAL redirect host and REAL granted scopes rather
   * than anything carried in the (user-rewritable) query string.
   *
   * Session-authed like `beginMcpConnect` — the consent screen is only reachable
   * with a valid Kratos session, and this call re-establishes who is deciding.
   */
  getOAuthConsentContext: protectedProcedure
    .input(oauthAuthorizeParamsSchema)
    .query(async ({ ctx, input }) => {
      try {
        // The viewer: an app sign-in shows THEIR spaces, nobody else's.
        return await getOAuthConsentContext(input, ctx.userId, ctx.session);
      } catch (err) {
        throw toConsentTrpcError(err, input.clientId);
      }
    }),

  /**
   * decideOAuthAuthorization — the human clicked Allow or Deny.
   *
   * On Allow this mints the authorization code bound to the PKCE challenge, with
   * `userId` = THIS caller. That id becomes the access token's `linkedUserId` at
   * /token, which is the only thing that makes Claude's writes land as governed
   * proposals rather than silently auto-applying as the operator.
   *
   * Returns the absolute URL to navigate to — built server-side from the
   * client's REGISTERED redirect_uri, never from user input, so this can never
   * become an open redirect.
   */
  decideOAuthAuthorization: credentialProcedure
    .input(
      oauthAuthorizeParamsSchema.extend({
        approve: z.boolean(),
        // A pod app: the (permission, space) pairs the person left ticked.
        // Untrusted — the pod's own offer bounds it (`connectOAuthApp`).
        approved: z
          .array(
            z.object({
              permission: z.string().min(1).max(200),
              workspaceId: z.string().uuid(),
            })
          )
          .max(512)
          .optional(),
        // "Sign in with Synap": the `appSignIn.fingerprint` the screen
        // rendered — an approval is only for exactly what was shown.
        appSignInFingerprint: z.string().max(128).optional(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      // CSRF floor (PR #29 L2), the rule of the Kratos-cookie decision routes
      // (`refuseCrossSiteCookieRequest`, rest/setup.ts): a decision that rides
      // the browser's cookie must come from THIS pod's console, where the
      // consent page lives. A session-token caller carries no ambient
      // authority and is not refused here.
      const req = ctx.req;
      if (
        req?.headers.get("cookie") &&
        !isPodAdminOrigin(req.headers.get("origin"), req.url)
      ) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Authorize this connection from your pod's console.",
        });
      }
      try {
        const result = await decideOAuthAuthorization(input, ctx.userId, ctx);
        auditLog({
          subjectType: "apiKey",
          action: "create",
          phase: "completed",
          subjectId: input.clientId,
          userId: ctx.userId,
          data: {
            kind: "pod_oauth_authorization",
            approve: input.approve,
            scopes: input.scope ?? null,
          },
        });
        return result;
      } catch (err) {
        throw toConsentTrpcError(err, input.clientId);
      }
    }),

  /**
   * List workspace keys (Workspace Owner/Admin only)
   */
  listWorkspaceKeys: protectedProcedure
    .input(z.object({ workspaceId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      // Check permissions
      const membership = await db.query.workspaceMembers.findFirst({
        where: (members, { and, eq }) =>
          and(
            eq(members.workspaceId, input.workspaceId),
            eq(members.userId, ctx.userId)
          ),
      });

      if (!membership || !["owner", "admin"].includes(membership.role)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Insufficient permissions",
        });
      }

      // Get all members of workspace
      const members = await db.query.workspaceMembers.findMany({
        where: eq(workspaceMembers.workspaceId, input.workspaceId),
        columns: { userId: true },
      });

      const memberIds = members.map((m) => m.userId);

      if (memberIds.length === 0) {
        return [];
      }

      // Get keys for these users
      const keys = await db.query.apiKeys.findMany({
        where: (apiKeys, { inArray }) => inArray(apiKeys.userId, memberIds),
        orderBy: (apiKeys, { desc }) => [desc(apiKeys.createdAt)],
        with: {
          user: true,
        },
      });

      return keys.map((key) => ({
        id: key.id,
        keyName: key.keyName,
        keyPrefix: key.keyPrefix,
        hubId: key.hubId,
        scope: key.scope,
        isActive: key.isActive,
        expiresAt: key.expiresAt,
        lastUsedAt: key.lastUsedAt,
        usageCount: key.usageCount,
        createdAt: key.createdAt,
        user: {
          id: key.user.id,
          email: key.user.email,
          name: key.user.name,
        },
      }));
    }),

  /**
   * Workspace-admin: list every API key tagged to ctx.workspaceId.
   *
   * Unlike `listWorkspaceKeys` (which infers workspace association from
   * member->user->keys), this procedure reads the explicit `workspace_id`
   * column on `api_keys`. Only keys minted via `createForWorkspace` show up
   * here — legacy pod-wide / user-scoped keys (workspace_id = NULL) are
   * intentionally excluded so the UI only displays keys it can manage.
   *
   * Auth: workspaceProcedure verifies membership; we further require
   * admin/owner role for any key-management surface.
   */
  listForWorkspace: workspaceProcedure.query(async ({ ctx }) => {
    if (!["owner", "admin"].includes(ctx.workspaceRole)) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "Workspace admin role required",
      });
    }

    const keys = await db.query.apiKeys.findMany({
      where: eq(apiKeys.workspaceId, ctx.workspaceId),
      orderBy: (apiKeys, { desc }) => [desc(apiKeys.createdAt)],
    });
    const reachOf = await loadKeyReach(keys.map((k) => k.id));

    return keys.map((key) => ({
      id: key.id,
      keyName: key.keyName,
      keyPrefix: key.keyPrefix,
      keyType: key.keyType,
      hubId: key.hubId,
      scope: key.scope,
      isActive: key.isActive,
      expiresAt: key.expiresAt,
      lastUsedAt: key.lastUsedAt,
      usageCount: key.usageCount,
      createdAt: key.createdAt,
      createdBy: key.createdBy,
      revokedAt: key.revokedAt,
      revokedReason: key.revokedReason,
      workspaceId: key.workspaceId,
      /** What this key may touch: `access` + every live grant. */
      ...reachOf(key.id),
    }));
  }),

  /**
   * Workspace-admin: create a new API key tagged to ctx.workspaceId.
   *
   * The key is bound to the current workspace via `api_keys.workspace_id`
   * so subsequent listForWorkspace / revokeForWorkspace calls only see and
   * touch keys that belong to this workspace.
   *
   * SECURITY: The plaintext key is returned ONCE. The caller is the owner
   * of the key (`userId = ctx.userId`).
   */
  createForWorkspace: workspaceProcedure
    .use(requireFreshAuthentication)
    .input(
      z.object({
        name: z.string().min(1).max(100),
        scopes: z
          .array(z.enum([...API_KEY_SCOPES] as [string, ...string[]]))
          .min(1),
        /** Legacy absolute expiry; wins over expiresInDays when given. */
        expiresAt: z.date().optional(),
        // Omitted → 90 days; a number → that many; null → never (W1f).
        expiresInDays: ExpiresInDaysSchema,
        /** What the key may touch; always held inside this workspace. Required. */
        grant: GrantInputSchema.omit({ workspaceIds: true }),
      })
    )
    .mutation(async ({ input, ctx }) => {
      assertGrantInput(input.grant);
      if (!["owner", "admin"].includes(ctx.workspaceRole)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Workspace admin role required",
        });
      }

      const id = randomUUID();

      // Permission check (mirrors `create`) — workspace-scoped this time.
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        subjectType: "apiKey",
        action: "create",
        data: { id, keyName: input.name },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return {
          id,
          key: null as unknown as string,
          keyPrefix: "",
          status: "proposed" as const,
          proposalId: perm.proposalId,
        };
      }

      // Workspace-scoped keys are user PATs (not hub-inbound).
      const keyPrefix = "synap_user_";
      const expiresAt =
        input.expiresAt ?? resolveKeyExpiry(input.expiresInDays);
      const key = generateApiKey(keyPrefix);

      const database = await getDb();
      const eventRepo = new EventRepository(sql);
      const apiKeyRepo = new ApiKeyRepository(database, eventRepo);

      const apiKey = await apiKeyRepo.create(
        {
          keyName: input.name,
          keyPrefix,
          key,
          scope: input.scopes,
          expiresAt: expiresAt ?? undefined,
          userId: ctx.userId,
          keyType: "user_pat",
          workspaceId: ctx.workspaceId,
        },
        ctx.userId
      );

      await attachGrantOrRevoke({
        apiKeyId: apiKey.id,
        principalUserId: ctx.userId,
        onBehalfOf: ctx.userId,
        // A workspace key's grant never reaches beyond its workspace.
        grant: { ...input.grant, workspaceIds: [ctx.workspaceId] },
        expiresAt,
        createdBy: ctx.userId,
      });

      auditLog({
        subjectType: "apiKey",
        action: "create",
        phase: "completed",
        subjectId: apiKey.id,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        data: { keyName: input.name, keyPrefix, scope: "workspace" },
      });

      emitSideEffects({
        subjectType: "apiKey",
        action: "create",
        subjectId: apiKey.id,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
      });

      return {
        id: apiKey.id,
        key, // displayed ONCE
        keyPrefix,
        status: "created" as const,
        message: "Save this key securely. It will not be displayed again.",
      };
    }),

  /**
   * Workspace-admin: revoke an API key that belongs to ctx.workspaceId.
   *
   * Anti-cross-workspace mistake: we read the key first and FAIL if its
   * `workspace_id` does not match `ctx.workspaceId`. This prevents an admin
   * of workspace A from revoking a key owned by workspace B even if they
   * happen to know its UUID.
   */
  revokeForWorkspace: workspaceProcedure
    .input(z.object({ keyId: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      if (!["owner", "admin"].includes(ctx.workspaceRole)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Workspace admin role required",
        });
      }

      const key = await db.query.apiKeys.findFirst({
        where: eq(apiKeys.id, input.keyId),
      });

      if (!key) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "API key not found",
        });
      }

      // Cross-workspace defense: a workspace admin can only revoke keys
      // that were minted to THIS workspace. Pod-wide / user-scoped /
      // other-workspace keys are off-limits via this surface.
      if (key.workspaceId !== ctx.workspaceId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "API key does not belong to this workspace",
        });
      }

      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        subjectType: "apiKey",
        action: "delete",
        data: { id: input.keyId },
      });

      if ("denied" in perm && perm.denied) {
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      }
      if ("proposalId" in perm) {
        return { status: "proposed" as const, proposalId: perm.proposalId };
      }

      const database = await getDb();
      const eventRepo = new EventRepository(sql);
      const apiKeyRepo = new ApiKeyRepository(database, eventRepo);

      await apiKeyRepo.revoke(
        input.keyId,
        ctx.userId,
        "Revoked via workspace admin"
      );

      auditLog({
        subjectType: "apiKey",
        action: "revoke",
        phase: "completed",
        subjectId: input.keyId,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
        data: { scope: "workspace" },
      });

      emitSideEffects({
        subjectType: "apiKey",
        action: "revoke",
        subjectId: input.keyId,
        userId: ctx.userId,
        workspaceId: ctx.workspaceId,
      });

      return { status: "revoked" as const };
    }),
});
