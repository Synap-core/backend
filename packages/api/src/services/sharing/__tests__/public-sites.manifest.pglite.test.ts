/**
 * THE SITE MANIFEST DOOR — `GET /public/sites/:siteToken` — on PGlite.
 *
 * Sites are made through the REAL owner doors (tRPC `shares.configureSite` +
 * `publishSite`); odd states (expired, a member row with a token, a planted
 * config) are written with SQL. Read back through the REAL route.
 *
 * Pinned:
 *   - the UNIFORM MISS: every kind of miss below answers the byte-identical
 *     404 `{"error":"Not found"}` with `Cache-Control: no-cache` — no oracle
 *     between unknown, malformed, over-long, draft, revoked, expired, deleted
 *     project, a member row, a W3 publication or a link token;
 *   - a site token is never served by the W3 door `/public/shares/:token`;
 *   - the public-doors switch is decided LAST: a live site behind a closed
 *     switch is the 403 `public_doors_disabled`, a miss behind it stays 404;
 *   - the manifest holds the allowlisted metadata and the configured
 *     collections only: no id of any kind, no `publishWhen`; an unreadable
 *     config serves no collections (fail closed);
 *   - weak ETag + If-None-Match → 304; re-publishing changes the ETag;
 *   - credentials never change the bytes (the handler reads no principal).
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
// The owner is a signed-in human: the production gate grants a non-agent.
vi.mock("../../../utils/permission-check.js", () => ({
  checkPermissionOrPropose: vi.fn(async () => ({ granted: true })),
  previewPermissionDecision: vi.fn(),
  proposedMessageFor: vi.fn(() => "proposed"),
}));
vi.mock("../../../utils/audit-log.js", () => ({ auditLog: vi.fn() }));
vi.mock("../../../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));

import { OpenAPIHono } from "@hono/zod-openapi";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { sharesRouter } from "../../../routers/shares.js";
import { registerPublicSitesRoutes } from "../../../routers/hub-protocol/rest/public-sites.js";
import { registerPublicSharesRoutes } from "../../../routers/hub-protocol/rest/public-shares.js";
import { generateShareToken, hashToken } from "../../../utils/share-token.js";

const A = randomUUID();
const W = randomUUID();
const PROJECTS = Array.from({ length: 8 }, () => randomUUID());
const [P_LIVE, P_DRAFT, P_REVOKED, P_EXPIRED, P_GONE, P_CLOSED, P_BAD] =
  PROJECTS;
const ENTITY = randomUUID();

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

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);
const owner = sharesRouter.createCaller({
  authenticated: true,
  userId: A,
  workspaceId: null,
} as never);

const app = new OpenAPIHono();
registerPublicSitesRoutes(app as never);
registerPublicSharesRoutes(app as never);
async function get(url: string, headers: Record<string, string> = {}) {
  const res = await app.request(url, { headers });
  return {
    status: res.status,
    text: await res.text(),
    etag: res.headers.get("etag"),
    cache: res.headers.get("cache-control"),
  };
}
const site = (token: string, headers?: Record<string, string>) =>
  get(`/public/sites/${encodeURIComponent(token)}`, headers);

const KIND = {
  guest: { read: "direct" as const, create: "proposal" as const },
  link: { read: "direct" as const, create: "proposal" as const },
};
const policy = (projectFields: string[]) => ({
  version: 1 as const,
  kinds: {
    entity: {
      ...KIND,
      public: {
        read: "direct" as const,
        create: "denied" as const,
        fields: ["title", "year"],
      },
    },
    document: {
      ...KIND,
      public: {
        read: "denied" as const,
        create: "denied" as const,
        fields: [],
      },
    },
    view: {
      ...KIND,
      public: {
        read: "denied" as const,
        create: "denied" as const,
        fields: [],
      },
    },
    project: {
      ...KIND,
      public: {
        read: "direct" as const,
        create: "denied" as const,
        fields: projectFields,
      },
    },
  },
});
const CONFIG = {
  version: 1,
  collections: {
    paper: {
      sort: ["-year"],
      slugField: "title",
      publishWhen: { statuses: ["approved-secret-status"] },
    },
    member: { pageSize: 50 },
  },
};

/** Configure + go live; returns the site id and its token. */
async function liveSite(projectId: string) {
  const c = await owner.configureSite({ projectId, config: CONFIG });
  if (c.status === "proposed") throw new Error("unreachable");
  const live = await owner.publishSite({ siteId: c.siteId });
  return { siteId: c.siteId, token: live.token! };
}

const tokens: Record<string, string> = {};
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const m of [
    "0276_exposure_substrate.sql",
    "0336_site_collections.sql",
  ]) {
    await h.client!.exec(
      readFileSync(
        path.resolve(here, `../../../../../database/migrations/${m}`),
        "utf8"
      )
    );
  }
  await q(`insert into users (id, email, user_type) values ($1,$2,'human')`, [
    A,
    `${A}@example.test`,
  ]);
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'W',$2,'{}'::jsonb)`,
    [W, A]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
    [randomUUID(), W, A]
  );
  for (const id of PROJECTS) {
    // The name embeds an id-shaped string: the served title must redact it.
    await q(
      `insert into projects (id, user_id, workspace_id, name, description, status) values ($1,$2,$3,$4,'Internal plans','active')`,
      [id, A, W, `Lab ${randomUUID()}`]
    );
  }
  for (const [slug, kind] of [
    ["paper", "kind"],
    ["member", "role"],
  ]) {
    await q(
      `insert into profiles (id, slug, display_name, profile_kind, entity_scope) values ($1,$2,$2,$3,'workspace')`,
      [randomUUID(), slug, kind]
    );
  }
  await q(
    `insert into entities (id, user_id, workspace_id, title, properties) values ($1,$2,$3,'Rec','{}'::jsonb)`,
    [ENTITY, A, W]
  );
  await owner.setPolicy({ workspaceId: W, policy: policy(["title"]) });

  for (const [name, p] of [
    ["live", P_LIVE],
    ["draft", P_DRAFT],
    ["revoked", P_REVOKED],
    ["expired", P_EXPIRED],
    ["gone", P_GONE],
    ["closed", P_CLOSED],
    ["bad", P_BAD],
  ] as Array<[string, string]>) {
    const { siteId, token } = await liveSite(p!);
    tokens[name] = token;
    if (name === "draft") await owner.unpublishSite({ siteId });
    if (name === "revoked") await owner.revokeSite({ siteId });
    if (name === "expired") {
      await q(
        `update resource_shares set expires_at = now() - interval '1 minute' where id = $1`,
        [siteId]
      );
    }
    if (name === "gone") await q(`delete from projects where id = $1`, [p]);
    if (name === "bad") {
      await q(
        `update resource_shares set site_config = '{"version":1,"collections":{"paper":{"sort":"not-a-list"}}}'::jsonb where id = $1`,
        [siteId]
      );
    }
  }

  // A W3 publication of a record, a link, and a member row given a token:
  // none of them is a site.
  const w3 = generateShareToken();
  const link = generateShareToken();
  const member = generateShareToken();
  tokens.w3 = w3;
  tokens.link = link;
  tokens.member = member;
  await q(
    `insert into resource_shares (resource_type, resource_id, workspace_id, audience, state, created_by, published_at, published_properties, token_hash)
     values ('entity', $1, $2, 'public', 'published', $3, now(), '{"title":"Rec"}'::jsonb, $4)`,
    [ENTITY, W, A, hashToken(w3)]
  );
  await q(
    `insert into resource_shares (resource_type, resource_id, workspace_id, audience, anchor_project_id, state, created_by, token_hash)
     values ('project', $1, $2, 'link', $1, 'draft', $3, $4)`,
    [P_LIVE, W, A, hashToken(link)]
  );
  const { rows } = await q<{ id: string }>(
    `select id from resource_shares where resource_type='project' and resource_id=$1 and audience='public' and revoked_at is null`,
    [P_LIVE]
  );
  await q(
    `insert into resource_shares (resource_type, resource_id, workspace_id, audience, state, created_by, published_at, published_properties, site_share_id, published_collection, public_id, token_hash)
     values ('entity', $1, $2, 'public', 'published', $3, now(), '{}'::jsonb, $4, 'paper', 'p_AAAABBBBCCCCDDDD', $5)`,
    [ENTITY, W, A, rows[0]!.id, hashToken(member)]
  );
}, 120_000);

const MISS = JSON.stringify({ error: "Not found" });

describe("the manifest of a live site", () => {
  it("serves the allowlisted metadata and the configured collections — nothing else", async () => {
    const r = await site(tokens.live!);
    expect(r.status).toBe(200);
    expect(r.cache).toBe("no-cache");
    const body = JSON.parse(r.text);
    expect(Object.keys(body).sort()).toEqual([
      "collections",
      "publishedOn",
      "title",
    ]);
    expect(body.title).toMatch(/^Lab \[redacted\]$/);
    expect(body.publishedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.collections).toEqual([
      {
        key: "member",
        count: 0,
        sort: [],
        pageSize: 50,
        addressing: "publicId",
      },
      {
        key: "paper",
        count: 0,
        sort: ["-year"],
        pageSize: 20,
        addressing: "slug",
      },
    ]);
    // No id of any kind; no owner workflow; no non-allowlisted metadata.
    expect(r.text).not.toMatch(UUID_RE);
    expect(r.text).not.toContain("approved-secret-status");
    expect(r.text).not.toContain("Internal plans");
    expect(r.text).not.toContain(tokens.live!);
  });

  it("widening the project allowlist + going live again serves `description` and changes the ETag", async () => {
    const before = await site(tokens.live!);
    await owner.setPolicy({
      workspaceId: W,
      policy: policy(["title", "description"]),
    });
    const st = await owner.siteStatus({ projectId: P_LIVE! });
    // Snapshot, not live: nothing changes until the owner publishes again.
    expect(JSON.parse((await site(tokens.live!)).text).description).toBe(
      undefined
    );
    await owner.publishSite({ siteId: st!.siteId });
    const after = await site(tokens.live!);
    expect(JSON.parse(after.text).description).toBe("Internal plans");
    expect(after.etag).not.toBe(before.etag);
    await owner.setPolicy({ workspaceId: W, policy: policy(["title"]) });
  });

  it("ETag is weak; If-None-Match → 304", async () => {
    const r = await site(tokens.live!);
    expect(r.etag).toMatch(/^W\/"[0-9a-f]{32}"$/);
    const again = await site(tokens.live!, { "if-none-match": r.etag! });
    expect(again.status).toBe(304);
    expect(again.text).toBe("");
  });

  it("credentials never change the bytes", async () => {
    const plain = await site(tokens.live!);
    const withCreds = await site(tokens.live!, {
      authorization: `Bearer ${randomUUID()}`,
      cookie: "ory_kratos_session=abc",
      "x-session-token": "abc",
    });
    expect(withCreds.status).toBe(plain.status);
    expect(withCreds.text).toBe(plain.text);
  });

  it("a PLANTED metadata snapshot is re-filtered at read: ids redacted, identity keys and non-scalars dropped", async () => {
    const id = randomUUID();
    await q(
      `update resource_shares set published_properties = $2::jsonb where token_hash = $1`,
      [
        hashToken(tokens.bad!),
        JSON.stringify({
          title: `Planted ${id}`,
          description: id,
          ownerId: "someone",
          nested: { a: 1 },
        }),
      ]
    );
    const r = await site(tokens.bad!);
    expect(r.status).toBe(200);
    const body = JSON.parse(r.text);
    expect(body.title).toBe("Planted [redacted]");
    expect(body.description).toBeUndefined();
    expect(r.text).not.toMatch(UUID_RE);
    expect(r.text).not.toContain("someone");
  });

  it("an unreadable stored config serves NO collections (fail closed)", async () => {
    const r = await site(tokens.bad!);
    expect(r.status).toBe(200);
    expect(JSON.parse(r.text).collections).toEqual([]);
  });
});

describe("the uniform miss: every kind of miss is the same 404", () => {
  const misses: Array<[string, () => string]> = [
    ["an unknown token", () => generateShareToken()],
    ["a malformed token", () => "not a token!!"],
    ["an over-long token", () => "a".repeat(300)],
    ["a live token, one character short", () => tokens.live!.slice(0, -1)],
    ["a draft (unpublished) site", () => tokens.draft!],
    ["a revoked site", () => tokens.revoked!],
    ["an expired site", () => tokens.expired!],
    ["a site whose project was deleted", () => tokens.gone!],
    ["a W3 record publication's token", () => tokens.w3!],
    ["a link token", () => tokens.link!],
    ["a site MEMBER row's token", () => tokens.member!],
  ];

  it("self-check: the live site and the W3 publication do answer 200 on their own doors", async () => {
    expect((await site(tokens.live!)).status).toBe(200);
    expect((await get(`/public/shares/${tokens.w3!}`)).status).toBe(200);
  });

  it.each(misses)("%s → 404, byte-identical", async (_l, token) => {
    const r = await site(token());
    expect(r.status).toBe(404);
    expect(r.text).toBe(MISS);
    expect(r.cache).toBe("no-cache");
    expect(r.etag).toBeNull();
  });

  it("a live SITE token is never served by the W3 door", async () => {
    const r = await get(`/public/shares/${tokens.live!}`);
    expect(r.status).toBe(404);
    expect(r.text).toBe(MISS);
  });
});

describe("the public-doors switch is decided LAST", () => {
  it("closed: a live site → 403 public_doors_disabled; a miss stays 404; reopened → 200", async () => {
    await owner.setPublicDoors({ workspaceId: W, enabled: false });
    try {
      const closed = await site(tokens.closed!);
      expect(closed.status).toBe(403);
      expect(JSON.parse(closed.text)).toEqual({
        error:
          "The owner has not turned on public pages and forms for this workspace.",
        code: "public_doors_disabled",
      });
      for (const token of [
        tokens.draft!,
        tokens.revoked!,
        generateShareToken(),
      ]) {
        const r = await site(token);
        expect(r.status).toBe(404);
        expect(r.text).toBe(MISS);
      }
    } finally {
      await owner.setPublicDoors({ workspaceId: W, enabled: null });
    }
    expect((await site(tokens.closed!)).status).toBe(200);
  });
});
