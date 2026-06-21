/**
 * Hub Protocol REST — vault
 *
 * Three capabilities for agents:
 *   1. POST /vault/request          — request to READ a secret (proposal-gated)
 *   2. GET  /vault/request/:id       — poll the outcome of a request proposal
 *   3. POST   /vault/secrets         — STORE a credential (direct, server-encrypted)
 *   4. GET    /vault/secrets         — LIST credential metadata (never values)
 *   5. DELETE /vault/secrets/:id     — SOFT-delete a credential (governed write-gate)
 *
 * Reading secret VALUES stays exclusively behind the request → proposal →
 * grantAIAccess flow. No route here returns decrypted data to an agent.
 */

import { z } from "zod";
import {
  db,
  eq,
  and,
  isNull,
  inArray,
  encryptServerSide,
  getWorkspaceMembership,
  SECRET_TYPES,
  parseVaultReference,
  resolveVaultSecret,
  VaultGrantError,
  assertGrantScoped,
} from "@synap/database";
import {
  secrets,
  secretAuditLog,
  proposals,
  users,
  vaultGrants,
} from "@synap/database/schema";

import { NotificationService } from "../../../notifications/NotificationService.js";
import { createEventBackedProposal } from "../../../utils/event-backed-proposal.js";
import { secretsVaultRouter } from "../../secrets-vault.js";
import { createHubProtocolCallerContext } from "../utils.js";

import { ErrorSchema } from "./_codecs/_openapi.js";
import {
  VaultRequestRequestSchema,
  VaultRequestResponseSchema,
} from "./_codecs/misc.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  hasScope,
  logger,
  resolveActingContext,
  type HubHono,
} from "./_shared.js";

// ── Local OpenAPI schemas (not in user-WIP _codecs/misc.ts) ────────────────

const StoreSecretRequestSchema = z.object({
  workspaceId: z.string().uuid().optional(),
  name: z.string().min(1).max(255),
  type: z.enum(SECRET_TYPES).optional(),
  service: z.string().optional(),
  value: z.union([z.string(), z.record(z.string(), z.unknown())]),
  description: z.string().max(1000).optional(),
  url: z.string().optional(),
  agentUserId: z.string().optional(),
});

const StoreSecretResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  vaultRef: z.string(),
});

const SecretMetadataSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  service: z.string().nullable(),
  url: z.string().nullable(),
  category: z.string().nullable(),
  createdAt: z.string(),
});

const ListSecretsResponseSchema = z.object({
  secrets: z.array(SecretMetadataSchema),
});

const RequestOutcomeResponseSchema = z.object({
  status: z.string(),
  vaultRef: z.string().nullable(),
  scope: z.string().nullable(),
  expiresAt: z.string().nullable(),
});

export function registerVaultRoutes(app: HubHono): void {
  // ── OpenAPI metadata ─────────────────────────────────────────────────────
  registerOpenApi(app, {
    method: "post",
    path: "/vault/request",
    tags: ["Vault"],
    summary: "Request a secret from the Vault",
    description:
      "AI requests access to a vault secret — creates a pending proposal and emits an urgent notification for user approval.",
    request: {
      body: VaultRequestRequestSchema,
    },
    responses: {
      200: {
        description: "Pending proposal id",
        schema: VaultRequestResponseSchema,
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  /**
   * POST /vault/request
   * AI requests access to a vault secret — creates a proposal for user approval.
   */
  app.post("/vault/request", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }
    const body = (await c.req.json()) as {
      workspaceId?: string;
      agentUserId?: string;
      channelId?: string;
      sourceMessageId?: string;
      secretType: string;
      service: string;
      purpose: string;
      accessLevel?: string;
      ttl?: number;
    };

    if (!body.secretType || !body.service || !body.purpose) {
      return c.json(
        { error: "secretType, service, and purpose are required" },
        400
      );
    }

    const userId = (body.agentUserId as string) ?? (c.get("userId") as string);
    const workspaceId =
      (body.workspaceId as string | null | undefined) ??
      c.req.header("x-workspace-id") ??
      null;

    const accessLevel = body.accessLevel ?? "read";
    const ttl = body.ttl ?? 60;

    try {
      // Resolve the requesting agent's display name so the approval card can
      // show WHO is asking (the proposal only stores agentUserId otherwise).
      let agentName: string | null = null;
      if (userId) {
        const agentRow = await db.query.users.findFirst({
          where: eq(users.id, userId),
          columns: { name: true },
        });
        agentName = agentRow?.name ?? null;
      }

      const summary = `AI requests ${body.secretType} for ${body.service}: ${body.purpose}`;
      const { proposal: row } = await createEventBackedProposal({
        userId,
        workspaceId,
        targetType: "vault",
        targetId: `${body.service}:${body.secretType}`,
        proposalType: "vault.request",
        action: "request",
        source: "intelligence",
        summary,
        agentUserId: userId ?? null,
        createdBy: userId ?? null,
        threadId: body.channelId ?? null,
        sourceMessageId: body.sourceMessageId ?? null,
        data: {
          secretType: body.secretType,
          service: body.service,
          purpose: body.purpose,
          accessLevel,
          ttl,
          requestedBy: "ai",
          source: "agent",
          sourceId: userId,
          agentName,
        },
      });

      // Emit urgent notification — shows as banner (not toast) in the UI
      NotificationService.create({
        workspaceId: workspaceId ?? null,
        userId,
        type: "ai_request.vault_access",
        sourceType: "proposal",
        sourceId: row.id,
        data: {
          secretType: body.secretType,
          service: body.service,
          purpose: body.purpose,
          proposalId: row.id,
        },
      }).catch(() => {});

      return c.json({
        status: "pending",
        proposalId: row.id,
        message: `Vault secret request created. Awaiting user approval.`,
      });
    } catch (err) {
      logger.error({ err, workspaceId }, "vault.request failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ── GET /vault/request/:proposalId ─────────────────────────────────────────
  // Poll the outcome of a vault.request proposal so the agent can learn whether
  // the user approved (and pick up the vaultRef) without a side channel.
  registerOpenApi(app, {
    method: "get",
    path: "/vault/request/{proposalId}",
    tags: ["Vault"],
    summary: "Poll a vault access request outcome",
    description:
      "Returns the proposal status (pending/approved/rejected) and, once approved, the vault:// reference granted by the user.",
    request: {
      params: z.object({ proposalId: z.string() }),
    },
    responses: {
      200: {
        description: "Request outcome",
        schema: RequestOutcomeResponseSchema,
      },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.get("/vault/request/:proposalId", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }

    const proposalId = c.req.param("proposalId");
    try {
      const acting = await resolveActingContext(c, {});
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);

      // vault.request proposals are workspace-scoped and authored via createdBy.
      // When an agent key creates the request, createdBy is the agentUserId; when
      // a human/service key creates it, createdBy is the acting user. Bind to the
      // membership-verified workspace AND either authorship identity so an agent
      // can poll its own requests but never another tenant's.
      const ctxAgentUserId = c.get("agentUserId") as string | undefined;
      const authoredBy = ctxAgentUserId
        ? [acting.userId, ctxAgentUserId]
        : [acting.userId];

      // Look up by id + authorship, then verify membership of the proposal's
      // OWN workspace. (resolveActingContext with an empty body falls back to
      // the caller's first accessible workspace, which is rarely the one the
      // request was filed in — binding the query to it made every poll 404.)
      const row = await db.query.proposals.findFirst({
        where: and(
          eq(proposals.id, proposalId),
          inArray(proposals.createdBy, authoredBy)
        ),
        columns: { status: true, data: true, workspaceId: true },
      });
      if (!row) return c.json({ error: "Request not found" }, 404);
      if (row.workspaceId) {
        const membership = await getWorkspaceMembership(
          db,
          row.workspaceId,
          acting.userId
        );
        if (!membership) return c.json({ error: "Request not found" }, 404);
      }

      const data = (row.data ?? {}) as {
        vaultRef?: string;
        scope?: string;
        expiresAt?: string | null;
      };
      return c.json({
        status: row.status,
        vaultRef: data.vaultRef ?? null,
        scope: data.scope ?? null,
        expiresAt: data.expiresAt ?? null,
      });
    } catch (err) {
      logger.error({ err, proposalId }, "vault.request poll failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ── POST /vault/redeem ─────────────────────────────────────────────────────
  // Grant-gated redemption: an agent (e.g. a running skill) resolves a vault://
  // ref it was GRANTED to plaintext, consuming one grant use. Routes through the
  // SAME canonical resolver as automations (resolveVaultSecret) but with the
  // GATED props (requireGrant + redeemer). The redeemer is SERVER-DERIVED from
  // the authenticated principal — never the caller — and the grant gate (scoped
  // to grantee + workspace + TTL + use-count) is what authorizes it. Only
  // server-encrypted secrets resolve; client-encrypted ones never leave the
  // user's device.
  const RedeemRequestSchema = z.object({ ref: z.string() });
  const RedeemResponseSchema = z.object({ value: z.string() });
  registerOpenApi(app, {
    method: "post",
    path: "/vault/redeem",
    tags: ["Vault"],
    summary: "Redeem a granted vault reference to its value",
    description:
      "Resolves a vault:// reference the authenticated agent has an active grant for, consuming one grant use. 403 if no redeemable grant exists for this principal.",
    request: { body: RedeemRequestSchema },
    responses: {
      200: {
        description: "Resolved secret value",
        schema: RedeemResponseSchema,
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "No redeemable grant", schema: ErrorSchema },
      404: {
        description: "Secret not found / unresolvable",
        schema: ErrorSchema,
      },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.post("/vault/redeem", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const raw = (await c.req.json().catch(() => null)) as {
      ref?: unknown;
    } | null;
    const refStr = typeof raw?.ref === "string" ? raw.ref : null;
    if (!refStr) return c.json({ error: "ref (vault://…) is required" }, 400);
    const parsed = parseVaultReference(refStr);
    if (!parsed) return c.json({ error: "Invalid vault reference" }, 400);

    // Redeemer is SERVER-DERIVED — never trust the body. The grant gate binds
    // redemption to THIS principal (vault_grants.granted_to / workspace_id).
    const acting = await resolveActingContext(c, {});
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    const agentUserId =
      (c.get("agentUserId") as string | undefined) ?? acting.userId;

    // The owner load only enables decrypt; authorization is the grant gate
    // (findRedeemableGrant by secretId + redeemer), NOT ownership.
    const secret = await db.query.secrets.findFirst({
      where: eq(secrets.id, parsed.secretId),
      columns: { userId: true },
    });
    // Return the SAME 403 as a grant denial for a non-existent secret — no
    // secret-existence oracle (a missing secret has no redeemable grant anyway).
    if (!secret) {
      return c.json({ error: "Vault grant denied: no_grant" }, 403);
    }

    try {
      const value = await resolveVaultSecret(
        parsed.secretId,
        secret.userId,
        parsed.fieldName,
        {
          requireGrant: true,
          redeemer: { agentUserId, workspaceId: acting.workspaceId ?? null },
        }
      );
      if (value === null) {
        return c.json(
          { error: "Secret could not be resolved (server-encrypted only)" },
          404
        );
      }
      return c.json({ value });
    } catch (err) {
      if (err instanceof VaultGrantError) {
        return c.json({ error: `Vault grant denied: ${err.code}` }, 403);
      }
      logger.error({ err, secretId: parsed.secretId }, "vault.redeem failed");
      return c.json({ error: "Vault redeem failed" }, 500);
    }
  });

  // ── POST /vault/secrets/{id}/grant ─────────────────────────────────────────
  // Direct, OWNER-gated grant of redeem access to a vault secret — the headless
  // equivalent of the UI "grant access to this ability" flow (which is proposal-
  // based). Lets the CLI authorize an external client (e.g. the Discord bridge)
  // to redeem a capability credential it just provisioned, so the token lives
  // ONLY in the vault — never an env var. Scope: once (15m/1use) · session
  // (ttlMinutes, default 60m) · permanent. assertGrantScoped firewalls a fully-
  // wildcard grant. Idempotent: reuses an active, identically-scoped grant.
  const GrantRequestSchema = z.object({
    grantedTo: z.string().uuid().optional(),
    workspaceId: z.string().uuid().optional(),
    scope: z.enum(["once", "session", "permanent"]).optional(),
    ttlMinutes: z.number().int().min(1).max(525600).optional(),
  });
  app.post("/vault/secrets/:id/grant", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json({ error: "Missing scope: hub-protocol.write" }, 403);
    }
    const secretId = c.req.param("id");
    const parsed = GrantRequestSchema.safeParse(
      await c.req.json().catch(() => ({}))
    );
    if (!parsed.success) {
      return c.json(
        { error: "Invalid grant body", details: parsed.error.issues },
        400
      );
    }
    const acting = await resolveActingContext(c, {});
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);

    // OWNER gate — authorize on the LOADED row's userId, never a request value.
    const secret = await db.query.secrets.findFirst({
      where: eq(secrets.id, secretId),
      columns: { id: true, userId: true },
    });
    if (!secret) return c.json({ error: "Secret not found" }, 404);
    if (secret.userId !== acting.userId) {
      return c.json({ error: "Only the secret owner can grant access" }, 403);
    }

    const scope = parsed.data.scope ?? "permanent";
    const now = Date.now();
    let expiresAt: Date | null;
    let maxUses: number | null;
    if (scope === "once") {
      expiresAt = new Date(now + 15 * 60 * 1000);
      maxUses = 1;
    } else if (scope === "permanent") {
      expiresAt = null;
      maxUses = null;
    } else {
      expiresAt = new Date(now + (parsed.data.ttlMinutes ?? 60) * 60 * 1000);
      maxUses = null;
    }

    const grantedTo = parsed.data.grantedTo ?? null;
    const grantWorkspaceId = parsed.data.workspaceId ?? null;
    try {
      assertGrantScoped({ grantedTo, workspaceId: grantWorkspaceId });
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Invalid grant scope" },
        400
      );
    }

    try {
      // Idempotent: reuse an active, identically-scoped grant.
      const existing = await db.query.vaultGrants.findFirst({
        where: and(
          eq(vaultGrants.grantableType, "secret"),
          eq(vaultGrants.grantableId, secretId),
          grantedTo
            ? eq(vaultGrants.grantedTo, grantedTo)
            : isNull(vaultGrants.grantedTo),
          grantWorkspaceId
            ? eq(vaultGrants.workspaceId, grantWorkspaceId)
            : isNull(vaultGrants.workspaceId),
          isNull(vaultGrants.revokedAt)
        ),
        columns: { id: true, scope: true, expiresAt: true },
      });
      if (
        existing &&
        (existing.expiresAt === null || existing.expiresAt > new Date())
      ) {
        return c.json({
          grantId: existing.id,
          scope: existing.scope ?? scope,
          expiresAt: existing.expiresAt
            ? existing.expiresAt.toISOString()
            : null,
          reused: true,
        });
      }

      const [grant] = await db
        .insert(vaultGrants)
        .values({
          grantableType: "secret",
          grantableId: secretId,
          execMode: "auto",
          grantedTo,
          workspaceId: grantWorkspaceId,
          scope,
          expiresAt,
          maxUses,
          createdBy: acting.userId,
        })
        .returning({ id: vaultGrants.id });

      return c.json({
        grantId: grant.id,
        scope,
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
      });
    } catch (err) {
      logger.error({ err, secretId }, "vault.grant failed");
      return c.json({ error: "Vault grant failed" }, 500);
    }
  });

  // ── POST /vault/secrets ────────────────────────────────────────────────────
  // Agents STORE a credential they already possess. Direct write (not proposal-
  // gated — gating adds no security when the agent already holds the value).
  // Always server-encrypted (encryptionMode 'server', the schema default).
  registerOpenApi(app, {
    method: "post",
    path: "/vault/secrets",
    tags: ["Vault"],
    summary: "Store a credential in the Vault",
    description:
      "Server-encrypts and stores a secret owned by the resolved acting user. Writes a secret_audit_log row recording the agent actor. Does NOT return the value.",
    request: {
      body: StoreSecretRequestSchema,
    },
    responses: {
      200: {
        description: "Stored secret metadata",
        schema: StoreSecretResponseSchema,
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.post("/vault/secrets", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }

    const body = (await c.req.json()) as {
      workspaceId?: string;
      name?: string;
      type?: string;
      service?: string;
      value?: string | Record<string, unknown>;
      description?: string;
      url?: string;
      agentUserId?: string;
    };

    if (!body.name || body.value === undefined || body.value === null) {
      return c.json({ error: "name and value are required" }, 400);
    }

    const secretType = (body.type ??
      "credential") as (typeof SECRET_TYPES)[number];
    if (!SECRET_TYPES.includes(secretType)) {
      return c.json(
        { error: `Invalid type. Must be one of: ${SECRET_TYPES.join(", ")}` },
        400
      );
    }

    try {
      const acting = await resolveActingContext(c, {
        userId: body.agentUserId,
        workspaceId: body.workspaceId,
      });
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);

      // The agent actor that performed the write (for audit). Falls back to the
      // resolved acting user when no explicit agent key is in play.
      const agentActorId =
        body.agentUserId ??
        (c.get("agentUserId") as string | undefined) ??
        acting.userId;

      const plaintext =
        typeof body.value === "string"
          ? body.value
          : JSON.stringify(body.value);
      const blob = encryptServerSide(plaintext);

      const [secret] = await db
        .insert(secrets)
        .values({
          userId: acting.userId,
          workspaceId: acting.workspaceId,
          name: body.name,
          type: secretType,
          url: body.url ?? null,
          description: body.description ?? null,
          serviceId: body.service ?? null,
          encryptedData: blob.encryptedData,
          iv: blob.iv,
          authTag: blob.authTag,
          encryptionVersion: 1,
          encryptionMode: "server",
        })
        .returning();

      // Audit: record the agent actor that stored this secret.
      await db.insert(secretAuditLog).values({
        secretId: secret.id,
        userId: agentActorId,
        action: "created",
        metadata: {
          via: "hub-protocol",
          actor: "agent",
          service: body.service ?? null,
        },
      });

      return c.json({
        id: secret.id,
        name: secret.name,
        type: secret.type,
        vaultRef: `vault://${secret.id}`,
      });
    } catch (err) {
      logger.error({ err }, "vault.secrets store failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ── GET /vault/secrets ─────────────────────────────────────────────────────
  // Metadata list ONLY — never decrypted values. Scoped to the acting user's
  // workspace via resolveActingContext.
  registerOpenApi(app, {
    method: "get",
    path: "/vault/secrets",
    tags: ["Vault"],
    summary: "List credential metadata",
    description:
      "Returns metadata for secrets owned by the acting user in scope. NEVER returns decrypted values — reading a value requires the request → proposal → grant flow.",
    request: {
      query: z.object({ workspaceId: z.string().uuid().optional() }),
    },
    responses: {
      200: {
        description: "Secret metadata list",
        schema: ListSecretsResponseSchema,
      },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.get("/vault/secrets", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }

    try {
      const workspaceId = c.req.query("workspaceId");
      const acting = await resolveActingContext(c, { workspaceId });
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);

      const rows = await db.query.secrets.findMany({
        where: and(
          eq(secrets.userId, acting.userId),
          eq(secrets.workspaceId, acting.workspaceId),
          isNull(secrets.deletedAt)
        ),
        columns: {
          id: true,
          name: true,
          type: true,
          serviceId: true,
          url: true,
          category: true,
          createdAt: true,
        },
      });

      return c.json({
        secrets: rows.map((r) => ({
          id: r.id,
          name: r.name,
          type: r.type,
          service: r.serviceId ?? null,
          url: r.url ?? null,
          category: r.category ?? null,
          createdAt:
            r.createdAt instanceof Date
              ? r.createdAt.toISOString()
              : String(r.createdAt),
        })),
      });
    } catch (err) {
      logger.error({ err }, "vault.secrets list failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        500
      );
    }
  });

  // ── DELETE /vault/secrets/:id ──────────────────────────────────────────────
  // SOFT-delete only (sets deletedAt/deletedBy) — grants/audit reference the row
  // and resolveVaultSecret returns null for a deleted secret (lazy grant death),
  // so a hard delete is never needed. Thin door over the governed
  // secretsVaultRouter.deleteSecret (write-gate on the LOADED row's workspaceId).
  registerOpenApi(app, {
    method: "delete",
    path: "/vault/secrets/{id}",
    tags: ["Vault"],
    summary: "Soft-delete a credential",
    description:
      "Soft-deletes a vault secret (sets deletedAt/deletedBy). Write-gated on the " +
      "secret's own workspace (editor+) or its owner for a pod-wide secret. Never " +
      "hard-deletes — grants and audit rows reference it. Requires hub-protocol.write.",
    request: { params: z.object({ id: z.string().uuid() }) },
    responses: {
      200: {
        description: "Soft-deleted",
        schema: z.object({ success: z.boolean() }),
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      404: { description: "Not found", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.delete("/vault/secrets/:id", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.write")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.write required" },
        403
      );
    }

    const id = c.req.param("id");
    const idCheck = z.string().uuid().safeParse(id);
    if (!idCheck.success) {
      return c.json({ error: "id must be a UUID" }, 400);
    }

    try {
      const acting = await resolveActingContext(c, {});
      if (!acting.ok) return c.json({ error: acting.error }, acting.status);

      const ctx = await createHubProtocolCallerContext(
        acting.userId,
        c.get("scopes") as string[],
        acting.workspaceId ?? null
      );
      const caller = secretsVaultRouter.createCaller(ctx as never);
      const result = await caller.deleteSecret({ id });
      return c.json(result, 200);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      if (msg.toLowerCase().includes("not found")) {
        return c.json({ error: msg }, 404);
      }
      if (msg.toLowerCase().includes("not a member") || msg.includes("owner")) {
        return c.json({ error: msg }, 403);
      }
      logger.error({ err, id }, "vault.secrets delete failed");
      return c.json({ error: msg }, 500);
    }
  });
}
