/**
 * Hub Protocol REST — /ai-providers/credentials read + write authority.
 *
 * THE DEFECT THESE PIN (2026-10-09, verified live before the fix): the GET
 * returned every enabled provider's DECRYPTED key to any bearer holding
 * `hub-protocol.read` — a scope in every agent key's default bundle. A
 * connected agent could read the pod's OpenRouter key verbatim. PATCH/DELETE
 * were gated on the same read scope, so any agent could also swap the key that
 * pays for (and sees) the operator's prompts.
 *
 * WHAT IS ASSERTED (reachability, not shape): the plaintext string never
 * appears anywhere in a non-runtime caller's response body, while the
 * Intelligence Service's `is_internal` key still receives it (the BYOI path
 * must keep working); refused writes write NOTHING.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "sk-or-v1-0123456789abcdefPLAINTEXT";

const h = vi.hoisted(() => ({
  dbWrites: 0,
  membershipRole: null as string | null,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const row = {
    providerId: "openrouter",
    enabled: true,
    encryptedApiKey: "ENC",
  };
  return {
    ...actual,
    db: {
      query: {
        aiProviders: {
          findMany: vi.fn(async () => [row]),
          findFirst: vi.fn(async () => row),
        },
        aiProviderCredentials: {
          findFirst: vi.fn(async () => undefined),
          findMany: vi.fn(async () => [{ id: "c1" }]),
        },
      },
      insert: vi.fn(() => {
        h.dbWrites++;
        return { values: vi.fn(async () => []) };
      }),
      update: vi.fn(() => {
        h.dbWrites++;
        return { set: vi.fn(() => ({ where: vi.fn(async () => []) })) };
      }),
      delete: vi.fn(() => {
        h.dbWrites++;
        return { where: vi.fn(async () => []) };
      }),
    },
    isEncryptedServiceKey: (k: string) => k === "ENC",
    decryptServiceKey: () => "sk-or-v1-0123456789abcdefPLAINTEXT",
    encryptServiceKey: (k: string) => `ENCRYPTED::${k.length}`,
    getWorkspaceMembership: vi.fn(async () =>
      h.membershipRole ? { role: h.membershipRole } : null
    ),
  };
});

vi.mock("../../ai-provider-credentials.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    resolveProviderCredentialsBatch: vi.fn(async () => new Map()),
  };
});

vi.mock("../../../utils/push-providers-to-is.js", () => ({
  pushProvidersToIS: vi.fn(async () => {}),
  resolveISAdminEndpoint: vi.fn(async () => ({ endpoint: "x", adminKey: "k" })),
}));

import { registerAiProvidersRoutes } from "./ai-providers.js";
import type { HubHono, HubVariables } from "./_shared.js";

const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const WS = "33333333-3333-4333-8333-333333333333";
const DEFAULT_AGENT_SCOPES = ["hub-protocol.read", "hub-protocol.write"];

function buildApp(vars: Partial<HubVariables> & { keyType?: string }): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    c.set("scopes", vars.scopes ?? DEFAULT_AGENT_SCOPES);
    c.set("userId", vars.userId ?? USER);
    if (vars.agentUserId) c.set("agentUserId", vars.agentUserId);
    if (vars.keyType) c.set("keyType", vars.keyType);
    await next();
  });
  registerAiProvidersRoutes(app);
  return app;
}

const patch = () => ({
  method: "PATCH",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ providerId: "openrouter", apiKey: "sk-new" }),
});

beforeEach(() => {
  h.dbWrites = 0;
  h.membershipRole = null;
});

describe("GET /ai-providers/credentials", () => {
  it.each(["hub_inbound", "user_pat", "service", undefined])(
    "never returns the plaintext key to a %s caller",
    async (keyType) => {
      const app = buildApp({ agentUserId: AGENT, keyType });
      const res = await app.request("/ai-providers/credentials");
      expect(res.status).toBe(200);
      const text = await res.text();
      // Non-vacuity: the provider row IS in the response…
      expect(text).toContain("openrouter");
      // …but no byte of the secret beyond the mask is.
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain("PLAINTEXT");
      expect(JSON.parse(text).providers[0]).toMatchObject({
        hasApiKey: true,
        apiKey: "sk-or-v1…TEXT",
      });
    }
  );

  it.each(["is_internal", "system"])(
    "still returns the plaintext key to the %s runtime key (BYOI path)",
    async (keyType) => {
      const app = buildApp({ keyType });
      const res = await app.request("/ai-providers/credentials");
      expect((await res.json()).providers[0].apiKey).toBe(SECRET);
    }
  );
});

describe("PATCH/DELETE /ai-providers/credentials", () => {
  it("refuses an agent key with the default bundle and writes nothing", async () => {
    const app = buildApp({ agentUserId: AGENT });
    const p = patch();
    const res = await app.request("/ai-providers/credentials", p);
    expect(res.status).toBe(403);
    const del = await app.request("/ai-providers/credentials/openrouter", {
      method: "DELETE",
    });
    expect(del.status).toBe(403);
    expect(h.dbWrites).toBe(0);
  });

  it("refuses a workspace override from a non-admin member", async () => {
    h.membershipRole = "editor";
    const app = buildApp({});
    const res = await app.request(
      `/ai-providers/credentials?workspaceId=${WS}`,
      patch()
    );
    expect(res.status).toBe(403);
    expect(h.dbWrites).toBe(0);
  });

  it("lets a human write their own user-level override", async () => {
    const app = buildApp({});
    const res = await app.request("/ai-providers/credentials", patch());
    expect(res.status).toBe(200);
    expect(h.dbWrites).toBe(1);
  });

  it("lets a workspace admin write the workspace override", async () => {
    h.membershipRole = "admin";
    const app = buildApp({});
    const res = await app.request(
      `/ai-providers/credentials?workspaceId=${WS}`,
      patch()
    );
    expect(res.status).toBe(200);
    expect(h.dbWrites).toBe(1);
  });
});
