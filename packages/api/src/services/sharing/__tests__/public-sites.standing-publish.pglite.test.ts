/**
 * PUBLISHING IS A STANDING ACT (collection door C1b, founder decision
 * 2026-10-20: by design), on PGlite.
 *
 * The live checks only HIDE a member; they never take its publication back.
 * A record filed back into the site's project, or a space whose public doors
 * open again, is served again at once: the same public id, the same slug, the
 * same snapshot (same ETag), with no new publish act, because the member row
 * was never touched. Taking a record off a site for good is an explicit
 * unpublish or revoke.
 *
 * Records are published through the REAL owner doors (tRPC
 * `shares.publishToSite`, `setPublicDoors`, `siteStatus`), the REAL site core
 * and the REAL 0276 + 0336 migrations; read back through the REAL routes
 * `GET /public/sites/:token/collections/:key[/:slugOrPublicId]`.
 *
 * Pinned, for each narrowing (out of the project; the member's own space
 * closed; the home space closed):
 *   - while narrowed: hidden — a member outside the project or in a closed
 *     space is the UNIFORM 404 (byte-identical to a public id that never
 *     existed) by public id and by slug, and absent from the list and its
 *     total; the home space closed is the site-wide 403 `public_doors_disabled`;
 *     the owner status marks it not live;
 *   - narrowing undone: served again with the same public id, slug,
 *     properties and ETag; the member row (id, published_at, public id, slug,
 *     snapshot) is unchanged.
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
import { mintPublicId } from "../site-service.js";
import { createSiteSchema, sitePolicy, siteWorld } from "./site-fixture.js";

const A = randomUUID();
const W = randomUUID(); // home space
const W2 = randomUUID(); // another space of A's: its record joins the site
const P = randomUUID();
const owner = sharesRouter.createCaller({
  authenticated: true,
  userId: A,
  workspaceId: null,
} as never);

const app = new OpenAPIHono();
registerPublicSitesRoutes(app as never);
async function get(url: string) {
  const res = await app.request(url);
  const text = await res.text();
  return {
    status: res.status,
    text,
    json: text ? (JSON.parse(text) as any) : null,
    etag: res.headers.get("etag"),
    cache: res.headers.get("cache-control"),
  };
}

let world: ReturnType<typeof siteWorld>;
let siteId = "";
let token = "";
const rec: Record<string, string> = {};
const pub: Record<string, { publicId: string; slug: string }> = {};

const list = () => get(`/public/sites/${token}/collections/paper?limit=100`);
const record = (idOrSlug: string) =>
  get(`/public/sites/${token}/collections/paper/${idOrSlug}`);
const listed = async () =>
  ((await list()).json.items as Array<{ publicId: string }>).map(
    (i) => i.publicId
  );

/** The member row, every column a publish act would write. */
async function memberRow(entityId: string) {
  const { rows } = await world.q(
    `select id, state, published_at, public_id, public_slug, published_properties,
            published_document_version_id, updated_at
       from resource_shares
      where site_share_id = $1 and resource_id = $2 and revoked_at is null`,
    [siteId, entityId]
  );
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function ownerLive(entityId: string): Promise<boolean> {
  const st = await owner.siteStatus({ siteId });
  return st!.members.find((m) => m.entityId === entityId)!.live;
}

/** A served record: everything a visitor can see of it, plus its row. */
async function served(name: string) {
  const byId = await record(pub[name]!.publicId);
  const bySlug = await record(pub[name]!.slug);
  expect(byId.status).toBe(200);
  expect(bySlug.status).toBe(200);
  expect(bySlug.json).toEqual(byId.json);
  expect(await listed()).toContain(pub[name]!.publicId);
  expect(await ownerLive(rec[name]!)).toBe(true);
  return {
    publicId: byId.json.publicId,
    slug: byId.json.slug,
    properties: byId.json.properties,
    etag: byId.etag,
    row: await memberRow(rec[name]!),
  };
}

/** The uniform miss: byte-identical to a public id that never existed. */
async function hiddenAsNeverExisted(name: string) {
  const never = await record(mintPublicId());
  expect(never.status).toBe(404);
  for (const r of [
    await record(pub[name]!.publicId),
    await record(pub[name]!.slug),
  ]) {
    expect(r.status).toBe(never.status);
    expect(r.text).toBe(never.text);
    expect(r.cache).toBe(never.cache);
  }
  const l = await list();
  expect(l.status).toBe(200);
  expect(l.json.items.map((i: any) => i.publicId)).not.toContain(
    pub[name]!.publicId
  );
  expect(l.json.total).toBe(1);
  expect(await ownerLive(rec[name]!)).toBe(false);
}

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
  const c = await owner.configureSite({
    projectId: P,
    config: {
      version: 1,
      collections: { paper: { sort: [], pageSize: 20, slugField: "title" } },
    },
  });
  if (c.status === "proposed") throw new Error("unreachable");
  siteId = c.siteId;
  token = (await owner.publishSite({ siteId })).token!;

  for (const [name, ws] of [
    ["Alpha", W],
    ["Gamma", W2],
  ] as const) {
    const r = await world.record({
      ownerId: A,
      workspaceId: ws,
      profileId: paper,
      title: name,
      properties: { year: 2020 },
      body: `${name} body`,
    });
    rec[name] = r.id;
    await world.fileInto(r.id, P, A);
  }
  const res = await owner.publishToSite({
    siteId,
    entityIds: [rec.Alpha!, rec.Gamma!],
  });
  if (res.status === "proposed") throw new Error("unreachable");
  expect(res.skipped).toEqual([]);
  for (const p of res.published) {
    const name = p.entityId === rec.Alpha ? "Alpha" : "Gamma";
    pub[name] = { publicId: p.publicId, slug: name.toLowerCase() };
  }
}, 120_000);

describe("publishing is a standing act: the live checks only hide", () => {
  it("a record moved OUT of the project is hidden; filed BACK, it is served again at the same address", async () => {
    const before = await served("Alpha");

    await world.unfile(rec.Alpha!, P);
    await hiddenAsNeverExisted("Alpha");
    // Hiding is not unpublishing: the member row did not move.
    expect(await memberRow(rec.Alpha!)).toEqual(before.row);

    await world.fileInto(rec.Alpha!, P, A);
    const after = await served("Alpha");
    expect(after).toEqual(before);
  });

  it("a member whose OWN space closes is hidden; the space reopened, it is served again at the same address", async () => {
    const before = await served("Gamma");

    await owner.setPublicDoors({ workspaceId: W2, enabled: false });
    try {
      await hiddenAsNeverExisted("Gamma");
      expect(await memberRow(rec.Gamma!)).toEqual(before.row);
    } finally {
      await owner.setPublicDoors({ workspaceId: W2, enabled: null });
    }

    const after = await served("Gamma");
    expect(after).toEqual(before);
  });

  it("the HOME space closed answers 403 site-wide; reopened, every member is served again at the same address", async () => {
    const before = {
      Alpha: await served("Alpha"),
      Gamma: await served("Gamma"),
    };

    await owner.setPublicDoors({ workspaceId: W, enabled: false });
    try {
      for (const r of [
        await list(),
        await record(pub.Alpha!.publicId),
        await record(pub.Gamma!.slug),
      ]) {
        expect(r.status).toBe(403);
        expect(r.json.code).toBe("public_doors_disabled");
      }
      expect(await memberRow(rec.Alpha!)).toEqual(before.Alpha.row);
      expect(await memberRow(rec.Gamma!)).toEqual(before.Gamma.row);
    } finally {
      await owner.setPublicDoors({ workspaceId: W, enabled: null });
    }

    expect(await served("Alpha")).toEqual(before.Alpha);
    expect(await served("Gamma")).toEqual(before.Gamma);
  });
});
