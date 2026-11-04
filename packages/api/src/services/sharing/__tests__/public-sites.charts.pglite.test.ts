/**
 * THE CHART DOORS of a site — `GET /public/sites/:token/charts[/:slugOrPublicId]`
 * — and the owner door that fills them (`shares.publishChartsToSite`), on PGlite.
 *
 * Charts are cell instances published through the REAL owner door, the REAL
 * site core and the REAL 0276 + 0336 + 0397 migrations; read back through the
 * REAL routes. Only the live chart's READ (`liveChartReader`, which calls the
 * `entities.list` procedure) is replaced by a counted stub over in-memory rows:
 * the shaper (`shapeChartEntities`) is the real one.
 *
 * Pinned:
 *   - SNAPSHOT: a chart publishes its inline data (a custom cellKey too) or,
 *     with none, its query read ONCE at publish; an edit to the cell after
 *     publish is invisible (data, props, ETag) until the owner publishes again
 *     (same public id, new data);
 *   - LIVE: only a pod chart with a query; the data is re-read as the
 *     publisher, at most once per TTL whatever the request rate; a failed live
 *     read is a 5xx (never empty data) and is not cached; live data holding a
 *     UUID fails closed;
 *   - ONE SHAPE for both modes; the list carries no props and no data;
 *   - nothing internal leaves: a prop holding a UUID is dropped, data holding
 *     one is refused at publish, and no response holds a UUID;
 *   - policy: the chart's space must allow `view` publicly, and the chart must
 *     live in the site's home space;
 *   - UNIFORM MISS: unknown slug, malformed ref, unpublished chart, deleted
 *     cell, a record's slug, a draft site — the byte-identical 404; a closed
 *     switch is the 403.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | import("./site-fixture.js").PgClient,
  rows: [] as Array<Record<string, unknown>>,
  reads: 0,
  readers: [] as Array<{ userId: string; workspaceId: string | null }>,
  failNext: false,
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
// The live chart's read (entities.list as the publisher), counted.
vi.mock("../../document-charts/freeze-charts-verb.js", () => ({
  LIVE_CHART_ENTITIES_LIMIT: 500,
  liveChartReader:
    (ctx: { userId: string; workspaceId: string | null }) =>
    async (profileSlug: string | undefined) => {
      h.reads += 1;
      h.readers.push(ctx);
      if (h.failNext) {
        h.failNext = false;
        throw new Error("read failed");
      }
      return h.rows.filter(
        (r) => !profileSlug || r.profileSlug === profileSlug
      );
    },
}));

import { OpenAPIHono } from "@hono/zod-openapi";
import { sharesRouter } from "../../../routers/shares.js";
import { registerPublicSitesRoutes } from "../../../routers/hub-protocol/rest/public-sites.js";
import { clearLiveChartCache } from "../public-site-charts.js";
import {
  createSiteSchema,
  errOf,
  sitePolicy,
  siteWorld,
  UUID_RE,
} from "./site-fixture.js";

const A = randomUUID();
const W = randomUUID(); // home space: view public
const W2 = randomUUID(); // another space of A's
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
    json: text && res.status === 200 ? (JSON.parse(text) as any) : null,
    etag: res.headers.get("etag"),
    cache: res.headers.get("cache-control"),
  };
}
const MISS = JSON.stringify({ error: "Not found" });

let world: ReturnType<typeof siteWorld>;
let siteId = "";
let token = "";
const chart = (ref: string) => get(`/public/sites/${token}/charts/${ref}`);
const list = () => get(`/public/sites/${token}/charts`);

async function cell(opts: {
  cellType: string;
  config: Record<string, unknown>;
  name: string | null;
  workspaceId?: string;
}): Promise<string> {
  const id = randomUUID();
  await world.q(
    `insert into cell_instances (id, workspace_id, user_id, cell_type, config, name, is_template, created_by_kind, trust_level) values ($1,$2,$3,$4,$5::jsonb,$6,false,'user','trusted')`,
    [
      id,
      opts.workspaceId ?? W,
      A,
      opts.cellType,
      JSON.stringify(opts.config),
      opts.name,
    ]
  );
  return id;
}

async function publish(
  charts: Array<{
    cellInstanceId: string;
    mode: "snapshot" | "live";
    slug?: string | null;
  }>
) {
  const res = await owner.publishChartsToSite({ siteId, charts });
  if (res.status === "proposed") throw new Error("unreachable");
  return res;
}

const HISTO = {
  series: [{ key: "n", label: "Marchés" }],
  valueFormat: "count",
  data: [
    { label: "0-1", values: { n: 4 } },
    { label: "1-2", values: { n: 9 } },
  ],
  capturedAt: "2026-10-30",
};
const id: Record<string, string> = {};

beforeAll(async () => {
  await createSiteSchema(h.client!);
  world = siteWorld(h.client!);
  await world.user(A);
  await world.workspace(W, A);
  await world.workspace(W2, A);
  await world.project(P, A, W);
  await owner.setPolicy({
    workspaceId: W,
    policy: sitePolicy({ viewRead: "direct" }),
  });
  await owner.setPolicy({ workspaceId: W2, policy: sitePolicy() });
  const paper = await world.profile("paper");
  const rec = await world.record({
    ownerId: A,
    workspaceId: W,
    profileId: paper,
    title: "Alpha",
    properties: { year: 2020 },
  });
  await world.fileInto(rec.id, P, A);
  const c = await owner.configureSite({
    projectId: P,
    config: {
      version: 1,
      collections: { paper: { sort: ["title"], slugField: "title" } },
    },
  });
  if (c.status === "proposed") throw new Error("unreachable");
  siteId = c.siteId;
  token = (await owner.publishSite({ siteId })).token!;
  await owner.publishToSite({ siteId, entityIds: [rec.id] });

  id.histo = await cell({
    cellType: "sillage-histogram",
    name: "Délais de paiement",
    config: { ...HISTO, sourceView: randomUUID() },
  });
  id.bars = await cell({
    cellType: "chart-bar",
    name: "Marchés par statut",
    config: { profileSlug: "paper", groupBy: "status", valueLabel: "Marchés" },
  });
  id.frozen = await cell({
    cellType: "chart-bar",
    name: "Statuts figés",
    config: { profileSlug: "paper", groupBy: "status" },
  });
}, 120_000);

beforeEach(() => {
  h.rows = [
    { profileSlug: "paper", properties: { status: "open" } },
    { profileSlug: "paper", properties: { status: "open" } },
    { profileSlug: "paper", properties: { status: "closed" } },
  ];
  h.reads = 0;
  h.readers = [];
  h.failNext = false;
  clearLiveChartCache();
});

describe("snapshot charts", () => {
  it("publishes a custom cell's inline data, served by slug and by public id, one shape", async () => {
    const res = await publish([
      { cellInstanceId: id.histo!, mode: "snapshot" },
    ]);
    expect(res.skipped).toEqual([]);
    expect(res.published).toHaveLength(1);
    const [p] = res.published;
    expect(p!.slug).toBe("delais-de-paiement");
    expect(p!.publicId).toMatch(/^p_[A-Za-z0-9]{16}$/);

    const r = await chart("delais-de-paiement");
    expect(r.status).toBe(200);
    expect(r.cache).toBe("no-cache");
    expect(r.etag).toMatch(/^W\//);
    expect(r.json).toEqual({
      publicId: p!.publicId,
      slug: "delais-de-paiement",
      title: "Délais de paiement",
      cellKey: "sillage-histogram",
      mode: "snapshot",
      // `data` / `capturedAt` are not props; the UUID-holding prop is dropped.
      props: { series: HISTO.series, valueFormat: "count" },
      data: HISTO.data,
      capturedAt: "2026-10-30T00:00:00.000Z",
      publishedOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
    expect(r.text).not.toMatch(UUID_RE);
    expect((await chart(p!.publicId)).text).toBe(r.text);
    expect(h.reads).toBe(0); // inline data: nothing was read
  });

  it("is frozen: an edit to the cell is invisible until the owner publishes again", async () => {
    const before = await chart("delais-de-paiement");
    await world.q(
      `update cell_instances set config = $2::jsonb where id = $1`,
      [
        id.histo,
        JSON.stringify({
          ...HISTO,
          valueFormat: "eur",
          data: [{ label: "0-1", values: { n: 99 } }],
        }),
      ]
    );
    const after = await chart("delais-de-paiement");
    expect(after.text).toBe(before.text);
    expect(after.etag).toBe(before.etag);

    const again = await publish([
      { cellInstanceId: id.histo!, mode: "snapshot" },
    ]);
    expect(again.published[0]!.status).toBe("republished");
    expect(again.published[0]!.publicId).toBe(before.json.publicId);
    const fresh = await chart("delais-de-paiement");
    expect(fresh.json.data).toEqual([{ label: "0-1", values: { n: 99 } }]);
    expect(fresh.json.props.valueFormat).toBe("eur");
    expect(fresh.etag).not.toBe(before.etag);
  });

  it("a query chart with no inline data is read ONCE at publish, as the publisher, then frozen", async () => {
    await publish([{ cellInstanceId: id.frozen!, mode: "snapshot" }]);
    expect(h.reads).toBe(1);
    expect(h.readers[0]).toEqual({ userId: A, workspaceId: W });
    h.rows.push({ profileSlug: "paper", properties: { status: "closed" } });
    const r = await chart("statuts-figes");
    expect(r.json.mode).toBe("snapshot");
    expect(r.json.data).toEqual([
      { label: "open", value: 2 },
      { label: "closed", value: 1 },
    ]);
    expect(h.reads).toBe(1); // serving a snapshot reads nothing
  });
});

describe("live charts", () => {
  it("re-reads the query as the publisher, at most once per TTL, same shape as a snapshot", async () => {
    const res = await publish([{ cellInstanceId: id.bars!, mode: "live" }]);
    expect(res.skipped).toEqual([]);
    expect(h.reads).toBe(1); // the trial read at publish
    clearLiveChartCache();

    const first = await chart("marches-par-statut");
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({
      cellKey: "chart-bar",
      mode: "live",
      props: { profileSlug: "paper", groupBy: "status", valueLabel: "Marchés" },
      data: [
        { label: "open", value: 2 },
        { label: "closed", value: 1 },
      ],
    });
    expect(Object.keys(first.json).sort()).toEqual(
      [
        "capturedAt",
        "cellKey",
        "data",
        "mode",
        "props",
        "publicId",
        "publishedOn",
        "slug",
        "title",
      ].sort()
    );
    expect(first.text).not.toMatch(UUID_RE);
    expect(h.reads).toBe(2);
    expect(h.readers.at(-1)).toEqual({ userId: A, workspaceId: W });

    // Within the TTL: no new read, whatever the request rate.
    h.rows.push({ profileSlug: "paper", properties: { status: "closed" } });
    await Promise.all([1, 2, 3, 4, 5].map(() => chart("marches-par-statut")));
    expect(h.reads).toBe(2);

    // After it (the cache forgotten): the new data.
    clearLiveChartCache();
    const later = await chart("marches-par-statut");
    expect(later.json.data).toEqual([
      { label: "closed", value: 2 },
      { label: "open", value: 2 },
    ]);
    expect(h.reads).toBe(3);
    expect(later.etag).not.toBe(first.etag);
  });

  it("a failed live read is a 5xx, never empty data, and is not cached", async () => {
    h.failNext = true;
    const r = await chart("marches-par-statut");
    expect(r.status).toBe(500);
    expect(r.text).not.toContain("data");
    const next = await chart("marches-par-statut");
    expect(next.status).toBe(200);
    expect(next.json.data.length).toBeGreaterThan(0);
  });

  it("live data that came to hold a UUID fails closed", async () => {
    h.rows = [{ profileSlug: "paper", properties: { status: randomUUID() } }];
    const r = await chart("marches-par-statut");
    expect(r.status).toBe(500);
    expect(r.text).not.toMatch(UUID_RE);
  });

  it("a custom cell cannot be live (no query the pod can run)", async () => {
    const e = await errOf(
      publish([{ cellInstanceId: id.histo!, mode: "live" }])
    );
    expect(e?.code).toBe("BAD_REQUEST");
    expect(e?.message).toMatch(/snapshot/);
  });
});

describe("what may leave", () => {
  it("data holding a UUID is refused at publish", async () => {
    const leaky = await cell({
      cellType: "chart-bar",
      name: "Leaky",
      config: { data: [{ label: randomUUID(), value: 1 }] },
    });
    const e = await errOf(
      publish([{ cellInstanceId: leaky, mode: "snapshot" }])
    );
    expect(e?.code).toBe("BAD_REQUEST");
    expect(e?.message).toMatch(/internal ids/);
  });

  it("the chart's space must allow views publicly; the chart must live in the site's home", async () => {
    const elsewhere = await cell({
      cellType: "sillage-histogram",
      name: "Elsewhere",
      config: HISTO,
      workspaceId: W2,
    });
    expect(
      (await errOf(publish([{ cellInstanceId: elsewhere, mode: "snapshot" }])))
        ?.code
    ).toBe("BAD_REQUEST");

    await owner.setPolicy({ workspaceId: W, policy: sitePolicy() });
    const denied = await errOf(
      publish([{ cellInstanceId: id.histo!, mode: "snapshot" }])
    );
    expect(denied?.code).toBe("FORBIDDEN");
    await owner.setPolicy({
      workspaceId: W,
      policy: sitePolicy({ viewRead: "direct" }),
    });
  });

  it("the list: every live chart, newest first, no props and no data", async () => {
    const r = await list();
    expect(r.status).toBe(200);
    expect(r.cache).toBe("no-cache");
    expect(r.json.total).toBe(3);
    for (const item of r.json.items) {
      expect(Object.keys(item).sort()).toEqual(
        ["cellKey", "mode", "publicId", "publishedOn", "slug", "title"].sort()
      );
    }
    expect(r.json.items.map((i: any) => i.slug).sort()).toEqual([
      "delais-de-paiement",
      "marches-par-statut",
      "statuts-figes",
    ]);
    expect(r.text).not.toMatch(UUID_RE);
  });
});

describe("uniform miss", () => {
  it("unknown slug, malformed ref, a record's slug, an unknown token: the byte-identical 404", async () => {
    for (const r of [
      await chart("no-such-chart"),
      await chart("Not A Slug!"),
      await chart("p_0000000000000000"),
      await chart("alpha"), // a RECORD of the site, not a chart
      await get(`/public/sites/not-a-token/charts/delais-de-paiement`),
      await get(`/public/sites/not-a-token/charts`),
    ]) {
      expect(r.status).toBe(404);
      expect(r.text).toBe(MISS);
      expect(r.cache).toBe("no-cache");
    }
    // ...and a chart is never served as a record of a collection.
    const asRecord = await get(
      `/public/sites/${token}/collections/paper/delais-de-paiement`
    );
    expect(asRecord.status).toBe(404);
  });

  it("an unpublished chart and a deleted cell 404 at once; publishing again restores the same URL", async () => {
    const before = await chart("statuts-figes");
    expect(before.status).toBe(200);
    await owner.unpublishChartsFromSite({
      siteId,
      cellInstanceIds: [id.frozen!],
    });
    expect((await chart("statuts-figes")).text).toBe(MISS);
    expect((await list()).json.total).toBe(2);
    await publish([{ cellInstanceId: id.frozen!, mode: "snapshot" }]);
    expect((await chart("statuts-figes")).json.publicId).toBe(
      before.json.publicId
    );

    await world.q(`delete from cell_instances where id = $1`, [id.frozen]);
    expect((await chart("statuts-figes")).text).toBe(MISS);
    expect((await chart(before.json.publicId)).text).toBe(MISS);
  });

  it("the home space's switch closed: 403 on a live chart, a miss stays 404", async () => {
    await owner.setPublicDoors({ workspaceId: W, enabled: false });
    const closed = await chart("delais-de-paiement");
    expect(closed.status).toBe(403);
    expect(closed.text).toContain("public_doors_disabled");
    expect((await chart("no-such-chart")).status).toBe(404);
    await owner.setPublicDoors({ workspaceId: W, enabled: true });
    expect((await chart("delais-de-paiement")).status).toBe(200);
  });

  it("a site back to draft 404s on both chart doors", async () => {
    await owner.unpublishSite({ siteId });
    expect((await chart("delais-de-paiement")).text).toBe(MISS);
    expect((await list()).text).toBe(MISS);
  });
});
