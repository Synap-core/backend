/**
 * The playbook write door on a playbook dedicated to one record
 * (`subjectProfile.entityId`), on PGlite through the real
 * `assertPlaybookDefinitionWritable`:
 *   - the record must be one the WRITER can read, of the playbook's kind; a
 *     record of another kind and a record in a space they cannot see read
 *     the same, so the refusal says nothing about what exists there;
 *   - it takes no activator but `manual`: an activator compiles per kind and
 *     would fire on every record of it.
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
  const db = drizzle(client, { schema });
  return { ...actual, db, getDb: async () => db };
});

import { db } from "@synap/database";
import { pgliteAllTablesDdl } from "../__tests__/pglite-ddl.js";
import { assertPlaybookDefinitionWritable } from "./playbooks.js";

const USER = randomUUID();
const STRANGER = randomUUID();
const THEIR_SPACE = randomUUID();
const POST_KIND = randomUUID();
const PERSON_KIND = randomUUID();
const MY_POST = randomUUID();
const MY_PERSON = randomUUID();
const THEIR_POST = randomUUID();

const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

beforeAll(async () => {
  await h.client!.exec(pgliteAllTablesDdl());
  for (const [id, slug] of [
    [POST_KIND, "post"],
    [PERSON_KIND, "person"],
  ] as const) {
    await q(
      `insert into profiles (id, slug, display_name, profile_kind, entity_scope) values ($1, $2, $2, 'kind', 'workspace')`,
      [id, slug]
    );
  }
  await q(
    `insert into workspaces (id, name, owner_id) values ($1, 'Theirs', $2)`,
    [THEIR_SPACE, STRANGER]
  );
  for (const [id, user, ws, kind, type] of [
    [MY_POST, USER, null, POST_KIND, "post"],
    [MY_PERSON, USER, null, PERSON_KIND, "person"],
    [THEIR_POST, STRANGER, THEIR_SPACE, POST_KIND, "post"],
  ] as const) {
    await q(
      `insert into entities (id, user_id, workspace_id, type, profile_id, title, properties, version, created_at, updated_at)
       values ($1, $2, $3, $4, $5, 'x', '{}'::jsonb, 1, now(), now())`,
      [id, user, ws, type, kind]
    );
  }
}, 120_000);

const write = (subjectProfile: Record<string, unknown>) =>
  assertPlaybookDefinitionWritable(
    db as never,
    { subjectProfile },
    undefined,
    { userId: USER }
  );

describe("a playbook dedicated to one record — the write door", () => {
  it("accepts a record of the kind the writer can read", async () => {
    await expect(
      write({ profileSlug: "post", entityId: MY_POST })
    ).resolves.toBeUndefined();
  });

  it("NEGATIVE: refuses a record of another kind", async () => {
    await expect(
      write({ profileSlug: "post", entityId: MY_PERSON })
    ).rejects.toThrow(/names no post you can read/);
  });

  it("NEGATIVE: refuses a record in a space the writer cannot see, with the same words", async () => {
    await expect(
      write({ profileSlug: "post", entityId: THEIR_POST })
    ).rejects.toThrow(/names no post you can read/);
  });

  it("NEGATIVE: refuses an activator, which would fire on every post; a manual one is fine", async () => {
    await expect(
      write({
        profileSlug: "post",
        entityId: MY_POST,
        activators: [{ on: "enters_status", status: "ready", mode: "run" }],
      })
    ).rejects.toThrow(/takes no activator/);
    await expect(
      write({
        profileSlug: "post",
        entityId: MY_POST,
        activators: [{ on: "manual", mode: "run" }],
      })
    ).resolves.toBeUndefined();
  });
});
