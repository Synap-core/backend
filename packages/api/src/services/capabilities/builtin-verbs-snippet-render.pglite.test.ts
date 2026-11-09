/**
 * `snippet.render` on PGlite: the REAL builtin verb handler over the REAL
 * access floor (no mocked `scopedDb`), tables generated from the Drizzle
 * definitions (the `document.freeze_charts` pattern).
 *
 * Proves what the mocked unit test cannot: that the floor itself, not the
 * handler's own bookkeeping, decides what a caller may render. User B cannot
 * render user A's private snippet by id (the same NOT_FOUND as a missing id),
 * and a subject B cannot read fills nothing and is recorded.
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
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const pg = drizzle(client, {
    schema: {
      entities: actual.entities as never,
      entityFacets: actual.entityFacets as never,
      profiles: actual.profiles as never,
      workspaces: actual.workspaces as never,
      workspaceMembers: actual.workspaceMembers as never,
      users: actual.users as never,
    },
  });
  return { ...actual, db: pg, getDb: async () => pg };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { BUILTIN_VERBS } from "./builtin-verbs.js";
import { allSchemaTables } from "../../__tests__/pglite-ddl.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const A = randomUUID();
const B = randomUUID();
const A_SNIPPET = randomUUID();
const B_SNIPPET = randomUUID();
const A_SUBJECT = randomUUID();

async function insertEntity(opts: {
  id: string;
  user: string;
  type: string;
  title: string;
  status?: string;
  properties?: Record<string, unknown>;
}) {
  await q(
    `insert into entities (id, user_id, workspace_id, type, title, status, properties, created_at, updated_at)
     values ($1, $2, null, $3, $4, $5, $6::jsonb, now(), now())`,
    [
      opts.id,
      opts.user,
      opts.type,
      opts.title,
      opts.status ?? null,
      JSON.stringify(opts.properties ?? {}),
    ]
  );
}

const BODY = {
  body: "Hi {first}!",
  variables: [{ name: "first", from: "subject.title" }],
};

beforeAll(async () => {
  for (const t of allSchemaTables()) await h.client!.exec(ddlFor(t));
  await q(
    `insert into users (id, email, name) values ($1, 'a@x', 'Ann'), ($2, 'b@x', 'Bob')`,
    [A, B]
  );
  for (const slug of ["snippet", "person"]) {
    await q(
      `insert into profiles (id, slug, display_name, profile_kind) values ($1, $2, $2, 'kind')`,
      [randomUUID(), slug]
    );
  }
  await insertEntity({
    id: A_SNIPPET,
    user: A,
    type: "snippet",
    title: "A's snippet",
    status: "current",
    properties: BODY,
  });
  await insertEntity({
    id: B_SNIPPET,
    user: B,
    type: "snippet",
    title: "B's snippet",
    status: "current",
    properties: BODY,
  });
  await insertEntity({
    id: A_SUBJECT,
    user: A,
    type: "person",
    title: "Grace",
  });
});

const render = (user: string, params: Record<string, unknown>) =>
  BUILTIN_VERBS["snippet.render"]!(params, {
    userId: user,
    workspaceId: null,
  }) as Promise<{
    text: string;
    misses: Array<{ name: string; kind: string; count: number }>;
  }>;

describe("snippet.render through the real access floor", () => {
  it("the owner renders their snippet, filling from a subject they may read", async () => {
    const out = await render(A, {
      snippetId: A_SNIPPET,
      subjectEntityId: A_SUBJECT,
    });
    expect(out.text).toBe("Hi Grace!");
  });

  it("another user cannot render a private snippet by id (NOT_FOUND)", async () => {
    await expect(
      render(B, { snippetId: A_SNIPPET, values: { first: "Bob" } })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("a subject the caller cannot read fills nothing and is recorded", async () => {
    const out = await render(B, {
      snippetId: B_SNIPPET,
      subjectEntityId: A_SUBJECT,
    });
    expect(out.text).toBe("Hi !");
    expect(out.text).not.toContain("Grace");
    expect(out.misses).toContainEqual({
      name: "subject.title",
      kind: "unresolved-context",
      count: 1,
    });
  });
});
