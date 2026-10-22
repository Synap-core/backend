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
    sessionKind: string;
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

describe("orySessionMiddleware marks a session held as a token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  const app = () => {
    const a = new Hono<AuthTestEnv>();
    a.use("*", orySessionMiddleware);
    a.get("/", (c) => c.json({ kind: c.get("sessionKind") ?? null }));
    return a;
  };

  it("an X-Session-Token that resolves is a kratos_token session", async () => {
    mocks.getKratosSessionByToken.mockResolvedValue(validSession);
    const res = await app().request("/", {
      headers: { "X-Session-Token": "app-held-token" },
    });
    await expect(res.json()).resolves.toEqual({ kind: "kratos_token" });
  });

  it("a browser cookie is not, even beside a stale token", async () => {
    mocks.getKratosSessionByToken.mockResolvedValue(null);
    mocks.getKratosSession.mockResolvedValue(validSession);
    const res = await app().request("/", {
      headers: {
        Cookie: "ory_kratos_session=valid-browser-cookie",
        "X-Session-Token": "expired-token",
      },
    });
    await expect(res.json()).resolves.toEqual({ kind: null });
  });
});
