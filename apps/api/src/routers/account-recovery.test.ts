/**
 * `/api/account-recovery/*` driven through the REAL router (real hashing,
 * real constant-work matcher, real limiter) with fake stores and a fake
 * Kratos. What each block would catch is named on it.
 */
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MiddlewareHandler } from "hono";
import {
  normalizeRecoveryCode,
  RECOVERY_CODE_COUNT,
  type CloudTrustMode,
} from "@synap-core/types/account-recovery";
import {
  createAccountRecoveryRouter,
  defaultLimiters,
  podAdminUrlFromConfig,
  REDEEM_MIN_RESPONSE_MS,
  type AccountRecoveryDeps,
  type AccountRecoveryLimiters,
} from "./account-recovery.js";
import { hashRecoveryCode, newBatchSalt } from "../account-recovery/codes.js";
import { FixedWindowLimiter } from "../account-recovery/rate-limit.js";

const OWNER = { userId: "user-owner", identityId: "kratos-owner" };
const OWNER_EMAIL = "owner@example.com";
const KRATOS_CODE = "482913";

interface Row {
  id: string;
  userId: string;
  codeHash: string;
  usedAt: Date | null;
  createdAt: Date;
}

function makeWorld(opts: { trust?: CloudTrustMode } = {}) {
  const rows: Row[] = [];
  const logs: unknown[] = [];
  const audits: unknown[] = [];
  let trust: CloudTrustMode = opts.trust ?? "sign_in";
  const kratos = {
    credential: true,
    failCreate: false,
    failRevoke: false,
    revoked: [] as string[],
    created: [] as string[],
  };
  const log =
    (level: string) => (obj: Record<string, unknown>, msg?: string) =>
      logs.push({ level, obj, msg });

  const authenticate: MiddlewareHandler = async (c, next) => {
    const raw = c.req.header("x-test-session");
    if (!raw) return c.json({ error: "Unauthorized" }, 401);
    const session = JSON.parse(raw);
    c.set("userId" as never, session.identity.id as never);
    c.set("session" as never, session as never);
    await next();
  };

  const deps: AccountRecoveryDeps = {
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    logger: { info: log("info"), warn: log("warn"), error: log("error") },
    authenticate: [authenticate],
    findAccountByEmail: async (email) => (email === OWNER_EMAIL ? OWNER : null),
    findAccountByIdentity: async (id) => (id === OWNER.identityId ? OWNER : null),
    codes: {
      listUnused: async (userId) =>
        rows
          .filter((r) => r.userId === userId && r.usedAt === null)
          .map((r) => ({ id: r.id, codeHash: r.codeHash })),
      claim: vi.fn(async (id: string, at: Date) => {
        const r = rows.find((x) => x.id === id);
        if (!r || r.usedAt) return false;
        r.usedAt = at;
        return true;
      }),
      release: async (id, at) => {
        const r = rows.find((x) => x.id === id);
        if (r && r.usedAt?.getTime() === at.getTime()) r.usedAt = null;
      },
      replaceBatch: async (userId, _batch, hashes, at) => {
        for (let i = rows.length - 1; i >= 0; i--) {
          if (rows[i]!.userId === userId) rows.splice(i, 1);
        }
        for (const codeHash of hashes) {
          rows.push({ id: randomUUID(), userId, codeHash, usedAt: null, createdAt: at });
        }
      },
      summary: async (userId) => {
        const mine = rows.filter((r) => r.userId === userId);
        return {
          total: mine.length,
          remaining: mine.filter((r) => !r.usedAt).length,
          createdAt: mine[0]?.createdAt ?? null,
        };
      },
      anyUnused: async () => rows.some((r) => !r.usedAt),
    },
    createKratosRecovery: async (identityId) => {
      if (kratos.failCreate) throw new Error("Kratos recovery code failed: 500");
      kratos.created.push(identityId);
      return {
        recoveryLink: "https://pod-admin.example.test/recovery?flow=flow-1",
        recoveryCode: KRATOS_CODE,
        expiresAt: "2026-10-04T12:15:00.000Z",
      };
    },
    revokeIdentitySessions: async (identityId) => {
      if (kratos.failRevoke) throw new Error("Kratos session revoke failed: 500");
      kratos.revoked.push(identityId);
    },
    identityHasPodHeldCredential: async () => kratos.credential,
    readCloudTrust: async () => trust,
    writeCloudTrust: async (mode) => {
      trust = mode;
    },
    cloudSignInAvailable: async () => true,
    courierStatus: () => "catchall",
    podAdminConfig: () => ({ ok: false, code: "POD_ADMIN_URL_REQUIRED" }),
    isPodAdmin: async (userId) => userId === OWNER.userId,
    audit: async (entry) => {
      audits.push(entry);
    },
  };
  return { rows, logs, audits, kratos, deps, getTrust: () => trust };
}

/** Seed a batch with REAL hashes; returns the plaintext codes. */
async function seed(world: ReturnType<typeof makeWorld>, codes: string[]) {
  const salt = newBatchSalt();
  for (const code of codes) {
    world.rows.push({
      id: randomUUID(),
      userId: OWNER.userId,
      codeHash: await hashRecoveryCode(normalizeRecoveryCode(code)!, salt),
      usedAt: null,
      createdAt: new Date(),
    });
  }
}

const CODES = [
  "ABCD-EFGH-JKMN-PQRS",
  "0123-4567-89AB-CDEF",
  "TVWX-YZ01-2345-6789",
];

function app(
  world: ReturnType<typeof makeWorld>,
  limiters: AccountRecoveryLimiters = defaultLimiters()
) {
  return createAccountRecoveryRouter(world.deps, limiters);
}

function redeem(
  router: ReturnType<typeof app>,
  body: { email: string; code: string }
) {
  return router.request("/redeem", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function session(opts: {
  methods?: Array<{ method: string; provider?: string }>;
  authenticatedMinutesAgo?: number;
  identityId?: string;
}) {
  return JSON.stringify({
    active: true,
    authenticated_at: new Date(
      Date.now() - (opts.authenticatedMinutesAgo ?? 1) * 60_000
    ).toISOString(),
    authentication_methods: opts.methods ?? [{ method: "password" }],
    identity: { id: opts.identityId ?? OWNER.identityId },
  });
}

describe("POST /redeem — single use", () => {
  it("a matching code returns the continue URL once; the same code is then refused", async () => {
    const world = makeWorld();
    await seed(world, CODES);
    const router = app(world);

    const first = await redeem(router, { email: "Owner@Example.com", code: "abcd efgh jkmn pqrs" });
    expect(first.status).toBe(200);
    const ok = await first.json();
    expect(ok).toEqual({
      ok: true,
      continueUrl: `https://pod-admin.example.test/recovery?flow=flow-1#code=${KRATOS_CODE}`,
      expiresAt: "2026-10-04T12:15:00.000Z",
      sessionsRevoked: true,
    });
    expect(world.rows.filter((r) => r.usedAt)).toHaveLength(1);

    const again = await redeem(router, { email: OWNER_EMAIL, code: CODES[0]! });
    expect(again.status).toBe(401);
    expect((await again.json()).error).toBe("invalid_code");
    // Other codes of the batch still work.
    expect((await redeem(router, { email: OWNER_EMAIL, code: CODES[1]! })).status).toBe(200);
  });

  it("two concurrent redeems of one code: exactly one wins (the claim is the tiebreak)", async () => {
    const world = makeWorld();
    await seed(world, CODES);
    const router = app(world);
    const results = await Promise.all([
      redeem(router, { email: OWNER_EMAIL, code: CODES[0]! }),
      redeem(router, { email: OWNER_EMAIL, code: CODES[0]! }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
    expect(world.kratos.created).toHaveLength(1);
  });

  it("revokes the identity's sessions and creates the Kratos recovery for THAT identity", async () => {
    const world = makeWorld();
    await seed(world, CODES);
    await redeem(app(world), { email: OWNER_EMAIL, code: CODES[2]! });
    expect(world.kratos.revoked).toEqual([OWNER.identityId]);
    expect(world.kratos.created).toEqual([OWNER.identityId]);
    expect(world.audits).toContainEqual(
      expect.objectContaining({ userId: OWNER.userId, change: "account_recovery.code_redeemed" })
    );
  });

  it("a Kratos failure (create or revoke) answers 503 and gives the code back", async () => {
    for (const failure of ["failCreate", "failRevoke"] as const) {
      const world = makeWorld();
      await seed(world, CODES);
      world.kratos[failure] = true;
      const res = await redeem(app(world), { email: OWNER_EMAIL, code: CODES[0]! });
      expect(res.status).toBe(503);
      expect((await res.json()).error).toBe("recovery_unavailable");
      expect(world.rows.every((r) => r.usedAt === null)).toBe(true);
    }
  });
});

describe("POST /redeem — a wrong code consumes nothing", () => {
  it("never claims, never touches Kratos, leaves every code unused", async () => {
    const world = makeWorld();
    await seed(world, CODES);
    const res = await redeem(app(world), { email: OWNER_EMAIL, code: "ZZZZ-ZZZZ-ZZZZ-ZZZZ" });
    expect(res.status).toBe(401);
    expect(world.deps.codes.claim).not.toHaveBeenCalled();
    expect(world.kratos.created).toEqual([]);
    expect(world.kratos.revoked).toEqual([]);
    expect(world.rows.every((r) => r.usedAt === null)).toBe(true);
  });

  it("a malformed code is refused the same way", async () => {
    const world = makeWorld();
    await seed(world, CODES);
    const res = await redeem(app(world), { email: OWNER_EMAIL, code: "not-a-code" });
    expect(res.status).toBe(401);
    expect(world.deps.codes.claim).not.toHaveBeenCalled();
  });
});

describe("POST /redeem — enumeration-safe", () => {
  it("unknown email and known email + wrong code: same status, same body, same time class", async () => {
    const world = makeWorld();
    await seed(world, CODES);
    const router = app(world);

    const t0 = Date.now();
    const unknown = await redeem(router, { email: "nobody@example.com", code: CODES[0]! });
    const t1 = Date.now();
    const wrong = await redeem(router, { email: OWNER_EMAIL, code: "ZZZZ-ZZZZ-ZZZZ-ZZZZ" });
    const t2 = Date.now();

    expect(unknown.status).toBe(wrong.status);
    expect(await unknown.json()).toEqual(await wrong.json());
    expect(t1 - t0).toBeGreaterThanOrEqual(REDEEM_MIN_RESPONSE_MS - 5);
    expect(t2 - t1).toBeGreaterThanOrEqual(REDEEM_MIN_RESPONSE_MS - 5);
    expect(Math.abs(t2 - t1 - (t1 - t0))).toBeLessThan(150);
  });

  it("an account with no codes answers exactly like a wrong code", async () => {
    const world = makeWorld();
    const res = await redeem(app(world), { email: OWNER_EMAIL, code: CODES[0]! });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("invalid_code");
  });
});

describe("POST /redeem — rate limits", () => {
  it("per email: the 6th attempt in the window is refused, even for an unknown email", async () => {
    for (const email of [OWNER_EMAIL, "ghost@example.com"]) {
      const world = makeWorld();
      await seed(world, CODES);
      let t = 0;
      const limiters = {
        perEmail: new FixedWindowLimiter(5, 1000, () => t),
        global: new FixedWindowLimiter(1000, 1000, () => t),
      };
      const router = app(world, limiters);
      world.deps.sleep = async () => undefined;
      for (let i = 0; i < 5; i++) {
        expect((await redeem(router, { email, code: "ZZZZ-ZZZZ-ZZZZ-ZZZZ" })).status).toBe(401);
      }
      const limited = await redeem(router, { email, code: CODES[0]! });
      expect(limited.status).toBe(429);
      expect((await limited.json()).error).toBe("rate_limited");
      // Even the RIGHT code is refused while limited — and nothing is claimed.
      expect(world.rows.every((r) => r.usedAt === null)).toBe(true);
      t = 1000; // window rolls over
      if (email === OWNER_EMAIL) {
        expect((await redeem(router, { email, code: CODES[0]! })).status).toBe(200);
      }
    }
  });

  it("global: a spray across many emails trips the global bucket", async () => {
    const world = makeWorld();
    world.deps.sleep = async () => undefined;
    const limiters = {
      perEmail: new FixedWindowLimiter(5, 60_000),
      global: new FixedWindowLimiter(3, 60_000),
    };
    const router = app(world, limiters);
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await redeem(router, { email: `p${i}@example.com`, code: CODES[0]! })).status);
    }
    expect(statuses).toEqual([401, 401, 401, 429]);
  });
});

describe("codes never reach a log or an audit event", () => {
  it("success, wrong code, Kratos failure and generation leave no code anywhere", async () => {
    const world = makeWorld();
    await seed(world, CODES);
    const router = app(world);
    await redeem(router, { email: OWNER_EMAIL, code: CODES[0]! });
    await redeem(router, { email: OWNER_EMAIL, code: "ZZZZ-ZZZZ-ZZZZ-ZZZZ" });
    world.kratos.failCreate = true;
    await redeem(router, { email: OWNER_EMAIL, code: CODES[1]! });
    world.kratos.failCreate = false;
    const gen = await router.request("/codes", {
      method: "POST",
      headers: { "x-test-session": session({}) },
    });
    const generated: string[] = (await gen.json()).codes;
    expect(generated).toHaveLength(RECOVERY_CODE_COUNT);
    await new Promise((r) => setTimeout(r, 10)); // un-awaited rejection audit

    const everything = JSON.stringify([world.logs, world.audits]);
    expect(world.logs.length + world.audits.length).toBeGreaterThan(3); // non-vacuous
    for (const code of [...CODES, ...generated, KRATOS_CODE, "ZZZZ-ZZZZ-ZZZZ-ZZZZ"]) {
      expect(everything).not.toContain(code);
      expect(everything).not.toContain(normalizeRecoveryCode(code) ?? code);
    }
    // Self-check: the scan CAN see a code if one leaks.
    world.deps.logger.info({ leaked: CODES[0] });
    expect(JSON.stringify(world.logs)).toContain(CODES[0]);
  });
});

describe("POST /codes — generation requires privilege", () => {
  it("no session → 401", async () => {
    const res = await app(makeWorld()).request("/codes", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("a sign-in older than the 15-minute privileged window → 403 reauth_required", async () => {
    const world = makeWorld();
    const res = await app(world).request("/codes", {
      method: "POST",
      headers: { "x-test-session": session({ authenticatedMinutesAgo: 16 }) },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("reauth_required");
    expect(world.rows).toHaveLength(0);
  });

  it("a Cloud-only session cannot regenerate when the account already has a pod-held factor", async () => {
    const world = makeWorld({ trust: "sign_in" });
    await seed(world, CODES);
    const res = await app(world).request("/codes", {
      method: "POST",
      headers: {
        "x-test-session": session({ methods: [{ method: "oidc", provider: "cp" }] }),
      },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("cloud_session_not_allowed");
    expect(world.rows).toHaveLength(CODES.length); // old batch untouched
  });

  it("…but may create the FIRST factor, and may regenerate when the owner trusts Cloud for recovery", async () => {
    const first = makeWorld({ trust: "sign_in" });
    first.kratos.credential = false;
    const cloud = { "x-test-session": session({ methods: [{ method: "oidc", provider: "cp" }] }) };
    expect((await app(first).request("/codes", { method: "POST", headers: cloud })).status).toBe(200);

    const trusted = makeWorld({ trust: "sign_in_recovery" });
    await seed(trusted, CODES);
    expect((await app(trusted).request("/codes", { method: "POST", headers: cloud })).status).toBe(200);
  });

  it("a fresh password session gets 10 one-time codes of 80 bits; the old batch is replaced", async () => {
    const world = makeWorld();
    await seed(world, CODES);
    const res = await app(world).request("/codes", {
      method: "POST",
      headers: { "x-test-session": session({}) },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    expect(body.codes).toHaveLength(10);
    expect(new Set(body.codes).size).toBe(10);
    for (const code of body.codes as string[]) {
      expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
      expect(normalizeRecoveryCode(code)).toHaveLength(16); // 16 × 5 bits = 80
    }
    expect(world.rows).toHaveLength(10);
    // Old codes are gone; a new one redeems.
    const router = app(world);
    expect((await redeem(router, { email: OWNER_EMAIL, code: CODES[0]! })).status).toBe(401);
    expect((await redeem(router, { email: OWNER_EMAIL, code: body.codes[3] })).status).toBe(200);
  });
});

describe("GET /status and PUT /cloud-trust", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("reports codes, courier, trust and the session marks", async () => {
    const world = makeWorld();
    await seed(world, CODES);
    const res = await app(world).request("/status", {
      headers: { "x-test-session": session({ methods: [{ method: "oidc", provider: "cp" }] }) },
    });
    expect(await res.json()).toEqual({
      recoveryCodes: { set: true, remaining: 3, total: 3, createdAt: expect.any(String) },
      courier: { configured: false, status: "catchall" },
      cloud: { trust: "sign_in", available: true, canEdit: true },
      session: { privileged: true, cloudOnly: true, canManage: false },
    });
  });

  it("only a pod admin may change Cloud trust", async () => {
    const world = makeWorld();
    world.deps.isPodAdmin = async () => false;
    const res = await app(world).request("/cloud-trust", {
      method: "PUT",
      headers: { "x-test-session": session({}), "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "sign_in_recovery" }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("forbidden");
    expect(world.getTrust()).toBe("sign_in");
  });

  it("a Cloud-only session cannot widen Cloud trust to recovery", async () => {
    const world = makeWorld();
    const res = await app(world).request("/cloud-trust", {
      method: "PUT",
      headers: {
        "x-test-session": session({ methods: [{ method: "oidc", provider: "cp" }] }),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ mode: "sign_in_recovery" }),
    });
    expect(res.status).toBe(403);
    expect(world.getTrust()).toBe("sign_in");
  });

  it("the owner with a password session sets it, and it is audited", async () => {
    const world = makeWorld();
    const res = await app(world).request("/cloud-trust", {
      method: "PUT",
      headers: { "x-test-session": session({}), "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "off" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).cloud.trust).toBe("off");
    expect(world.audits).toContainEqual(
      expect.objectContaining({ change: "account_recovery.cloud_trust_changed", data: { from: "sign_in", to: "off" } })
    );
  });
});

describe("GET /doors", () => {
  it("offers only what works on this pod", async () => {
    const world = makeWorld({ trust: "sign_in" });
    expect(await (await app(world).request("/doors")).json()).toEqual({
      recoveryCode: false,
      email: false,
      cloud: false,
    });
    await seed(world, CODES);
    world.deps.courierStatus = () => "configured";
    await world.deps.writeCloudTrust("sign_in_recovery");
    expect(await (await app(world).request("/doors")).json()).toEqual({
      recoveryCode: true,
      email: true,
      cloud: true,
    });
  });

  it("publishes podAdminUrl when the pod's admin URL is configured", async () => {
    const world = makeWorld();
    world.deps.podAdminConfig = () => ({ ok: true, base: new URL("https://pod-admin.example.org/") });
    const body = await (await app(world).request("/doors")).json();
    expect(body.podAdminUrl).toBe("https://pod-admin.example.org");
  });

  it("omits podAdminUrl when unset or invalid — never a guessed fallback", async () => {
    const world = makeWorld();
    for (const code of ["POD_ADMIN_URL_REQUIRED", "POD_ADMIN_URL_INVALID"] as const) {
      world.deps.podAdminConfig = () => ({ ok: false, code });
      const res = await app(world).request("/doors");
      expect(res.status).toBe(200);
      expect(Object.keys(await res.json()).sort()).toEqual(["cloud", "email", "recoveryCode"]);
    }
  });

  it("a throwing pod-admin resolver never fails /doors", async () => {
    const world = makeWorld();
    world.deps.podAdminConfig = () => {
      throw new Error("boom");
    };
    const res = await app(world).request("/doors");
    expect(res.status).toBe(200);
    expect("podAdminUrl" in (await res.json())).toBe(false);
  });

  it("the REAL resolver drives it: env POD_ADMIN_URL set → origin, unset → absent", async () => {
    const { configuredPodAdminBase } = await import("../pod-admin-config.js");
    const saved = { url: process.env.POD_ADMIN_URL, domain: process.env.POD_ADMIN_DOMAIN };
    try {
      delete process.env.POD_ADMIN_DOMAIN;
      process.env.POD_ADMIN_URL = "https://antoinesrvt-admin.synap.live";
      expect(podAdminUrlFromConfig(configuredPodAdminBase())).toBe("https://antoinesrvt-admin.synap.live");
      delete process.env.POD_ADMIN_URL;
      expect(podAdminUrlFromConfig(configuredPodAdminBase())).toBeUndefined();
      process.env.POD_ADMIN_URL = "https://pod-admin.example.org/some/path";
      expect(podAdminUrlFromConfig(configuredPodAdminBase())).toBeUndefined();
    } finally {
      if (saved.url === undefined) delete process.env.POD_ADMIN_URL;
      else process.env.POD_ADMIN_URL = saved.url;
      if (saved.domain !== undefined) process.env.POD_ADMIN_DOMAIN = saved.domain;
    }
  }, 30_000); // cold import of the @synap/api barrel takes >5s

  it("a failed read is a 503, never an all-false 'nothing works'", async () => {
    const world = makeWorld();
    world.deps.codes.anyUnused = async () => {
      throw new Error("db down");
    };
    const res = await app(world).request("/doors");
    expect(res.status).toBe(503);
  });
});
