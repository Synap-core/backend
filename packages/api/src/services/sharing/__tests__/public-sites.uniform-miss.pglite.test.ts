/**
 * T3 — ENUMERATION / ORACLE: the uniform miss of every site door (collection
 * door C1b), on PGlite, as a DERIVED matrix.
 *
 * The matrix is built from data, never hand-paired: every TOKEN miss × every
 * door (manifest, collection, record), every COLLECTION miss × the collection
 * and record doors, every RECORD miss × the record door — each asked plain AND
 * with an invalid query (a 400 is decided only after the site, the collection
 * and the record resolved). Every cell must be the byte-identical 404
 * `{"error":"Not found"}`, `Cache-Control: no-cache`, and no ETag.
 *
 * World built through the REAL owner doors (configure, go live, publish into a
 * site, unpublish, revoke); odd states (expired, planted token, deleted
 * project, deleted record) are written with SQL. Read back through the REAL
 * routes.
 *
 * Also pinned: the positive controls answer 200 (non-vacuity); an invalid
 * query on a live site's real collection is the 400; the home switch closed
 * → 403 for what would be served, while every miss stays the 404.
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
import { generateShareToken, hashToken } from "../../../utils/share-token.js";
import { mintPublicId } from "../site-service.js";
import { createSiteSchema, sitePolicy, siteWorld } from "./site-fixture.js";

const A = randomUUID();
const W = randomUUID(); // home space
const W2 = randomUUID(); // another space of A's; its switch gets closed
const P = randomUUID(); // the live site
const P_OTHER = randomUUID(); // another live site
const P_STATE = Array.from({ length: 5 }, () => randomUUID());
const owner = sharesRouter.createCaller({
  authenticated: true,
  userId: A,
  workspaceId: null,
} as never);

const app = new OpenAPIHono();
registerPublicSitesRoutes(app as never);
async function get(url: string) {
  const res = await app.request(url);
  return {
    status: res.status,
    text: await res.text(),
    etag: res.headers.get("etag"),
    cache: res.headers.get("cache-control"),
  };
}
const MISS = JSON.stringify({ error: "Not found" });
/** Every knob invalid: a miss must never reach the query check. */
const BAD_QUERY = "?sort=nope&offset=99999999&limit=x&embed=a&ref[x]=p_1";

const CONFIG = {
  version: 1,
  collections: {
    paper: { sort: ["-year"], slugField: "title" },
    talk: { slugField: "title" },
  },
};

let world: ReturnType<typeof siteWorld>;
const T: Record<string, string> = {}; // tokens
const S: Record<string, string> = {}; // site ids
/** Public addresses of every member, by name. */
const M: Record<string, { publicId: string; slug: string }> = {};

async function liveSite(projectId: string) {
  const c = await owner.configureSite({ projectId, config: CONFIG });
  if (c.status === "proposed") throw new Error("unreachable");
  const live = await owner.publishSite({ siteId: c.siteId });
  return { siteId: c.siteId, token: live.token! };
}

beforeAll(async () => {
  await createSiteSchema(h.client!);
  world = siteWorld(h.client!);
  await world.user(A);
  await world.workspace(W, A);
  await world.workspace(W2, A);
  for (const p of [P, P_OTHER, ...P_STATE]) await world.project(p, A, W);
  const paper = await world.profile("paper");
  await world.profile("talk");
  await world.profile("note"); // a real kind, not a collection of the site
  for (const ws of [W, W2]) {
    await owner.setPolicy({ workspaceId: ws, policy: sitePolicy() });
  }

  ({ siteId: S.live!, token: T.live! } = await liveSite(P));
  ({ siteId: S.other!, token: T.other! } = await liveSite(P_OTHER));
  const [pDraft, pRevoked, pExpired, pGone, pBad] = P_STATE as [
    string,
    string,
    string,
    string,
    string,
  ];
  for (const [name, p] of [
    ["draft", pDraft],
    ["revoked", pRevoked],
    ["expired", pExpired],
    ["gone", pGone],
    ["badConfig", pBad],
  ] as const) {
    ({ siteId: S[name]!, token: T[name]! } = await liveSite(p));
  }

  // Members, each published through the REAL door, then narrowed.
  const member = async (
    name: string,
    opts: { workspaceId?: string; siteId?: string; projectId?: string } = {}
  ) => {
    const r = await world.record({
      ownerId: A,
      workspaceId: opts.workspaceId ?? W,
      profileId: paper,
      title: `${name} paper`,
      properties: { year: 2024 },
      body: `${name} body`,
    });
    await world.fileInto(r.id, opts.projectId ?? P, A);
    const res = await owner.publishToSite({
      siteId: opts.siteId ?? S.live!,
      entityIds: [r.id],
    });
    if (res.status !== "published") throw new Error(`publish ${name}`);
    M[name] = {
      publicId: res.published[0]!.publicId,
      slug: res.published[0]!.slug!,
    };
    return r.id;
  };
  await member("live");
  const draftId = await member("unpublished");
  await owner.unpublishFromSite({ siteId: S.live!, entityIds: [draftId] });
  const revokedId = await member("revoked");
  await world.q(
    `update resource_shares set revoked_at = now(), revoked_by = $2 where site_share_id = $1 and resource_id = $3`,
    [S.live, A, revokedId]
  );
  const expiredId = await member("expired");
  await world.q(
    `update resource_shares set expires_at = now() - interval '1 minute' where site_share_id = $1 and resource_id = $2`,
    [S.live, expiredId]
  );
  const unfiledId = await member("unfiled");
  // Moved to ANOTHER project: an edge exists, just not to this site's.
  await world.fileInto(unfiledId, P_OTHER, A);
  await world.unfile(unfiledId, P);
  const deletedId = await member("deleted");
  await world.q(`update entities set deleted_at = now() where id = $1`, [
    deletedId,
  ]);
  await member("closedSpace", { workspaceId: W2 });
  await owner.setPublicDoors({ workspaceId: W2, enabled: false });
  await member("otherSite", { siteId: S.other!, projectId: P_OTHER });
  // A member of the live site in the draft/revoked/expired/gone sites'
  // shape is unnecessary: a dead site 404s before any member is looked at.

  // Odd site states.
  await owner.unpublishSite({ siteId: S.draft! });
  await owner.revokeSite({ siteId: S.revoked! });
  await world.q(
    `update resource_shares set expires_at = now() - interval '1 minute' where id = $1`,
    [S.expired]
  );
  await world.q(`delete from projects where id = $1`, [pGone]);
  await world.q(
    `update resource_shares set site_config = '{"version":1,"collections":{"paper":{"sort":"not-a-list"}}}'::jsonb where id = $1`,
    [S.badConfig]
  );

  // Tokens that are NOT a site: a W3 publication, a member row given a token.
  const w3Entity = await world.record({
    ownerId: A,
    workspaceId: W,
    profileId: paper,
    title: "standalone",
  });
  T.w3 = generateShareToken();
  await world.q(
    `insert into resource_shares (resource_type, resource_id, workspace_id, audience, state, created_by, published_at, published_properties, token_hash)
     values ('entity', $1, $2, 'public', 'published', $3, now(), '{"title":"standalone"}'::jsonb, $4)`,
    [w3Entity.id, W, A, hashToken(T.w3)]
  );
  T.plantedMember = generateShareToken();
  await world.q(
    `insert into resource_shares (resource_type, resource_id, workspace_id, audience, state, created_by, published_at, published_properties, site_share_id, published_collection, public_id, token_hash)
     values ('entity', $1, $2, 'public', 'published', $3, now(), '{}'::jsonb, $4, 'paper', $5, $6)`,
    [w3Entity.id, W, A, S.live, mintPublicId(), hashToken(T.plantedMember)]
  );
}, 120_000);

// ── The derived matrix ──────────────────────────────────────────────────────

type Door = "manifest" | "collection" | "record";

const tokenMisses = (): Array<[string, string]> => [
  ["an unknown token", generateShareToken()],
  ["a malformed token", "not a token!"],
  ["an over-long token", "a".repeat(300)],
  ["a draft site", T.draft!],
  ["a revoked site", T.revoked!],
  ["an expired site", T.expired!],
  ["a site whose project was deleted", T.gone!],
  ["a W3 publication's token", T.w3!],
  ["a token planted on a member row", T.plantedMember!],
];

const collectionMisses = (): Array<[string, string, string]> => [
  ["an unknown collection", T.live!, "nope"],
  ["a real kind that is not configured", T.live!, "note"],
  ["a prototype key", T.live!, "__proto__"],
  ["another prototype key", T.live!, "constructor"],
  ["an unreadable config", T.badConfig!, "paper"],
];

const recordMisses = (): Array<[string, string, string]> => [
  ["an unknown public id", "paper", mintPublicId()],
  ["an unknown slug", "paper", "no-such-paper"],
  ["a malformed address", "paper", "Not_A_Slug"],
  ["an over-long slug", "paper", "a".repeat(200)],
  ["an unpublished member (public id)", "paper", M.unpublished!.publicId],
  ["an unpublished member (slug)", "paper", M.unpublished!.slug],
  ["a revoked member", "paper", M.revoked!.publicId],
  ["an expired member", "paper", M.expired!.publicId],
  ["a member out of the project", "paper", M.unfiled!.publicId],
  ["a deleted record", "paper", M.deleted!.publicId],
  ["a member of a closed space", "paper", M.closedSpace!.publicId],
  ["another site's member (public id)", "paper", M.otherSite!.publicId],
  ["another site's member (slug)", "paper", M.otherSite!.slug],
  ["a live member under another collection", "talk", M.live!.publicId],
];

function urlOf(
  door: Door,
  token: string,
  key = "paper",
  address = M.live?.publicId ?? "x"
) {
  const t = encodeURIComponent(token);
  if (door === "manifest") return `/public/sites/${t}`;
  const k = encodeURIComponent(key);
  if (door === "collection") return `/public/sites/${t}/collections/${k}`;
  return `/public/sites/${t}/collections/${k}/${encodeURIComponent(address)}`;
}

/** Every cell of the matrix, as [label, url]. */
function matrix(): Array<[string, string]> {
  const cells: Array<[string, string]> = [];
  for (const [label, token] of tokenMisses()) {
    for (const door of ["manifest", "collection", "record"] as const) {
      cells.push([`${door} · ${label}`, urlOf(door, token)]);
    }
  }
  for (const [label, token, key] of collectionMisses()) {
    for (const door of ["collection", "record"] as const) {
      cells.push([`${door} · ${label}`, urlOf(door, token, key)]);
    }
  }
  for (const [label, key, address] of recordMisses()) {
    cells.push([`record · ${label}`, urlOf("record", T.live!, key, address)]);
  }
  // Each one asked again with every query knob invalid.
  return cells.flatMap(([label, url]) => [
    [label, url],
    [`${label} + invalid query`, `${url}${BAD_QUERY}`],
  ]);
}

async function expectMiss(label: string, url: string) {
  const r = await get(url);
  expect({ label, status: r.status, text: r.text }).toEqual({
    label,
    status: 404,
    text: MISS,
  });
  expect(r.cache, label).toBe("no-cache");
  expect(r.etag, label).toBeNull();
}

describe("T3: every miss × every door is the byte-identical 404", () => {
  it("positive controls answer 200 (the matrix is not vacuous)", async () => {
    for (const url of [
      urlOf("manifest", T.live!),
      urlOf("collection", T.live!),
      urlOf("collection", T.live!, "talk"),
      urlOf("record", T.live!, "paper", M.live!.publicId),
      urlOf("record", T.live!, "paper", M.live!.slug),
      urlOf("record", T.other!, "paper", M.otherSite!.publicId),
      urlOf("manifest", T.badConfig!),
    ]) {
      expect((await get(url)).status, url).toBe(200);
    }
  });

  it("the matrix covers every miss kind of every door", () => {
    const cells = matrix();
    expect(cells.length).toBe(
      2 *
        (tokenMisses().length * 3 +
          collectionMisses().length * 2 +
          recordMisses().length)
    );
  });

  it("every cell → 404 {error:'Not found'}, no-cache, no ETag", async () => {
    for (const [label, url] of matrix()) await expectMiss(label, url);
  });

  it("an invalid query is a 400 ONLY on a live site's real collection", async () => {
    for (const q of [
      "?sort=nope",
      "?offset=10001",
      "?offset=-1",
      "?embed=authors",
      "?ref[authors]=p_x",
    ]) {
      const r = await get(`${urlOf("collection", T.live!)}${q}`);
      expect(r.status, q).toBe(400);
      expect(r.cache).toBe("no-cache");
    }
    const embed = await get(
      `${urlOf("record", T.live!, "paper", M.live!.publicId)}?embed=authors`
    );
    expect(embed.status).toBe(400);
  });

  it("the home switch closed → 403 for what would be served; every miss stays the 404", async () => {
    await owner.setPublicDoors({ workspaceId: W, enabled: false });
    try {
      for (const url of [
        urlOf("manifest", T.live!),
        urlOf("collection", T.live!),
        urlOf("record", T.live!, "paper", M.live!.publicId),
        // A live site's real collection with a bad query: the switch first.
        `${urlOf("collection", T.live!)}?sort=nope`,
      ]) {
        const r = await get(url);
        expect(r.status, url).toBe(403);
        expect(JSON.parse(r.text).code).toBe("public_doors_disabled");
      }
      for (const [label, url] of matrix()) await expectMiss(label, url);
    } finally {
      await owner.setPublicDoors({ workspaceId: W, enabled: null });
    }
  });
});
