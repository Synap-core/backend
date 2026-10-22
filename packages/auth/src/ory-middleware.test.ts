import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getKratosSession: vi.fn(),
  getKratosSessionByToken: vi.fn(),
}));

vi.mock("./ory-kratos.js", () => ({
  getIdentityById: vi.fn(),
  getKratosSession: mocks.getKratosSession,
  getKratosSessionByToken: mocks.getKratosSessionByToken,
}));

vi.mock("./local-mode.js", () => ({
  buildLocalSession: vi.fn(),
  buildLocalUser: vi.fn(),
  getLocalAuthToken: vi.fn(),
  isLocalModeEnabled: () => false,
  safeTokenEqual: vi.fn(),
}));

import { orySessionMiddleware } from "./ory-middleware.js";

const validSession = {
  identity: {
    id: "pod-user-1",
    traits: { email: "person@example.test", name: "Person" },
  },
};

type AuthTestEnv = {
  Variables: {
    requireExplicitSessionToken: boolean;
    userId: string;
  };
};

function applicationRequestApp() {
  const app = new Hono<AuthTestEnv>();
  app.use("*", async (c, next) => {
    c.set("requireExplicitSessionToken", true);
    await next();
  });
  app.use("*", orySessionMiddleware);
  app.get("/", (c) => c.json({ userId: c.get("userId") }));
  return app;
}

function ordinaryRequestApp() {
  const app = new Hono<AuthTestEnv>();
  app.use("*", orySessionMiddleware);
  app.get("/", (c) => c.json({ userId: c.get("userId") }));
  return app;
}

describe("orySessionMiddleware external application requests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getKratosSessionByToken.mockResolvedValue(null);
    mocks.getKratosSession.mockResolvedValue(validSession);
  });

  it("never falls back to a Pod cookie after an invalid explicit token", async () => {
    const response = await applicationRequestApp().request("/", {
      headers: {
        Cookie: "ory_kratos_session=valid-browser-cookie",
        "X-Session-Token": "expired-or-forged-token",
      },
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({
      error: "Invalid X-Session-Token",
    });
    expect(mocks.getKratosSessionByToken).toHaveBeenCalledWith(
      "expired-or-forged-token"
    );
    expect(mocks.getKratosSession).not.toHaveBeenCalled();
  });

  it("keeps normal first-party stale-token cookie fallback intact", async () => {
    const response = await ordinaryRequestApp().request("/", {
      headers: {
        Cookie: "ory_kratos_session=valid-browser-cookie",
        "X-Session-Token": "expired-token",
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ userId: "pod-user-1" });
    expect(mocks.getKratosSession).toHaveBeenCalledWith(
      "ory_kratos_session=valid-browser-cookie"
    );
  });
});
