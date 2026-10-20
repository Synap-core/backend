/**
 * T11 — SLUG COLLISION / SQUATTING, and the public addresses of a member
 * (collection door C1b), on PGlite.
 *
 * Records are published into a site through the REAL owner doors (tRPC
 * `shares.publishToSite` / `unpublishFromSite`), the REAL site core and the
 * REAL 0336 partial unique index `resource_shares_site_slug_uidx`.
 *
 * Pinned:
 *   - a slug is unique per (site, collection) among LIVE PUBLISHED members: a
 *     one-record publish onto a taken slug is the owner-side 409
 *     `SITE_SLUG_TAKEN` naming the holder (id + title); a batch reports it per
 *     record and publishes the rest; two records of ONE batch → the first wins;
 *   - an UNPUBLISHED holder frees the slug; republishing the old holder onto
 *     the now-taken slug is a 409;
 *   - a slug lost to a racing publish (the plan was clean, the index says no)
 *     is reported as `SITE_SLUG_TAKEN`, never a 500 and never a half write;
 *   - the slug is the normalized slug field (NFKD, no diacritics, `-`-joined,
 *     ≤ 96), NULL when empty; the public id is `p_` + 16 base62, random, and
 *     KEPT across unpublish → republish (same URL), while the slug follows the
 *     field's value at the last publish;
 *   - the same title in ANOTHER collection or ANOTHER site is not a collision.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | import("./site-fixture.js").PgClient,
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

import { sharesRouter } from "../../../routers/shares.js";
import { slugify, PUBLIC_ID_RE } from "../site-config.js";
import {
  applySitePublish,
  mintPublicId,
  planSitePublish,
} from "../site-service.js";
import {
  createSiteSchema,
  errOf,
  sitePolicy,
  siteWorld,
} from "./site-fixture.js";

const A = randomUUID();
const W = randomUUID();
const P = randomUUID();
const P2 = randomUUID();
const owner = sharesRouter.createCaller({
  authenticated: true,
  userId: A,
  workspaceId: null,
} as never);

let world: ReturnType<typeof siteWorld>;
let site = "";
let site2 = "";
let paper = "";
let talk = "";

const CONFIG = {
  version: 1,
  collections: {
    paper: { slugField: "title" },
    talk: { slugField: "title" },
  },
};

async function makeSite(projectId: string) {
  const c = await owner.configureSite({ projectId, config: CONFIG });
  if (c.status === "proposed") throw new Error("unreachable");
  await owner.publishSite({ siteId: c.siteId });
  return c.siteId;
}

/** A paper filed into P (and P2 when asked). */
async function paperRecord(title: string, profileId = paper, also?: string) {
  const r = await world.record({
    ownerId: A,
    workspaceId: W,
    profileId,
    title,
    properties: { year: 2024 },
  });
  await world.fileInto(r.id, P, A);
  if (also) await world.fileInto(r.id, also, A);
  return r.id;
}

async function memberOf(siteId: string, entityId: string) {
  const rows = await world.members(siteId);
  return rows.filter((r) => r.resource_id === entityId);
}

beforeAll(async () => {
  await createSiteSchema(h.client!);
  world = siteWorld(h.client!);
  await world.user(A);
  await world.workspace(W, A);
  await world.project(P, A, W, "Lab");
  await world.project(P2, A, W, "Other lab");
  paper = await world.profile("paper");
  talk = await world.profile("talk");
  await owner.setPolicy({ workspaceId: W, policy: sitePolicy() });
  site = await makeSite(P);
  site2 = await makeSite(P2);
}, 120_000);

describe("slugify + public ids (pure)", () => {
  it.each([
    ["Deep Learning", "deep-learning"],
    ["  Ünïcode — Café!! ", "unicode-cafe"],
    ["a_b c", "a-b-c"],
    ["!!!", null],
    ["", null],
    [2024, "2024"],
    [true, null],
    ["x".repeat(120), "x".repeat(96)],
    [`${"ab-".repeat(40)}`, `${"ab-".repeat(32)}`.replace(/-$/, "")],
  ] as Array<[unknown, string | null]>)("slugify(%j) → %j", (input, out) => {
    expect(slugify(input)).toBe(out);
  });

  it("a slug can never look like a public id; public ids are p_ + 16 base62, random", () => {
    const ids = new Set(Array.from({ length: 500 }, () => mintPublicId()));
    expect(ids.size).toBe(500);
    for (const id of ids) {
      expect(id).toMatch(PUBLIC_ID_RE);
      expect(slugify(id)).not.toMatch(PUBLIC_ID_RE);
    }
  });
});

describe("T11: a slug is unique per site collection among live members", () => {
  let holder = "";
  let squatter = "";

  it("the first record takes the slug; its public id is random and stable", async () => {
    holder = await paperRecord("Deep Learning");
    const res = await owner.publishToSite({
      siteId: site,
      entityIds: [holder],
    });
    expect(res).toMatchObject({
      status: "published",
      skipped: [],
      published: [
        { entityId: holder, collection: "paper", slug: "deep-learning" },
      ],
    });
    const [row] = await memberOf(site, holder);
    expect(row).toMatchObject({
      state: "published",
      public_slug: "deep-learning",
      published_collection: "paper",
      token_hash: null,
    });
    expect(row!.public_id).toMatch(PUBLIC_ID_RE);
  });

  it("a ONE-record publish onto the taken slug → 409 SITE_SLUG_TAKEN naming the holder; nothing written", async () => {
    squatter = await paperRecord("Deep  learning!");
    const e = await errOf(
      owner.publishToSite({ siteId: site, entityIds: [squatter] })
    );
    expect(e?.code).toBe("CONFLICT");
    expect(e?.message).toMatch(/^SITE_SLUG_TAKEN/);
    expect(e?.message).toContain(holder);
    expect(e?.message).toContain("Deep Learning");
    expect(await memberOf(site, squatter)).toHaveLength(0);
  });

  it("in a BATCH it is reported per record and the rest lands", async () => {
    const other = await paperRecord("Graph Neural Nets");
    const res = await owner.publishToSite({
      siteId: site,
      entityIds: [squatter, other],
    });
    if (res.status === "proposed") throw new Error("unreachable");
    expect(res.status).toBe("published");
    expect(res.published.map((p) => p.entityId)).toEqual([other]);
    expect(res.skipped).toEqual([
      expect.objectContaining({ entityId: squatter, code: "SITE_SLUG_TAKEN" }),
    ]);
    expect(await memberOf(site, squatter)).toHaveLength(0);
  });

  it("two records of ONE batch deriving the same slug: the first keeps it", async () => {
    const first = await paperRecord("Same Title");
    const second = await paperRecord("same title");
    const res = await owner.publishToSite({
      siteId: site,
      entityIds: [first, second],
    });
    if (res.status === "proposed") throw new Error("unreachable");
    expect(res.published.map((p) => p.entityId)).toEqual([first]);
    expect(res.skipped).toEqual([
      expect.objectContaining({ entityId: second, code: "SITE_SLUG_TAKEN" }),
    ]);
  });

  it("the same title in ANOTHER collection or ANOTHER site is not a collision", async () => {
    const asTalk = await paperRecord("Deep Learning", talk);
    const res = await owner.publishToSite({
      siteId: site,
      entityIds: [asTalk],
    });
    if (res.status === "proposed") throw new Error("unreachable");
    expect(res.published[0]).toMatchObject({
      collection: "talk",
      slug: "deep-learning",
    });
    const elsewhere = await paperRecord("Deep Learning", paper, P2);
    const res2 = await owner.publishToSite({
      siteId: site2,
      entityIds: [elsewhere],
    });
    if (res2.status === "proposed") throw new Error("unreachable");
    expect(res2.published[0]).toMatchObject({ slug: "deep-learning" });
  });

  it("an UNPUBLISHED holder frees the slug; republishing the old holder onto it → 409, its URL kept", async () => {
    const [before] = await memberOf(site, holder);
    expect(
      await owner.unpublishFromSite({ siteId: site, entityIds: [holder] })
    ).toEqual({ status: "unpublished", siteId: site, entityIds: [holder] });
    const res = await owner.publishToSite({
      siteId: site,
      entityIds: [squatter],
    });
    if (res.status === "proposed") throw new Error("unreachable");
    expect(res.published[0]).toMatchObject({
      entityId: squatter,
      slug: "deep-learning",
    });
    const e = await errOf(
      owner.publishToSite({ siteId: site, entityIds: [holder] })
    );
    expect(e?.code).toBe("CONFLICT");
    expect(e?.message).toMatch(/^SITE_SLUG_TAKEN/);
    expect(e?.message).toContain(squatter);
    const [after] = await memberOf(site, holder);
    expect(after).toMatchObject({ id: before!.id, state: "draft" });
    expect(after!.public_id).toBe(before!.public_id);
  });

  it("republish keeps the public id and re-derives the slug from the field's value now", async () => {
    await world.q(
      `update entities set title = 'Deep Learning II' where id = $1`,
      [holder]
    );
    const [before] = await memberOf(site, holder);
    const res = await owner.publishToSite({
      siteId: site,
      entityIds: [holder],
    });
    if (res.status === "proposed") throw new Error("unreachable");
    expect(res.published[0]).toMatchObject({
      slug: "deep-learning-ii",
      publicId: before!.public_id,
    });
    const rows = await memberOf(site, holder);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      state: "published",
      public_slug: "deep-learning-ii",
      public_id: before!.public_id,
    });
  });

  it("a record without a usable slug value is addressed by its public id only", async () => {
    const bare = await paperRecord("!!!");
    const res = await owner.publishToSite({
      siteId: site,
      entityIds: [bare],
    });
    if (res.status === "proposed") throw new Error("unreachable");
    expect(res.published[0]).toMatchObject({ slug: null });
    expect((await memberOf(site, bare))[0]!.public_slug).toBeNull();
  });

  it("a slug lost to a RACING publish (the index refuses it) is reported, not thrown, and nothing is half-written", async () => {
    const racer = await paperRecord("Race Condition");
    const db = h.db as never;
    const plan = await planSitePublish(db, A, {
      siteId: site,
      entityIds: [racer],
    });
    expect(plan.members[0]!.slug).toBe("race-condition");
    // Another publish takes the slug between plan and write.
    await world.q(
      `insert into resource_shares (resource_type, resource_id, workspace_id, audience, state, created_by, published_at, published_properties, site_share_id, published_collection, public_id, public_slug)
       values ('entity', $1, $2, 'public', 'published', $3, now(), '{}'::jsonb, $4, 'paper', $5, 'race-condition')`,
      [randomUUID(), W, A, site, mintPublicId()]
    );
    const applied = await applySitePublish(db, plan, { userId: A });
    expect(applied.published).toEqual([]);
    expect(applied.rowsWritten).toBe(0);
    expect(applied.skipped).toEqual([
      expect.objectContaining({ entityId: racer, code: "SITE_SLUG_TAKEN" }),
    ]);
    expect(await memberOf(site, racer)).toHaveLength(0);
  });
});

describe("owner status lists the site's members (ids are fine on the owner door)", () => {
  it("each non-revoked member with its public address, live flag and stale mark", async () => {
    const fresh = await paperRecord("Status Paper");
    await owner.publishToSite({ siteId: site, entityIds: [fresh] });
    const drafted = await paperRecord("Status Draft");
    await owner.publishToSite({ siteId: site, entityIds: [drafted] });
    await owner.unpublishFromSite({ siteId: site, entityIds: [drafted] });
    // Edited after its snapshot: stale until published again.
    await world.q(
      `update entities set updated_at = now() + interval '1 hour' where id = $1`,
      [fresh]
    );

    const status = await owner.siteStatus({ siteId: site });
    expect(status?.membersTruncated).toBe(false);
    const byId = new Map(status!.members.map((m) => [m.entityId, m]));
    expect(byId.get(fresh)).toMatchObject({
      title: "Status Paper",
      collection: "paper",
      slug: "status-paper",
      state: "published",
      live: true,
      stale: true,
    });
    expect(byId.get(fresh)!.publicId).toMatch(PUBLIC_ID_RE);
    expect(byId.get(drafted)).toMatchObject({
      state: "draft",
      live: false,
      stale: false,
    });
    // Live members here and the manifest's count are the same rule.
    const live = status!.members.filter(
      (m) => m.live && m.collection === "paper"
    ).length;
    expect(status!.collections.find((c) => c.key === "paper")!.count).toBe(
      live
    );

    // Out of the project → not live, at once (narrowing is live).
    await world.unfile(fresh, P);
    const after = await owner.siteStatus({ siteId: site });
    expect(after!.members.find((m) => m.entityId === fresh)!.live).toBe(false);
    await world.fileInto(fresh, P, A);
  });
});
