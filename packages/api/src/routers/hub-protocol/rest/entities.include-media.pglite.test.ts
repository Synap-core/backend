/**
 * GET /entities?includeMedia=true — a pod-app draws a grid of posts with their
 * covers from ONE list read: each row carries the `file` entities it links
 * (`row --references--> file`, the attachments door's edge), through the REAL
 * hub auth door (its fence + `runWithGrant`), the REAL route, the REAL
 * `loadLinkedFileRefs` reading `relations` and `entities` through `scopedDb`
 * (rule + key grant), compiled and run as SQL on PGlite. Only the key lookup
 * (`apiKeyService`), the guest check and the object-store signer are stubbed;
 * each key's grant is a real `grants` row.
 *
 * Rows rule out: a default response that starts carrying media; a file the
 * caller could not read on its own showing up (one in a space the key is not
 * granted, one in a space the owner is not a member of, a deleted one) — and
 * the URL door is asked the same question, so "listed" and "signable" cannot
 * drift; an unreadable file eating a slot under the cap; a non-file target or a
 * non-`references` edge counted as media; a mime type read off a document the
 * file's owner does not own; an unstable order; a per-row load; a scope=all
 * merge that loses media; and `q` silently answering without media.
 *
 * Cannot see: production Postgres (no FKs/enums/defaults here), a real signer.
 */
import { OpenAPIHono } from "@hono/zod-openapi";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  getApiKeyStatus: vi.fn(),
  loadLinkedFileRefs: vi.fn(),
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
vi.mock("../../../utils/stored-file-access.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  h.loadLinkedFileRefs.mockImplementation(
    actual.loadLinkedFileRefs as (...a: unknown[]) => unknown
  );
  return { ...actual, loadLinkedFileRefs: h.loadLinkedFileRefs };
});
vi.mock("@synap/storage", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  storage: {
    getSignedUrl: async (key: string, expiresIn: number) =>
      `https://signed.test/${key}?expires=${expiresIn}`,
  },
}));
vi.mock("../../../access/guest-containment.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isGuestPrincipal: vi.fn(async () => false),
}));
vi.mock("../../../services/api-keys.js", () => ({
  apiKeyService: {
    getApiKeyStatus: (...a: unknown[]) => h.getApiKeyStatus(...a),
    recordKeyUse: vi.fn(),
    checkRateLimit: () => true,
  },
}));
vi.mock("../../../services/external-user-mapping.js", () => ({
  isSubTokenFeatureEnabled: () => false,
  resolveExternalUserMapping: vi.fn(),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
// Registers the grant read provider the database floors call (as the API does
// at load) — otherwise a scoped grant reads deny-all, not narrowed.
import "../../../access/grant-read.js";
import { hubAuthMiddleware } from "../_middleware/auth.js";
import { registerEntitiesRoutes } from "./entities.js";
import type { HubHono, HubVariables } from "./_shared.js";
import { MAX_LINKED_FILES_PER_ROW } from "../../../utils/stored-file-access.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const pk = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : c.name === "is_active"
          ? " default true"
          : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const OWNER = randomUUID(); // the human whose pod it is
const AGENT = randomUUID(); // the key principal (an agent user, linked to OWNER)
const STRANGER = randomUUID(); // another human: OWNER is not in their space
const STUDIO = randomUUID(); // inserted first: scope=all reads it first
const OTHER = randomUUID(); // OWNER's other space, not granted to the space key
const THEIRS = randomUUID(); // STRANGER's space
const POST = randomUUID(); // kind profiles
const FILE = randomUUID();
const NOTE = randomUUID();

const CAROUSEL = randomUUID(); // STUDIO post: the visibility + shape fixture
const LONG = randomUUID(); // STUDIO post: the cap fixture
const BARE = randomUUID(); // STUDIO post linking nothing
const POD_POST = randomUUID(); // pod-wide post: read by every lens on scope=all

const SLIDE_1 = randomUUID(); // STUDIO, png
const SLIDE_2 = randomUUID(); // STUDIO, jpeg (linked AFTER slide 1)
const IN_OTHER = randomUUID(); // OTHER: the owner reads it, the space key does not
const IN_THEIRS = randomUUID(); // THEIRS: nobody here reads it
const DELETED = randomUUID(); // STUDIO, soft-deleted
const FOREIGN_DOC = randomUUID(); // STUDIO file pointing at STRANGER's document
const A_NOTE = randomUUID(); // a non-file target
const MENTIONED = randomUUID(); // a file linked by a non-`references` edge
const POD_COVER = randomUUID(); // STUDIO file linked from POD_POST

const KEYS = {
  full: { id: randomUUID(), permissions: ["*"], workspaceIds: null },
  space: {
    id: randomUUID(),
    permissions: ["entity.*.read", "relation.read"],
    workspaceIds: [STUDIO],
  },
  // May read entities but no relation: it cannot read an edge, so no media.
  noEdges: {
    id: randomUUID(),
    permissions: ["entity.*.read"],
    workspaceIds: [STUDIO],
  },
} as const;
type KeyName = keyof typeof KEYS;

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

// The cap fixture: two unreadable files linked FIRST, then more readable ones
// than the cap, each linked one second after the previous.
const LONG_HIDDEN = [randomUUID(), randomUUID()];
const LONG_SEEN = Array.from({ length: MAX_LINKED_FILES_PER_ROW + 2 }, () =>
  randomUUID()
);

let clock = Date.parse("2026-10-01T00:00:00Z");
const tick = () => new Date((clock += 1000)).toISOString();

async function insertFile(
  id: string,
  ws: string | null,
  opts: {
    owner?: string;
    title?: string;
    mime?: string;
    docOwner?: string;
    deleted?: boolean;
  } = {}
) {
  const owner = opts.owner ?? OWNER;
  const doc = randomUUID();
  await q(
    `insert into documents (id, user_id, workspace_id, title, type, storage_key, mime_type)
     values ($1,$2,$3,$4,'image',$5,$6)`,
    [
      doc,
      opts.docOwner ?? owner,
      ws,
      opts.title ?? "f",
      `blobs/${id}`,
      opts.mime ?? "image/png",
    ]
  );
  await q(
    `insert into entities (id, user_id, workspace_id, profile_id, type, title, document_id, properties, system_data, deleted_at)
     values ($1,$2,$3,$4,'file',$5,$6,'{}'::jsonb,'{}'::jsonb,$7)`,
    [
      id,
      owner,
      ws,
      FILE,
      opts.title ?? "f",
      doc,
      opts.deleted ? new Date().toISOString() : null,
    ]
  );
}

async function link(
  from: string,
  to: string,
  ws: string | null,
  type = "references",
  owner = OWNER
) {
  await q(
    `insert into relations (id, user_id, workspace_id, source_entity_id, target_entity_id, source_kind, target_kind, type, metadata, created_at)
     values ($1,$2,$3,$4,$5,'entity','entity',$6,'{}'::jsonb,$7)`,
    [randomUUID(), owner, ws, from, to, type, tick()]
  );
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  await q(`insert into users (id, email, user_type) values ($1,$2,'human')`, [
    OWNER,
    "owner@example.test",
  ]);
  await q(`insert into users (id, email, user_type) values ($1,$2,'human')`, [
    STRANGER,
    "stranger@example.test",
  ]);
  await q(
    `insert into users (id, email, user_type, created_by_user_id) values ($1,$2,'agent',$3)`,
    [AGENT, "agent@example.test", OWNER]
  );
  for (const [ws, name, owner] of [
    [STUDIO, "Studio", OWNER],
    [OTHER, "Other", OWNER],
    [THEIRS, "Theirs", STRANGER],
  ] as const) {
    await q(
      `insert into workspaces (id, name, owner_id, settings) values ($1,$2,$3,'{}'::jsonb)`,
      [ws, name, owner]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
      [randomUUID(), ws, owner]
    );
  }
  for (const [id, slug] of [
    [POST, "post"],
    [FILE, "file"],
    [NOTE, "note"],
  ] as const) {
    await q(
      `insert into profiles (id, slug, display_name, profile_kind, scope, entity_scope, is_active, ui_hints)
       values ($1,$2,$2,'kind','system','workspace',true,'{}'::jsonb)`,
      [id, slug]
    );
  }
  for (const [id, ws] of [
    [CAROUSEL, STUDIO],
    [LONG, STUDIO],
    [BARE, STUDIO],
    [POD_POST, null],
  ] as const) {
    await q(
      `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties, system_data)
       values ($1,$2,$3,$4,'post','p','{}'::jsonb,'{}'::jsonb)`,
      [id, OWNER, ws, POST]
    );
  }
  await q(
    `insert into entities (id, user_id, workspace_id, profile_id, type, title, properties, system_data)
     values ($1,$2,$3,$4,'note','n','{}'::jsonb,'{}'::jsonb)`,
    [A_NOTE, OWNER, STUDIO, NOTE]
  );

  await insertFile(SLIDE_1, STUDIO, { title: "slide 1/2" });
  await insertFile(SLIDE_2, STUDIO, { title: "slide 2/2", mime: "image/jpeg" });
  await insertFile(IN_OTHER, OTHER, { title: "other" });
  await insertFile(IN_THEIRS, THEIRS, { owner: STRANGER, title: "theirs" });
  await insertFile(DELETED, STUDIO, { title: "gone", deleted: true });
  await insertFile(FOREIGN_DOC, STUDIO, {
    title: "foreign",
    docOwner: STRANGER,
  });
  await insertFile(MENTIONED, STUDIO, { title: "mentioned" });
  await insertFile(POD_COVER, STUDIO, { title: "pod cover" });
  for (const id of LONG_HIDDEN)
    await insertFile(id, THEIRS, { owner: STRANGER, title: "hidden" });
  for (const [i, id] of LONG_SEEN.entries())
    await insertFile(id, STUDIO, { title: `seen ${i}` });

  // CAROUSEL: the hidden, deleted and non-file links come FIRST, so a floor
  // that let one through would also show up in the order.
  await link(CAROUSEL, IN_THEIRS, STUDIO);
  await link(CAROUSEL, DELETED, STUDIO);
  await link(CAROUSEL, A_NOTE, STUDIO);
  await link(CAROUSEL, MENTIONED, STUDIO, "mentions");
  await link(CAROUSEL, SLIDE_1, STUDIO);
  await link(CAROUSEL, IN_OTHER, STUDIO);
  await link(CAROUSEL, FOREIGN_DOC, STUDIO);
  await link(CAROUSEL, SLIDE_2, STUDIO);
  await link(CAROUSEL, SLIDE_1, STUDIO); // a second edge to the same file
  for (const id of [...LONG_HIDDEN, ...LONG_SEEN]) await link(LONG, id, STUDIO);
  await link(POD_POST, POD_COVER, STUDIO);

  for (const k of Object.values(KEYS)) {
    await q(
      `insert into grants (id, api_key_id, principal_user_id, on_behalf_of, permissions, workspace_ids, created_by)
       values ($1,$2,$3,$4,$5::text[],$6::uuid[],$4)`,
      [
        randomUUID(),
        k.id,
        AGENT,
        OWNER,
        `{${k.permissions.join(",")}}`,
        k.workspaceIds ? `{${k.workspaceIds.join(",")}}` : null,
      ]
    );
  }
}, 120_000);

beforeEach(() => {
  h.loadLinkedFileRefs.mockClear();
  h.getApiKeyStatus.mockImplementation(async (bearer: string) => {
    const name = bearer.replace(/^synap_/, "") as KeyName;
    return {
      status: "valid",
      record: {
        id: KEYS[name].id,
        userId: AGENT,
        linkedUserId: OWNER,
        parentKeyId: null,
        scope: ["hub-protocol.read"],
        keyType: "hub_inbound",
        workspaceId: null,
        expiresAt: null,
      },
    };
  });
});

function app() {
  const hub: HubHono = new OpenAPIHono<{ Variables: HubVariables }>();
  hub.use("/*", hubAuthMiddleware as never);
  registerEntitiesRoutes(hub);
  const root = new Hono();
  root.route("/api/hub", hub);
  return root;
}

type Media = { id: string; title: string | null; mimeType: string | null };
type Row = { id: string; media?: Media[] };

async function list(key: KeyName, query: string): Promise<Row[]> {
  const res = await app().request(`/api/hub/entities?limit=50&${query}`, {
    headers: { authorization: `Bearer synap_${key}` },
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Row[];
}

async function urlStatus(key: KeyName, fileId: string): Promise<number> {
  const res = await app().request(`/api/hub/files/${fileId}/url`, {
    headers: { authorization: `Bearer synap_${key}` },
  });
  return res.status;
}

const byId = (rows: Row[]) => new Map(rows.map((r) => [r.id, r]));
const ids = (row: Row | undefined) => (row?.media ?? []).map((m) => m.id);

describe("GET /entities — the default response carries no media", () => {
  it("rows that link files come back without `media`, and nothing is loaded", async () => {
    const rows = await list("full", `workspaceId=${STUDIO}&profileSlug=post`);
    expect(rows.map((r) => r.id)).toContain(CAROUSEL);
    for (const row of rows) expect(row).not.toHaveProperty("media");
    expect(h.loadLinkedFileRefs).not.toHaveBeenCalled();
  });

  it("includeMedia=false answers the default body exactly", async () => {
    expect(
      await list(
        "full",
        `workspaceId=${STUDIO}&profileSlug=post&includeMedia=false`
      )
    ).toEqual(await list("full", `workspaceId=${STUDIO}&profileSlug=post`));
  });
});

describe("GET /entities?includeMedia=true — each row carries the files it links", () => {
  it("the owner's key: readable `references` files, oldest link first, each once", async () => {
    const m = byId(
      await list(
        "full",
        `workspaceId=${STUDIO}&profileSlug=post&includeMedia=true`
      )
    );
    // Not IN_THEIRS (a space OWNER is not in), not DELETED, not the note, not
    // MENTIONED (a `mentions` edge). IN_OTHER is the owner's: in.
    expect(ids(m.get(CAROUSEL))).toEqual([
      SLIDE_1,
      IN_OTHER,
      FOREIGN_DOC,
      SLIDE_2,
    ]);
    expect(m.get(CAROUSEL)!.media![0]).toEqual({
      id: SLIDE_1,
      title: "slide 1/2",
      mimeType: "image/png",
    });
    expect(m.get(CAROUSEL)!.media![3]!.mimeType).toBe("image/jpeg");
    expect(m.get(BARE)).not.toHaveProperty("media");
  });

  it("a document the file's owner does not own lends it no type (the signer's owner lock)", async () => {
    const m = byId(
      await list(
        "full",
        `workspaceId=${STUDIO}&profileSlug=post&includeMedia=true`
      )
    );
    const foreign = m.get(CAROUSEL)!.media!.find((f) => f.id === FOREIGN_DOC);
    expect(foreign).toEqual({
      id: FOREIGN_DOC,
      title: "foreign",
      mimeType: null,
    });
  });

  it(`at most ${MAX_LINKED_FILES_PER_ROW} per row, and an unreadable file never takes a slot`, async () => {
    const m = byId(
      await list(
        "full",
        `workspaceId=${STUDIO}&profileSlug=post&includeMedia=true`
      )
    );
    expect(ids(m.get(LONG))).toEqual(
      LONG_SEEN.slice(0, MAX_LINKED_FILES_PER_ROW)
    );
  });

  it("one batched load for the page, never one per row", async () => {
    const rows = await list(
      "full",
      `workspaceId=${STUDIO}&profileSlug=post&includeMedia=true`
    );
    expect(h.loadLinkedFileRefs).toHaveBeenCalledTimes(1);
    expect(h.loadLinkedFileRefs.mock.calls[0]![1]).toEqual(
      rows.map((r) => r.id)
    );
  });

  it("scope=all: a pod-wide row read by several lenses comes back once, with its media", async () => {
    const rows = await list(
      "full",
      "scope=all&profileSlug=post&includeMedia=true"
    );
    expect(rows.filter((r) => r.id === POD_POST)).toHaveLength(1);
    const m = byId(rows);
    expect(ids(m.get(POD_POST))).toEqual([POD_COVER]);
    expect(ids(m.get(CAROUSEL))).toEqual([
      SLIDE_1,
      IN_OTHER,
      FOREIGN_DOC,
      SLIDE_2,
    ]);
    expect(h.loadLinkedFileRefs).toHaveBeenCalledTimes(1);
  });

  it("with q: a 400, never a search silently answered without media", async () => {
    const res = await app().request("/api/hub/entities?q=p&includeMedia=true", {
      headers: { authorization: "Bearer synap_full" },
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /entities?includeMedia=true — never a file the caller could not read on its own", () => {
  it("a key granted Studio never sees the file in Other, and the URL door agrees", async () => {
    const m = byId(await list("space", "profileSlug=post&includeMedia=true"));
    expect(ids(m.get(CAROUSEL))).toEqual([SLIDE_1, FOREIGN_DOC, SLIDE_2]);
    // Same question, asked of the door that signs: listed ⇔ readable.
    expect(await urlStatus("space", IN_OTHER)).toBe(403);
    expect(await urlStatus("space", IN_THEIRS)).toBe(403);
    expect(await urlStatus("space", SLIDE_1)).toBe(200);
    // Control: the owner's full key reads Other.
    expect(await urlStatus("full", IN_OTHER)).toBe(200);
  });

  it("the owner never sees a file in a space they are not a member of", async () => {
    for (const key of ["full", "space"] as const) {
      const m = byId(await list(key, "profileSlug=post&includeMedia=true"));
      expect(ids(m.get(CAROUSEL))).not.toContain(IN_THEIRS);
      for (const id of LONG_HIDDEN) expect(ids(m.get(LONG))).not.toContain(id);
    }
    expect(await urlStatus("full", IN_THEIRS)).toBe(403);
  });

  it("a key that may not read relations reads no edge, so no media", async () => {
    const rows = await list("noEdges", "profileSlug=post&includeMedia=true");
    expect(rows.map((r) => r.id)).toContain(CAROUSEL);
    for (const row of rows) expect(row).not.toHaveProperty("media");
  });
});
