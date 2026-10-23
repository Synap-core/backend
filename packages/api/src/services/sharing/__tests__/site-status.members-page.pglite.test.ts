/**
 * The owner status PAGES its member list (collection door C1b, founder
 * decision 2026-10-20: no cap), on PGlite.
 *
 * Records are published through the REAL owner doors (tRPC
 * `shares.publishToSite`, `shares.siteStatus`; Hub REST `GET /shares/sites`
 * and `GET /shares/sites/:id`), the REAL site core and the REAL 0276 + 0336
 * migrations.
 *
 * Pinned:
 *   - every non-revoked member is reachable, past any former cap: a cursor walk
 *     lists each exactly once, no gap, in ONE order (newest member first,
 *     `created_at DESC, id DESC`), and `membersTotal` counts the same rows;
 *   - the order holds where timestamps tie (one publish batch) and where rows
 *     differ by MICROSECONDS inside one millisecond (a millisecond cursor would
 *     skip or repeat them);
 *   - a republish mid-walk does not move a member across pages (the order is
 *     the membership's birth, not its last publish);
 *   - `limit` defaults to and clamps at the site door's own bound
 *     (`SITE_MAX_LIMIT`); a forged cursor is a 400, never a 500.
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
import { registerSharesRoutes } from "../../../routers/hub-protocol/rest/shares.js";
import { SITE_MAX_LIMIT } from "../public-site-read.js";
import { SITE_PUBLISH_MAX_RECORDS } from "../site-service.js";
import {
  createSiteSchema,
  errOf,
  sitePolicy,
  siteWorld,
} from "./site-fixture.js";

const A = randomUUID();
const W = randomUUID();
const P = randomUUID();
const owner = sharesRouter.createCaller({
  authenticated: true,
  userId: A,
  workspaceId: null,
} as never);

const rest = new OpenAPIHono();
rest.use("/*", async (c, next) => {
  c.set("userId" as never, A as never);
  c.set("scopes" as never, ["hub-protocol.read"] as never);
  await next();
});
registerSharesRoutes(rest as never);

/** Past the former 500 cap, over several publish batches. */
const N = 520;
let world: ReturnType<typeof siteWorld>;
let siteId = "";
const recordIds: string[] = [];

type Page = {
  members: Array<{ entityId: string }>;
  membersNextCursor: string | null;
  membersTotal: number;
};

/** Walk every page; `between` runs after the first page. */
async function walk(
  limit: number | undefined,
  between?: () => Promise<void>
): Promise<{ ids: string[]; pages: number; totals: number[] }> {
  const ids: string[] = [];
  const totals: number[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const st = (await owner.siteStatus({
      siteId,
      ...(cursor ? { cursor } : {}),
      ...(limit !== undefined ? { limit } : {}),
    } as never)) as unknown as Page;
    pages += 1;
    if (pages > N) throw new Error("the walk does not end");
    ids.push(...st.members.map((m) => m.entityId));
    totals.push(st.membersTotal);
    cursor = st.membersNextCursor ?? undefined;
    if (pages === 1 && between) await between();
  } while (cursor);
  return { ids, pages, totals };
}

/** THE order, straight from SQL: newest member first, id as the tie-break. */
async function sqlOrder(): Promise<string[]> {
  const { rows } = await world.q<{ resource_id: string }>(
    `select resource_id from resource_shares
      where site_share_id = $1 and revoked_at is null
      order by created_at desc, id desc`,
    [siteId]
  );
  return rows.map((r) => r.resource_id);
}

beforeAll(async () => {
  await createSiteSchema(h.client!);
  world = siteWorld(h.client!);
  await world.user(A);
  await world.workspace(W, A);
  await world.project(P, A, W);
  const paper = await world.profile("paper");
  await owner.setPolicy({ workspaceId: W, policy: sitePolicy() });
  const c = await owner.configureSite({
    projectId: P,
    config: {
      version: 1,
      collections: { paper: { sort: [], pageSize: 20, slugField: "title" } },
    },
  });
  if (c.status === "proposed") throw new Error("unreachable");
  siteId = c.siteId;
  await owner.publishSite({ siteId });

  // N records filed into the project, in one statement each (fast).
  await world.q(
    `insert into entities (id, user_id, workspace_id, profile_id, title, properties)
     select gen_random_uuid(), $1, $2, $3, 'Paper ' || n, '{}'::jsonb
       from generate_series(1, ${N}) as n`,
    [A, W, paper]
  );
  const { rows } = await world.q<{ id: string }>(
    `select id from entities where user_id = $1 order by title`,
    [A]
  );
  recordIds.push(...rows.map((r) => r.id));
  await world.q(
    `insert into relations (id, user_id, source_entity_id, target_entity_id, type)
     select gen_random_uuid(), $1, id, $2, 'belongs_to_project'
       from entities where user_id = $1`,
    [A, P]
  );
  for (let i = 0; i < recordIds.length; i += SITE_PUBLISH_MAX_RECORDS) {
    const res = await owner.publishToSite({
      siteId,
      entityIds: recordIds.slice(i, i + SITE_PUBLISH_MAX_RECORDS),
    });
    if (res.status === "proposed") throw new Error("unreachable");
    expect(res.skipped).toEqual([]);
  }
  // Ties and sub-millisecond spreads, on purpose: 40 members share ONE
  // instant; 40 more sit inside one millisecond, a microsecond apart.
  await world.q(
    `update resource_shares set created_at = timestamptz '2026-01-01 00:00:00.123456+00'
      where id in (select id from resource_shares where site_share_id = $1 order by id limit 40)`,
    [siteId]
  );
  await world.q(
    `with picked as (
       select id, row_number() over (order by id desc) as k
         from resource_shares where site_share_id = $1 order by id desc limit 40)
     update resource_shares r
        set created_at = timestamptz '2026-01-02 00:00:00.500000+00' + (picked.k * interval '1 microsecond')
       from picked where r.id = picked.id`,
    [siteId]
  );
}, 300_000);

describe("the owner status pages its members (no cap)", () => {
  it(`every one of ${N} members is reachable: once each, no gap, in the SQL order`, async () => {
    const { ids, pages, totals } = await walk(SITE_MAX_LIMIT);
    expect(ids).toHaveLength(N);
    expect(new Set(ids).size).toBe(N);
    expect(new Set(ids)).toEqual(new Set(recordIds));
    expect(ids).toEqual(await sqlOrder());
    expect(pages).toBe(Math.ceil(N / SITE_MAX_LIMIT));
    expect(new Set(totals)).toEqual(new Set([N]));
  });

  it("small pages walk the same order (ties and microseconds included)", async () => {
    const { ids } = await walk(7);
    expect(ids).toEqual(await sqlOrder());
  });

  it("the last page says so with a null cursor; the former truncation flag is gone", async () => {
    let st = (await owner.siteStatus({ siteId })) as unknown as Page &
      Record<string, unknown>;
    expect("membersTruncated" in st).toBe(false);
    while (st.membersNextCursor) {
      st = (await owner.siteStatus({
        siteId,
        cursor: st.membersNextCursor,
      } as never)) as unknown as Page & Record<string, unknown>;
    }
    expect(st.membersNextCursor).toBeNull();
    expect(st.members).toHaveLength(N % SITE_MAX_LIMIT);
  });

  it("limit defaults to, and clamps at, the site door's bound", async () => {
    const byDefault = (await owner.siteStatus({
      siteId,
    })) as unknown as Page;
    expect(byDefault.members).toHaveLength(SITE_MAX_LIMIT);
    expect(byDefault.membersNextCursor).toEqual(expect.any(String));
    const asked = (await owner.siteStatus({
      siteId,
      limit: 10_000,
    } as never)) as unknown as Page;
    expect(asked.members).toHaveLength(SITE_MAX_LIMIT);
    const one = (await owner.siteStatus({
      siteId,
      limit: 1,
    } as never)) as unknown as Page;
    expect(one.members).toHaveLength(1);
  });

  it("a republish mid-walk does not move a member across pages", async () => {
    const order = await sqlOrder();
    // A member deep in the walk, republished after the first page.
    const late = order[order.length - 3]!;
    const before = await world.q<{ published_at: Date }>(
      `select published_at from resource_shares where site_share_id = $1 and resource_id = $2 and revoked_at is null`,
      [siteId, late]
    );
    const { ids } = await walk(SITE_MAX_LIMIT, async () => {
      const res = await owner.publishToSite({ siteId, entityIds: [late] });
      if (res.status === "proposed") throw new Error("unreachable");
      expect(res.published.map((p) => p.entityId)).toEqual([late]);
    });
    const after = await world.q<{ published_at: Date }>(
      `select published_at from resource_shares where site_share_id = $1 and resource_id = $2 and revoked_at is null`,
      [siteId, late]
    );
    expect(after.rows[0]!.published_at.getTime()).toBeGreaterThan(
      before.rows[0]!.published_at.getTime()
    );
    expect(ids).toEqual(order);
  });

  it("a forged cursor is BAD_REQUEST, never a cast error", async () => {
    const forged = [
      "not-a-cursor",
      Buffer.from("{}").toString("base64url"),
      Buffer.from(
        JSON.stringify({ at: "2026-02-30T00:00:00.000000Z", id: randomUUID() })
      ).toString("base64url"),
      Buffer.from(
        JSON.stringify({ at: "2026-01-01T00:00:00.000000Z", id: "x" })
      ).toString("base64url"),
    ];
    for (const cursor of forged) {
      const e = await errOf(owner.siteStatus({ siteId, cursor } as never));
      expect(e?.code, cursor).toBe("BAD_REQUEST");
    }
  });
});

describe("the Hub REST status doors page the same way", () => {
  it("GET /shares/sites/:id?limit=&cursor= walks every member; bad knobs are 400", async () => {
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const qs = new URLSearchParams({ limit: "100" });
      if (cursor) qs.set("cursor", cursor);
      const res = await rest.request(`/shares/sites/${siteId}?${qs}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Page;
      expect(body.membersTotal).toBe(N);
      ids.push(...body.members.map((m) => m.entityId));
      cursor = body.membersNextCursor;
    } while (cursor);
    expect(ids).toEqual(await sqlOrder());

    const byProject = await rest.request(
      `/shares/sites?projectId=${P}&limit=3`
    );
    expect(byProject.status).toBe(200);
    expect(((await byProject.json()) as Page).members).toHaveLength(3);

    for (const qs of ["limit=abc", "limit=0", "limit=-1", "cursor=nope"]) {
      const res = await rest.request(`/shares/sites/${siteId}?${qs}`);
      expect(res.status, qs).toBe(400);
    }
  });
});
