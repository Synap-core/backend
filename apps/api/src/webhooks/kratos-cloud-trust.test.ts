/**
 * The Kratos Cloud-trust hooks, driven with the exact bodies our jsonnet
 * emits (`generate_kratos_config` in `synap`):
 *   settings: { identity_id, session_cookie }
 *   login:    { identity_id }
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  CLOUD_SESSION_CANNOT_CHANGE_CREDENTIALS,
  CLOUD_SIGN_IN_DISABLED,
  PASSKEY_CHANGE_NEEDS_PRESENCE,
} from "@synap-core/types/kratos-messages";
import type { CloudTrustMode } from "@synap-core/types/account-recovery";
import {
  createCloudTrustHookRouter,
  type CloudTrustHookDeps,
} from "./kratos-cloud-trust.js";
import type { KratosSessionLike } from "../account-recovery/policy.js";

const SECRET = "test-webhook-secret";
const ID = "kratos-owner";

const cloudSession: KratosSessionLike = {
  identity: { id: ID },
  authentication_methods: [{ method: "oidc", provider: "cp" }],
};
const passwordSession: KratosSessionLike = {
  id: "kratos-session-1",
  identity: { id: ID },
  authentication_methods: [
    { method: "oidc", provider: "cp" },
    { method: "password" },
  ],
};
const recoverySession: KratosSessionLike = {
  identity: { id: ID },
  authentication_methods: [{ method: "code_recovery" }],
};

function world(opts: {
  trust?: CloudTrustMode;
  sessions?: Record<string, KratosSessionLike | null>;
  podHeld?: boolean;
  failRead?: boolean;
  /** W3 slice 3: does the person hold a proof factor, and a grant to redeem? */
  proofFactor?: boolean;
  grants?: number;
  notified?: string[];
  /** "Add this device" (9 Nov 2026): the session the grants are bound to, and the keys the guard asked with. */
  grantSession?: string;
  askedWith?: Array<string | null>;
}) {
  let grants = opts.grants ?? 0;
  const deps: CloudTrustHookDeps = {
    readCloudTrust: async () => {
      if (opts.failRead) throw new Error("db down");
      return opts.trust ?? "sign_in";
    },
    resolveSession: async (cookie) => opts.sessions?.[cookie] ?? null,
    accountHasPodHeldFactor: async () => opts.podHeld ?? true,
    passkeyChange: {
      hasProofFactor: async () => opts.proofFactor ?? false,
      redeemGrant: async (_identityId, sessionKey) => {
        opts.askedWith?.push(sessionKey);
        // As `redeemPasskeyChangeGrant`: no session, no grant.
        if (!sessionKey) return false;
        if (opts.grantSession && sessionKey !== opts.grantSession) return false;
        if (grants <= 0) return false;
        grants -= 1;
        return true;
      },
      notify: async (identityId) => {
        opts.notified?.push(identityId);
      },
    },
    logger: { info: () => undefined, error: () => undefined },
  };
  return createCloudTrustHookRouter(deps);
}

function settings(
  router: ReturnType<typeof world>,
  body: unknown,
  secret = SECRET,
  path = "/settings/guard"
) {
  return router.request(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Webhook-Secret": secret },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  process.env.KRATOS_WEBHOOK_SECRET = SECRET;
});

describe("POST /settings/guard", () => {
  it("refuses a Cloud-only session changing an account that has a pod-held factor", async () => {
    const res = await settings(world({ sessions: { c1: cloudSession } }), {
      identity_id: ID,
      session_cookie: "c1",
    });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.messages[0].messages[0]).toMatchObject({
      id: CLOUD_SESSION_CANNOT_CHANGE_CREDENTIALS.id,
      type: "error",
    });
  });

  it("allows a session that also proved the password, or a recovery code", async () => {
    for (const s of [passwordSession, recoverySession]) {
      const res = await settings(world({ sessions: { c1: s } }), {
        identity_id: ID,
        session_cookie: "c1",
      });
      expect(res.status).toBe(204);
    }
  });

  it("allows Cloud-only when the owner trusts Cloud for recovery", async () => {
    const res = await settings(
      world({ trust: "sign_in_recovery", sessions: { c1: cloudSession } }),
      { identity_id: ID, session_cookie: "c1" }
    );
    expect(res.status).toBe(204);
  });

  it("allows Cloud-only to add the FIRST pod-held factor", async () => {
    const res = await settings(
      world({ sessions: { c1: cloudSession }, podHeld: false }),
      {
        identity_id: ID,
        session_cookie: "c1",
      }
    );
    expect(res.status).toBe(204);
  });

  it("fails closed when the session cannot be proven: no cookie, invalid cookie, other identity", async () => {
    const other: KratosSessionLike = {
      ...passwordSession,
      identity: { id: "someone-else" },
    };
    const router = world({ sessions: { other } });
    for (const body of [
      { identity_id: ID },
      { identity_id: ID, session_cookie: "expired" },
      { identity_id: ID, session_cookie: "other" },
    ]) {
      expect((await settings(router, body)).status).toBe(403);
    }
  });

  it("a failed read is 503 (system error), never a refusal or a silent allow", async () => {
    const res = await settings(world({ failRead: true }), {
      identity_id: ID,
      session_cookie: "c1",
    });
    expect(res.status).toBe(503);
    expect(await res.json()).not.toHaveProperty("messages");
  });

  it("rejects a wrong webhook secret", async () => {
    const res = await settings(world({}), { identity_id: ID }, "nope");
    expect(res.status).toBe(401);
  });
});

describe("POST /settings/guard?method=passkey (W3 slice 3, founder decision 2)", () => {
  const passkey = (w: ReturnType<typeof world>) =>
    settings(
      w,
      { identity_id: ID, session_cookie: "c1" },
      SECRET,
      "/settings/guard?method=passkey"
    );

  it("GUARDRAIL: a person who holds a proof factor cannot change passkeys without a proof", async () => {
    const res = await passkey(
      world({ sessions: { c1: passwordSession }, proofFactor: true })
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.messages[0].messages[0]).toMatchObject({
      id: PASSKEY_CHANGE_NEEDS_PRESENCE.id,
      type: "error",
    });
  });

  it("one proof allows ONE change, and the person is told", async () => {
    const notified: string[] = [];
    const w = world({
      sessions: { c1: passwordSession },
      proofFactor: true,
      grants: 1,
      notified,
    });
    expect((await passkey(w)).status).toBe(204);
    expect(notified).toEqual([ID]);
    expect((await passkey(w)).status).toBe(403);
  });

  it("GUARDRAIL: a grant is redeemed only by the session that obtained it (founder, 9 Nov 2026)", async () => {
    const askedWith: Array<string | null> = [];
    const w = world({
      sessions: {
        c1: passwordSession,
        c2: { ...passwordSession, id: "kratos-session-2" },
      },
      proofFactor: true,
      grants: 1,
      grantSession: "kratos:kratos-session-1",
      askedWith,
    });
    // Another session of the same person cannot spend it.
    const other = await settings(
      w,
      { identity_id: ID, session_cookie: "c2" },
      SECRET,
      "/settings/guard?method=passkey"
    );
    expect(other.status).toBe(403);
    // The session that obtained it can, once.
    expect((await passkey(w)).status).toBe(204);
    expect(askedWith).toEqual([
      "kratos:kratos-session-2",
      "kratos:kratos-session-1",
    ]);
  });

  it("GUARDRAIL: with no session of this person (no cookie, or another person's), the guard asks with no key and refuses", async () => {
    const askedWith: Array<string | null> = [];
    // Cloud trusted for recovery, so the Cloud-only rule lets these through
    // and the passkey check is what decides.
    const w = world({
      trust: "sign_in_recovery",
      sessions: {
        c9: { ...passwordSession, identity: { id: "someone-else" } },
      },
      proofFactor: true,
      grants: 5,
      askedWith,
    });
    const noCookie = await settings(
      w,
      { identity_id: ID },
      SECRET,
      "/settings/guard?method=passkey"
    );
    const foreign = await settings(
      w,
      { identity_id: ID, session_cookie: "c9" },
      SECRET,
      "/settings/guard?method=passkey"
    );
    expect(noCookie.status).toBe(403);
    expect(foreign.status).toBe(403);
    expect(askedWith).toEqual([null, null]);
  });

  it("the first passkey needs no proof (no factor yet); other methods are not asked", async () => {
    expect(
      (await passkey(world({ sessions: { c1: passwordSession } }))).status
    ).toBe(204);
    const res = await settings(
      world({ sessions: { c1: passwordSession }, proofFactor: true }),
      { identity_id: ID, session_cookie: "c1" }
    );
    expect(res.status).toBe(204);
  });
});

describe("POST /login/cloud", () => {
  const login = (router: ReturnType<typeof world>) =>
    router.request("/login/cloud", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Webhook-Secret": SECRET,
      },
      body: JSON.stringify({ identity_id: ID }),
    });

  it("refuses Cloud sign-in when the owner turned it off", async () => {
    const res = await login(world({ trust: "off" }));
    expect(res.status).toBe(403);
    expect((await res.json()).messages[0].messages[0].id).toBe(
      CLOUD_SIGN_IN_DISABLED.id
    );
  });

  it("lets it through for sign_in and sign_in_recovery", async () => {
    expect((await login(world({ trust: "sign_in" }))).status).toBe(204);
    expect((await login(world({ trust: "sign_in_recovery" }))).status).toBe(
      204
    );
  });

  it("a failed read is 503", async () => {
    expect((await login(world({ failRead: true }))).status).toBe(503);
  });
});
