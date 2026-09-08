/**
 * Hub Protocol REST — /ai-providers write authority.
 *
 * THE DEFECT THESE PIN. An `ai_providers` row carries the `baseUrl` the
 * Intelligence Service sends every prompt to. This door used to gate on
 * `hub-protocol.write` — the scope EVERY agent key is minted with
 * (`agent-identity-service.ts`) — with no governance call anywhere in the
 * router. So any connected agent could repoint pod-wide LLM traffic at a host
 * it controlled, and every subsequent prompt (plus whatever pod context the
 * agents inject) would flow through it. Config-driven prompt exfiltration.
 *
 * WHAT IS ASSERTED, and why it is reachability rather than shape:
 *  1. A key holding only the OLD scope is refused AND WRITES NOTHING. Asserting
 *     the 403 alone would still pass if the handler 403'd after writing, or if
 *     the scope constant were renamed to something nothing checks — so every
 *     refusal case asserts `dbWrites === 0` as well.
 *  2. An AGENT-attributed write PROPOSES: 202, no row written, no IS push. This
 *     is the actual security property. A test that only checked "the gate was
 *     called" would pass on a handler that called it and ignored the verdict.
 *  3. A human operator write with the right scope EXECUTES — the guard must not
 *     be a brick wall that also blocks the legitimate operator flow.
 *  4. enable/disable on an unknown provider is a 404. The old handler issued an
 *     UPDATE matching no rows and returned `{ok:true}`, so a typo read as
 *     success.
 *
 * NEGATIVE CONTROLS RUN (each mutation applied, verified present in the file
 * with grep, then reverted):
 *  - `missingScope()` forced to `false` → 5 tests fail.
 *  - gate verdict `proposed` ignored (fall through to the write) → case 2 fails.
 *    Observed: it trips the STATUS assertion (200 vs 202) first, because that
 *    line comes before the `dbWrites` one — the write-count assertion is the
 *    one that matters, but it is not the one that reports. Stated because the
 *    original wording here guessed the opposite and the run disproved it.
 *  - `PROVIDER_SCOPE` reverted to "hub-protocol.write" → 11 tests fail.
 *
 * WHAT THIS DOES NOT COVER, measured: the gate's own ladder. These tests stub
 * `checkPermissionOrPropose` and assert the ROUTER honours each verdict. That
 * the `aiProvider.*` floor actually forces `propose` for an agent is a property
 * of `@synap/governance-policy` and is pinned by its own ADMIN_ACTIONS_LIVE
 * tests, not here.
 */

import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  dbWrites: 0,
  isPushes: 0,
  existingRow: null as Record<string, unknown> | null,
  /** Row the post-write re-read returns, so the 200 path can serialize it. */
  writtenRow: {
    providerId: "freellmapi",
    name: "FreeLLMAPI",
    baseUrl: "http://eve-brain-freellmapi:3001/v1",
    encryptedApiKey: "ENCRYPTED::20",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  } as Record<string, unknown>,
  gateVerdict: { granted: true } as Record<string, unknown>,
  gateCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  // Spread the real module: a TOTAL mock goes dark the moment the source gains
  // an import this factory does not name, and a file that dies at collection
  // reports as "0 tests" — which reads like success everywhere.
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    db: {
      query: {
        aiProviders: {
          // Before the write: whatever the test staged. After it: the row the
          // handler re-reads to build its 200 body. Without the second half the
          // success path dereferences `row!` on undefined and 500s — which is a
          // mock artefact, not a defect, and would otherwise masquerade as one.
          findFirst: vi.fn(async () =>
            h.dbWrites > 0 ? h.writtenRow : (h.existingRow ?? undefined)
          ),
          findMany: vi.fn(async () => []),
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
    eq: (a: unknown, b: unknown) => ({ op: "eq", a, b }),
    // Deliberately NOT `enc:${k}` — that contains the plaintext as a substring,
    // which makes the "no plaintext in the payload" assertion below pass or fail
    // for the wrong reason. The stub must be unable to leak the input.
    encryptServiceKey: (k: string) => `ENCRYPTED::${k.length}`,
  };
});

vi.mock("../../../utils/permission-check.js", () => ({
  checkPermissionOrPropose: vi.fn(async (opts: Record<string, unknown>) => {
    h.gateCalls.push(opts);
    return h.gateVerdict;
  }),
}));

vi.mock("../../../utils/push-providers-to-is.js", () => ({
  pushProvidersToIS: vi.fn(async () => {
    h.isPushes++;
  }),
  resolveISAdminEndpoint: vi.fn(async () => ({
    endpoint: "http://is.test",
    adminKey: "k",
  })),
}));

import { registerAiProvidersRoutes } from "./ai-providers.js";
import type { HubHono, HubVariables } from "./_shared.js";

const USER = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";

function buildApp(vars: Partial<HubVariables> = {}): HubHono {
  const app: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  app.use("*", async (c, next) => {
    c.set("scopes", vars.scopes ?? ["hub-protocol.read", "providers.write"]);
    c.set("userId", vars.userId ?? USER);
    if (vars.agentUserId) c.set("agentUserId", vars.agentUserId);
    if (vars.linkedUserId) c.set("linkedUserId", vars.linkedUserId);
    await next();
  });
  registerAiProvidersRoutes(app);
  return app;
}

const VALID_BODY = {
  providerId: "freellmapi",
  name: "FreeLLMAPI",
  baseUrl: "http://eve-brain-freellmapi:3001/v1",
  apiKeyEnvVar: "FREELLMAPI_API_KEY",
  apiKey: "freellmapi-deadbeef",
  priority: 90,
  models: [{ id: "auto", tier: "free" as const, costPer1MInput: 0 }],
};

const post = (body?: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});

beforeEach(() => {
  h.dbWrites = 0;
  h.isPushes = 0;
  h.existingRow = null;
  h.gateVerdict = { granted: true };
  h.gateCalls.length = 0;
});

describe("scope narrowing", () => {
  it("refuses a key holding only the default agent bundle, and writes nothing", async () => {
    const app = buildApp({
      scopes: ["hub-protocol.read", "hub-protocol.write", "mcp.write"],
    });
    const res = await app.request("/ai-providers", post(VALID_BODY));

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: expect.stringContaining("providers.write"),
    });
    // The property that matters: refusal happened BEFORE any write.
    expect(h.dbWrites).toBe(0);
    expect(h.isPushes).toBe(0);
    expect(h.gateCalls).toHaveLength(0);
  });

  it.each([
    ["POST", "/ai-providers/x/enable"],
    ["POST", "/ai-providers/x/disable"],
    ["POST", "/ai-providers/sync"],
    ["DELETE", "/ai-providers/x"],
  ])("refuses %s %s without providers.write", async (method, path) => {
    const app = buildApp({
      scopes: ["hub-protocol.read", "hub-protocol.write"],
    });
    const res = await app.request(path, { method });
    expect(res.status).toBe(403);
    expect(h.dbWrites).toBe(0);
  });

  it("still allows reads with hub-protocol.read", async () => {
    const app = buildApp({ scopes: ["hub-protocol.read"] });
    const res = await app.request("/ai-providers");
    expect(res.status).toBe(200);
  });
});

describe("governance", () => {
  it("an agent-attributed write PROPOSES — no row, no IS push", async () => {
    h.gateVerdict = { proposalId: "prop-1" };
    const app = buildApp({ agentUserId: AGENT, linkedUserId: USER });

    const res = await app.request("/ai-providers", post(VALID_BODY));

    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({
      status: "proposed",
      proposalId: "prop-1",
    });
    // THE security property. If this ever goes to 1, an agent repointed the pod.
    expect(h.dbWrites).toBe(0);
    expect(h.isPushes).toBe(0);
  });

  it("attributes the write to the agent, and the human it acts for", async () => {
    const app = buildApp({ agentUserId: AGENT, linkedUserId: USER });
    await app.request("/ai-providers", post(VALID_BODY));

    expect(h.gateCalls).toHaveLength(1);
    expect(h.gateCalls[0]).toMatchObject({
      subjectType: "aiProvider",
      action: "create",
      agentUserId: AGENT,
      userId: USER,
    });
  });

  it("gates an existing provider as an UPDATE, not a create", async () => {
    h.existingRow = { providerId: "freellmapi", encryptedApiKey: "enc:old" };
    const app = buildApp({ agentUserId: AGENT, linkedUserId: USER });
    await app.request("/ai-providers", post(VALID_BODY));

    expect(h.gateCalls[0]).toMatchObject({ action: "update" });
  });

  it("never puts the plaintext key in the proposal payload", async () => {
    const app = buildApp({ agentUserId: AGENT, linkedUserId: USER });
    await app.request("/ai-providers", post(VALID_BODY));

    const payload = JSON.stringify(h.gateCalls[0]?.data ?? {});
    expect(payload).not.toContain("freellmapi-deadbeef");
    expect(payload).toContain("ENCRYPTED::");
    // The field itself must be gone, not merely absent from the serialization.
    expect(h.gateCalls[0]?.data).not.toHaveProperty("apiKey");
  });

  it("a denied verdict is a 403 that writes nothing", async () => {
    h.gateVerdict = { denied: true, reason: "nope" };
    const app = buildApp();
    const res = await app.request("/ai-providers", post(VALID_BODY));

    expect(res.status).toBe(403);
    expect(h.dbWrites).toBe(0);
  });

  it("a granted operator write EXECUTES and pushes to the IS", async () => {
    const app = buildApp();
    const res = await app.request("/ai-providers", post(VALID_BODY));

    expect(res.status).toBe(200);
    expect(h.dbWrites).toBe(1);
    expect(h.isPushes).toBe(1);
  });
});

describe("enable/disable on an unknown provider", () => {
  it("404s instead of reporting ok on a no-op UPDATE", async () => {
    h.existingRow = null;
    const app = buildApp();
    const res = await app.request("/ai-providers/nope/enable", post());

    expect(res.status).toBe(404);
    expect(h.dbWrites).toBe(0);
  });
});
