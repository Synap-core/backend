/**
 * D9 — PROVISIONING_TOKEN is BOOTSTRAP-ONLY.
 *
 * Through the REAL setup routes: the right token is accepted only while the
 * pod has no owner (no Kratos identity, no human `users` row). Once it has
 * one, every door that recognises the token answers a typed 403
 * PROVISIONING_TOKEN_RETIRED; a WRONG token is still a plain 401 (the
 * bootstrap read never runs for it); an unreadable bootstrap state is a 503,
 * never a silent accept.
 *
 * Mocked: the Kratos identity list, the human-count read, the API-key lookup.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TOKEN = "test-provisioning-token-0123456789";

const listIdentities = vi.fn();
const humanCount = vi.fn();
const validateApiKey = vi.fn();

vi.mock("@synap/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@synap/auth")>()),
  kratosAdmin: { listIdentities },
}));
vi.mock("../../../services/api-keys.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../services/api-keys.js")>();
  return {
    ...actual,
    apiKeyService: { ...actual.apiKeyService, validateApiKey },
  };
});
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  return {
    ...actual,
    db: {
      select: () => ({
        from: () => ({ where: async () => humanCount() }),
      }),
    },
  };
});

const { registerSetupRoutes } = await import("./setup.js");

function post(path: string, token: string, body: unknown = {}) {
  const app = new OpenAPIHono();
  registerSetupRoutes(app as never);
  return app.request(path, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function ownerExists(yes: boolean) {
  listIdentities.mockResolvedValue({ data: [] });
  humanCount.mockResolvedValue([{ count: yes ? 1 : 0 }]);
}

beforeEach(() => {
  process.env.PROVISIONING_TOKEN = TOKEN;
  listIdentities.mockReset();
  humanCount.mockReset();
  validateApiKey.mockReset();
  validateApiKey.mockResolvedValue(null);
});

const DOORS: Array<[string, unknown]> = [
  ["/setup/agent", { agentType: "openclaw" }],
  ["/setup/service", { name: "svc" }],
  ["/setup/magic-link", { email: "owner@example.com" }],
];

describe("PROVISIONING_TOKEN after the pod has an owner (D9)", () => {
  it.each(DOORS)("%s → 403 PROVISIONING_TOKEN_RETIRED", async (path, body) => {
    ownerExists(true);
    const res = await post(path, TOKEN, body);
    expect(res.status).toBe(403);
    const json = (await res.json()) as { code?: string; error?: string };
    expect(json.code).toBe("PROVISIONING_TOKEN_RETIRED");
    expect(json.error).toMatch(/synap init/);
    expect(JSON.stringify(json)).not.toContain(TOKEN);
  });

  it("a Kratos identity alone counts as bootstrapped", async () => {
    listIdentities.mockResolvedValue({ data: [{ id: "k1" }] });
    humanCount.mockResolvedValue([{ count: 0 }]);
    const res = await post("/setup/agent", TOKEN, { agentType: "openclaw" });
    expect(res.status).toBe(403);
  });

  it("/setup/first-admin (token header) → 403 PROVISIONING_TOKEN_RETIRED", async () => {
    ownerExists(true);
    const res = await post("/setup/first-admin", TOKEN, {
      email: "x@example.com",
      password: "test-password-123",
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe(
      "PROVISIONING_TOKEN_RETIRED"
    );
  });
});

describe("before bootstrap and on other failures", () => {
  it("no owner yet → the magic link is minted (positive control)", async () => {
    ownerExists(false);
    const res = await post("/setup/magic-link", TOKEN, {});
    expect(res.status).toBe(200);
    expect(((await res.json()) as { url?: string }).url).toMatch(
      /\/setup\?token=/
    );
  });

  it("a wrong token stays a 401 and never reads bootstrap state", async () => {
    ownerExists(true);
    const res = await post("/setup/agent", "test-wrong-token", {
      agentType: "openclaw",
    });
    expect(res.status).toBe(401);
    expect(humanCount).not.toHaveBeenCalled();
  });

  it("an unreadable bootstrap state is a 503, not an accept", async () => {
    listIdentities.mockResolvedValue({ data: [] });
    humanCount.mockRejectedValue(new Error("db down"));
    const res = await post("/setup/agent", TOKEN, { agentType: "openclaw" });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { code: string }).code).toBe(
      "BOOTSTRAP_STATE_UNAVAILABLE"
    );
  });
});
