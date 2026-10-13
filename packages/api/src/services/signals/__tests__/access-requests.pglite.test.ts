/**
 * The ACCESS-REQUEST halves on PGlite, through the REAL pod-admin check
 * (`isPodAdmin`) and the REAL table reads:
 *
 *  - a pod admin sees every pending issuer and every app request waiting on
 *    an owner — oldest first;
 *  - a member (or a stranger) sees NOTHING, and that is an empty answer, not
 *    a failure: the asks are not theirs to decide;
 *  - only the asks: a built-in or decided issuer, an app request still
 *    awaiting the requester's sign-in, and one past its lease are no ask;
 *  - the admin check runs at most once per read, shared by both halves.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  // With the schema: `isPodAdmin` reads through `db.query`.
  return { ...actual, db: drizzle(client, { schema }) };
});

const adminSpy = vi.hoisted(() => vi.fn());
vi.mock("../../../utils/workspace-role.js", async (orig) => {
  const actual = await orig<{
    isPodAdmin: (userId: string) => Promise<boolean>;
  }>();
  return {
    ...actual,
    isPodAdmin: async (userId: string) => {
      adminSpy(userId);
      return actual.isPodAdmin(userId);
    },
  };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  federatedApplicationConnectionRequests,
  trustedIssuers,
  workspaceMembers,
  workspaces,
} from "@synap/database";
import {
  listPendingAppRequests,
  listPendingIssuers,
  podAdminCheck,
} from "../access-requests.js";

const ADMIN = "admin-1";
const MEMBER = "member-1";
const POD_ADMIN_WS = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const def =
      c.name === "id"
        ? " default gen_random_uuid()"
        : c.name === "created_at" || c.name === "updated_at"
          ? " default now()"
          : "";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const ahead = (min: number) =>
  new Date(Date.now() + min * 60_000).toISOString();

beforeAll(async () => {
  for (const t of [
    workspaces,
    workspaceMembers,
    trustedIssuers,
    federatedApplicationConnectionRequests,
  ]) {
    await h.client!.exec(ddlFor(t as unknown as PgTable));
  }
  await q(
    `insert into workspaces (id, name, system_slug) values ($1, 'Pod admin', 'pod-admin')`,
    [POD_ADMIN_WS]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values
       (gen_random_uuid(), $1, $2, 'owner'), (gen_random_uuid(), $1, $3, 'member')`,
    [POD_ADMIN_WS, ADMIN, MEMBER]
  );
  const issuer = (url: string, status: string, builtIn: boolean, at: string) =>
    q(
      `insert into trusted_issuers (issuer_url, display_name, status, is_built_in, allowed_scopes, created_at)
       values ($1, $2, $3, $4, '{}', $5)`,
      [url, new URL(url).hostname, status, builtIn, at]
    );
  await issuer("https://newer.example.com", "pending", false, ago(5));
  await issuer("https://older.example.com", "pending", false, ago(60));
  await issuer("https://seeded.example.com", "pending", true, ago(90));
  await issuer("https://decided.example.com", "approved", false, ago(120));
  const request = (name: string, status: string, at: string, exp: string) =>
    q(
      `insert into federated_application_connection_requests
         (issuer_url, issuer_subject, client_id, display_name, requested_origin, requested_callback_url,
          requested_scopes, continuation_hash, redemption_hash, status, expires_at, created_at)
       values ('https://cp.example.com', 'sub', $1, $1, $2, $2, '{}', $3, 'r', $4, $5, $6)`,
      [name, `https://${name}.test`, randomUUID(), status, exp, at]
    );
  await request("waiting", "pending", ago(10), ahead(20));
  await request("lapsed", "pending", ago(50), ago(20));
  await request("signing-in", "awaiting_local_auth", ago(3), ahead(27));
  await request("decided", "approved", ago(40), ahead(5));
});

describe("access requests — pod admins only, the asks only", () => {
  it("a pod admin sees the pending issuers (not built-in, not decided), oldest first", async () => {
    const r = await listPendingIssuers({ isAdmin: podAdminCheck(ADMIN) });
    expect(r.truncated).toBe(false);
    expect(r.rows.map((x) => x.issuerUrl)).toEqual([
      "https://older.example.com",
      "https://newer.example.com",
    ]);
  });

  it("a pod admin sees only app requests waiting on an owner, inside their lease", async () => {
    const r = await listPendingAppRequests({ isAdmin: podAdminCheck(ADMIN) });
    expect(r.rows.map((x) => x.displayName)).toEqual(["waiting"]);
    expect(r.rows[0]!.requestedOrigin).toBe("https://waiting.test");
  });

  it("a member — and a stranger — get an EMPTY answer, not an error", async () => {
    for (const user of [MEMBER, "stranger"]) {
      const isAdmin = podAdminCheck(user);
      expect(await listPendingIssuers({ isAdmin })).toEqual({
        rows: [],
        truncated: false,
      });
      expect(await listPendingAppRequests({ isAdmin })).toEqual({
        rows: [],
        truncated: false,
      });
    }
  });

  it("the admin check runs ONCE for both halves of one read", async () => {
    adminSpy.mockClear();
    const isAdmin = podAdminCheck(ADMIN);
    await Promise.all([
      listPendingIssuers({ isAdmin }),
      listPendingAppRequests({ isAdmin }),
    ]);
    expect(adminSpy).toHaveBeenCalledTimes(1);
  });
});
