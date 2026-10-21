/**
 * `applicationConnections.unlinkAccount` / `.get` — who may unlink whom, and
 * what the confirm says goes with it, through the REAL router, the REAL
 * pod-admin role read (`getPodAdminRole`) and the REAL SQL on PGlite.
 *
 * Pinned:
 *   - a pod ADMIN unlinking the pod OWNER is FORBIDDEN and the owner's link
 *     row survives (the owner may sign in only through Synap Cloud);
 *   - the owner unlinking an admin goes through (the link row is gone);
 *   - `get`'s `unlinkReach` names the issuer's OTHER approved apps (not a
 *     revoked one, not another issuer's) and Cloud sign-in when the issuer is
 *     this Pod's Cloud sign-in issuer.
 *
 * Stubbed: Kratos (`deleteIdentityCredentials`), which has no PGlite twin,
 * and the audit writes.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
  deleteCredentials: null as null | ((...args: unknown[]) => Promise<void>),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const schema = await import("@synap/database/schema");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, { schema });
  // `unlinkFederatedIdentity` closes over the package's OWN `db`, which this
  // mock does not replace; hand it the PGlite executor so the REAL delete runs.
  return {
    ...actual,
    db: h.db,
    getDb: async () => h.db,
    unlinkFederatedIdentity: (input: { issuerId: string; userId: string }) =>
      (
        actual.unlinkFederatedIdentity as (
          input: { issuerId: string; userId: string },
          conn: unknown
        ) => Promise<unknown>
      )(input, h.db),
  };
});
vi.mock("@synap/auth", async (importOriginal) => {
  const deleteCredentials = vi.fn(async () => undefined);
  h.deleteCredentials = deleteCredentials;
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    kratosAdmin: { deleteIdentityCredentials: deleteCredentials },
  };
});

// The timeline write and the request audit are not under test here.
vi.mock("../utils/audit-log.js", () => ({ auditLog: async () => undefined }));
vi.mock("../middleware/audit-log.js", async () => {
  const { t } = await import("../init-trpc.js");
  return { auditLogMiddleware: t.middleware(({ next }) => next()) };
});

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { applicationConnectionsRouter } from "./application-connections.js";

const OWNER = "human-owner";
const ADMIN = "human-admin";
const CLOUD = "https://api.synap.example";
const CLOUD_ISSUER = randomUUID();
const OTHER_ISSUER = randomUUID();
const STUDIO = randomUUID();
const CRM = randomUUID();
const RETIRED = randomUUID();
const ELSEWHERE = randomUUID();
const POD_ADMIN_WS = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t)
      ? t.replace(/\(.*\)/, "")
      : t.endsWith("[]")
        ? t
        : "text";
    const key = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : c.default !== undefined && typeof c.default !== "object"
          ? ` default ${typeof c.default === "string" ? `'${c.default}'` : String(c.default)}`
          : "";
    return `"${c.name}" ${type}${key}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(text: string, params?: unknown[]) =>
  h.client!.query<T>(text, params).then((r) => r.rows);

const caller = (userId: string) =>
  applicationConnectionsRouter.createCaller({
    authenticated: true,
    userId,
    session: { id: "s" },
  } as never);

const linkOf = (userId: string) =>
  q<{ user_id: string }>(
    `select user_id from federated_identity_links where user_id = $1`,
    [userId]
  );

beforeAll(async () => {
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) await h.client!.exec(ddlFor(value));
  }
  for (const [id, name] of [
    [OWNER, "Olivia"],
    [ADMIN, "Adam"],
  ])
    await q(
      `insert into users (id, email, name, user_type) values ($1, $1 || '@x', $2, 'human')`,
      [id, name]
    );
  // The pod-admin system space: Olivia owns the Pod, Adam administers it.
  await q(
    `insert into workspaces (id, name, owner_id, system_slug, settings)
     values ($1, 'Pod admin', $2, 'pod-admin', '{}'::jsonb)`,
    [POD_ADMIN_WS, OWNER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role)
     values (gen_random_uuid(), $1, $2, 'owner'), (gen_random_uuid(), $1, $3, 'admin')`,
    [POD_ADMIN_WS, OWNER, ADMIN]
  );
  await q(
    `insert into pod_settings (id, settings) values (gen_random_uuid(), $1::jsonb)`,
    [JSON.stringify({ federationOidcClient: { issuer: CLOUD } })]
  );
  for (const [id, url] of [
    [CLOUD_ISSUER, CLOUD],
    [OTHER_ISSUER, "https://other.example"],
  ])
    await q(
      `insert into trusted_issuers (id, issuer_url, display_name, status) values ($1, $2, $2, 'approved')`,
      [id, url]
    );
  for (const [id, issuer, name, status] of [
    [STUDIO, CLOUD_ISSUER, "Studio", "approved"],
    [CRM, CLOUD_ISSUER, "CRM", "approved"],
    [RETIRED, CLOUD_ISSUER, "Retired", "revoked"],
    [ELSEWHERE, OTHER_ISSUER, "Elsewhere", "approved"],
  ])
    await q(
      `insert into federated_application_connections
         (id, issuer_id, client_id, display_name, allowed_origins, allowed_callback_urls, allowed_scopes, status)
       values ($1, $2, $3, $4, '{https://app.example}', '{https://app.example/cb}', '{}', $5)`,
      [id, issuer, `client-${name}`, name, status]
    );
  await q(
    `insert into federated_identity_links (issuer_id, issuer_subject, user_id)
     values ($1, 'sub-owner', $2), ($1, 'sub-admin', $3)`,
    [CLOUD_ISSUER, OWNER, ADMIN]
  );
}, 120_000);

describe("applicationConnections.unlinkAccount — the owner floor", () => {
  it("an admin cannot unlink the owner; the owner's link stays", async () => {
    await expect(
      caller(ADMIN).unlinkAccount({ connectionId: STUDIO, userId: OWNER })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await linkOf(OWNER)).toHaveLength(1);
    expect(h.deleteCredentials).not.toHaveBeenCalled();
  });

  it("the owner can unlink an admin", async () => {
    await expect(
      caller(OWNER).unlinkAccount({ connectionId: STUDIO, userId: ADMIN })
    ).resolves.toMatchObject({ status: "unlinked", signIn: "removed" });
    expect(await linkOf(ADMIN)).toHaveLength(0);
    expect(h.deleteCredentials).toHaveBeenCalledWith(
      expect.objectContaining({ id: ADMIN, identifier: "cp:sub-admin" })
    );
  });
});

describe("applicationConnections.get — unlinkReach", () => {
  it("names the issuer's other approved apps and Cloud sign-in", async () => {
    const studio = await caller(OWNER).get({ id: STUDIO });
    expect(studio.unlinkReach).toEqual({
      otherApps: [{ id: CRM, displayName: "CRM" }],
      cloudSignIn: true,
    });
  });

  it("another issuer's app reaches no Cloud sign-in and no Cloud app", async () => {
    const elsewhere = await caller(OWNER).get({ id: ELSEWHERE });
    expect(elsewhere.unlinkReach).toEqual({
      otherApps: [],
      cloudSignIn: false,
    });
  });
});
