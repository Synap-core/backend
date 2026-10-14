/**
 * The file door's read floor (`loadSignableDocument` / `loadSignableFileEntity`)
 * on PGlite, through the REAL `entities` + `documents` VisibilityRules.
 *
 * A pod-wide entity is shared with a member through a shared ROLE granted to a
 * space they belong to (the same setup as shared-role-visibility). Its media
 * copy is a pod-wide document owned by the entity's author: before the entity
 * leg, that copy 403'd for every member but the author although the entity
 * itself was readable to them.
 *
 * What this CANNOT see: the Hono route (status codes) — it drives the helpers
 * the route calls; production Postgres constraints (tables are generated from
 * the Drizzle definitions without FKs).
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
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return { ...actual, db, getDb: async () => db };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import {
  loadSignableDocument,
  loadSignableFileEntity,
} from "./stored-file-access.js";

const OWNER = "sf-owner";
const MEMBER = "sf-member"; // pod member, in the space the role is granted to
const OUTSIDER = "sf-outsider"; // pod member, in no granted space
const ATTACKER = "sf-attacker"; // pod member, owns an entity of their own

const WS_A = randomUUID();
const ROLE = randomUUID();

const E_SHARED = randomUUID(); // OWNER's pod-wide entity, shared to WS_A
const D_FILE = randomUUID(); // E_SHARED's own document
const D_MEDIA = randomUUID(); // E_SHARED's media copy
const D_UNRELATED = randomUUID(); // OWNER's pod-wide doc nobody references
const E_ATTACK = randomUUID(); // ATTACKER's entity pointing at OWNER's docs

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);
const keyOf = (id: string) => `blobs/${id}`;

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  for (const u of [OWNER, MEMBER, OUTSIDER, ATTACKER]) {
    await q(`insert into users (id, email) values ($1, $2)`, [
      u,
      `${u}@x.test`,
    ]);
    await q(
      `insert into pod_members (id, user_id, pod_role) values ($1,$2,$3)`,
      [randomUUID(), u, u === OWNER ? "owner" : "member"]
    );
  }
  await q(`insert into workspaces (id, name, owner_id) values ($1,'A',$2)`, [
    WS_A,
    OWNER,
  ]);
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'editor')`,
    [randomUUID(), WS_A, MEMBER]
  );
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, workspace_id) values ($1,'client','Client','role','shared',null)`,
    [ROLE]
  );
  await q(
    `insert into profile_workspace_access (profile_id, workspace_id) values ($1,$2)`,
    [ROLE, WS_A]
  );
  for (const d of [D_FILE, D_MEDIA, D_UNRELATED]) {
    await q(
      `insert into documents (id, user_id, workspace_id, title, type, current_version, content_revision, storage_key, mime_type) values ($1,$2,null,'Doc','image',1,1,$3,'image/webp')`,
      [d, OWNER, keyOf(d)]
    );
  }
  await q(
    `insert into entities (id, user_id, workspace_id, title, document_id, system_data) values ($1,$2,null,'Person',$3,$4::jsonb)`,
    [
      E_SHARED,
      OWNER,
      D_FILE,
      JSON.stringify({
        media: [
          {
            documentId: D_MEDIA,
            mime: "image/jpeg",
            bytes: 10,
            sourceUrl: "https://example.org/a.jpg",
            copiedAt: "2026-10-14T00:00:00.000Z",
          },
        ],
      }),
    ]
  );
  await q(
    `insert into entity_facets (id, entity_id, profile_id, user_id, workspace_id, deleted_at) values ($1,$2,$3,$4,null,null)`,
    [randomUUID(), E_SHARED, ROLE, OWNER]
  );
  // The attacker's own entity, readable to them, pointing at OWNER's documents
  // both as its file and as a "media copy".
  await q(
    `insert into entities (id, user_id, workspace_id, title, document_id, system_data) values ($1,$2,null,'Mine',$3,$4::jsonb)`,
    [
      E_ATTACK,
      ATTACKER,
      D_UNRELATED,
      JSON.stringify({ media: [{ documentId: D_UNRELATED }] }),
    ]
  );
}, 60_000);

describe("file door read floor — documents", () => {
  it("the author signs every document of theirs", async () => {
    for (const d of [D_FILE, D_MEDIA, D_UNRELATED]) {
      expect((await loadSignableDocument(OWNER, d))?.storageKey).toBe(
        keyOf(d)
      );
    }
  });

  it("a member who can READ the pod-wide entity signs its media copy", async () => {
    expect((await loadSignableDocument(MEMBER, D_MEDIA))?.storageKey).toBe(
      keyOf(D_MEDIA)
    );
    expect((await loadSignableDocument(MEMBER, D_FILE))?.storageKey).toBe(
      keyOf(D_FILE)
    );
  });

  it("negative: an unrelated pod-wide document of the author stays unsignable", async () => {
    expect(await loadSignableDocument(MEMBER, D_UNRELATED)).toBeUndefined();
  });

  it("negative: a member who cannot read the entity cannot sign its media", async () => {
    expect(await loadSignableDocument(OUTSIDER, D_MEDIA)).toBeUndefined();
    expect(await loadSignableDocument(OUTSIDER, D_FILE)).toBeUndefined();
  });

  it("owner lock: pointing your own entity at another user's document signs nothing", async () => {
    expect(await loadSignableDocument(ATTACKER, D_UNRELATED)).toBeUndefined();
  });

  it("carries the served mime type, by either leg", async () => {
    expect((await loadSignableDocument(OWNER, D_FILE))?.mimeType).toBe(
      "image/webp"
    );
    expect((await loadSignableDocument(MEMBER, D_MEDIA))?.mimeType).toBe(
      "image/webp"
    );
  });

  it("an unknown id is undefined, not a throw", async () => {
    expect(await loadSignableDocument(MEMBER, randomUUID())).toBeUndefined();
  });
});

describe("file door read floor — file entities", () => {
  it("a member who can read the pod-wide entity gets its file's key", async () => {
    expect(await loadSignableFileEntity(MEMBER, E_SHARED)).toEqual({
      id: E_SHARED,
      storageKey: keyOf(D_FILE),
      mimeType: "image/webp",
    });
  });

  it("negative: a member who cannot read the entity gets nothing", async () => {
    expect(await loadSignableFileEntity(OUTSIDER, E_SHARED)).toBeUndefined();
  });

  it("owner lock: an entity linked to another user's document carries no key", async () => {
    expect(await loadSignableFileEntity(ATTACKER, E_ATTACK)).toEqual({
      id: E_ATTACK,
      storageKey: undefined,
      mimeType: null,
    });
  });
});
