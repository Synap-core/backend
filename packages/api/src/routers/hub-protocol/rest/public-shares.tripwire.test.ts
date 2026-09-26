/**
 * TRIPWIRE — the credentialless public read of a PUBLISHED share (Sites W3).
 *
 * Driven on PGlite through the REAL hub auth middleware, the REAL idempotency
 * middleware and the REAL `GET /public/shares/:token` route, against the REAL
 * 0276 constraints + revoke-is-permanent trigger. Nothing between the stored
 * row and the served bytes is hand-built.
 *
 * What it pins:
 *   1. Only a live PUBLISHED public row serves; its body is the PINNED revision
 *      (never the live / later draft text) and its values are the SNAPSHOT.
 *   2. The response carries no owner / workspace / entity / share id, no actor,
 *      no relation to an unshared object (ids removed from values and body).
 *   3. UNIFORM 404: unknown, draft, revoked, expired, link-audience, view,
 *      deleted entity, foreign pin → byte-identical status, body AND headers.
 *   4. Revoked stays revoked: the row cannot be un-revoked, and a revalidation
 *      with the old ETag after revoke is a 404, not a 304.
 *   5. Authorization / Cookie / X-Session-Token never change the response (a
 *      random Bearer would 401 if the auth skip ever stopped covering the door).
 *   6. `Cache-Control: no-cache` on 200 AND 404 (never the global max-age).
 *
 * What it does NOT see: the pod-edge CORS / rate limiter (apps/api
 * `public-doors.tripwire.test.ts` drives those), production Postgres, object
 * storage (every pinned version here stores its text inline).
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  return {
    ...actual,
    db,
    getDb: async () => db,
    eventRepository: { append: async () => undefined },
  };
});

import { OpenAPIHono } from "@hono/zod-openapi";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { hubAuthMiddleware } from "../_middleware/auth.js";
import { idempotencyMiddleware } from "../_middleware/idempotency.js";
import { registerPublicSharesRoutes } from "./public-shares.js";
import { hashToken } from "../../../utils/share-token.js";

// ── Fixture ids (every one of them must stay out of every response) ──
const A = randomUUID(); // owner
const W = randomUUID(); // workspace
const E = randomUUID(); // the published entity
const D = randomUUID(); // its document
const V1 = randomUUID(); // the PINNED checkpoint
const V2 = randomUUID(); // a later draft checkpoint (never published)
const U = randomUUID(); // an UNSHARED entity, referenced from E's snapshot + body
const DX = randomUUID(); // another entity's document
const VX = randomUUID(); // a checkpoint of DX (a foreign pin)
const INTERNAL_IDS = [A, W, E, D, V1, V2, U, DX, VX];

const PINNED_TEXT = `# Launch notes\n\nSee [[entity:${U}]] for pricing.`;
const DRAFT_TEXT = "DRAFT-SECRET-NOT-PUBLISHED";

// One entity per row: 0276 allows ONE live publication per resource.
const ent = {
  pub: E,
  draft: randomUUID(),
  revoked: randomUUID(),
  expired: randomUUID(),
  link: randomUUID(),
  deleted: randomUUID(),
  mispin: randomUUID(),
  plain: randomUUID(), // published, no document at all
};
// A VIEW share whose resource id ALSO names a live entity (with the pinned
// document): the discriminating input for "only entities are publishable" —
// without the resource-type check it would serve that entity's body.
const VIEW_ID = randomUUID();
let PROJECT = "";

const tok = {
  pub: "tok-published-aaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  draft: "tok-draft-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  revoked: "tok-revoked-ccccccccccccccccccccccccccccccc",
  expired: "tok-expired-ddddddddddddddddddddddddddddddd",
  link: "tok-link-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  view: "tok-view-fffffffffffffffffffffffffffffffffff",
  deleted: "tok-deleted-ggggggggggggggggggggggggggggggg",
  mispin: "tok-mispin-hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh",
  plain: "tok-plain-iiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiiii",
  unknown: "tok-never-minted-jjjjjjjjjjjjjjjjjjjjjjjjj",
};
const shareIds: Record<string, string> = {};

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
      !c.primary && c.hasDefault
        ? type.startsWith("timestamp")
          ? " default now()"
          : type === "uuid"
            ? " default gen_random_uuid()"
            : ""
        : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

function headerList(headers: Headers): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  headers.forEach((value, key) => out.push([key, value]));
  return out;
}

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

function makeApp() {
  const app = new OpenAPIHono();
  // The REAL hub middleware stack, in the hub's order (auth → idempotency).
  app.use("/*", hubAuthMiddleware as never);
  app.use("/*", idempotencyMiddleware({ skipPaths: [] }));
  registerPublicSharesRoutes(app as never);
  const root = new OpenAPIHono();
  root.route("/api/hub", app);
  return root;
}

async function get(
  app: ReturnType<typeof makeApp>,
  token: string,
  headers: Record<string, string> = {}
) {
  const res = await app.request(`/api/hub/public/shares/${token}`, {
    headers,
  });
  const text = await res.text();
  return {
    status: res.status,
    text,
    headers: headerList(res.headers).sort(([a], [b]) => a.localeCompare(b)),
    etag: res.headers.get("etag"),
    cacheControl: res.headers.get("cache-control"),
  };
}

async function insertShare(
  key: string,
  row: {
    resourceType?: string;
    resourceId: string;
    audience?: "public" | "link";
    state?: "draft" | "published";
    pin?: string | null;
    props?: Record<string, unknown> | null;
    expiresAt?: string | null;
    anchor?: string | null;
    /** A draft that WAS published (unpublished): keeps its publication data. */
    everPublished?: boolean;
  }
) {
  const id = randomUUID();
  shareIds[key] = id;
  const published =
    (row.state ?? "published") === "published" || row.everPublished === true;
  await q(
    `insert into resource_shares
       (id, resource_type, resource_id, workspace_id, audience, anchor_project_id, state,
        published_at, published_by, published_document_version_id, published_properties,
        token_hash, token_prefix, expires_at, created_by, visibility, permissions)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,'private','{"read":true}'::jsonb)`,
    [
      id,
      row.resourceType ?? "entity",
      row.resourceId,
      W,
      row.audience ?? "public",
      row.anchor ?? null,
      row.state ?? "published",
      published ? new Date("2026-09-20T10:11:12Z").toISOString() : null,
      published ? A : null,
      row.pin ?? null,
      row.props === undefined
        ? published
          ? JSON.stringify({ title: "Hi" })
          : null
        : row.props === null
          ? null
          : JSON.stringify(row.props),
      hashToken(tok[key as keyof typeof tok]),
      tok[key as keyof typeof tok].slice(0, 6),
      row.expiresAt ?? null,
      A,
    ]
  );
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
  const here = path.dirname(fileURLToPath(import.meta.url));
  await h.client!.exec(
    readFileSync(
      path.resolve(
        here,
        "../../../../../database/migrations/0276_exposure_substrate.sql"
      ),
      "utf8"
    )
  );

  await q(`insert into users (id, email, user_type) values ($1,$2,'human')`, [
    A,
    `${A}@example.test`,
  ]);
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'W',$2,'{}'::jsonb)`,
    [W, A]
  );
  PROJECT = randomUUID();
  await q(
    `insert into projects (id, name, workspace_id, user_id) values ($1,'P',$2,$3)`,
    [PROJECT, W, A]
  );
  for (const [id, doc] of [
    [E, D],
    [U, null],
    [ent.draft, D],
    [ent.revoked, D],
    [ent.expired, D],
    [ent.link, D],
    [ent.deleted, D],
    [ent.mispin, D],
    [ent.plain, null],
    [VIEW_ID, D],
  ] as const) {
    await q(
      `insert into entities (id, user_id, workspace_id, title, document_id) values ($1,$2,$3,'LIVE-TITLE-NOT-SNAPSHOT',$4)`,
      [id, A, W, doc]
    );
  }
  await q(`update entities set deleted_at = now() where id = $1`, [
    ent.deleted,
  ]);
  for (const doc of [D, DX]) {
    await q(
      `insert into documents (id, user_id, workspace_id, title, type, current_version, content_revision) values ($1,$2,$3,'Doc','markdown',2,2)`,
      [doc, A, W]
    );
  }
  for (const [id, doc, version, content] of [
    [V1, D, 1, PINNED_TEXT],
    [V2, D, 2, DRAFT_TEXT],
    [VX, DX, 1, "FOREIGN-DOCUMENT-BODY"],
  ] as const) {
    await q(
      `insert into document_versions (id, document_id, version, content, size, author, author_id) values ($1,$2,$3,$4,0,'user',$5)`,
      [id, doc, version, content, A]
    );
  }

  await insertShare("pub", {
    resourceId: E,
    pin: V1,
    props: {
      title: "Launch",
      price: 12,
      live: true,
      ownerId: A,
      workspaceId: W,
      // Identity keys with NON-id values: the discriminating input for the
      // identity-key refusal (an id-valued one is also dropped as an id).
      createdBy: "Owner Display Name",
      AuthorId: "owner-handle",
      related: U,
      note: `ask about ${U} first`,
      nested: { secret: "x" },
      list: [1, 2],
      nan: null,
    },
  });
  // An UNPUBLISHED row that still carries its old publication data + pin: the
  // discriminating input for "state must be published" (a never-published
  // draft has no published_at and would 404 on that alone).
  await insertShare("draft", {
    resourceId: ent.draft,
    state: "draft",
    everPublished: true,
    pin: V1,
  });
  await insertShare("revoked", { resourceId: ent.revoked, pin: V1 });
  await q(
    `update resource_shares set revoked_at = now(), revoked_by = $2 where id = $1`,
    [shareIds.revoked, A]
  );
  await insertShare("expired", {
    resourceId: ent.expired,
    pin: V1,
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  });
  await insertShare("link", {
    resourceId: ent.link,
    audience: "link",
    state: "draft",
    anchor: PROJECT,
  });
  await insertShare("view", {
    resourceType: "view",
    resourceId: VIEW_ID,
    pin: V1,
  });
  await insertShare("deleted", { resourceId: ent.deleted, pin: V1 });
  await insertShare("mispin", { resourceId: ent.mispin, pin: VX });
  await insertShare("plain", {
    resourceId: ent.plain,
    props: { price: 3 },
  });
});

describe("public share read — only a live published row serves, and only its snapshot", () => {
  it("serves the pinned revision and the filtered snapshot", async () => {
    const r = await get(makeApp(), tok.pub);
    expect(r.status).toBe(200);
    const body = JSON.parse(r.text);
    expect(body).toEqual({
      resourceType: "entity",
      title: "Launch",
      properties: {
        price: 12,
        live: true,
        note: "ask about [redacted] first",
      },
      body: {
        format: "markdown",
        content: "# Launch notes\n\nSee [[entity:[redacted]]] for pricing.",
      },
      publishedOn: "2026-09-20",
    });
  });

  it("never serves the live record or a later draft checkpoint", async () => {
    const r = await get(makeApp(), tok.pub);
    expect(r.text).not.toContain(DRAFT_TEXT);
    expect(r.text).not.toContain("LIVE-TITLE-NOT-SNAPSHOT");
  });

  it("carries no internal id, owner, workspace or actor — anywhere in the bytes", async () => {
    const r = await get(makeApp(), tok.pub);
    expect(r.text).not.toContain("Owner Display Name");
    expect(r.text).not.toContain("owner-handle");
    for (const id of [...INTERNAL_IDS, shareIds.pub]) {
      expect(r.text).not.toContain(id);
      expect(JSON.stringify(r.headers)).not.toContain(id);
    }
    const body = JSON.parse(r.text);
    for (const key of [
      "id",
      "userId",
      "ownerId",
      "workspaceId",
      "projectId",
      "createdBy",
      "publishedBy",
      "resourceId",
    ]) {
      expect(body).not.toHaveProperty(key);
      expect(body.properties).not.toHaveProperty(key);
    }
  });

  it("omits title when the snapshot did not allowlist it", async () => {
    const r = await get(makeApp(), tok.plain);
    expect(r.status).toBe(200);
    const body = JSON.parse(r.text);
    expect(body).not.toHaveProperty("title");
    expect(body.properties).toEqual({ price: 3 });
    expect(body.body).toBeNull();
  });

  it("sends Cache-Control: no-cache and a weak ETag", async () => {
    const r = await get(makeApp(), tok.pub);
    expect(r.cacheControl).toBe("no-cache");
    expect(r.etag).toMatch(/^W\/"[0-9a-f]{32}"$/);
    const again = await get(makeApp(), tok.pub, { "If-None-Match": r.etag! });
    expect(again.status).toBe(304);
  });
});

describe("public share read — a failed read is not a miss", () => {
  it("a database fault answers 500, never the calm uniform 404", async () => {
    await q(`alter table document_versions rename to document_versions_hidden`);
    try {
      const r = await get(makeApp(), tok.pub);
      expect(r.status).toBe(500);
      expect(r.text).not.toContain(PINNED_TEXT.slice(0, 10));
    } finally {
      await q(
        `alter table document_versions_hidden rename to document_versions`
      );
    }
    expect((await get(makeApp(), tok.pub)).status).toBe(200);
  });
});

describe("public share read — the uniform 404", () => {
  const MISSES = [
    "unknown",
    "draft",
    "revoked",
    "expired",
    "link",
    "view",
    "deleted",
    "mispin",
  ] as const;

  it("answers every kind of miss with byte-identical status, body and headers", async () => {
    const app = makeApp();
    const reference = await get(app, tok.unknown);
    expect(reference.status).toBe(404);
    expect(JSON.parse(reference.text)).toEqual({ error: "Not found" });
    expect(reference.cacheControl).toBe("no-cache");
    expect(reference.etag).toBeNull();
    for (const miss of MISSES) {
      const r = await get(app, tok[miss]);
      expect({
        miss,
        status: r.status,
        text: r.text,
        headers: r.headers,
      }).toEqual({
        miss,
        status: reference.status,
        text: reference.text,
        headers: reference.headers,
      });
    }
  });

  it("non-vacuity: each miss token names a stored row except `unknown`", async () => {
    const { rows } = await q<{ n: number }>(
      `select count(*)::int as n from resource_shares where token_hash = any($1)`,
      [MISSES.filter((m) => m !== "unknown").map((m) => hashToken(tok[m]))]
    );
    expect(rows[0]!.n).toBe(MISSES.length - 1);
  });
});

describe("public share read — revoked stays revoked", () => {
  it("the row cannot be un-revoked or re-published (0276 trigger)", async () => {
    await expect(
      q(`update resource_shares set revoked_at = null where id = $1`, [
        shareIds.revoked,
      ])
    ).rejects.toThrow(/revocation is permanent/);
    await expect(
      q(`update resource_shares set published_at = now() where id = $1`, [
        shareIds.revoked,
      ])
    ).rejects.toThrow(/revocation is permanent/);
    expect((await get(makeApp(), tok.revoked)).status).toBe(404);
  });

  it("a revalidation with the pre-revoke ETag is a 404, not a 304", async () => {
    const key = "revalidate";
    const entityId = randomUUID();
    await q(
      `insert into entities (id, user_id, workspace_id, title, document_id) values ($1,$2,$3,'t',$4)`,
      [entityId, A, W, D]
    );
    (tok as Record<string, string>)[key] =
      "tok-revalidate-kkkkkkkkkkkkkkkkkkkkkkkkkkkkk";
    await insertShare(key, { resourceId: entityId, pin: V1 });
    const app = makeApp();
    const first = await get(app, tok[key as keyof typeof tok]);
    expect(first.status).toBe(200);
    await q(`update resource_shares set revoked_at = now() where id = $1`, [
      shareIds[key],
    ]);
    const after = await get(app, tok[key as keyof typeof tok], {
      "If-None-Match": first.etag!,
    });
    expect(after.status).toBe(404);
  });
});

describe("public share read — a credential never changes the response", () => {
  const CREDENTIALS: Array<Record<string, string>> = [
    { Authorization: `Bearer synap_${randomUUID().replace(/-/g, "")}` },
    { Authorization: "Bearer not-even-a-key-shape-at-all-000000" },
    { Cookie: "ory_kratos_session=forged; synap_session=forged" },
    { "X-Session-Token": "forged-session-token" },
  ];

  for (const token of ["pub", "unknown", "revoked"] as const) {
    it(`identical bytes with and without credentials (${token})`, async () => {
      const app = makeApp();
      const bare = await get(app, tok[token]);
      for (const creds of CREDENTIALS) {
        const withCreds = await get(app, tok[token], creds);
        expect({ creds, ...withCreds }).toEqual({ creds, ...bare });
      }
    });
  }

  it("positive control: the same middleware DOES authenticate a non-public path", async () => {
    const app = makeApp();
    const res = await app.request("/api/hub/entities", {
      headers: { Authorization: "Bearer not-even-a-key-shape-at-all-000000" },
    });
    expect(res.status).toBe(401);
  });
});
