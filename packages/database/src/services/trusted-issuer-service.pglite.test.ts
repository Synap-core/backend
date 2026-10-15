/**
 * D7 — the Control Plane never widens its own grant on a pod.
 *
 * Drives the REAL `TrustedIssuerService.seedBuiltIn` on PGlite against the
 * REAL `trusted_issuers` DDL (migration 0001). Pinned:
 *  - a fresh seed grants exactly the release-pinned set, whatever the issuer
 *    requests; a requested scope beyond it is PENDING, not granted;
 *  - an existing built-in row is never widened by a request either (the
 *    boot path that used to union `/federation/metadata` scopes);
 *  - an owner approval clears the ask (`getPendingScopes` filters by grant);
 *  - the opt-in (`autoAcceptRequestedScopes`) grants and leaves nothing pending;
 *  - an unchanged request is idempotent (`requestedAt` is not rewritten).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
    },
    db: null as unknown,
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const schema = await import("../schema/index.js");
        const client = new PGlite();
        state.client = client as unknown as typeof state.client;
        state.db = drizzle(client, { schema });
      }
      return state.db;
    },
  };
  return state;
});

vi.mock("../client-pg.js", async () => {
  const db = await h.init();
  return { db, sql: undefined, getDb: async () => db };
});

import {
  TrustedIssuerService,
  getPendingScopes,
  getDeclinedScopes,
  PENDING_SCOPE_REQUEST_KEY,
} from "./trusted-issuer-service.js";
import { CONTROL_PLANE_ISSUER_SCOPES } from "../schema/trusted-issuers.js";

const DDL = readFileSync(
  fileURLToPath(
    new URL("../../migrations/0001_trusted_issuers.sql", import.meta.url)
  ),
  "utf8"
);

// A decision on an issuer also actions its pending "needs approval"
// notifications in the same transaction, so `notifications` must exist too —
// sliced from the REAL baseline DDL (the only file that creates it). Throws if
// the slice ever stops matching, so the suite can't run against a missing table.
const NOTIFICATIONS_DDL = (() => {
  const baseline = readFileSync(
    fileURLToPath(
      new URL("../../migrations/0000_baseline_schema.sql", import.meta.url)
    ),
    "utf8"
  );
  const start = baseline.indexOf('CREATE TABLE IF NOT EXISTS "notifications" (');
  const end = baseline.indexOf("\n);", start);
  if (start < 0 || end < 0)
    throw new Error("notifications DDL not found in the baseline schema");
  return baseline.slice(start, end + 3);
})();

const CP = "https://api.test-cp.example";
const WIDER = "membership:activate";
const OTHER = "sync";
const PINNED = [...CONTROL_PLANE_ISSUER_SCOPES];

function seedCp(
  svc: TrustedIssuerService,
  requested: string[],
  autoAccept = false
) {
  return svc.seedBuiltIn([
    {
      issuerUrl: CP,
      displayName: "Synap Control Plane",
      allowedScopes: PINNED,
      requestedScopes: requested,
      autoAcceptRequestedScopes: autoAccept,
    },
  ]);
}

beforeEach(async () => {
  await h.init();
  await h.client!.exec(
    `DROP TABLE IF EXISTS "trusted_issuers"; DROP TABLE IF EXISTS "notifications"; ${DDL}; ${NOTIFICATIONS_DDL}`
  );
});

describe("seedBuiltIn — CP scopes are pinned, wider = owner consent (D7)", () => {
  it("a fresh seed grants the pinned set only; the extra request is pending", async () => {
    const svc = new TrustedIssuerService();
    const [res] = await seedCp(svc, [...PINNED, WIDER]);
    const row = (await svc.getByUrl(CP))!;
    expect([...row.allowedScopes].sort()).toEqual([...PINNED].sort());
    expect(row.allowedScopes).not.toContain(WIDER);
    expect(row.status).toBe("approved");
    expect(res.pendingScopes).toEqual([WIDER]);
    expect(getPendingScopes(row)).toEqual([WIDER]);
  });

  it("an existing built-in row is not widened by a later request", async () => {
    const svc = new TrustedIssuerService();
    await seedCp(svc, PINNED);
    expect(getPendingScopes((await svc.getByUrl(CP))!)).toEqual([]);

    await seedCp(svc, [...PINNED, WIDER]); // a CP that started asking for more
    const row = (await svc.getByUrl(CP))!;
    expect(row.allowedScopes).not.toContain(WIDER);
    expect(getPendingScopes(row)).toEqual([WIDER]);
  });

  it("the owner's approval grants the scope and clears the ask", async () => {
    const svc = new TrustedIssuerService();
    await seedCp(svc, [...PINNED, WIDER]);
    const row = (await svc.getByUrl(CP))!;
    const approved = (await svc.approveFromStatus(
      row.id,
      "owner-1",
      [...PINNED, WIDER],
      "approved"
    ))!;
    expect(approved.allowedScopes).toContain(WIDER);
    expect(getPendingScopes(approved)).toEqual([]);

    await seedCp(svc, [...PINNED, WIDER]); // next boot keeps the grant
    const after = (await svc.getByUrl(CP))!;
    expect(after.allowedScopes).toContain(WIDER);
    expect(
      (after.initialRequestData as Record<string, unknown> | null)?.[
        PENDING_SCOPE_REQUEST_KEY
      ]
    ).toBeUndefined();
  });

  it("trust.autoAcceptCpScopes (opt-in) grants the request; nothing pending", async () => {
    const svc = new TrustedIssuerService();
    const [res] = await seedCp(svc, [...PINNED, WIDER], true);
    const row = (await svc.getByUrl(CP))!;
    expect(row.allowedScopes).toContain(WIDER);
    expect(res.pendingScopes).toEqual([]);
    expect(getPendingScopes(row)).toEqual([]);
  });

  it("an unchanged request is idempotent", async () => {
    const svc = new TrustedIssuerService();
    await seedCp(svc, [...PINNED, WIDER]);
    const first = (await svc.getByUrl(CP))!;
    await seedCp(svc, [WIDER, ...PINNED]);
    const second = (await svc.getByUrl(CP))!;
    expect(second.initialRequestData).toEqual(first.initialRequestData);
    expect(second.updatedAt.getTime()).toBe(first.updatedAt.getTime());
  });

  it("a non-built-in row with the same URL is left untouched", async () => {
    const svc = new TrustedIssuerService();
    await svc.registerPending(CP, "Someone else", null);
    const [res] = await seedCp(svc, [...PINNED, WIDER]);
    expect(res).toBeUndefined();
    const row = (await svc.getByUrl(CP))!;
    expect(row.status).toBe("pending");
    expect(row.allowedScopes).toEqual([]);
  });
});

describe("owner consent — grant / decline the CP's request (D7)", () => {
  it("granting the request adds EXACTLY the asked scopes and clears the ask", async () => {
    const svc = new TrustedIssuerService();
    await seedCp(svc, [...PINNED, WIDER, OTHER]);
    const row = (await svc.getByUrl(CP))!;
    const res = await svc.grantRequestedScopes(row.id, "owner-1", [
      WIDER,
      OTHER,
    ]);
    expect(res.status).toBe("granted");
    const after = (await svc.getByUrl(CP))!;
    expect([...after.allowedScopes].sort()).toEqual(
      [...PINNED, WIDER, OTHER].sort()
    );
    expect(getPendingScopes(after)).toEqual([]);
    expect(
      (after.initialRequestData as Record<string, unknown> | null)?.[
        PENDING_SCOPE_REQUEST_KEY
      ]
    ).toBeUndefined();
    expect(after.reviewedBy).toBe("owner-1");
  });

  it("never grants a scope the issuer did not ask for (a revised payload)", async () => {
    const svc = new TrustedIssuerService();
    await seedCp(svc, [...PINNED, WIDER]);
    const row = (await svc.getByUrl(CP))!;
    const res = await svc.grantRequestedScopes(row.id, "owner-1", [
      WIDER,
      "admin",
    ]);
    expect(res).toEqual({ status: "not_requested", scopes: ["admin"] });
    const after = (await svc.getByUrl(CP))!;
    expect(after.allowedScopes).not.toContain(WIDER);
    expect(after.allowedScopes).not.toContain("admin");
    expect(getPendingScopes(after)).toEqual([WIDER]);
  });

  it("never resurrects a revoked issuer", async () => {
    const svc = new TrustedIssuerService();
    await seedCp(svc, [...PINNED, WIDER]);
    const row = (await svc.getByUrl(CP))!;
    await svc.revoke(row.id, "owner-1");
    const res = await svc.grantRequestedScopes(row.id, "owner-1", [WIDER]);
    expect(res).toEqual({ status: "not_approved", issuerStatus: "revoked" });
    const after = (await svc.getByUrl(CP))!;
    expect(after.status).toBe("revoked");
    expect(after.allowedScopes).not.toContain(WIDER);
  });

  it("a declined ask is not re-asked on the next boot; a DIFFERENT ask is", async () => {
    const svc = new TrustedIssuerService();
    await seedCp(svc, [...PINNED, WIDER]);
    const row = (await svc.getByUrl(CP))!;
    expect(await svc.declineRequestedScopes(row.id, [WIDER], "prop-1")).toBe(
      true
    );
    const declined = (await svc.getByUrl(CP))!;
    expect(getPendingScopes(declined)).toEqual([]);
    expect(getDeclinedScopes(declined)).toEqual([WIDER]);

    const [same] = await seedCp(svc, [...PINNED, WIDER]); // next boot, same ask
    expect(same!.pendingScopes).toEqual([]);
    expect(getPendingScopes((await svc.getByUrl(CP))!)).toEqual([]);

    const [changed] = await seedCp(svc, [...PINNED, WIDER, OTHER]);
    expect(changed!.pendingScopes).toEqual([WIDER, OTHER].sort());
  });

  it("a decision about an OLDER ask never clears a newer one", async () => {
    const svc = new TrustedIssuerService();
    await seedCp(svc, [...PINNED, WIDER, OTHER]);
    const row = (await svc.getByUrl(CP))!;
    expect(await svc.declineRequestedScopes(row.id, [WIDER], "prop-old")).toBe(
      false
    );
    expect(getPendingScopes((await svc.getByUrl(CP))!).sort()).toEqual(
      [WIDER, OTHER].sort()
    );
  });

  it("a reconsidered (declined) ask can still be granted", async () => {
    const svc = new TrustedIssuerService();
    await seedCp(svc, [...PINNED, WIDER]);
    const row = (await svc.getByUrl(CP))!;
    await svc.declineRequestedScopes(row.id, [WIDER], "prop-1");
    const res = await svc.grantRequestedScopes(row.id, "owner-1", [WIDER]);
    expect(res.status).toBe("granted");
    const after = (await svc.getByUrl(CP))!;
    expect(after.allowedScopes).toContain(WIDER);
    expect(getDeclinedScopes(after)).toEqual([]);
  });

  it("an UNKNOWN ask (discovery failed) keeps the stored request", async () => {
    const svc = new TrustedIssuerService();
    await seedCp(svc, [...PINNED, WIDER]);
    const [res] = await svc.seedBuiltIn([
      {
        issuerUrl: CP,
        displayName: "Synap Control Plane",
        allowedScopes: PINNED,
        requestedScopes: undefined,
      },
    ]);
    expect(res!.pendingScopes).toEqual([WIDER]);
    expect(getPendingScopes((await svc.getByUrl(CP))!)).toEqual([WIDER]);
  });
});
