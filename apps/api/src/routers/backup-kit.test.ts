/**
 * `/api/backup/*` driven through the REAL router, the REAL kit store (files in
 * a temp state dir, the same layout pgdata-safety.sh writes) and the REAL
 * status reader — only the session, owner lookup and Cloud trust are fakes.
 * What each block would catch is named on it.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { MiddlewareHandler } from "hono";

// The status reader's module imports @synap-core/core, which validates config at import; nothing connects.
vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgres://unused:unused@127.0.0.1:1/unused";
});
import type { CloudTrustMode } from "@synap-core/types/account-recovery";
import {
  createBackupKitRouter,
  kitFileName,
  type BackupKitDeps,
} from "./backup-kit.js";
import { FixedWindowLimiter } from "../account-recovery/rate-limit.js";
import { readKitText, writeKitMarker } from "../backup-kit/kit-store.js";
import { readRecoveryKitSaved } from "../status/pod-data-status.js";

const OWNER = { userId: "user-owner", identityId: "kratos-owner" };
const MEMBER = { userId: "user-member", identityId: "kratos-member" };
const PASSWORD =
  "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0";
const B2_KEY = "K005-b2-application-key-secret";
const KIT = [
  "═══════════════════════ SYNAP BACKUP RECOVERY KIT ═══════════════════════",
  "Repository : b2:synap-backups:pods/abc",
  `Password   : ${PASSWORD}`,
  `BACKUP_B2_ACCOUNT_KEY=${B2_KEY}`,
  "",
].join("\n");
const NOW = new Date("2026-10-15T20:00:00Z");
const minutesAgo = (m: number) =>
  new Date(NOW.getTime() - m * 60_000).toISOString();

function session(
  identityId: string,
  opts: { signedInMinutesAgo?: number; methods?: string[] } = {}
) {
  return {
    identity: { id: identityId },
    authenticated_at: minutesAgo(opts.signedInMinutesAgo ?? 2),
    authentication_methods: (opts.methods ?? ["password"]).map((method) => ({
      method,
      ...(method === "oidc" ? { provider: "cp" } : {}),
    })),
  };
}

function makeWorld(opts: { trust?: CloudTrustMode; kit?: string | null } = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), "backup-kit-"));
  mkdirSync(join(stateDir, "kit"));
  if (opts.kit !== null) {
    writeFileSync(join(stateDir, "kit", "recovery-kit.txt"), opts.kit ?? KIT, {
      mode: 0o600,
    });
    writeFileSync(join(stateDir, "kit", "status"), "pending\n");
  }
  const logs: unknown[] = [];
  const audits: Array<{ userId: string; change: string; data?: unknown }> = [];
  const log = (level: string) => (obj: Record<string, unknown>, msg?: string) =>
    logs.push({ level, obj, msg });
  const authenticate: MiddlewareHandler = async (c, next) => {
    const raw = c.req.header("x-test-session");
    if (!raw) return c.json({ error: "Unauthorized" }, 401);
    const s = JSON.parse(raw);
    c.set("userId" as never, s.identity.id as never);
    c.set("session" as never, s as never);
    return next();
  };
  const limiter = new FixedWindowLimiter(5, 15 * 60_000, () => NOW.getTime());
  const deps: BackupKitDeps = {
    now: () => NOW,
    logger: { info: log("info"), warn: log("warn"), error: log("error") },
    authenticate: [authenticate],
    findAccountByIdentity: async (id) =>
      id === OWNER.identityId
        ? OWNER
        : id === MEMBER.identityId
          ? MEMBER
          : null,
    isPodAdmin: async (userId) => userId === OWNER.userId,
    readCloudTrust: async () => opts.trust ?? "sign_in",
    kit: {
      readText: () => readKitText(stateDir),
      markSaved: () => writeKitMarker(stateDir, "saved"),
    },
    podHost: () => "pod.alice.synap.live",
    audit: async (entry) => {
      audits.push(entry);
    },
  };
  const call = (
    path: string,
    s: object | null,
    body?: unknown,
    kit?: Partial<BackupKitDeps["kit"]>
  ) =>
    createBackupKitRouter(
      kit ? { ...deps, kit: { ...deps.kit, ...kit } } : deps,
      limiter
    ).request(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(s ? { "x-test-session": JSON.stringify(s) } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { stateDir, logs, audits, call };
}

const everything = (w: ReturnType<typeof makeWorld>) =>
  JSON.stringify(w.logs) + JSON.stringify(w.audits);

describe("POST /recovery-kit — the download", () => {
  it("the owner, freshly signed in with a pod factor, gets the kit as a no-store attachment", async () => {
    const w = makeWorld();
    const res = await w.call("/recovery-kit", session(OWNER.identityId));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe(KIT);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-disposition")).toBe(
      'attachment; filename="synap-recovery-kit-pod.alice.synap.live.txt"'
    );
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(w.audits).toEqual([
      { userId: OWNER.userId, change: "backup.recovery_kit_downloaded" },
    ]);
    // catches: the kit (or its password / key) leaking into a log or the audit trail
    expect(everything(w)).not.toContain(PASSWORD);
    expect(everything(w)).not.toContain(B2_KEY);
  });

  it("no session → 401; a member who is not the owner → 403 forbidden, no kit", async () => {
    const w = makeWorld();
    expect((await w.call("/recovery-kit", null)).status).toBe(401);
    const res = await w.call("/recovery-kit", session(MEMBER.identityId));
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(JSON.parse(body).error).toBe("forbidden");
    expect(body).not.toContain(PASSWORD);
  });

  it("a sign-in older than 15 minutes → 403 reauth_required (the step-up)", async () => {
    const w = makeWorld();
    const res = await w.call(
      "/recovery-kit",
      session(OWNER.identityId, { signedInMinutesAgo: 16 })
    );
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(JSON.parse(body).error).toBe("reauth_required");
    expect(body).not.toContain(PASSWORD);
    // and at the boundary it still serves
    expect(
      (
        await w.call(
          "/recovery-kit",
          session(OWNER.identityId, { signedInMinutesAgo: 15 })
        )
      ).status
    ).toBe(200);
  });

  it("a Synap-Cloud-only session never gets the kit — unless the owner trusts Cloud with recovery", async () => {
    const cloud = session(OWNER.identityId, { methods: ["oidc"] });
    const w = makeWorld({ trust: "sign_in" });
    const res = await w.call("/recovery-kit", cloud);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe(
      "cloud_session_not_allowed"
    );
    const trusted = makeWorld({ trust: "sign_in_recovery" });
    expect((await trusted.call("/recovery-kit", cloud)).status).toBe(200);
  });

  it("no kit generated yet → 404 kit_not_found (not a 503, not an empty file)", async () => {
    const w = makeWorld({ kit: null });
    const res = await w.call("/recovery-kit", session(OWNER.identityId));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe(
      "kit_not_found"
    );
  });
});

describe("POST /recovery-kit/confirm — the read-back", () => {
  const last6 = PASSWORD.slice(-6);

  it("the right last 6 → the marker the status route reads becomes saved", async () => {
    const w = makeWorld();
    expect(readRecoveryKitSaved(w.stateDir)).toBe(false);
    const res = await w.call(
      "/recovery-kit/confirm",
      session(OWNER.identityId),
      { last6: ` ${last6.toUpperCase()} ` }
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, recoveryKitSaved: true });
    // catches: a confirm that answers ok but writes nothing /status/backup can see
    expect(readFileSync(join(w.stateDir, "kit", "status"), "utf8")).toBe(
      "saved\n"
    );
    expect(readRecoveryKitSaved(w.stateDir)).toBe(true);
    expect(w.audits.map((a) => a.change)).toEqual([
      "backup.recovery_kit_saved",
    ]);
  });

  it("a wrong last 6, the first 6, or 5 characters → 422, marker stays pending, nothing secret echoed", async () => {
    const w = makeWorld();
    for (const typed of ["aaaaaa", PASSWORD.slice(0, 6), last6.slice(1)]) {
      const res = await w.call(
        "/recovery-kit/confirm",
        session(OWNER.identityId),
        { last6: typed }
      );
      expect(res.status).toBe(422);
      const body = await res.text();
      expect(JSON.parse(body).error).toBe("kit_mismatch");
      expect(body).not.toContain(last6);
    }
    expect(readRecoveryKitSaved(w.stateDir)).toBe(false);
    expect(everything(w)).not.toContain(PASSWORD);
    expect(everything(w)).not.toContain(last6);
  });

  it("is owner-only: a member's right answer is refused and changes nothing", async () => {
    const w = makeWorld();
    const res = await w.call(
      "/recovery-kit/confirm",
      session(MEMBER.identityId),
      { last6 }
    );
    expect(res.status).toBe(403);
    expect(readRecoveryKitSaved(w.stateDir)).toBe(false);
  });

  it("is rate limited per owner: the 6th attempt in 15 minutes is refused even when right", async () => {
    const w = makeWorld();
    for (let i = 0; i < 5; i++) {
      expect(
        (
          await w.call("/recovery-kit/confirm", session(OWNER.identityId), {
            last6: "000000",
          })
        ).status
      ).toBe(422);
    }
    const res = await w.call(
      "/recovery-kit/confirm",
      session(OWNER.identityId),
      { last6 }
    );
    expect(res.status).toBe(429);
    expect(readRecoveryKitSaved(w.stateDir)).toBe(false);
  });

  it("does not need a fresh sign-in (it proves possession, it reveals nothing)", async () => {
    const w = makeWorld();
    const res = await w.call(
      "/recovery-kit/confirm",
      session(OWNER.identityId, { signedInMinutesAgo: 600 }),
      { last6 }
    );
    expect(res.status).toBe(200);
  });

  it("a marker the backend cannot write yet (state/kit still root-owned) → 503, never a false ok", async () => {
    const w = makeWorld();
    const res = await w.call(
      "/recovery-kit/confirm",
      session(OWNER.identityId),
      { last6 },
      {
        markSaved: async () => {
          throw Object.assign(new Error("EACCES: permission denied"), {
            code: "EACCES",
          });
        },
      }
    );
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe(
      "kit_unavailable"
    );
    expect(readRecoveryKitSaved(w.stateDir)).toBe(false);
    expect(w.audits.map((a) => a.change)).not.toContain(
      "backup.recovery_kit_saved"
    );
  });

  it("an empty or missing answer → 400; no kit → 404", async () => {
    const w = makeWorld();
    expect(
      (await w.call("/recovery-kit/confirm", session(OWNER.identityId), {}))
        .status
    ).toBe(400);
    expect(
      (
        await w.call("/recovery-kit/confirm", session(OWNER.identityId), {
          last6: "",
        })
      ).status
    ).toBe(400);
    const none = makeWorld({ kit: null });
    expect(
      (
        await none.call("/recovery-kit/confirm", session(OWNER.identityId), {
          last6,
        })
      ).status
    ).toBe(404);
  });
});

describe("kitFileName", () => {
  it("is header-safe whatever the host holds", () => {
    expect(kitFileName("Pod.Alice.synap.live")).toBe(
      "synap-recovery-kit-pod.alice.synap.live.txt"
    );
    expect(kitFileName('evil"\r\nX: y')).toBe(
      "synap-recovery-kit-evil-x-y.txt"
    );
    expect(kitFileName(null)).toBe("synap-recovery-kit.txt");
  });
});
