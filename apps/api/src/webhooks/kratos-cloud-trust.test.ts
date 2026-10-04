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
  identity: { id: ID },
  authentication_methods: [{ method: "oidc", provider: "cp" }, { method: "password" }],
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
}) {
  const deps: CloudTrustHookDeps = {
    readCloudTrust: async () => {
      if (opts.failRead) throw new Error("db down");
      return opts.trust ?? "sign_in";
    },
    resolveSession: async (cookie) => opts.sessions?.[cookie] ?? null,
    accountHasPodHeldFactor: async () => opts.podHeld ?? true,
    logger: { info: () => undefined, error: () => undefined },
  };
  return createCloudTrustHookRouter(deps);
}

function settings(router: ReturnType<typeof world>, body: unknown, secret = SECRET) {
  return router.request("/settings/guard", {
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
    const res = await settings(world({ sessions: { c1: cloudSession }, podHeld: false }), {
      identity_id: ID,
      session_cookie: "c1",
    });
    expect(res.status).toBe(204);
  });

  it("fails closed when the session cannot be proven: no cookie, invalid cookie, other identity", async () => {
    const other: KratosSessionLike = { ...passwordSession, identity: { id: "someone-else" } };
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

describe("POST /login/cloud", () => {
  const login = (router: ReturnType<typeof world>) =>
    router.request("/login/cloud", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Webhook-Secret": SECRET },
      body: JSON.stringify({ identity_id: ID }),
    });

  it("refuses Cloud sign-in when the owner turned it off", async () => {
    const res = await login(world({ trust: "off" }));
    expect(res.status).toBe(403);
    expect((await res.json()).messages[0].messages[0].id).toBe(CLOUD_SIGN_IN_DISABLED.id);
  });

  it("lets it through for sign_in and sign_in_recovery", async () => {
    expect((await login(world({ trust: "sign_in" }))).status).toBe(204);
    expect((await login(world({ trust: "sign_in_recovery" }))).status).toBe(204);
  });

  it("a failed read is 503", async () => {
    expect((await login(world({ failRead: true }))).status).toBe(503);
  });
});
