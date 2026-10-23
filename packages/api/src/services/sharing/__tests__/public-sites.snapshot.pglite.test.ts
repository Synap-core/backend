/**
 * T2 — DRAFT LEAKAGE through the collection and record doors (collection door
 * C1b), plus their pages, sort and ETags, on PGlite.
 *
 * Records are published through the REAL owner doors (tRPC
 * `shares.publishToSite` / `unpublishFromSite` / `unpublishSite`), the REAL
 * site core, the REAL 0276 + 0336 migrations; read back through the REAL
 * routes `GET /public/sites/:token/collections/:key[/:slugOrPublicId]`.
 *
 * Pinned:
 *   - CONTENT IS A SNAPSHOT: an edit after publish (title, a property, a new
 *     body checkpoint) is invisible on the list and the record, and the ETag
 *     does not move; only a publish act refreshes it (same public id, slug
 *     re-derived, new pin, new ETag);
 *   - NARROWING IS LIVE: an unpublished member, a record taken out of the
 *     project, a deleted record, a member whose OWN space closed its public
 *     doors — each disappears from the list and its record door 404s at once;
 *     a site back to draft 404s on every door; going live again restores the
 *     same token and the same record URLs;
 *   - the home space's switch closed → 403 on a live collection and record;
 *   - pages: limit/offset, the configured default sort, an asked sort, jsonb
 *     numeric order with missing values last, a stable tie-break; `total`
 *     counts live members only;
 *   - no response carries an internal id.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | import("./site-fixture.js").PgClient,
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
import { sharesRouter } from "../../../routers/shares.js";
import { registerPublicSitesRoutes } from "../../../routers/hub-protocol/rest/public-sites.js";
import {
  createSiteSchema,
  sitePolicy,
  siteWorld,
  UUID_RE,
} from "./site-fixture.js";

const A = randomUUID();
const W = randomUUID(); // home space
const W2 = randomUUID(); // another space of A's: its records join the site
const P = randomUUID();
const owner = sharesRouter.createCaller({
  authenticated: true,
  userId: A,
  workspaceId: null,
} as never);

const app = new OpenAPIHono();
registerPublicSitesRoutes(app as never);
async function get(url: string, headers: Record<string, string> = {}) {
  const res = await app.request(url, { headers });
  const text = await res.text();
  return {
    status: res.status,
    text,
    json: text ? (JSON.parse(text) as any) : null,
    etag: res.headers.get("etag"),
    cache: res.headers.get("cache-control"),
  };
}
const MISS = JSON.stringify({ error: "Not found" });

const CONFIG = {
  version: 1,
  collections: {
    paper: { sort: ["-year", "title"], pageSize: 2, slugField: "title" },
  },
};

let world: ReturnType<typeof siteWorld>;
let siteId = "";
let token = "";
const rec: Record<string, { id: string; documentId: string | null }> = {};
const pub: Record<string, string> = {};

const list = (query = "") =>
  get(`/public/sites/${token}/collections/paper${query}`);
const record = (idOrSlug: string) =>
  get(`/public/sites/${token}/collections/paper/${idOrSlug}`);

async function publish(...names: string[]) {
  const res = await owner.publishToSite({
    siteId,
    entityIds: names.map((n) => rec[n]!.id),
  });
  if (res.status === "proposed") throw new Error("unreachable");
  expect(res.skipped).toEqual([]);
  for (const p of res.published) {
    const name = names.find((n) => rec[n]!.id === p.entityId)!;
    pub[name] = p.publicId;
  }
  return res;
}

const titles = (r: { json: any }) =>
  (r.json.items as Array<{ title?: string }>).map((i) => i.title);

beforeAll(async () => {
  await createSiteSchema(h.client!);
  world = siteWorld(h.client!);
  await world.user(A);
  await world.workspace(W, A);
  await world.workspace(W2, A);
  await world.project(P, A, W);
  const paper = await world.profile("paper");
  for (const ws of [W, W2]) {
    await owner.setPolicy({ workspaceId: ws, policy: sitePolicy() });
  }
  const c = await owner.configureSite({ projectId: P, config: CONFIG });
  if (c.status === "proposed") throw new Error("unreachable");
  siteId = c.siteId;
  token = (await owner.publishSite({ siteId })).token!;

  const make = async (
    name: string,
    props: Record<string, unknown>,
    workspaceId = W
  ) => {
    rec[name] = await world.record({
      ownerId: A,
      workspaceId,
      profileId: paper,
      title: name,
      // `internalNote` is not allowlisted: never served.
      properties: { ...props, internalNote: `${name}-private` },
      body: `${name} body v1 — see ${randomUUID()}`,
    });
    await world.fileInto(rec[name]!.id, P, A);
  };
  await make("Alpha", { year: 2020, venue: "X" });
  await make("Beta", { year: 2022 });
  await make("Gamma", { year: 2021 }, W2);
  await make("Delta", {}); // no year: sorts last
  await publish("Alpha", "Beta", "Gamma", "Delta");
}, 120_000);

describe("the collection door: pages and sort", () => {
  it("default = the configured sort (-year, title), the configured page size; total counts live members", async () => {
    const r = await list();
    expect(r.status).toBe(200);
    expect(r.cache).toBe("no-cache");
    expect(r.etag).toMatch(/^W\//);
    expect(r.json).toMatchObject({ total: 4, offset: 0, limit: 2 });
    expect(titles(r)).toEqual(["Beta", "Gamma"]);
    expect(titles(await list("?offset=2"))).toEqual(["Alpha", "Delta"]);
    expect(titles(await list("?offset=4"))).toEqual([]);
  });

  it("an asked sort (allowlisted keys only) and limit", async () => {
    expect(titles(await list("?sort=title&limit=10"))).toEqual([
      "Alpha",
      "Beta",
      "Delta",
      "Gamma",
    ]);
    // Numeric jsonb order ascending, the record without a year last.
    expect(titles(await list("?sort=year&limit=10"))).toEqual([
      "Alpha",
      "Gamma",
      "Beta",
      "Delta",
    ]);
    const byPublished = await list("?sort=-publishedAt,title&limit=10");
    expect(byPublished.status).toBe(200);
    expect(byPublished.json.items).toHaveLength(4);
  });

  it("each item: collection, public id, slug, title, allowlisted properties, day — nothing else", async () => {
    const r = await list("?sort=title&limit=1");
    expect(r.json.items[0]).toEqual({
      collection: "paper",
      publicId: pub.Alpha,
      slug: "alpha",
      title: "Alpha",
      properties: { year: 2020, venue: "X" },
      publishedOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
    expect(r.text).not.toMatch(UUID_RE);
    expect(r.text).not.toContain("private");
  });

  it("If-None-Match → 304 on the list", async () => {
    const r = await list();
    const again = await get(`/public/sites/${token}/collections/paper`, {
      "if-none-match": r.etag!,
    });
    expect(again.status).toBe(304);
  });
});

describe("the record door", () => {
  it("by slug and by public id: the snapshot and the PINNED body, ids redacted", async () => {
    const bySlug = await record("alpha");
    const byId = await record(pub.Alpha!);
    expect(bySlug.status).toBe(200);
    expect(bySlug.text).toBe(byId.text);
    expect(bySlug.json).toMatchObject({
      collection: "paper",
      publicId: pub.Alpha,
      slug: "alpha",
      title: "Alpha",
      properties: { year: 2020, venue: "X" },
      body: { format: "markdown" },
    });
    expect(bySlug.json.body.content).toMatch(/^Alpha body v1/);
    expect(bySlug.text).not.toMatch(UUID_RE);
    expect(bySlug.text).not.toContain("private");
    const again = await get(`/public/sites/${token}/collections/paper/alpha`, {
      "if-none-match": bySlug.etag!,
    });
    expect(again.status).toBe(304);
  });
});

describe("T2: content is a snapshot — an edit never publishes itself", () => {
  it("edits after publish are invisible (list, record, ETag) until the owner publishes again", async () => {
    const listBefore = await list("?sort=title&limit=10");
    const recBefore = await record(pub.Alpha!);

    await world.q(
      `update entities set title = 'Alpha Revised', properties = '{"year":2030,"venue":"Y"}'::jsonb where id = $1`,
      [rec.Alpha!.id]
    );
    await world.checkpoint(rec.Alpha!.documentId!, 2, "Alpha body v2", A);

    const listAfter = await list("?sort=title&limit=10");
    const recAfter = await record(pub.Alpha!);
    expect(listAfter.text).toBe(listBefore.text);
    expect(listAfter.etag).toBe(listBefore.etag);
    expect(recAfter.text).toBe(recBefore.text);
    expect(recAfter.etag).toBe(recBefore.etag);
    expect((await record("alpha")).status).toBe(200);

    // The publish act refreshes it: same public id, new slug, new pin.
    await publish("Alpha");
    const republished = await record(pub.Alpha!);
    expect(republished.json).toMatchObject({
      publicId: recBefore.json.publicId,
      slug: "alpha-revised",
      title: "Alpha Revised",
      properties: { year: 2030, venue: "Y" },
      body: { content: "Alpha body v2" },
    });
    expect(republished.etag).not.toBe(recBefore.etag);
    expect((await record("alpha")).text).toBe(MISS);
    expect((await record("alpha-revised")).status).toBe(200);
    expect((await list("?sort=title&limit=10")).etag).not.toBe(listBefore.etag);
  });
});

describe("T2: narrowing is live", () => {
  it("an UNPUBLISHED member 404s and leaves the list; publishing again restores the same URL", async () => {
    await owner.unpublishFromSite({ siteId, entityIds: [rec.Beta!.id] });
    expect((await record(pub.Beta!)).text).toBe(MISS);
    expect((await record("beta")).text).toBe(MISS);
    const l = await list("?limit=10");
    expect(l.json.total).toBe(3);
    expect(titles(l)).not.toContain("Beta");

    await publish("Beta");
    expect((await record(pub.Beta!)).status).toBe(200);
    expect((await list()).json.total).toBe(4);
  });

  it("a record taken OUT OF THE PROJECT 404s at once", async () => {
    await world.unfile(rec.Delta!.id, P);
    try {
      expect((await record(pub.Delta!)).text).toBe(MISS);
      expect((await list("?limit=10")).json.total).toBe(3);
    } finally {
      await world.fileInto(rec.Delta!.id, P, A);
    }
  });

  it("a DELETED record 404s at once", async () => {
    await world.q(`update entities set deleted_at = now() where id = $1`, [
      rec.Delta!.id,
    ]);
    try {
      expect((await record(pub.Delta!)).text).toBe(MISS);
      expect(titles(await list("?limit=10"))).not.toContain("Delta");
    } finally {
      await world.q(`update entities set deleted_at = null where id = $1`, [
        rec.Delta!.id,
      ]);
    }
  });

  it("a member whose OWN space closed its public doors is silently left out (404, not 403); the home switch answers 403", async () => {
    await owner.setPublicDoors({ workspaceId: W2, enabled: false });
    try {
      const r = await record(pub.Gamma!);
      expect(r.status).toBe(404);
      expect(r.text).toBe(MISS);
      const l = await list("?limit=10");
      expect(l.json.total).toBe(3);
      expect(titles(l)).not.toContain("Gamma");
    } finally {
      await owner.setPublicDoors({ workspaceId: W2, enabled: null });
    }
    expect((await record(pub.Gamma!)).status).toBe(200);

    await owner.setPublicDoors({ workspaceId: W, enabled: false });
    try {
      for (const r of [await list(), await record(pub.Alpha!)]) {
        expect(r.status).toBe(403);
        expect(r.json.code).toBe("public_doors_disabled");
      }
    } finally {
      await owner.setPublicDoors({ workspaceId: W, enabled: null });
    }
  });

  it("the SITE back to draft → every door 404s; live again → the same token and record URLs", async () => {
    const before = await record(pub.Alpha!);
    await owner.unpublishSite({ siteId });
    for (const r of [
      await get(`/public/sites/${token}`),
      await list(),
      await record(pub.Alpha!),
      await record("alpha-revised"),
    ]) {
      expect(r.status).toBe(404);
      expect(r.text).toBe(MISS);
      expect(r.cache).toBe("no-cache");
    }
    await owner.publishSite({ siteId });
    const after = await record(pub.Alpha!);
    expect(after.status).toBe(200);
    expect(after.json.publicId).toBe(before.json.publicId);
    expect(after.json.properties).toEqual(before.json.properties);
  });
});
