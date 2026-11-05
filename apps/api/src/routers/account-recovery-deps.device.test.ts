/**
 * The REAL account-recovery wiring (`accountRecoveryDeps.authenticate`) lets a
 * Synap app's device token reach `/status` as the person. The router's own
 * tests inject a stand-in `authenticate`, so they stay green whatever the
 * deps wire; this one reads the deps list itself. Would catch: the deps going
 * back to the Kratos-only `authMiddleware` (a device-signed-in Relay then reads
 * 401 on its recovery settings).
 *
 * The session gates are stand-ins with the real contracts: `@synap/api`'s
 * `appSessionMiddleware()` takes a `synap_pd_…` bearer as the person (its own
 * behaviour is proven on PGlite in packages/api
 * `person-device-token.pglite.test.ts`), `@synap/auth`'s `authMiddleware`
 * knows only a Kratos session and refuses a bearer.
 */
import { describe, expect, it, vi } from "vitest";
import type { MiddlewareHandler } from "hono";

const OWNER = { userId: "user-owner", identityId: "kratos-owner" };

vi.mock("@synap/api", () => ({
  appSessionMiddleware: (): MiddlewareHandler => async (c, next) => {
    const bearer = c.req
      .header("authorization")
      ?.match(/^Bearer (synap_pd_\S+)$/)?.[1];
    if (!bearer) return c.json({ error: "Unauthorized" }, 401);
    c.set("userId" as never, OWNER.identityId as never);
    c.set(
      "session" as never,
      {
        identity: { id: OWNER.identityId, traits: { email: "o@x" } },
        active: true,
        device: {
          id: "device-1",
          clientId: "synap-relay",
          authTime: new Date(),
        },
      } as never
    );
    return next();
  },
  refuseGuestSession: (async (_c, next) => next()) as MiddlewareHandler,
  isPodAdmin: async () => true,
}));
vi.mock("@synap/auth", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  authMiddleware: (async (c) =>
    c.json({ error: "Invalid session" }, 401)) as MiddlewareHandler,
}));
vi.mock("@synap/jobs", () => ({ createUnifiedEvent: vi.fn() }));

const { accountRecoveryDeps } = await import("./account-recovery-deps.js");
const { createAccountRecoveryRouter } = await import("./account-recovery.js");

describe("account recovery takes a Synap app's device token (real deps wiring)", () => {
  it("GET /status with a device bearer answers the person, privileged from its step-up clock", async () => {
    const router = createAccountRecoveryRouter({
      ...accountRecoveryDeps,
      // Every read below the gate is faked: the wiring is under test.
      findAccountByIdentity: async (id) =>
        id === OWNER.identityId ? OWNER : null,
      codes: {
        ...accountRecoveryDeps.codes,
        summary: async () => ({ total: 0, remaining: 0, createdAt: null }),
      },
      readCloudTrust: async () => "sign_in",
      cloudSignInAvailable: async () => true,
      courierStatus: () => "catchall",
      isPodAdmin: async () => true,
      identityHasPodHeldCredential: async () => true,
    });
    const res = await router.request("/status", {
      headers: { authorization: "Bearer synap_pd_device-token" },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).session).toEqual({
      privileged: true,
      cloudOnly: false,
      canManage: true,
    });
  });
});
