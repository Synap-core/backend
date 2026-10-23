/**
 * T4 — CROSS-SITE LEAKAGE (collection door C1b), on PGlite.
 *
 * Two live sites of the same owner and home space, A and B (two projects).
 * A record filed into both projects is a member of each site through its OWN
 * member row (its own public id). Published through the REAL owner doors;
 * read back through the REAL routes.
 *
 * Pinned:
 *   - every query is keyed on the site: B's list never holds A's members and
 *     B's counts are B's own; A's member — by public id or by slug — is the
 *     uniform 404 through B's token, even in the same collection;
 *   - a record in both sites has a DIFFERENT public id per site, and A's id
 *     never resolves through B;
 *   - per-site stops stay per site: unpublishing from A or revoking A leaves
 *     B serving; the record-level stop ("off the web", `shares.unpublish`)
 *     takes it off EVERY site at once.
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
import { createSiteSchema, sitePolicy, siteWorld } from "./site-fixture.js";

const A = randomUUID();
const W = randomUUID();
const PA = randomUUID();
const PB = randomUUID();
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
  return { status: res.status, text, json: JSON.parse(text) as any };
}
const MISS = JSON.stringify({ error: "Not found" });

const CONFIG = {
  version: 1,
  collections: { paper: { slugField: "title" } },
};

let world: ReturnType<typeof siteWorld>;
const site: Record<"A" | "B", { id: string; token: string }> = {
  A: { id: "", token: "" },
  B: { id: "", token: "" },
};
const rec: Record<string, string> = {};
/** Public ids by `${site}:${record}`. */
const pid: Record<string, string> = {};

const listOf = (s: "A" | "B") =>
  get(`/public/sites/${site[s].token}/collections/paper?limit=100`);
const recordOf = (s: "A" | "B", address: string) =>
  get(`/public/sites/${site[s].token}/collections/paper/${address}`);
const titlesOf = async (s: "A" | "B") =>
  ((await listOf(s)).json.items as Array<{ title: string }>)
    .map((i) => i.title)
    .sort();

async function publishInto(s: "A" | "B", name: string) {
  const res = await owner.publishToSite({
    siteId: site[s].id,
    entityIds: [rec[name]!],
  });
  if (res.status !== "published") throw new Error("unreachable");
  pid[`${s}:${name}`] = res.published[0]!.publicId;
}

beforeAll(async () => {
  await createSiteSchema(h.client!);
  world = siteWorld(h.client!);
  await world.user(A);
  await world.workspace(W, A);
  await world.project(PA, A, W, "Lab A");
  await world.project(PB, A, W, "Lab B");
  const paper = await world.profile("paper");
  await owner.setPolicy({ workspaceId: W, policy: sitePolicy() });
  for (const [s, p] of [
    ["A", PA],
    ["B", PB],
  ] as const) {
    const c = await owner.configureSite({ projectId: p, config: CONFIG });
    if (c.status === "proposed") throw new Error("unreachable");
    site[s] = {
      id: c.siteId,
      token: (await owner.publishSite({ siteId: c.siteId })).token!,
    };
  }
  for (const [name, projects] of [
    ["onlyA", [PA]],
    ["onlyB", [PB]],
    ["both", [PA, PB]],
  ] as const) {
    const r = await world.record({
      ownerId: A,
      workspaceId: W,
      profileId: paper,
      title: name,
      properties: { year: 2024 },
    });
    rec[name] = r.id;
    for (const p of projects) await world.fileInto(r.id, p, A);
  }
  await publishInto("A", "onlyA");
  await publishInto("B", "onlyB");
  await publishInto("A", "both");
  await publishInto("B", "both");
}, 120_000);

describe("T4: a site serves its own members only", () => {
  it("each list and each manifest count holds its own site's members", async () => {
    expect(await titlesOf("A")).toEqual(["both", "onlyA"]);
    expect(await titlesOf("B")).toEqual(["both", "onlyB"]);
    for (const s of ["A", "B"] as const) {
      const m = await get(`/public/sites/${site[s].token}`);
      expect(m.json.collections).toEqual([
        expect.objectContaining({ key: "paper", count: 2 }),
      ]);
    }
  });

  it("A's member through B's token is the uniform 404 — by public id and by slug", async () => {
    expect((await recordOf("A", pid["A:onlyA"]!)).status).toBe(200);
    expect((await recordOf("B", pid["A:onlyA"]!)).text).toBe(MISS);
    expect((await recordOf("B", "onlya")).text).toBe(MISS);
    expect((await recordOf("A", pid["B:onlyB"]!)).text).toBe(MISS);
  });

  it("a record in both sites has one public id PER site; neither resolves through the other", async () => {
    expect(pid["A:both"]).not.toBe(pid["B:both"]);
    expect((await recordOf("A", pid["A:both"]!)).status).toBe(200);
    expect((await recordOf("B", pid["B:both"]!)).status).toBe(200);
    expect((await recordOf("B", pid["A:both"]!)).text).toBe(MISS);
    expect((await recordOf("A", pid["B:both"]!)).text).toBe(MISS);
    // The same slug is fine in both: each site resolves its own row.
    expect((await recordOf("A", "both")).json.publicId).toBe(pid["A:both"]);
    expect((await recordOf("B", "both")).json.publicId).toBe(pid["B:both"]);
  });
});

describe("T4: stops stay where they were asked", () => {
  it("unpublishing from A leaves B serving; publishing into A again restores A", async () => {
    await owner.unpublishFromSite({
      siteId: site.A.id,
      entityIds: [rec.both!],
    });
    expect((await recordOf("A", pid["A:both"]!)).text).toBe(MISS);
    expect((await recordOf("B", pid["B:both"]!)).status).toBe(200);
    await publishInto("A", "both");
    expect((await recordOf("A", pid["A:both"]!)).status).toBe(200);
  });

  it("the record-level stop (`shares.unpublish`) takes it off EVERY site", async () => {
    await owner.unpublish({ resourceType: "entity", resourceId: rec.both! });
    expect((await recordOf("A", pid["A:both"]!)).text).toBe(MISS);
    expect((await recordOf("B", pid["B:both"]!)).text).toBe(MISS);
    await publishInto("A", "both");
    await publishInto("B", "both");
  });

  it("revoking site A revokes A's members only; B keeps serving the shared record", async () => {
    await owner.revokeSite({ siteId: site.A.id });
    expect((await recordOf("A", pid["A:both"]!)).text).toBe(MISS);
    expect((await get(`/public/sites/${site.A.token}`)).text).toBe(MISS);
    expect((await recordOf("B", pid["B:both"]!)).status).toBe(200);
    const revokedB = await world.q(
      `select count(*)::int as n from resource_shares where site_share_id = $1 and revoked_at is not null`,
      [site.B.id]
    );
    expect(revokedB.rows[0]).toEqual({ n: 0 });
  });
});
