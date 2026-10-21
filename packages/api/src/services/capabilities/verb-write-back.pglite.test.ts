/**
 * VERB WRITE-BACK through the ONE post-gate runner (`runResolvedSkill`, used by
 * a direct run AND an approved `capability/run`), on a real Postgres (PGlite)
 * with the real owner write floor. Only the code-skill sandbox is a stub that
 * returns what `postiz_schedule_post` returns.
 *
 *  - a declared write-back records the outside id on the post the run named,
 *    and reports it on the run result;
 *  - a post the runner cannot edit is never written, and the report says so;
 *  - the kind's lifecycle property is never written, even when declared;
 *  - no declaration, or a proposed (not performed) run: nothing happens.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

const holder = vi.hoisted(() => ({
  db: undefined as unknown,
  sandboxResult: undefined as unknown,
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
vi.mock("../skills/execute-skill-via-is.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  executeSkillViaIS: vi.fn(async () => ({
    success: true,
    result: holder.sandboxResult,
  })),
}));

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { declareLifecycle, buildStoredConstraints } from "@synap/database";
import {
  runResolvedSkill,
  type ResolvedSkillRow,
} from "./execute-capability.js";

const OWNER = "owner-1";
const OTHER = "other-1";

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
    "../../../../database/migrations/0319_lifecycle_columns.sql"
  ),
  "utf8"
);

let pg: PGlite;
let db: any;
let postProfileId: string;

const WRITE_BACK = {
  entityParam: "postEntityId",
  kind: "post",
  properties: { "postiz-post-id": "postId" },
};

function skill(metadata: unknown): ResolvedSkillRow {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    name: "postiz_schedule_post",
    kind: "code",
    providerSpec: null,
    metadata,
  };
}

async function insertPost(userId: string) {
  const [e] = await db
    .insert(schema.entities)
    .values({
      userId,
      profileId: postProfileId,
      type: "post",
      title: "A post",
      status: "Review",
      statusCategory: "active",
      properties: { "post-status": "Review" },
    })
    .returning();
  return e.id as string;
}

async function props(id: string) {
  const r = await pg.query<{ properties: Record<string, unknown> }>(
    `select properties from entities where id = $1`,
    [id]
  );
  return r.rows[0]!.properties;
}

function run(metadata: unknown, postEntityId: string) {
  return runResolvedSkill(
    skill(metadata),
    { content: "Hello", integrationId: "i-1", provider: "x", postEntityId },
    { userId: OWNER, workspaceId: null }
  );
}

beforeAll(async () => {
  pg = new PGlite();
  for (const t of [
    schema.profiles,
    schema.propertyDefs,
    schema.profileProperties,
    schema.entities,
    schema.entityFacets,
    schema.skills,
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
          { key: "Review", category: "active" },
          { key: "Scheduled", category: "active" },
          { key: "Published", category: "done" },
        ],
      }),
    })
    .returning();
  await db
    .insert(schema.profileProperties)
    .values({ profileId: p.id, propertyDefId: d.id });
  await declareLifecycle(db, { profileId: p.id, propertySlug: "post-status" });
}, 120_000);
afterAll(async () => pg?.close());

describe("verb write-back via runResolvedSkill", () => {
  it("records the returned postId on the post the run named", async () => {
    const post = await insertPost(OWNER);
    holder.sandboxResult = { postId: "pz-123", postEntityId: post };
    const out = await run({ verbType: "write", writeBack: WRITE_BACK }, post);
    expect(out.kind).toBe("run");
    expect((out as { result: Record<string, unknown> }).result).toMatchObject({
      postId: "pz-123",
      writeBack: {
        status: "recorded",
        entityId: post,
        properties: { "postiz-post-id": "pz-123" },
      },
    });
    expect(await props(post)).toEqual({
      "post-status": "Review",
      "postiz-post-id": "pz-123",
    });
  });

  it("never writes a post the runner cannot edit, and says so", async () => {
    const theirs = await insertPost(OTHER);
    holder.sandboxResult = { postId: "pz-456" };
    const out = await run({ writeBack: WRITE_BACK }, theirs);
    expect((out as { result: Record<string, unknown> }).result).toMatchObject({
      writeBack: { status: "failed", entityId: theirs },
    });
    expect(await props(theirs)).toEqual({ "post-status": "Review" });
  });

  it("never writes the kind's lifecycle property, even when declared", async () => {
    const post = await insertPost(OWNER);
    holder.sandboxResult = { postId: "pz-789", status: "Published" };
    await run(
      {
        writeBack: {
          ...WRITE_BACK,
          properties: { "postiz-post-id": "postId", "post-status": "status" },
        },
      },
      post
    );
    const after = await props(post);
    expect(after["post-status"]).toBe("Review");
    expect(after["postiz-post-id"]).toBe("pz-789");
  });

  it("does nothing without a declaration, or when the run was only proposed", async () => {
    const post = await insertPost(OWNER);
    holder.sandboxResult = { postId: "pz-000" };
    const plain = await run({ verbType: "write" }, post);
    expect((plain as { result: unknown }).result).toEqual({ postId: "pz-000" });
    // postId present on purpose: only the proposed check can stop this write.
    holder.sandboxResult = {
      proposed: true,
      proposalId: "p-1",
      postId: "pz-x",
    };
    await run({ writeBack: WRITE_BACK }, post);
    expect(await props(post)).toEqual({ "post-status": "Review" });
  });
});
