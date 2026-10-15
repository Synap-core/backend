/**
 * Media copies NEVER enter a public projection (plan §4.5).
 *
 * A pod copy of a picture or a video (the entity's `systemData.media`, a
 * Library item's `metadata.importMedia`) is a `documents` row behind the
 * pod's signed-URL door. The pod's credentialless doors are:
 *   - `GET /public/projection` (a workspace's opted-in facet projection),
 *   - `GET /public/shares/:token` (a published share: the publish-time
 *     snapshot built by `buildPublishedSnapshot` + a pinned body).
 * Driven on PGlite through the REAL routes and the REAL snapshot builder, with
 * a publisher who allowlists EVERY key the record has plus the names the copies
 * live under (`media`, `systemData`, `importMedia`, …): no copy's document id,
 * storage key, mime record or source bookkeeping reaches a response byte. A
 * share that names a Library item (a document, not an entity) is the uniform
 * 404.
 *
 * What it does NOT see: a FUTURE public door (`/public/forms` serves a form
 * definition, not a record) — a new door must join this file.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  h.db = db;
  return { ...actual, db, getDb: async () => db };
});

import { OpenAPIHono } from "@hono/zod-openapi";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { registerPublicProjectionRoutes } from "../../../routers/hub-protocol/rest/public-projection.js";
import { registerPublicSharesRoutes } from "../../../routers/hub-protocol/rest/public-shares.js";
import { buildPublishedSnapshot } from "../../sharing/publish-service.js";
import { hashToken } from "../../../utils/share-token.js";

const A = randomUUID();
const SITE = randomUUID();
const ROLE = randomUUID();
const E = randomUUID(); // the published entity, holding media copies
const ITEM = randomUUID(); // a Library item, holding media copies
const COPY_IMAGE = randomUUID();
const COPY_VIDEO = randomUUID();
const COPY_LIBRARY = randomUUID();
const KEY_IMAGE = `files/${SITE}/${randomUUID()}/cover.jpg`;
const KEY_LIBRARY = `files/pod/${randomUUID()}/slide.png`;
/** Every byte that would mean a copy leaked. */
const SECRETS = [
  COPY_IMAGE,
  COPY_VIDEO,
  COPY_LIBRARY,
  KEY_IMAGE,
  KEY_LIBRARY,
  "copiedAt",
  "mediaCopyFailures",
];

const TOKEN = "tok-media-never-public-aaaaaaaaaaaaaaaaaaaaaa";
const LIB_TOKEN = "tok-library-item-share-bbbbbbbbbbbbbbbbbbbbbb";

/** Every key the record has, plus every name a copy lives under. */
const ALL_FIELDS = [
  "title",
  "tier",
  "caption",
  "media-urls",
  "media",
  "systemData",
  "importMedia",
  "mediaCopyFailures",
  "documentId",
  "storageKey",
];

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
        : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}
const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

let app: OpenAPIHono;

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'Site',$2,$3::jsonb)`,
    [
      SITE,
      A,
      JSON.stringify({
        publicProjection: {
          enabled: true,
          roles: ["partner"],
          fields: ALL_FIELDS,
        },
      }),
    ]
  );
  await q(
    `insert into profiles (id, slug, display_name, profile_kind, scope, workspace_id) values ($1,'partner','Partner','role','workspace',$2)`,
    [ROLE, SITE]
  );
  // The entity: its copies live in systemData.media (the runner's record).
  await q(
    `insert into entities (id, user_id, workspace_id, title, properties, system_data) values ($1,$2,$3,'Studio post',$4::jsonb,$5::jsonb)`,
    [
      E,
      A,
      SITE,
      JSON.stringify({
        tier: "gold",
        caption: "A carousel about type",
        "media-urls": ["https://cdn.example.com/cover.jpg"],
      }),
      JSON.stringify({
        media: [
          {
            documentId: COPY_IMAGE,
            storageKey: KEY_IMAGE,
            mime: "image/jpeg",
            sourceUrl: "https://cdn.example.com/cover.jpg",
            copiedAt: "2026-10-15T10:00:00Z",
          },
          {
            documentId: COPY_VIDEO,
            mime: "video/mp4",
            sourceUrl: "https://cdn.example.com/reel.mp4",
            copiedAt: "2026-10-15T10:00:00Z",
          },
        ],
        mediaCopyFailures: [],
      }),
    ]
  );
  await q(
    `insert into entity_facets (id, entity_id, profile_id, user_id, workspace_id, properties) values ($1,$2,$3,$4,$5,'{"tier":"gold"}'::jsonb)`,
    [randomUUID(), E, ROLE, A, SITE]
  );
  // The Library item: a documents row whose copies are in importMedia.
  await q(
    `insert into documents (id, user_id, workspace_id, title, type, metadata) values ($1,$2,$3,'Kept post','text',$4::jsonb)`,
    [
      ITEM,
      A,
      SITE,
      JSON.stringify({
        importItem: { version: 1, title: "Kept post", source: { kind: "url" } },
        importMedia: [
          {
            documentId: COPY_LIBRARY,
            mime: "image/png",
            sourceUrl: "https://cdn.example.com/slide.png",
            storageKey: KEY_LIBRARY,
            kind: "image",
            order: 0,
          },
        ],
      }),
    ]
  );

  // The share, published through the REAL snapshot builder with every key.
  const snapshot = await buildPublishedSnapshot(h.db as never, {
    requestedKind: "entity",
    entityId: E,
    workspaceId: SITE,
    documentId: null,
    fields: ALL_FIELDS,
  });
  for (const [token, resourceId, props] of [
    [TOKEN, E, snapshot],
    [LIB_TOKEN, ITEM, { title: "Kept post" }],
  ] as const) {
    await q(
      `insert into resource_shares
         (id, resource_type, resource_id, workspace_id, audience, state, published_at,
          published_properties, token_hash, token_prefix, created_by, visibility, permissions)
       values ($1,'entity',$2,$3,'public','published',now(),$4::jsonb,$5,$6,$7,'private','{"read":true}'::jsonb)`,
      [
        randomUUID(),
        resourceId,
        SITE,
        JSON.stringify(props),
        hashToken(token),
        token.slice(0, 8),
        A,
      ]
    );
  }

  app = new OpenAPIHono();
  registerPublicProjectionRoutes(app as never);
  registerPublicSharesRoutes(app as never);
}, 120_000);

function leaks(text: string): string[] {
  return SECRETS.filter((s) => text.includes(s));
}

describe("media copies never enter a public projection", () => {
  it("the workspace projection serves the record — and none of its copies", async () => {
    const res = await app.request(`/public/projection?workspace=${SITE}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    // Non-vacuity: the record IS served, with what was allowlisted.
    expect(JSON.parse(text).items).toEqual([
      expect.objectContaining({
        id: E,
        properties: expect.objectContaining({
          tier: "gold",
          caption: "A carousel about type",
        }),
      }),
    ]);
    expect(leaks(text)).toEqual([]);
  });

  it("a published share serves its snapshot — and none of the copies", async () => {
    const res = await app.request(`/public/shares/${TOKEN}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toMatchObject({
      title: "Studio post",
      properties: { tier: "gold", caption: "A carousel about type" },
    });
    expect(leaks(text)).toEqual([]);
  });

  it("a share naming a Library item (not an entity) is the uniform 404", async () => {
    const res = await app.request(`/public/shares/${LIB_TOKEN}`);
    expect(res.status).toBe(404);
    expect(leaks(await res.text())).toEqual([]);
  });

  it("self-check: the scan sees a leak when one is there", () => {
    expect(leaks(`{"documentId":"${COPY_IMAGE}"}`)).toEqual([COPY_IMAGE]);
  });
});
