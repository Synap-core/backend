/**
 * A POD APP ACTING AS THE PERSON at the site doors (finding 67ea991f, and
 * f4f0cbf4 for the status read), end to end on PGlite.
 *
 * backend#1046: every pod app acts as the person who connects it. Its token
 * (`api_keys.key_type = 'app_person'`) resolves AS the person, with no agent,
 * its grant cut down to what the app may give them (`access/key-identity.ts`).
 * The share doors' attribution floor refused exactly that key ("not
 * attributed to either"), so Content Studio could neither choose what the
 * person's site shows nor publish a piece to it.
 *
 * Driven through the REAL Hub REST `/shares/*` routes behind a stand-in for
 * the auth middleware that sets what the real one sets for such a key
 * (`keyType` from the key row, the person as `userId`, no `agentUserId`),
 * runs the REAL door fence (`restDoorAllowed`) and enters the key's grant
 * (`runWithGrant`). The site core and the public manifest are REAL; the gate
 * is the thin adapter of `site-service.pglite.test.ts` (rung 0 = the REAL
 * `grantWriteDenial`; a person is granted).
 *
 * What this cannot see: `resolveKeyIdentity` itself (pinned by the pod-app
 * suites of #1046), the gate's RBAC rungs, production Postgres.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | import("./site-fixture.js").PgClient,
  db: null as unknown,
  gateCalls: [] as Array<Record<string, unknown>>,
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
vi.mock("../../../utils/permission-check.js", async () => {
  const { grantWriteDenial } =
    await import("../../../utils/grant-write-check.js");
  return {
    checkPermissionOrPropose: vi.fn(async (opts: Record<string, unknown>) => {
      h.gateCalls.push(opts);
      // Rung 0 of the production gate, verbatim inputs.
      const grantDenied = await grantWriteDenial({
        subjectType: opts.subjectType as string,
        action: opts.action as string,
        workspaceId: opts.workspaceId as string | undefined,
        projectId: opts.projectId as string | undefined,
        data: opts.data as Record<string, unknown> | undefined,
      });
      if (grantDenied) return { denied: true, reason: grantDenied };
      if (opts.agentUserId) throw new Error("no agent in this suite");
      return { granted: true };
    }),
    previewPermissionDecision: vi.fn(),
    proposedMessageFor: vi.fn(() => "proposed"),
  };
});
vi.mock("../../../utils/audit-log.js", () => ({ auditLog: vi.fn() }));
vi.mock("../../../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));

import { OpenAPIHono } from "@hono/zod-openapi";
import { runWithGrant, type KeyGrant } from "@synap/database";
import { APP_PERSON_KEY_TYPE } from "@synap/database/schema";
import { sharesRouter } from "../../../routers/shares.js";
import { registerPublicSitesRoutes } from "../../../routers/hub-protocol/rest/public-sites.js";
import { registerSharesRoutes } from "../../../routers/hub-protocol/rest/shares.js";
import {
  isFencedGrant,
  restDoorAllowed,
} from "../../../access/grant-door-fence.js";
import { createSiteSchema, sitePolicy, siteWorld } from "./site-fixture.js";

// ── Principals / fixtures ──
const A = randomUUID(); // the person: owner of W, W2 and every project
const W = randomUUID(); // the site's home space (the app's space)
const W2 = randomUUID(); // another space of A's the app was not given
const P = randomUUID(); // the project whose site the app runs
const P_NEW = randomUUID(); // a project with no site yet
const APP = "app_content-studio-test"; // the app's public id (grant.clientId)

const human = sharesRouter.createCaller({
  authenticated: true,
  workspaceId: null,
  userId: A,
} as never);

const publicApp = new OpenAPIHono();
registerPublicSitesRoutes(publicApp as never);
async function manifest(token: string) {
  const res = await publicApp.request(`/public/sites/${token}`);
  return { status: res.status, body: (await res.json()) as any };
}

const SCOPES = ["hub-protocol.read", "hub-protocol.write"];

/**
 * The request as the real auth middleware leaves it for a key: the key ROW's
 * type, the person as `userId`, an agent only for an agent key, the real
 * door fence, then the key's grant entered for the handler.
 */
function keyApp(keyType: string, grant: KeyGrant) {
  const app = new OpenAPIHono();
  app.use("/*", async (c, next) => {
    c.set("userId" as never, A as never);
    c.set("scopes" as never, SCOPES as never);
    c.set("keyType" as never, keyType as never);
    if (isFencedGrant(grant) && !restDoorAllowed(c.req.method, c.req.path, grant)) {
      return c.json({ code: "GRANT_DOOR_UNSUPPORTED" }, 403);
    }
    return runWithGrant(grant, () => next());
  });
  registerSharesRoutes(app as never);
  return app;
}

/** What `classifyAppPersonKey` hands the request: the app's grant in its spaces. */
const appGrant = (permissions: string[], workspaceIds = [W]): KeyGrant => ({
  clientId: APP,
  scopes: [{ permissions, workspaceIds }],
});
const SITE_APP = appGrant(["share.create", "entity.read"]);
const appPerson = () => keyApp(APP_PERSON_KEY_TYPE, SITE_APP);

const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const configure = (app: OpenAPIHono, projectId: string, config: unknown) =>
  app.request("/shares/sites", json({ projectId, config }));
const publishTo = (app: OpenAPIHono, siteId: string, entityIds: string[]) =>
  app.request(`/shares/sites/${siteId}/publish`, json({ entityIds }));

const CONFIG = {
  version: 1,
  collections: { paper: { sort: ["-year"], slugField: "title" } },
};
const CONFIG_2 = {
  version: 1,
  collections: { paper: { sort: ["title"], slugField: "title", pageSize: 20 } },
};

let world: ReturnType<typeof siteWorld>;
let site = { siteId: "", token: "" };
const rec: Record<string, string> = {};

async function siteRow(projectId: string) {
  const { rows } = await world.q<Record<string, any>>(
    `select * from resource_shares where resource_type='project' and resource_id=$1 and revoked_at is null`,
    [projectId]
  );
  return rows;
}

beforeAll(async () => {
  await createSiteSchema(h.client!);
  world = siteWorld(h.client!);
  await world.user(A);
  await world.podOwner(A);
  await world.workspace(W, A);
  await world.workspace(W2, A);
  await world.project(P, A, W);
  await world.project(P_NEW, A, W);
  const paper = await world.profile("paper");
  for (const ws of [W, W2]) {
    await human.setPolicy({ workspaceId: ws, policy: sitePolicy() });
  }
  // The person's live site, made in the pod (going live is theirs alone).
  const c = await human.configureSite({ projectId: P, config: CONFIG });
  if (c.status === "proposed") throw new Error("unreachable");
  const live = await human.publishSite({ siteId: c.siteId });
  site = { siteId: c.siteId, token: live.token! };
  for (const [name, ws] of [
    ["one", W],
    ["two", W],
    ["far", W2],
  ] as const) {
    const r = await world.record({
      ownerId: A,
      workspaceId: ws,
      profileId: paper,
      title: `${name} title`,
      properties: { year: 2020 },
    });
    await world.fileInto(r.id, P, A);
    rec[name] = r.id;
  }
  // A record of W2 already on the site, published by the person in the pod.
  await human.publishToSite({ siteId: site.siteId, entityIds: [rec.far!] });
}, 120_000);

describe("an app the person signed in to configures their site AS them", () => {
  it("a first configure → the site is CREATED (not proposed), with no token", async () => {
    const before = h.gateCalls.length;
    const res = await configure(appPerson(), P_NEW, CONFIG);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).status).toBe("created");
    // The gate ran as the person (no agent), on the site's space and project.
    expect(h.gateCalls.length).toBe(before + 1);
    expect(h.gateCalls.at(-1)).toMatchObject({
      userId: A,
      subjectType: "share",
      action: "create",
      workspaceId: W,
      projectId: P_NEW,
    });
    expect(h.gateCalls.at(-1)!.agentUserId).toBeUndefined();
    const [row] = await siteRow(P_NEW);
    expect(row).toMatchObject({ state: "draft", token_hash: null });
  });

  it("choosing the collections of the LIVE site replaces its config, the token kept", async () => {
    const res = await configure(appPerson(), P, CONFIG_2);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).status).toBe("updated");
    const [row] = await siteRow(P);
    expect(row!.site_config.collections.paper).toMatchObject({
      sort: ["title"],
      pageSize: 20,
    });
    expect((await manifest(site.token)).status).toBe(200);
  });
});

describe("an app the person signed in to publishes to their site AS them", () => {
  it("a record of the app's space → published at once, served by the live site", async () => {
    const res = await publishTo(appPerson(), site.siteId, [rec.one!]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.status).toBe("published");
    expect(body.published.map((m: any) => m.entityId)).toEqual([rec.one]);
    expect(h.gateCalls.at(-1)!.agentUserId).toBeUndefined();
    const members = await world.members(site.siteId);
    expect(members.map((m) => m.resource_id)).toContain(rec.one);
  });

  it("a record of a space the app was not given → 403 by the grant, nothing published", async () => {
    await human.unpublishFromSite({
      siteId: site.siteId,
      entityIds: [rec.far!],
    });
    const before = h.gateCalls.length;
    const res = await publishTo(appPerson(), site.siteId, [rec.far!]);
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error).toMatch(
      new RegExp(`grant does not allow "share.create".*${W2}`)
    );
    expect(h.gateCalls.length).toBe(before);
    const live = (await world.members(site.siteId)).filter(
      (m) => m.resource_id === rec.far && m.state === "published"
    );
    expect(live).toHaveLength(0);
    await human.publishToSite({ siteId: site.siteId, entityIds: [rec.far!] });
  });
});

describe("what stays refused", () => {
  it("an app NOT given share.create → 403 by the gate's grant rung at both doors, nothing written", async () => {
    const reader = keyApp(APP_PERSON_KEY_TYPE, appGrant(["entity.read"]));
    const before = (await siteRow(P))[0]!.site_config;
    const c = await configure(reader, P, CONFIG);
    expect(c.status).toBe(403);
    expect(((await c.json()) as any).error).toMatch(
      /grant does not allow "share.create"/
    );
    expect((await siteRow(P))[0]!.site_config).toEqual(before);
    const p = await publishTo(reader, site.siteId, [rec.two!]);
    expect(p.status).toBe(403);
    expect(((await p.json()) as any).error).toMatch(
      /grant does not allow "share.create"/
    );
    expect(
      (await world.members(site.siteId)).map((m) => m.resource_id)
    ).not.toContain(rec.two);
  });

  it("an unattributed key with the SAME grant (a bare user_pat) is refused at the floor, before the gate", async () => {
    for (const keyType of ["user_pat", "service", "hub_inbound"]) {
      const bare = keyApp(keyType, SITE_APP);
      const before = h.gateCalls.length;
      const c = await configure(bare, P, CONFIG);
      expect(c.status, keyType).toBe(403);
      expect(((await c.json()) as any).error).toMatch(/none of them/);
      const p = await publishTo(bare, site.siteId, [rec.two!]);
      expect(p.status, keyType).toBe(403);
      expect(((await p.json()) as any).error).toMatch(/none of them/);
      expect(h.gateCalls.length, keyType).toBe(before);
    }
    expect(
      (await world.members(site.siteId)).map((m) => m.resource_id)
    ).not.toContain(rec.two);
  });

  it("going live and rotating the site's token stay a signed-in person's acts: refused to the app", async () => {
    const app = sharesRouter.createCaller({
      authenticated: true,
      workspaceId: null,
      userId: A,
      keyType: APP_PERSON_KEY_TYPE,
    } as never);
    for (const act of [
      () => app.publishSite({ siteId: site.siteId }),
      () => app.rotateSiteToken({ siteId: site.siteId }),
    ]) {
      await expect(act()).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect((await manifest(site.token)).status).toBe(200);
  });

  it("a publication made by the app hands it no secret (the owner mints it in the pod)", async () => {
    const res = await appPerson().request(
      "/shares/publish",
      json({ resourceType: "entity", resourceId: rec.two })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.status).toBe("published");
    expect(body.hasToken).toBe(false);
    expect(body.token).toBeUndefined();
  });
});

describe("the app reads its site (GET /shares/sites, finding f4f0cbf4)", () => {
  it("by project and by id: the config it edits; only the members of its spaces", async () => {
    const app = appPerson();
    const byProject = await app.request(`/shares/sites?projectId=${P}`);
    expect(byProject.status).toBe(200);
    const st = (await byProject.json()) as any;
    expect(st).toMatchObject({ siteId: site.siteId, projectId: P, live: true });
    expect(st.config.collections.paper).toMatchObject({
      sort: ["title"],
      pageSize: 20,
    });
    expect(JSON.stringify(st)).not.toContain(site.token);
    const ids = st.members.map((m: any) => m.entityId);
    expect(ids).toContain(rec.one);
    expect(ids).not.toContain(rec.far);
    expect(st.membersTotal).toBe(ids.length);
    // The person in the pod sees the W2 record too.
    const mine = await human.siteStatus({ siteId: site.siteId });
    expect(mine!.members.map((m) => m.entityId)).toContain(rec.far);
    const byId = await app.request(`/shares/sites/${site.siteId}`);
    expect(byId.status).toBe(200);
    expect(((await byId.json()) as any).siteId).toBe(site.siteId);
    const none = await app.request(`/shares/sites?projectId=${P_NEW}`);
    expect(none.status).toBe(200);
  });

  it("an app NOT given share.create is refused by the door fence", async () => {
    const reader = keyApp(APP_PERSON_KEY_TYPE, appGrant(["entity.read"]));
    const res = await reader.request(`/shares/sites?projectId=${P}`);
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).code).toBe("GRANT_DOOR_UNSUPPORTED");
  });

  it("an app given share.create in ANOTHER space → the same 404 as a missing site", async () => {
    const elsewhere = keyApp(
      APP_PERSON_KEY_TYPE,
      appGrant(["share.create"], [W2])
    );
    expect(
      (await elsewhere.request(`/shares/sites?projectId=${P}`)).status
    ).toBe(404);
    expect(
      (await elsewhere.request(`/shares/sites/${site.siteId}`)).status
    ).toBe(404);
  });
});
