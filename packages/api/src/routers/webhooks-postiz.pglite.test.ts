/**
 * `POST /api/webhooks/postiz/:token` on a real Postgres (PGlite), driven
 * through the real Hono route, the real token resolver, the real owner floor
 * (`entityWriteVisibleWhere`) and the real status door (`moveStatus` →
 * `applyStatusMove`). Only the event delivery is a recorder.
 *
 *  - an unknown token is 404 and touches nothing;
 *  - a published post lands its URL, time and outcome, and moves to Published
 *    ONCE — a re-delivery writes nothing and emits no second transition;
 *  - a Postiz post id no Synap post carries is a no-op;
 *  - another person's post carrying the same Postiz id is never touched.
 *
 * The payload is the one upstream Postiz sends (an ARRAY of the published
 * post — see services/postiz/record-postiz-published.ts for the source lines).
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

const holder = vi.hoisted(() => ({
  db: undefined as unknown,
  dispatched: [] as string[],
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked = { ...actual };
  Object.defineProperty(mocked, "db", {
    get: () => holder.db,
    enumerable: true,
  });
  return mocked;
});
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
  dispatchLifecycleTransition: vi.fn(async (id: string) => {
    holder.dispatched.push(id);
  }),
}));
vi.mock("@synap/jobs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getBoss: () => ({ send: async () => null }),
}));

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { Hono } from "hono";
import * as schema from "@synap/database/schema";
import { declareLifecycle, buildStoredConstraints } from "@synap/database";
import { webhooksInboundRouter } from "./webhooks-inbound.js";

const OWNER = "owner-1";
const OTHER = "other-1";
const TOKEN = "pz-token-0123456789abcdef";
const POSTIZ_ID = "cm6tcts4f0005qcwit25cis26";

/** CREATE TABLE from the drizzle definition (same shape as lifecycle-pglite.ts). */
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const columns = cfg.columns.map((c) => {
    let type = c.getSQLType();
    if (/vector/.test(type) || c.columnType === "PgEnumColumn") type = "text";
    let def = "";
    const d = c.default as unknown;
    if (d !== undefined && !(d instanceof SQL)) {
      if (typeof d === "string") def = ` default '${d.replace(/'/g, "''")}'`;
      else if (typeof d === "number" || typeof d === "boolean")
        def = ` default ${d}`;
      else if (type.endsWith("[]")) def = ` default '{}'`;
      else def = ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
    } else if (type.startsWith("timestamp") && c.hasDefault) {
      def = " default now()";
    } else if (c.primary && type === "uuid") {
      def = " default gen_random_uuid()";
    }
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${columns.join(", ")});`;
}

const MIGRATION_0319 = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../database/migrations/0319_lifecycle_columns.sql"
  ),
  "utf8"
);

let pg: PGlite;
let db: any;
let postProfileId: string;

const app = new Hono();
app.route("/api/webhooks", webhooksInboundRouter);

function deliver(token: string, body: unknown) {
  return app.request(`/api/webhooks/postiz/${token}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Exactly what Postiz's orchestrator POSTs after a publish. */
function published(id: string) {
  return [
    {
      id,
      content: "The first post",
      publishDate: "2026-10-19T09:00:00.000Z",
      releaseURL: "https://www.linkedin.com/feed/update/urn:li:share:1",
      state: "PUBLISHED",
      integration: {
        id: "cm6s4uyou0001i2r47pxix6z1",
        name: "Antoine",
        providerIdentifier: "linkedin",
        picture: "https://uploads.example/p.jpeg",
        type: "social",
      },
    },
  ];
}

async function insertPost(userId: string, postizId: string | null) {
  const [e] = await db
    .insert(schema.entities)
    .values({
      userId,
      profileId: postProfileId,
      type: "post",
      title: "A post",
      status: "Scheduled",
      statusCategory: "active",
      properties: {
        "post-status": "Scheduled",
        ...(postizId ? { "postiz-post-id": postizId } : {}),
      },
    })
    .returning();
  return e.id as string;
}

async function row(id: string) {
  const r = await pg.query<{
    status: string | null;
    properties: Record<string, unknown>;
    updated_at: Date;
  }>(`select status, properties, updated_at from entities where id = $1`, [id]);
  return r.rows[0]!;
}

beforeAll(async () => {
  pg = new PGlite();
  for (const t of [
    schema.profiles,
    schema.propertyDefs,
    schema.profileProperties,
    schema.entities,
    schema.entityFacets,
    schema.lifecycleTransitionOutbox,
    schema.proposals,
    schema.tools,
    schema.relations,
    schema.links,
    schema.projects,
    schema.workspaces,
    schema.workspaceMembers,
    schema.projectMembers,
    schema.podMembers,
    schema.users,
  ]) {
    await pg.exec(ddlFor(t as unknown as PgTable));
  }
  await pg.exec(MIGRATION_0319);
  await pg.exec(
    `insert into users (id, email) values ('${OWNER}', 'o@example.test'), ('${OTHER}', 'x@example.test')`
  );
  db = drizzle(pg, { schema });
  holder.db = db;

  // The Content OS `post` kind with its declared lifecycle (content-os.yaml).
  const [p] = await db
    .insert(schema.profiles)
    .values({ slug: "post", displayName: "Post", profileKind: "kind" })
    .returning();
  postProfileId = p.id;
  const [d] = await db
    .insert(schema.propertyDefs)
    .values({
      slug: "post-status",
      valueType: "string",
      profileId: p.id,
      constraints: buildStoredConstraints({
        enumOptions: [
          { key: "Idea", category: "open" },
          { key: "Scheduled", category: "active" },
          { key: "Published", category: "done" },
          { key: "Archived", category: "lost", humanOnly: true },
        ],
      }),
    })
    .returning();
  await db
    .insert(schema.profileProperties)
    .values({ profileId: p.id, propertyDefId: d.id });
  await declareLifecycle(db, { profileId: p.id, propertySlug: "post-status" });

  await db.insert(schema.tools).values({
    createdBy: OWNER,
    workspaceId: null,
    name: "postiz",
    kind: "api",
    metadata: { postiz: { webhook: { token: TOKEN } } },
  });
}, 120_000);
afterAll(async () => pg?.close());

describe("POST /api/webhooks/postiz/:token", () => {
  it("an unknown token is 404 and touches nothing", async () => {
    const id = await insertPost(OWNER, "pz-unknown-token-case");
    const before = await row(id);
    const res = await deliver(
      "not-the-token",
      published("pz-unknown-token-case")
    );
    expect(res.status).toBe(404);
    expect(await row(id)).toEqual(before);
  });

  it("a payload that is not Postiz's array is 400", async () => {
    const res = await deliver(TOKEN, { id: POSTIZ_ID });
    expect(res.status).toBe(400);
  });

  it("moves the matching post to Published once, with its URL and time", async () => {
    const mine = await insertPost(OWNER, POSTIZ_ID);
    const theirs = await insertPost(OTHER, POSTIZ_ID);
    const theirsBefore = await row(theirs);
    holder.dispatched.length = 0;

    const res = await deliver(TOKEN, published(POSTIZ_ID));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ updated: 1, unmatched: 0 });

    const after = await row(mine);
    expect(after.status).toBe("Published");
    expect(after.properties).toMatchObject({
      "post-status": "Published",
      "post-url": "https://www.linkedin.com/feed/update/urn:li:share:1",
      "published-at": "2026-10-19T09:00:00.000Z",
      "publish-outcome": "succeeded",
      "postiz-post-id": POSTIZ_ID,
    });
    expect(holder.dispatched).toHaveLength(1);

    // Another person's post carrying the same Postiz id: untouched.
    expect(await row(theirs)).toEqual(theirsBefore);

    // Re-delivery: nothing written, no second transition.
    const res2 = await deliver(TOKEN, published(POSTIZ_ID));
    expect(await res2.json()).toMatchObject({ updated: 0, unmatched: 0 });
    expect(await row(mine)).toEqual(after);
    expect(holder.dispatched).toHaveLength(1);
  });

  it("a Postiz post no Synap post carries is a no-op", async () => {
    const bystander = await insertPost(OWNER, "pz-someone-else");
    const before = await row(bystander);
    const res = await deliver(TOKEN, published("pz-never-scheduled"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ updated: 0, unmatched: 1 });
    expect(await row(bystander)).toEqual(before);
  });
});
