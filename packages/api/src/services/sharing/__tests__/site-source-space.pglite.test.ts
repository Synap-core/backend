/**
 * A COLLECTION'S SOURCE SPACE (`sourceWorkspaceId`), on PGlite.
 *
 * The case it exists for: the site of a project whose home is Brand publishes
 * essays that live in Content OS. Driven through the REAL owner doors (tRPC
 * `shares.configureSite` / `publishSite` / `publishToSite`), the REAL site
 * core, the REAL 0276 + 0336 constraints, and read back through the REAL
 * public manifest route.
 *
 * Pinned:
 *   - a collection naming its source resolves its profile THERE (a kind of
 *     that space, or a shared kind granted to it), and its records publish;
 *     without the source the same config is refused as today;
 *   - refused, nothing written: the source does not publish entities; the
 *     person does not write the source; the slug or sort field is not in the
 *     source's allowlist; a pod-wide kind, even in its source;
 *   - at the member step a sourced collection takes only records of its
 *     source (a same-slug kind of another space is refused);
 *   - a collection with no source behaves as before (a record of another
 *     space still joins);
 *   - the public manifest never carries the source space's id.
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

import { OpenAPIHono } from "@hono/zod-openapi";
import { sharesRouter } from "../../../routers/shares.js";
import { registerPublicSitesRoutes } from "../../../routers/hub-protocol/rest/public-sites.js";
import {
  createSiteSchema,
  errOf,
  sitePolicy,
  siteWorld,
} from "./site-fixture.js";

const A = randomUUID(); // owns every space below except FOREIGN
const B = randomUUID(); // owns FOREIGN; A is not a member there
const BRAND = randomUUID(); // the site's home
const CONTENT = randomUUID(); // where the essays live: the collection's source
const OTHER = randomUUID(); // a third space A owns (a twin kind lives here)
const ARCHIVED = randomUUID(); // a shared kind's home row sits here
const CLOSED = randomUUID(); // A writes it, its policy publishes no entity
const FOREIGN = randomUUID(); // a space A cannot write
const P = randomUUID(); // the project, home = BRAND

const owner = sharesRouter.createCaller({
  authenticated: true,
  userId: A,
  workspaceId: null,
} as never);

const publicApp = new OpenAPIHono();
registerPublicSitesRoutes(publicApp as never);

let world: ReturnType<typeof siteWorld>;
let siteId = "";
let token = "";

/** A profile row with a workspace and a scope (the fixture's has neither). */
async function profileIn(
  slug: string,
  workspaceId: string | null,
  opts: {
    scope?: "workspace" | "shared" | "system";
    entityScope?: "workspace" | "pod";
    grantedTo?: string[];
  } = {}
): Promise<string> {
  const id = randomUUID();
  await world.q(
    `insert into profiles (id, slug, display_name, profile_kind, entity_scope, origin, workspace_id, scope)
     values ($1,$2,$2,'kind',$3,'authored',$4,$5)`,
    [
      id,
      slug,
      opts.entityScope ?? "workspace",
      workspaceId,
      opts.scope ?? "workspace",
    ]
  );
  for (const ws of opts.grantedTo ?? []) {
    await world.q(
      `insert into profile_workspace_access (profile_id, workspace_id) values ($1,$2)`,
      [id, ws]
    );
  }
  return id;
}

const configure = (collections: Record<string, unknown>) =>
  owner.configureSite({ projectId: P, config: { version: 1, collections } });

async function storedConfig() {
  const { rows } = await world.q<{ site_config: any }>(
    `select site_config from resource_shares where id = $1`,
    [siteId]
  );
  return rows[0]!.site_config;
}

/** A record of `profileId` in `workspaceId`, filed into P. */
async function essay(
  workspaceId: string | null,
  profileId: string,
  title: string
) {
  const r = await world.record({
    ownerId: A,
    workspaceId,
    profileId,
    title,
    properties: { year: 2026 },
  });
  await world.fileInto(r.id, P, A);
  return r.id;
}

let piece = "";
let twin = "";
let shared = "";

beforeAll(async () => {
  await createSiteSchema(h.client!);
  world = siteWorld(h.client!);
  await world.user(A);
  await world.user(B);
  for (const ws of [BRAND, CONTENT, OTHER, ARCHIVED, CLOSED]) {
    await world.workspace(ws, A);
  }
  await world.workspace(FOREIGN, B);
  await world.project(P, A, BRAND, "Antoine in public");
  // BRAND publishes the project and entities with `title` only; CONTENT
  // publishes entities with `title`, `slug` and `year`.
  await owner.setPolicy({
    workspaceId: BRAND,
    policy: sitePolicy({ entityFields: ["title"] }),
  });
  for (const ws of [CONTENT, OTHER]) {
    await owner.setPolicy({
      workspaceId: ws,
      policy: sitePolicy({ entityFields: ["title", "slug", "year"] }),
    });
  }
  await owner.setPolicy({
    workspaceId: CLOSED,
    policy: sitePolicy({ entityRead: "denied" }),
  });
  piece = await profileIn("piece", CONTENT);
  twin = await profileIn("piece", OTHER);
  await profileIn("closed-kind", CLOSED);
  await profileIn("podwide-kind", CONTENT, { entityScope: "pod" });
  // A shared kind whose row lives in an archived space, granted to CONTENT
  // (the live `content-composition` shape once it is a workspace kind again).
  shared = await profileIn("composition", ARCHIVED, {
    scope: "shared",
    grantedTo: [CONTENT],
  });
}, 120_000);

describe("configure: a collection names the space that governs it", () => {
  it("without a source, a kind of another space is refused as before", async () => {
    const e = await errOf(configure({ piece: { slugField: "title" } }));
    expect(e?.code).toBe("BAD_REQUEST");
    expect(e?.message).toMatch(/names no profile in this space/);
  });

  it("naming the source resolves the kind there; the config stores it", async () => {
    const res = await configure({
      piece: {
        sourceWorkspaceId: CONTENT,
        slugField: "slug",
        sort: ["-year"],
      },
    });
    if (res.status === "proposed") throw new Error("unreachable");
    expect(res.status).toBe("created");
    siteId = res.siteId;
    expect((await storedConfig()).collections.piece).toMatchObject({
      sourceWorkspaceId: CONTENT,
      slugField: "slug",
    });
    token = (await owner.publishSite({ siteId })).token!;
    expect(token).toBeTruthy();
  });

  it("a shared kind granted to the source resolves there too", async () => {
    const res = await configure({
      piece: { sourceWorkspaceId: CONTENT, slugField: "slug" },
      composition: { sourceWorkspaceId: CONTENT, slugField: "slug" },
    });
    expect(res.status).toBe("updated");
    // …and not from a space it is not granted to.
    const e = await errOf(
      configure({ composition: { sourceWorkspaceId: OTHER } })
    );
    expect(e?.code).toBe("BAD_REQUEST");
    expect(e?.message).toMatch(/names no profile in its source space/);
  });

  it.each([
    [
      "the source does not publish entities",
      { "closed-kind": { sourceWorkspaceId: CLOSED } },
      "FORBIDDEN",
      /source workspace whose exposure policy does not allow publishing an entity/,
    ],
    [
      "the person does not write the source",
      { piece: { sourceWorkspaceId: FOREIGN } },
      "FORBIDDEN",
      /not a member of this resource's workspace/,
    ],
    [
      "the slug field is not in the source's allowlist",
      { piece: { sourceWorkspaceId: CONTENT, slugField: "secret" } },
      "BAD_REQUEST",
      /addresses records by "secret", which its source workspace does not publish/,
    ],
    [
      "the sort field is not in the source's allowlist",
      { piece: { sourceWorkspaceId: CONTENT, sort: ["-secret"] } },
      "BAD_REQUEST",
      /sorts on "secret", which its source workspace does not publish/,
    ],
    [
      "a pod-wide kind, even in its source",
      { "podwide-kind": { sourceWorkspaceId: CONTENT } },
      "BAD_REQUEST",
      /is a pod-wide kind/,
    ],
    [
      "the source is not a uuid",
      { piece: { sourceWorkspaceId: "content-os" } },
      "BAD_REQUEST",
      /Invalid site configuration/,
    ],
  ] as const)(
    "refused when %s; the stored config is unchanged",
    async (_why, collections, code, message) => {
      const before = await storedConfig();
      const e = await errOf(configure(collections));
      expect(e?.code).toBe(code);
      expect(e?.message).toMatch(message);
      expect(await storedConfig()).toEqual(before);
    }
  );
});

describe("publish: a sourced collection takes only records of its source", () => {
  it("an essay in the source publishes, addressed by the source's slug field", async () => {
    const id = await essay(CONTENT, piece, "Why I build in public");
    await world.q(
      `update entities set properties = properties || '{"slug":"why-i-build"}'::jsonb where id = $1`,
      [id]
    );
    const res = await owner.publishToSite({ siteId, entityIds: [id] });
    expect(res).toMatchObject({
      status: "published",
      skipped: [],
      published: [{ entityId: id, collection: "piece", slug: "why-i-build" }],
    });
  });

  it("a shared kind's record in the source publishes too", async () => {
    const id = await essay(CONTENT, shared, "A composition");
    const res = await owner.publishToSite({ siteId, entityIds: [id] });
    expect(res).toMatchObject({ status: "published", skipped: [] });
  });

  it("a same-slug kind of ANOTHER space is refused at the member step; nothing written", async () => {
    const id = await essay(OTHER, twin, "A twin essay");
    const e = await errOf(owner.publishToSite({ siteId, entityIds: [id] }));
    expect(e?.code).toBe("BAD_REQUEST");
    expect(e?.message).toMatch(
      /not in the workspace the "piece" collection is published from/
    );
    expect(
      (await world.members(siteId)).filter((m) => m.resource_id === id)
    ).toHaveLength(0);
  });

  it("a pod-wide record is still refused", async () => {
    const id = await essay(null, piece, "A pod-wide essay");
    const e = await errOf(owner.publishToSite({ siteId, entityIds: [id] }));
    expect(e?.code).toBe("BAD_REQUEST");
    expect(e?.message).toMatch(/pod-wide record/);
  });

  it("a collection with NO source behaves as before: a record of another space joins", async () => {
    const note = await profileIn("note", null);
    const res = await configure({
      piece: { sourceWorkspaceId: CONTENT, slugField: "slug" },
      note: {},
    });
    expect(res.status).toBe("updated");
    const id = await essay(OTHER, note, "A note from elsewhere");
    const pub = await owner.publishToSite({ siteId, entityIds: [id] });
    expect(pub).toMatchObject({
      status: "published",
      published: [{ entityId: id, collection: "note" }],
    });
  });
});

describe("the public manifest never carries the source space", () => {
  it("lists the collection without any workspace id", async () => {
    const res = await publicApp.request(`/public/sites/${token}`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain('"piece"');
    for (const ws of [CONTENT, BRAND, OTHER]) expect(text).not.toContain(ws);
    expect(text).not.toContain("sourceWorkspaceId");
  });
});
