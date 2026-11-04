/**
 * THE OWNER'S READS for pod-admin's Sites page — `shares.listSites` (every
 * site the caller administers) and the CHARTS in `shares.siteStatus` — on
 * PGlite, through the REAL owner doors, the REAL site core and the REAL
 * 0276 + 0336 + 0397 migrations.
 *
 * Pinned:
 *   - listSites shows the sites of the projects the caller ADMINISTERS (the
 *     project's owner, or an owner/admin of its home space): never another
 *     person's site, never to a mere editor of the home space;
 *   - each row's state, liveness and counts: records (non-revoked member rows,
 *     the site page's own total), records changed since published (published
 *     ones only), charts;
 *   - a revoked site disappears from the list;
 *   - the home space's public-pages switch and site policy are owner-only
 *     reads: the owner gets them, an admin who is not the owner gets null
 *     ("can't check"), never a guess;
 *   - siteStatus lists the site's charts (not as records), each with its mode,
 *     public address and liveness; a chart taken off stays listed as draft.
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
// The owners are signed-in humans: the production gate grants a non-agent.
vi.mock("../../../utils/permission-check.js", () => ({
  checkPermissionOrPropose: vi.fn(async () => ({ granted: true })),
  previewPermissionDecision: vi.fn(),
  proposedMessageFor: vi.fn(() => "proposed"),
}));
vi.mock("../../../utils/audit-log.js", () => ({ auditLog: vi.fn() }));
vi.mock("../../../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));
// Only snapshot charts with inline data here: the live read is never called.
vi.mock("../../document-charts/freeze-charts-verb.js", () => ({
  LIVE_CHART_ENTITIES_LIMIT: 500,
  liveChartReader: () => async () => {
    throw new Error("no live read in this test");
  },
}));

import { sharesRouter } from "../../../routers/shares.js";
import { createSiteSchema, sitePolicy, siteWorld } from "./site-fixture.js";

const A = randomUUID(); // owns W and P1..P3
const B = randomUUID(); // another person, owns WB and PB
const C = randomUUID(); // admin (not owner) of W
const E = randomUUID(); // editor of W
const W = randomUUID();
const WB = randomUUID();
const P1 = randomUUID(); // live site: records, a chart
const P2 = randomUUID(); // configured, never put live
const P3 = randomUUID(); // revoked
const P4 = randomUUID(); // put live, then taken off the web
const PB = randomUUID(); // B's live site
const P5 = randomUUID(); // A's project with no site

const as = (userId: string) =>
  sharesRouter.createCaller({
    authenticated: true,
    userId,
    workspaceId: null,
  } as never);
const owner = as(A);

type Summary = {
  projectId: string;
  projectName: string;
  siteId: string;
  state: string;
  live: boolean;
  hasToken: boolean;
  tokenPrefix: string | null;
  publishedAt: Date | null;
  homeWorkspaceId: string;
  recordsTotal: number;
  staleCount: number;
  chartsTotal: number;
  publicDoorsOpen: boolean | null;
  policyAllowsSites: boolean | null;
};
type Listed = { sites: Summary[]; truncated: boolean };
type Chart = {
  cellInstanceId: string;
  title: string | null;
  cellKey: string | null;
  mode: string | null;
  publicId: string | null;
  slug: string | null;
  state: string;
  live: boolean;
  publishedAt: Date | null;
  capturedAt: string | null;
};

const list = async (userId: string) =>
  (await (as(userId) as any).listSites()) as Listed;
const byProject = (l: Listed) =>
  new Map(l.sites.map((s) => [s.projectId, s] as const));

let world: ReturnType<typeof siteWorld>;
const site: Record<string, string> = {};
const rec: Record<string, string> = {};
let chartId = "";

const CONFIG = {
  version: 1,
  collections: { paper: { sort: ["title"], slugField: "title" } },
};

async function configure(projectId: string, by = owner) {
  const c = await by.configureSite({ projectId, config: CONFIG });
  if (c.status === "proposed") throw new Error("unreachable");
  return c.siteId;
}

beforeAll(async () => {
  delete process.env.SYNAP_SHARED_CLIENT_IP;
  await createSiteSchema(h.client!);
  world = siteWorld(h.client!);
  for (const u of [A, B, C, E]) await world.user(u);
  await world.workspace(W, A, [
    [C, "admin"],
    [E, "editor"],
  ]);
  await world.workspace(WB, B);
  await world.project(P1, A, W, "Politique 2027");
  await world.project(P2, A, W, "Atelier blog");
  await world.project(P3, A, W, "Old site");
  await world.project(P4, A, W, "Club newsletter");
  await world.project(P5, A, W, "No site");
  await world.project(PB, B, WB, "B's site");
  await owner.setPolicy({
    workspaceId: W,
    policy: sitePolicy({ viewRead: "direct" }),
  });
  await as(B).setPolicy({ workspaceId: WB, policy: sitePolicy() });
  const paper = await world.profile("paper");

  // P1: live, three records (one later taken off), one record changed since.
  site.p1 = await configure(P1);
  await owner.publishSite({ siteId: site.p1 });
  for (const t of ["Alpha", "Beta", "Gamma"]) {
    const r = await world.record({
      ownerId: A,
      workspaceId: W,
      profileId: paper,
      title: t,
    });
    await world.fileInto(r.id, P1, A);
    rec[t] = r.id;
  }
  const pub = await owner.publishToSite({
    siteId: site.p1,
    entityIds: Object.values(rec),
  });
  if (pub.status === "proposed") throw new Error("unreachable");
  await owner.unpublishFromSite({ siteId: site.p1, entityIds: [rec.Gamma!] });
  // Beta and Gamma change after their snapshot; Gamma is off the site.
  await world.q(
    `update entities set updated_at = now() + interval '1 hour' where id = any($1::uuid[])`,
    [[rec.Beta, rec.Gamma]]
  );
  // One chart (a custom cell with inline data: a snapshot).
  chartId = randomUUID();
  await world.q(
    `insert into cell_instances (id, workspace_id, user_id, cell_type, config, name, is_template, created_by_kind, trust_level) values ($1,$2,$3,'sillage-histogram',$4::jsonb,'Turnout by district',false,'user','trusted')`,
    [
      chartId,
      W,
      A,
      JSON.stringify({
        series: [{ key: "n", label: "Votes" }],
        data: [{ label: "North", values: { n: 4 } }],
        capturedAt: "2026-11-02",
      }),
    ]
  );
  const ch = await owner.publishChartsToSite({
    siteId: site.p1,
    charts: [{ cellInstanceId: chartId, mode: "snapshot" }],
  });
  if (ch.status === "proposed") throw new Error("unreachable");
  expect(ch.published).toHaveLength(1);

  // P2: configured only. P3: revoked. P4: live, then off the web.
  site.p2 = await configure(P2);
  site.p3 = await configure(P3);
  await owner.publishSite({ siteId: site.p3 });
  await owner.revokeSite({ siteId: site.p3 });
  site.p4 = await configure(P4);
  await owner.publishSite({ siteId: site.p4 });
  await owner.unpublishSite({ siteId: site.p4 });

  // B's own live site.
  site.pb = await configure(PB, as(B));
  await as(B).publishSite({ siteId: site.pb });
}, 120_000);

describe("shares.listSites", () => {
  it("lists exactly the caller's sites, with each one's state and counts", async () => {
    const l = await list(A);
    expect(l.truncated).toBe(false);
    const sites = byProject(l);
    // P3 was revoked, P5 has no site, PB is B's.
    expect([...sites.keys()].sort()).toEqual([P1, P2, P4].sort());

    expect(sites.get(P1)).toEqual({
      projectId: P1,
      projectName: "Politique 2027",
      siteId: site.p1,
      state: "published",
      live: true,
      hasToken: true,
      tokenPrefix: expect.any(String),
      publishedAt: expect.any(Date),
      homeWorkspaceId: W,
      // Every non-revoked record row, the one taken off included (the site
      // page's own total); only a PUBLISHED changed record needs the person.
      recordsTotal: 3,
      staleCount: 1,
      chartsTotal: 1,
      publicDoorsOpen: true,
      policyAllowsSites: true,
    });
    expect(sites.get(P2)).toMatchObject({
      siteId: site.p2,
      state: "draft",
      live: false,
      hasToken: false,
      tokenPrefix: null,
      recordsTotal: 0,
      staleCount: 0,
      chartsTotal: 0,
    });
    // Off the web: back to draft, its token kept for the same link.
    expect(sites.get(P4)).toMatchObject({
      siteId: site.p4,
      state: "draft",
      live: false,
      hasToken: true,
    });
  });

  it("another person's site never shows, and theirs shows only their own", async () => {
    const mine = await list(A);
    expect(mine.sites.map((s) => s.siteId)).not.toContain(site.pb);
    const theirs = await list(B);
    expect(theirs.sites.map((s) => s.siteId)).toEqual([site.pb]);
  });

  it("a home-space admin who is not its owner sees the sites, but cannot check the switch or the policy", async () => {
    const sites = byProject(await list(C));
    expect([...sites.keys()].sort()).toEqual([P1, P2, P4].sort());
    expect(sites.get(P1)).toMatchObject({
      live: true,
      publicDoorsOpen: null,
      policyAllowsSites: null,
    });
  });

  it("a mere editor of the home space administers no site: nothing listed", async () => {
    expect((await list(E)).sites).toEqual([]);
  });

  it("a revoked site disappears", async () => {
    const before = byProject(await list(A));
    expect(before.has(P2)).toBe(true);
    await owner.revokeSite({ siteId: site.p2 });
    const after = byProject(await list(A));
    expect(after.has(P2)).toBe(false);
    expect([...after.keys()].sort()).toEqual([P1, P4].sort());
  });

  it("follows the owner's switch and policy", async () => {
    await owner.setPublicDoors({ workspaceId: W, enabled: false });
    await owner.setPolicy({
      workspaceId: W,
      policy: sitePolicy({ viewRead: "direct", projectRead: "denied" }),
    });
    const off = byProject(await list(A)).get(P1)!;
    expect(off.publicDoorsOpen).toBe(false);
    expect(off.policyAllowsSites).toBe(false);
    // Still live by the site's own rule; the switch is a separate fact.
    expect(off.live).toBe(true);
    await owner.setPublicDoors({ workspaceId: W, enabled: null });
    await owner.setPolicy({
      workspaceId: W,
      policy: sitePolicy({ viewRead: "direct" }),
    });
    expect(byProject(await list(A)).get(P1)!.publicDoorsOpen).toBe(true);
  });
});

describe("shares.siteStatus lists the site's charts", () => {
  const status = async () =>
    (await owner.siteStatus({ projectId: P1 })) as unknown as {
      charts: Chart[];
      chartsTotal: number;
      members: Array<{ entityId: string }>;
      membersTotal: number;
    };

  it("each chart with its mode, public address and liveness; never as a record", async () => {
    const st = await status();
    expect(st.chartsTotal).toBe(1);
    expect(st.charts).toEqual([
      {
        cellInstanceId: chartId,
        title: "Turnout by district",
        cellKey: "sillage-histogram",
        mode: "snapshot",
        publicId: expect.stringMatching(/^p_[A-Za-z0-9]{16}$/),
        slug: "turnout-by-district",
        state: "published",
        live: true,
        publishedAt: expect.any(Date),
        capturedAt: "2026-11-02T00:00:00.000Z",
      },
    ]);
    // Records only in `members`.
    expect(st.membersTotal).toBe(3);
    expect(st.members.map((m) => m.entityId)).not.toContain(chartId);
  });

  it("a chart taken off stays listed, as draft and not live", async () => {
    await owner.unpublishChartsFromSite({
      siteId: site.p1,
      cellInstanceIds: [chartId],
    });
    const st = await status();
    expect(st.chartsTotal).toBe(1);
    expect(st.charts[0]).toMatchObject({
      cellInstanceId: chartId,
      state: "draft",
      live: false,
    });
  });

  it("a chart whose cell was deleted is not live", async () => {
    await owner.publishChartsToSite({
      siteId: site.p1,
      charts: [{ cellInstanceId: chartId, mode: "snapshot" }],
    });
    expect((await status()).charts[0]!.live).toBe(true);
    await world.q(`delete from cell_instances where id = $1`, [chartId]);
    const st = await status();
    expect(st.charts[0]).toMatchObject({ state: "published", live: false });
  });
});
