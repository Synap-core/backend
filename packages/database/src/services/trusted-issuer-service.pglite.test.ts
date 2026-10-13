/**
 * Deciding a pending issuer clears its "needs approval" notifications — every
 * deciding door of `TrustedIssuerService`, in the decision's own transaction
 * (console plan bug 1: they stayed unread in browser/relay forever).
 *
 * ENGINE: PGlite, the two tables built from their drizzle definitions.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

const holder = vi.hoisted(() => ({ pg: undefined as unknown }));

vi.mock("../client-pg.js", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("../schema/index.js");
  const pg = new PGlite();
  holder.pg = pg;
  return { db: drizzle(pg, { schema }) };
});

import type { PGlite } from "@electric-sql/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { notifications, trustedIssuers } from "../schema/index.js";
import {
  ISSUER_PENDING_NOTIFICATION_TYPE,
  TrustedIssuerService,
} from "./trusted-issuer-service.js";

/** CREATE TABLE from the drizzle definition — columns, types and literal defaults. */
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const columns = cfg.columns.map((c) => {
    const type = c.getSQLType();
    let def = "";
    const d = c.default as unknown;
    if (d !== undefined && !(d instanceof SQL)) {
      if (typeof d === "string") def = ` default '${d}'`;
      else if (typeof d === "number" || typeof d === "boolean")
        def = ` default ${d}`;
      else if (type.endsWith("[]")) def = ` default '{}'`;
      else def = ` default '${JSON.stringify(d)}'::jsonb`;
    } else if (type.startsWith("timestamp") && c.hasDefault) {
      def = " default now()";
    } else if (type.endsWith("[]") && c.hasDefault) {
      def = " default '{}'";
    } else if (c.primary && type === "uuid") {
      def = " default gen_random_uuid()";
    }
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${columns.join(", ")});`;
}

const pg = () => holder.pg as PGlite;
const svc = new TrustedIssuerService();

async function pendingIssuer(url: string): Promise<string> {
  const row = await svc.registerPending(url, new URL(url).hostname, null);
  return row.id;
}

/** One admin's "needs approval" row about `issuerId`, in `status`. */
async function notify(issuerId: string, userId: string, status = "unread") {
  await pg().query(
    `insert into notifications (user_id, type, category, title, source_type, source_id, status)
     values ($1, $2, 'system', 'New external issuer needs approval', 'system', $3, $4)`,
    [userId, ISSUER_PENDING_NOTIFICATION_TYPE, issuerId, status]
  );
}

async function statuses(issuerId: string): Promise<string[]> {
  const r = await pg().query<{ status: string }>(
    `select status from notifications where source_id = $1 order by user_id`,
    [issuerId]
  );
  return r.rows.map((x) => x.status);
}

beforeAll(async () => {
  for (const t of [trustedIssuers, notifications]) {
    await pg().exec(ddlFor(t as unknown as PgTable));
  }
}, 120_000);

beforeEach(async () => {
  await pg().exec(`delete from notifications; delete from trusted_issuers;`);
});

describe("TrustedIssuerService — a decision actions the pending notification", () => {
  it("approve: every admin's unread / snoozed row becomes actioned", async () => {
    const id = await pendingIssuer("https://a.example.com");
    await notify(id, "admin-1");
    await notify(id, "admin-2", "snoozed");
    await svc.approvePending(id, "admin-1", ["auth:exchange-user"]);
    expect(await statuses(id)).toEqual(["actioned", "actioned"]);
  });

  it("reject clears it too", async () => {
    const rejected = await pendingIssuer("https://r.example.com");
    await notify(rejected, "admin-1");
    await svc.reject(rejected, "admin-1", "not ours");
    expect(await statuses(rejected)).toEqual(["actioned"]);
  });

  it("touches only THIS issuer's rows, and keeps a dismissed row dismissed", async () => {
    const decided = await pendingIssuer("https://d.example.com");
    const other = await pendingIssuer("https://o.example.com");
    await notify(decided, "admin-1", "dismissed");
    await notify(other, "admin-1");
    await svc.revoke(decided, "admin-1");
    expect(await statuses(decided)).toEqual(["dismissed"]);
    expect(await statuses(other)).toEqual(["unread"]);
  });

  it("an approvePending that loses the race (already decided) leaves rows alone", async () => {
    const id = await pendingIssuer("https://x.example.com");
    await svc.reject(id, "admin-1", "no");
    await notify(id, "admin-2");
    expect(await svc.approvePending(id, "admin-2", ["sync"])).toBeNull();
    expect(await statuses(id)).toEqual(["unread"]);
  });
});

describe("TrustedIssuerService.approveFromStatus — a compare-and-set on status", () => {
  const status = async (id: string) =>
    (
      await pg().query<{ status: string; allowed_scopes: string[] }>(
        `select status, allowed_scopes from trusted_issuers where id = $1`,
        [id]
      )
    ).rows[0]!;

  it("a stale 'pending' approve never resurrects a revoked issuer", async () => {
    const id = await pendingIssuer("https://s.example.com");
    await svc.revoke(id, "admin-1");
    expect(await svc.approvePending(id, "admin-2", ["sync"])).toBeNull();
    expect((await status(id)).status).toBe("revoked");
  });

  it("from 'approved' changes the scopes of an approved issuer only", async () => {
    const id = await pendingIssuer("https://c.example.com");
    await svc.approvePending(id, "admin-1", ["sync"]);
    const row = await svc.approveFromStatus(
      id,
      "admin-1",
      ["sync", "source-config:write"],
      "approved"
    );
    expect(row?.allowedScopes).toEqual(["sync", "source-config:write"]);
    await svc.reject(id, "admin-1", "no");
    expect(
      await svc.approveFromStatus(id, "admin-1", ["sync"], "approved")
    ).toBeNull();
    expect((await status(id)).status).toBe("rejected");
  });

  it("from 'revoked' reinstates deliberately", async () => {
    const id = await pendingIssuer("https://v.example.com");
    await svc.revoke(id, "admin-1");
    const row = await svc.approveFromStatus(id, "admin-1", ["sync"], "revoked");
    expect(row?.status).toBe("approved");
  });
});
