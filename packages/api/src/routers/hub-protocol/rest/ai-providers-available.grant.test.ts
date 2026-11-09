/**
 * An APP's token reads the models the pod has enabled, through the REAL hub auth door and door fence, and never a secret.
 *
 * THE GAP THESE PIN: `GET /ai-providers` is not a fenced-safe read (an app was refused) and returns every column but the
 * key (base URL, priority). The new door `GET /ai-providers/available` is admitted for a scoped key that holds
 * `chat.stream` (the verb that lets an app run a turn) and answers only the selectable list.
 *
 * Asserted: an app grant with `chat.stream` pinned to a space reads the list (200) and the wire carries none of the
 * row's secret columns (the mocked table rows hold every one, as the real one does); a scoped key WITHOUT `chat.stream`
 * is refused (GRANT_DOOR_UNSUPPORTED); the old operator door stays refused to the app; a disabled provider's models are
 * absent. Handlers are the real `registerAiProvidersAvailableRoute`; the old door is a stub (the fence's verdict alone).
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SECRETS = [
  "ENCRYPTED-KEY-SENTINEL",
  "https://internal.example/v1",
  "SECRET_ENV_VAR",
];

const { getApiKeyStatus, grant } = vi.hoisted(() => ({
  getApiKeyStatus: vi.fn(),
  grant: { rows: [] as Array<Record<string, unknown>> },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const providers = [
    {
      providerId: "openrouter",
      name: "OpenRouter",
      priority: 1,
      enabled: true,
      models: [{ id: "anthropic/claude-sonnet-4.5", tier: "advanced" }],
      encryptedApiKey: SECRETS[0],
      baseUrl: SECRETS[1],
      apiKeyEnvVar: SECRETS[2],
    },
    {
      providerId: "off",
      name: "Off",
      priority: 0,
      enabled: false,
      models: [{ id: "hidden-model" }],
      encryptedApiKey: SECRETS[0],
      baseUrl: SECRETS[1],
      apiKeyEnvVar: SECRETS[2],
    },
  ];
  return {
    ...actual,
    db: {
      query: {
        users: { findFirst: async () => ({ id: "u", userType: "agent" }) },
        // The mock ignores `where`/`columns` on purpose: the mapper alone must keep secrets out.
        aiProviders: { findMany: async () => providers },
      },
      select: () => ({
        from: () => ({
          where: () => ({ orderBy: async () => grant.rows }),
        }),
      }),
    },
  };
});
vi.mock("../../../access/guest-containment.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isGuestPrincipal: vi.fn(async () => false),
}));
vi.mock("../../../services/api-keys.js", () => ({
  apiKeyService: {
    getApiKeyStatus: (...a: unknown[]) => getApiKeyStatus(...a),
    recordKeyUse: vi.fn(),
    checkRateLimit: () => true,
  },
}));
vi.mock("../../../services/external-user-mapping.js", () => ({
  isSubTokenFeatureEnabled: () => false,
  resolveExternalUserMapping: vi.fn(),
}));

const { hubAuthMiddleware } = await import("../_middleware/auth.js");
const { registerAiProvidersAvailableRoute } =
  await import("./ai-providers-available.js");
import type { HubHono, HubVariables } from "./_shared.js";

const grantRow = (over: Record<string, unknown>) => ({
  id: "g1",
  permissions: ["*"],
  workspaceIds: null,
  projectIds: null,
  entityIds: null,
  expiresAt: null,
  revokedAt: null,
  clientId: "app_chat",
  ...over,
});
const APP_WITH_CHAT = grantRow({
  permissions: ["chat.stream"],
  workspaceIds: ["ws-1"],
});
const APP_WITHOUT_CHAT = grantRow({
  permissions: ["entity.*.read"],
  workspaceIds: ["ws-1"],
});

function app() {
  const hub: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  hub.use("/*", hubAuthMiddleware as never);
  registerAiProvidersAvailableRoute(hub);
  hub.get("/ai-providers", (c) => c.json({ providers: "operator door" }));
  const root = new Hono();
  root.route("/api/hub", hub);
  return root;
}

function asKey(row: Record<string, unknown>) {
  grant.rows = [row];
  getApiKeyStatus.mockResolvedValue({
    status: "valid",
    record: {
      id: "key-1",
      userId: "agent-principal",
      linkedUserId: "pod-owner-human",
      parentKeyId: null,
      scope: ["hub-protocol.read", "hub-protocol.write"],
      keyType: "hub_inbound",
      workspaceId: null,
      expiresAt: null,
    },
  });
}

const get = (path: string) =>
  app().request(`/api/hub${path}`, {
    headers: { authorization: "Bearer synap_test" },
  });

beforeEach(() => vi.clearAllMocks());

describe("GET /ai-providers/available for an app", () => {
  it("an app holding chat.stream reads the enabled models and no secret", async () => {
    asKey(APP_WITH_CHAT);
    const res = await get("/ai-providers/available");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      models: [
        {
          id: "openrouter/anthropic/claude-sonnet-4.5",
          label: "anthropic/claude-sonnet-4.5",
          providerId: "openrouter",
          providerName: "OpenRouter",
          tier: "advanced",
          isDefault: true,
        },
      ],
      defaultModelId: "openrouter/anthropic/claude-sonnet-4.5",
    });
    for (const s of SECRETS) expect(text).not.toContain(s);
    expect(text).not.toContain("hidden-model");
  });

  it("a scoped key WITHOUT chat.stream is refused by the fence", async () => {
    asKey(APP_WITHOUT_CHAT);
    const res = await get("/ai-providers/available");
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("GRANT_DOOR_UNSUPPORTED");
  });

  it("the operator door GET /ai-providers stays refused to the same app", async () => {
    asKey(APP_WITH_CHAT);
    const res = await get("/ai-providers");
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("GRANT_DOOR_UNSUPPORTED");
  });

  it("CONTROL: an unbounded key passes", async () => {
    asKey(grantRow({ clientId: null }));
    expect((await get("/ai-providers/available")).status).toBe(200);
  });
});
