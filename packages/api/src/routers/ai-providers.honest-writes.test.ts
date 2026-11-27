/**
 * AI provider writes say what happened, at every door.
 *
 * 1. AN EDIT KEEPS WHAT IT DID NOT SEND. `ProviderUpsertSchema` used to default
 *    `models` / `tags` to [] and `metadata` to {} (and `enabled`, `priority`,
 *    `apiKeyEnvVar`), and every writer spread the parse over the stored row.
 *    Pod admin's provider form sends no models, so saving an edit wiped the
 *    provider's model list. Driven here through each of the THREE writers of
 *    an existing row (the tRPC door, the Hub REST door, the approve-executor),
 *    from the wire shape a caller sends, asserting what reaches `.set()`.
 * 2. "SYNC TO IS" IS NOT A SUCCESS WHEN THE IS FAILED. `aiProviders.sync` (and
 *    `POST /ai-providers/sync`) went through the best-effort push that swallows
 *    every error, so it answered `ok: true` with the IS down.
 *
 * Rules out: a test that hand-builds the patch downstream of the door (it would
 * stay green with the spread restored), and a sync test that only checks the
 * push was called.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  existing: null as Record<string, unknown> | null,
  sets: [] as Record<string, unknown>[],
  inserts: [] as Record<string, unknown>[],
  push: vi.fn(async () => undefined as void),
}));

const STORED = {
  id: "row-1",
  providerId: "openrouter",
  name: "OpenRouter",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKeyEnvVar: "OPENROUTER_API_KEY",
  encryptedApiKey: "sealed",
  enabled: true,
  priority: 5,
  tags: ["paid"],
  models: [{ id: "anthropic/claude", tier: "advanced" }],
  metadata: { note: "kept" },
  rateLimit: { rpm: 60 },
  extraBody: null,
  systemPromptPrefix: null,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
};

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  // `select(...).from(...)` answers the sync's count; `.where(...)` the
  // executor's "already approved?" read.
  const selected = Object.assign(Promise.resolve([{ count: 1 }]), {
    where: async () => [{ status: "pending" }],
  });
  return {
    ...actual,
    db: {
      query: {
        aiProviders: {
          findFirst: vi.fn(async () => h.existing ?? STORED),
          findMany: vi.fn(async () => [STORED]),
        },
      },
      update: vi.fn(() => ({
        set: (v: Record<string, unknown>) => {
          h.sets.push(v);
          return { where: async () => [] };
        },
      })),
      insert: vi.fn(() => ({
        values: async (v: Record<string, unknown>) => {
          h.inserts.push(v);
          return [];
        },
      })),
      select: vi.fn(() => ({ from: () => selected })),
    },
    encryptServiceKey: (k: string) => `SEALED::${k.length}`,
    transitionProposal: vi.fn(async () => undefined),
  };
});

vi.mock("../utils/workspace-role.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodAdmin: vi.fn(async () => true),
}));
vi.mock("../middleware/read-only-guard.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { readOnlyGuardMiddleware: t.middleware(({ next }) => next()) };
});
vi.mock("../middleware/audit-log.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { auditLogMiddleware: t.middleware(({ next }) => next()) };
});
vi.mock("../utils/audit-log.js", () => ({ auditLog: () => {} }));
vi.mock("../utils/permission-check.js", () => ({
  checkPermissionOrPropose: vi.fn(async () => ({ granted: true })),
}));
vi.mock("../utils/push-providers-to-is.js", async (importOriginal) => ({
  // The real ISProviderError: the doors map it by `instanceof`.
  ...(await importOriginal<Record<string, unknown>>()),
  pushProvidersToIS: h.push,
}));

import { aiProvidersRouter } from "./ai-providers.js";
import { registerAiProvidersRoutes } from "./hub-protocol/rest/ai-providers.js";
import type { HubHono, HubVariables } from "./hub-protocol/rest/_shared.js";
import { proposalExecRegistry } from "./proposals/execution-registry.js";
import { registerAiProviderExecutors } from "./proposals/executors/ai-provider.js";
import { ISProviderError } from "../utils/push-providers-to-is.js";
import type { Context } from "../types/context.js";

registerAiProviderExecutors();

const ADMIN = "11111111-1111-4111-8111-111111111111";

const trpc = () =>
  aiProvidersRouter.createCaller({
    authenticated: true,
    userId: ADMIN,
  } as unknown as Context);

function hub(): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    c.set("scopes", ["hub-protocol.read", "providers.write"]);
    c.set("userId", ADMIN);
    await next();
  });
  registerAiProvidersRoutes(app);
  return app;
}

/** What pod admin's edit form sends (provider-registry-section.tsx handleSave). */
const FORM_EDIT = {
  providerId: "openrouter",
  name: "OpenRouter (renamed)",
  baseUrl: "https://openrouter.ai/api/v1",
  apiKeyEnvVar: "OPENROUTER_API_KEY",
  priority: 7,
  enabled: true,
};

/** Fields the edit did not send: none may reach the update. */
const UNSENT = ["models", "tags", "metadata", "rateLimit", "extraBody"];

function expectOnlySent(set: Record<string, unknown> | undefined) {
  expect(set).toBeDefined();
  for (const field of UNSENT) expect(set, field).not.toHaveProperty(field);
  // Non-vacuity: what WAS sent arrives.
  expect(set).toMatchObject({ name: "OpenRouter (renamed)", priority: 7 });
}

beforeEach(() => {
  h.existing = null;
  h.sets.length = 0;
  h.inserts.length = 0;
  h.push.mockReset();
  h.push.mockResolvedValue(undefined);
});

describe("an edit of an existing provider keeps every field it did not send", () => {
  it("tRPC aiProviders.upsert (pod admin's form) keeps the models", async () => {
    await trpc().upsert(FORM_EDIT);
    expect(h.sets).toHaveLength(1);
    expectOnlySent(h.sets[0]);
    expect(h.inserts).toHaveLength(0);
  });

  it("an edit that names no enabled/priority/apiKeyEnvVar keeps them too", async () => {
    await trpc().upsert({
      providerId: "openrouter",
      name: "OpenRouter",
      baseUrl: "https://openrouter.ai/api/v1",
    });
    for (const field of ["enabled", "priority", "apiKeyEnvVar", ...UNSENT])
      expect(h.sets[0], field).not.toHaveProperty(field);
  });

  it("Hub REST POST /ai-providers keeps the models", async () => {
    const res = await hub().request("/ai-providers", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(FORM_EDIT),
    });
    expect(res.status).toBe(200);
    expect(h.sets).toHaveLength(1);
    expectOnlySent(h.sets[0]);
  });

  it("an approved aiProvider/update proposal keeps the models", async () => {
    const ex = proposalExecRegistry.resolve("aiProvider/update", "update");
    await ex!.execute({
      proposal: {
        id: "p1",
        targetType: "aiProvider",
        targetId: "openrouter",
        proposalType: "update",
        workspaceId: null,
        sessionId: null,
        projectId: null,
        agentUserId: "agent-1",
        sourceMessageId: null,
        data: { ...FORM_EDIT, keepExistingKey: true },
      },
      payload: null,
      userId: ADMIN,
      input: { proposalId: "p1" },
      ctx: {} as never,
      deps: {
        reportProposalOutcome: vi.fn(),
        emitProposalReviewed: vi.fn(),
      } as never,
    });
    expect(h.sets).toHaveLength(1);
    expectOnlySent(h.sets[0]);
  });

  it("a NEW provider still gets the defaults for what it did not send", async () => {
    // findFirst answers nothing: there is no stored row.
    const { db } = await import("@synap/database");
    const findFirst = db.query.aiProviders.findFirst as unknown as {
      mockResolvedValueOnce: (v: unknown) => void;
    };
    findFirst.mockResolvedValueOnce(undefined);
    await trpc().upsert({
      providerId: "fresh",
      name: "Fresh",
      baseUrl: "https://fresh.example/v1",
    });
    expect(h.inserts[0]).toMatchObject({
      providerId: "fresh",
      apiKeyEnvVar: "PROVIDER_API_KEY",
      enabled: true,
      priority: 10,
      tags: [],
      models: [],
      metadata: {},
    });
  });
});

describe("Sync to IS answers what the IS answered", () => {
  it("tRPC sync: an IS that refused is BAD_GATEWAY, never ok", async () => {
    h.push.mockRejectedValueOnce(
      new ISProviderError("IS_REJECTED", "IS provider sync failed: 500", 500)
    );
    await expect(trpc().sync()).rejects.toMatchObject({
      code: "BAD_GATEWAY",
      message: expect.stringContaining("500"),
    });
  });

  it("tRPC sync: no IS configured is PRECONDITION_FAILED", async () => {
    h.push.mockRejectedValueOnce(
      new ISProviderError("IS_NOT_CONFIGURED", "IS not configured")
    );
    await expect(trpc().sync()).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
  });

  it("tRPC sync: an unreachable IS (fetch threw) is an error too", async () => {
    h.push.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(trpc().sync()).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: expect.stringContaining("fetch failed"),
    });
  });

  it("tRPC sync: a push that went through answers ok with the count", async () => {
    await expect(trpc().sync()).resolves.toEqual({ ok: true, count: 1 });
    expect(h.push).toHaveBeenCalledTimes(1);
  });

  it("Hub REST POST /ai-providers/sync: a refusal is 502 with ok false", async () => {
    h.push.mockRejectedValueOnce(
      new ISProviderError("IS_REJECTED", "IS provider sync failed: 500", 500)
    );
    const res = await hub().request("/ai-providers/sync", { method: "POST" });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false });
  });

  it("a write's own push stays best-effort: the edit is saved with the IS down", async () => {
    h.push.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(trpc().upsert(FORM_EDIT)).resolves.toMatchObject({
      providerId: "openrouter",
    });
    expect(h.sets).toHaveLength(1);
  });
});
