/**
 * Hub Protocol REST — AI providers
 *
 * Full CRUD for AI provider configs accessible via hub-protocol Bearer auth.
 * Each mutation syncs the full provider list to the active IS so it hot-reloads.
 *
 * GET    /ai-providers            — list all providers (no API keys)
 * POST   /ai-providers            — upsert (create or update) a provider
 * POST   /ai-providers/:id/enable — enable a provider
 * POST   /ai-providers/:id/disable — disable a provider
 * DELETE /ai-providers/:id        — remove a provider
 * POST   /ai-providers/sync       — re-push all providers to IS
 */

import { z } from "zod";
import { db, eq, and, isNull, inArray } from "@synap/database";
import { aiProviders, aiProviderCredentials } from "@synap/database/schema";
import {
  encryptServiceKey,
  decryptServiceKey,
  isEncryptedServiceKey,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import type { Context as HonoLikeContext } from "hono";
import { hasScope, type HubHono } from "./_shared.js";
import { jsonGoverned } from "../proposal-response.js";
import { checkPermissionOrPropose } from "../../../utils/permission-check.js";
import {
  ProviderUpsertSchema,
  AiProviderProposalPayload,
  type AiProviderProposalPayloadInput,
} from "../../ai-providers.schema.js";
import {
  pushProvidersToIS,
  resolveISAdminEndpoint,
} from "../../../utils/push-providers-to-is.js";
import {
  resolveProviderCredentialsBatch,
  SetCredentialSchema,
} from "../../ai-provider-credentials.js";

const logger = createLogger({ module: "hub-ai-providers" });

// ── IS sync ───────────────────────────────────────────────────────────────────
// Payload construction + endpoint/key resolution live in the shared
// pushProvidersToIS() door. Best-effort here: the DB write has committed, so an
// IS that is down must not fail the request — log and move on.

async function syncToIS(): Promise<void> {
  try {
    await pushProvidersToIS();
  } catch (err) {
    logger.warn({ err }, "IS provider sync request failed");
  }
}

// ── Write authority ───────────────────────────────────────────────────────────
//
// SCOPE. These routes previously gated on `hub-protocol.write` — the scope EVERY
// agent key is minted with (`agent-identity-service.ts`). Since an ai_providers
// row carries the `baseUrl` the Intelligence Service sends every prompt to, that
// made "redirect all pod LLM traffic to a host I control" a config change any
// connected agent could perform, with no approval and no audit beyond the
// generic request log. Mutations now require the narrow `providers.write` scope,
// which is deliberately NOT in the default bundle — same treatment as
// `setup.agent`. Reads keep `hub-protocol.read`.
//
// GOVERNANCE. Scope decides who may reach the door; the gate decides whether an
// AGENT gets to walk through it unattended. `aiProvider.*` sits in
// ADMIN_ACTIONS_LIVE, below every floor, so no governance rule and no
// `autoApproveFor` entry can widen it to auto-execute — an agent-initiated
// provider write always becomes a proposal a human approves, and
// `executors/ai-provider.ts` is what applies it on approval.

const PROVIDER_SCOPE = "providers.write";

function missingScope(c: HonoLikeContext): boolean {
  return !hasScope(c.get("scopes") as string[], PROVIDER_SCOPE);
}

type GateOutcome =
  | { kind: "execute" }
  | { kind: "denied"; reason: string }
  | { kind: "proposed"; proposalId: string };

/**
 * Run the governance gate for one provider write.
 *
 * `userId` is the HUMAN the key acts for (`linkedUserId`) when there is one, so
 * an agent write is attributed to its owner and `agentUserId` carries the agent
 * — the split the ladder keys on. A key with no `linkedUserId` is anonymous and
 * falls to the human path, which is why the narrow scope matters as the
 * first line of defence rather than the only one.
 */
async function gateProviderWrite(
  c: HonoLikeContext,
  action: "create" | "update" | "delete",
  payload: Record<string, unknown>
): Promise<GateOutcome> {
  const agentUserId = c.get("agentUserId") as string | undefined;
  const linkedUserId = c.get("linkedUserId") as string | undefined;
  const userId = linkedUserId ?? (c.get("userId") as string);

  const perm = await checkPermissionOrPropose({
    userId,
    agentUserId,
    subjectType: "aiProvider",
    action,
    data: payload,
  });

  if ("denied" in perm && perm.denied) {
    return { kind: "denied", reason: perm.reason ?? "Not permitted" };
  }
  if ("proposalId" in perm && perm.proposalId) {
    return { kind: "proposed", proposalId: perm.proposalId };
  }
  return { kind: "execute" };
}

/**
 * Build the payload the gate stores and the approve-executor replays.
 *
 * The plaintext key is encrypted HERE and never reaches `proposals.data`;
 * `keepExistingKey` records "this write supplied no key" so an approved edit
 * does not blank a working credential.
 */
function toProposalPayload(
  body: z.infer<typeof ProviderUpsertSchema>
): AiProviderProposalPayloadInput {
  const { apiKey, ...rest } = body;
  return AiProviderProposalPayload.parse({
    ...rest,
    encryptedApiKey: apiKey ? encryptServiceKey(apiKey) : null,
    keepExistingKey: !apiKey,
  });
}

async function applyUpsert(
  payload: AiProviderProposalPayloadInput
): Promise<void> {
  const { encryptedApiKey, keepExistingKey: _keep, ...rest } = payload;
  const existing = await db.query.aiProviders.findFirst({
    where: eq(aiProviders.providerId, rest.providerId),
  });
  const resolvedKey = encryptedApiKey ?? existing?.encryptedApiKey ?? null;
  const now = new Date();
  if (existing) {
    await db
      .update(aiProviders)
      .set({ ...rest, encryptedApiKey: resolvedKey, updatedAt: now })
      .where(eq(aiProviders.providerId, rest.providerId));
  } else {
    await db.insert(aiProviders).values({
      ...rest,
      encryptedApiKey: resolvedKey,
      createdAt: now,
      updatedAt: now,
    });
  }
}

// ── Route registration ────────────────────────────────────────────────────────

export function registerAiProvidersRoutes(app: HubHono): void {
  // GET /ai-providers
  app.get("/ai-providers", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const rows = await db.query.aiProviders.findMany({
      orderBy: (t, { asc }) => [asc(t.priority)],
    });
    const providers = rows.map(({ encryptedApiKey: _k, ...p }) => ({
      ...p,
      hasApiKey: !!_k,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    }));
    return c.json({ providers });
  });

  // GET /ai-providers/credentials — resolve per-user/workspace credentials (for IS callback)
  app.get("/ai-providers/credentials", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const linkedUserId = c.get("linkedUserId") as string | undefined;
    const agentUserId = c.get("agentUserId") as string | undefined;
    const userId = linkedUserId ?? agentUserId;
    const workspaceId = c.req.query("workspaceId");

    const providerIds = (
      await db.query.aiProviders.findMany({
        where: eq(aiProviders.enabled, true),
      })
    ).map((p) => p.providerId);

    const overrides = await resolveProviderCredentialsBatch(
      providerIds,
      workspaceId ?? undefined,
      userId ?? undefined
    );

    const rows = await db.query.aiProviders.findMany({
      where: eq(aiProviders.enabled, true),
    });

    const providers = rows.map((p) => {
      const decryptedKey =
        p.encryptedApiKey && isEncryptedServiceKey(p.encryptedApiKey)
          ? decryptServiceKey(p.encryptedApiKey)
          : (p.encryptedApiKey ?? undefined);
      const apiKey = overrides.get(p.providerId) ?? decryptedKey ?? null;
      const source = overrides.has(p.providerId)
        ? userId
          ? "user"
          : "workspace"
        : "pod-wide";
      return {
        providerId: p.providerId,
        apiKey,
        source,
      };
    });

    return c.json({ providers });
  });

  // POST /ai-providers — upsert (governed)
  app.post("/ai-providers", async (c) => {
    if (missingScope(c)) {
      return c.json({ error: `Missing scope: ${PROVIDER_SCOPE}` }, 403);
    }
    let body: z.infer<typeof ProviderUpsertSchema>;
    try {
      body = ProviderUpsertSchema.parse(await c.req.json());
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }

    const existing = await db.query.aiProviders.findFirst({
      where: eq(aiProviders.providerId, body.providerId),
    });
    const payload = toProposalPayload(body);

    const gate = await gateProviderWrite(
      c,
      existing ? "update" : "create",
      payload as unknown as Record<string, unknown>
    );
    if (gate.kind === "denied") return c.json({ error: gate.reason }, 403);
    if (gate.kind === "proposed") {
      // 202: nothing has been written. The caller must not read this as success
      // — `eve` surfaces the review link rather than reporting "saved".
      return jsonGoverned(c, {
        status: "proposed",
        proposalId: gate.proposalId,
        providerId: body.providerId,
        message:
          "Provider change filed for approval — it takes effect once approved.",
      });
    }

    await applyUpsert(payload);
    await syncToIS();

    const row = await db.query.aiProviders.findFirst({
      where: eq(aiProviders.providerId, body.providerId),
    });
    const { encryptedApiKey: _k, ...safe } = row!;
    return c.json({
      ...safe,
      hasApiKey: !!_k,
      createdAt: safe.createdAt.toISOString(),
      updatedAt: safe.updatedAt.toISOString(),
    });
  });

  // POST /ai-providers/sync — re-push all to IS (must be before /:id routes)
  app.post("/ai-providers/sync", async (c) => {
    if (missingScope(c)) {
      return c.json({ error: `Missing scope: ${PROVIDER_SCOPE}` }, 403);
    }
    const count = await db.query.aiProviders.findMany().then((r) => r.length);
    await syncToIS();
    return c.json({ ok: true, count });
  });

  // POST /ai-providers/:id/enable — POST /ai-providers/:id/disable
  //
  // Flipping `enabled` changes which provider the IS cascade actually reaches,
  // so it is an `aiProvider.update` like any other — not a lesser write. The
  // proposal payload REPLAYS the whole stored row with the flag flipped, so
  // approving it cannot quietly reset the rest of the config to defaults.
  for (const [suffix, enabled] of [
    ["enable", true],
    ["disable", false],
  ] as const) {
    app.post(`/ai-providers/:id/${suffix}`, async (c) => {
      if (missingScope(c)) {
        return c.json({ error: `Missing scope: ${PROVIDER_SCOPE}` }, 403);
      }
      const providerId = c.req.param("id");
      const existing = await db.query.aiProviders.findFirst({
        where: eq(aiProviders.providerId, providerId),
      });
      // A silent no-op UPDATE on a missing row used to return ok:true, so a
      // typo read as success. An absent provider is a 404.
      if (!existing) {
        return c.json({ error: `No such provider: ${providerId}` }, 404);
      }

      const payload = AiProviderProposalPayload.parse({
        providerId: existing.providerId,
        name: existing.name,
        baseUrl: existing.baseUrl,
        apiKeyEnvVar: existing.apiKeyEnvVar,
        enabled,
        priority: existing.priority,
        tags: existing.tags,
        models: existing.models,
        rateLimit: existing.rateLimit ?? undefined,
        extraBody: existing.extraBody ?? undefined,
        systemPromptPrefix: existing.systemPromptPrefix ?? undefined,
        metadata: existing.metadata,
        encryptedApiKey: existing.encryptedApiKey,
        keepExistingKey: true,
      });

      const gate = await gateProviderWrite(
        c,
        "update",
        payload as unknown as Record<string, unknown>
      );
      if (gate.kind === "denied") return c.json({ error: gate.reason }, 403);
      if (gate.kind === "proposed") {
        return jsonGoverned(c, {
          status: "proposed",
          proposalId: gate.proposalId,
          providerId,
          message: `Request to ${suffix} "${providerId}" filed for approval.`,
        });
      }

      await applyUpsert(payload);
      await syncToIS();
      return c.json({ ok: true });
    });
  }

  // POST /ai-providers/:id/probe — live connectivity test via IS admin
  app.post("/ai-providers/:id/probe", async (c) => {
    if (missingScope(c)) {
      return c.json({ error: `Missing scope: ${PROVIDER_SCOPE}` }, 403);
    }
    const providerId = c.req.param("id");
    const { endpoint, adminKey } = await resolveISAdminEndpoint();
    if (!adminKey) {
      return c.json({ error: "IS not configured" }, 503);
    }
    try {
      const res = await fetch(
        `${endpoint}/admin/providers/${providerId}/test`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Admin-Key": adminKey,
          },
          signal: AbortSignal.timeout(15_000),
        }
      );
      const body = (await res.json()) as {
        ok?: boolean;
        models?: string[];
        latencyMs?: number;
        error?: string;
      };
      return c.json(body);
    } catch (err) {
      return c.json({ ok: false, error: String(err) }, 502);
    }
  });

  // DELETE /ai-providers/:id
  app.delete("/ai-providers/:id", async (c) => {
    if (missingScope(c)) {
      return c.json({ error: `Missing scope: ${PROVIDER_SCOPE}` }, 403);
    }
    const providerId = c.req.param("id");
    const existing = await db.query.aiProviders.findFirst({
      where: eq(aiProviders.providerId, providerId),
    });
    if (!existing) {
      return c.json({ error: `No such provider: ${providerId}` }, 404);
    }

    const gate = await gateProviderWrite(c, "delete", { providerId });
    if (gate.kind === "denied") return c.json({ error: gate.reason }, 403);
    if (gate.kind === "proposed") {
      return jsonGoverned(c, {
        status: "proposed",
        proposalId: gate.proposalId,
        providerId,
        message: `Request to remove "${providerId}" filed for approval.`,
      });
    }

    await db.delete(aiProviders).where(eq(aiProviders.providerId, providerId));
    await syncToIS();
    return c.json({ ok: true });
  });

  // PATCH /ai-providers/credentials — upsert per-user/workspace API key override
  app.patch("/ai-providers/credentials", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }

    let body: z.infer<typeof SetCredentialSchema>;
    try {
      body = SetCredentialSchema.parse(await c.req.json());
    } catch (err) {
      return c.json({ error: String(err) }, 400);
    }

    const linkedUserId = c.get("linkedUserId") as string | undefined;
    const agentUserId = c.get("agentUserId") as string | undefined;
    const userId = linkedUserId ?? agentUserId ?? (c.get("userId") as string);

    if (!userId) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    const encryptedApiKey = encryptServiceKey(body.apiKey);
    const now = new Date();

    // If workspace is specified, store as workspace-level override
    if (body.workspaceId) {
      const existing = await db.query.aiProviderCredentials.findFirst({
        where: and(
          eq(aiProviderCredentials.providerId, body.providerId),
          eq(aiProviderCredentials.workspaceId, body.workspaceId as any),
          isNull(aiProviderCredentials.userId)
        ),
      });

      if (existing) {
        await db
          .update(aiProviderCredentials)
          .set({
            encryptedApiKey,
            enabled: body.enabled,
            priority: body.priority,
            updatedAt: now,
          })
          .where(eq(aiProviderCredentials.id, existing.id));
      } else {
        await db.insert(aiProviderCredentials).values({
          providerId: body.providerId,
          workspaceId: body.workspaceId as any,
          userId: null,
          encryptedApiKey,
          enabled: body.enabled,
          priority: body.priority,
          createdBy: userId,
          createdAt: now,
          updatedAt: now,
        });
      }
    } else {
      // Store as user-level override
      const existing = await db.query.aiProviderCredentials.findFirst({
        where: and(
          eq(aiProviderCredentials.providerId, body.providerId),
          eq(aiProviderCredentials.userId, userId)
        ),
      });

      if (existing) {
        await db
          .update(aiProviderCredentials)
          .set({
            encryptedApiKey,
            enabled: body.enabled,
            priority: body.priority,
            updatedAt: now,
          })
          .where(eq(aiProviderCredentials.id, existing.id));
      } else {
        await db.insert(aiProviderCredentials).values({
          providerId: body.providerId,
          workspaceId: null,
          userId,
          encryptedApiKey,
          enabled: body.enabled,
          priority: body.priority,
          createdBy: userId,
          createdAt: now,
          updatedAt: now,
        });
      }
    }

    return c.json({ ok: true });
  });

  // DELETE /ai-providers/credentials/:providerId
  app.delete("/ai-providers/credentials/:providerId", async (c) => {
    if (!hasScope(c.get("scopes"), "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }

    const providerId = c.req.param("providerId");
    const linkedUserId = c.get("linkedUserId") as string | undefined;
    const agentUserId = c.get("agentUserId") as string | undefined;
    const userId = linkedUserId ?? agentUserId ?? (c.get("userId") as string);
    const workspaceId = c.req.query("workspaceId");

    if (!userId) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    // Delete both user-level and workspace-level if matching
    const conditions = [
      eq(aiProviderCredentials.providerId, providerId),
      eq(aiProviderCredentials.enabled, true),
    ];

    if (workspaceId) {
      conditions.push(
        eq(aiProviderCredentials.workspaceId, workspaceId as any),
        isNull(aiProviderCredentials.userId)
      );
    } else {
      conditions.push(eq(aiProviderCredentials.userId, userId));
    }

    const existing = await db.query.aiProviderCredentials.findMany({
      where: and(...conditions),
    });

    if (existing.length === 0) {
      return c.json({ ok: true, deleted: 0 });
    }

    const ids = existing.map((e) => e.id);
    await db
      .delete(aiProviderCredentials)
      .where(inArray(aiProviderCredentials.id, ids));

    return c.json({ ok: true, deleted: ids.length });
  });
}
