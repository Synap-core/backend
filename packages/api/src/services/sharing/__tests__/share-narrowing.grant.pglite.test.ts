/**
 * The NARROWING share doors are bounded by the KEY'S GRANT (ticket 14412a6d).
 *
 * `POST /shares/unpublish`, `/shares/publication/revoke` (permanent: the 0276
 * trigger freezes a revoked row), `/shares/sites/:id/unpublish`,
 * `/shares/sites/:id/revoke`, `/shares/unshare` and `/shares/links/:id/revoke`
 * checked the scope and the person's floor only: a pod app acting as the
 * person, given nothing about sharing (or another space), took records off
 * the web and killed public urls for good. Each core now asks the key's grant
 * (`grantWriteDenial`): `share.update` to unpublish, `share.delete` to revoke
 * or unshare, in the space (and project) the act lands in. No grant = a
 * signed-in person, unchanged.
 *
 * Driven through the REAL Hub REST `/shares/*` routes behind a stand-in for
 * the auth middleware (the person as `userId`, no agent, the REAL door fence,
 * then `runWithGrant`), the REAL share / publish / site cores and the REAL
 * 0276 migration on PGlite. The gate is the thin adapter of the site suites
 * (rung 0 = the REAL `grantWriteDenial`; a person is granted).
 *
 * Not covered: `resolveKeyIdentity`, the gate's RBAC rungs, production
 * Postgres.
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
vi.mock("../../../utils/permission-check.js", async () => {
  const { grantWriteDenial } =
    await import("../../../utils/grant-write-check.js");
  return {
    checkPermissionOrPropose: vi.fn(async (opts: Record<string, unknown>) => {
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
import { registerSharesRoutes } from "../../../routers/hub-protocol/rest/shares.js";
import {
  isFencedGrant,
  restDoorAllowed,
} from "../../../access/grant-door-fence.js";
import { createSiteSchema, sitePolicy, siteWorld } from "./site-fixture.js";

const A = randomUUID(); // the person: owner of W, W2 and P
const W = randomUUID(); // the space the app was given
const W2 = randomUUID(); // another space of A's the app was not given
const P = randomUUID(); // a project of W: the site, and the links' anchor
const APP = "studio.example.com";

const human = sharesRouter.createCaller({
  authenticated: true,
  workspaceId: null,
  userId: A,
} as never);

const SCOPES = ["hub-protocol.read", "hub-protocol.write"];

function keyApp(grant: KeyGrant) {
  const app = new OpenAPIHono();
  app.use("/*", async (c, next) => {
    c.set("userId" as never, A as never);
    c.set("scopes" as never, SCOPES as never);
    c.set("keyType" as never, APP_PERSON_KEY_TYPE as never);
    if (
      isFencedGrant(grant) &&
      !restDoorAllowed(c.req.method, c.req.path, grant)
    ) {
      return c.json({ code: "GRANT_DOOR_UNSUPPORTED" }, 403);
    }
    return runWithGrant(grant, () => next());
  });
  registerSharesRoutes(app as never);
  return app;
}

const appGrant = (permissions: string[], workspaceIds = [W]): KeyGrant => ({
  clientId: APP,
  scopes: [{ permissions, workspaceIds }],
});
/** What the ticket's app was given: people, nothing about sharing. */
const reader = () =>
  keyApp(appGrant(["entity.person.read", "entity.person.create"]));
/** An app the person let narrow what it shares, in W only. */
const narrower = () => keyApp(appGrant(["share.update", "share.delete"]));

const post = (app: OpenAPIHono, path: string, body?: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function expectGrantRefusal(res: Response, verb: "update" | "delete") {
  expect(res.status).toBe(403);
  expect(((await res.json()) as { error?: string }).error).toMatch(
    new RegExp(`grant does not allow "share\\.${verb}"`)
  );
}

let world: ReturnType<typeof siteWorld>;
const rec: Record<string, string> = {};
let siteId = "";
let linkId = "";

/** The record's PUBLIC publication row (not a site member, not a link). */
async function publication(entityId: string) {
  const { rows } = await world.q<Record<string, any>>(
    `select state, revoked_at from resource_shares
      where resource_type='entity' and resource_id=$1 and audience='public' and site_share_id is null`,
    [entityId]
  );
  return rows[0];
}
async function shareRow(id: string) {
  const { rows } = await world.q<Record<string, any>>(
    `select state, revoked_at from resource_shares where id=$1`,
    [id]
  );
  return rows[0];
}

beforeAll(async () => {
  await createSiteSchema(h.client!);
  world = siteWorld(h.client!);
  await world.user(A);
  await world.podOwner(A);
  await world.workspace(W, A);
  await world.workspace(W2, A);
  await world.project(P, A, W);
  const paper = await world.profile("paper");
  for (const ws of [W, W2]) {
    await human.setPolicy({ workspaceId: ws, policy: sitePolicy() });
  }
  for (const [name, ws] of [
    ["pub", W],
    ["revoke", W],
    ["far", W2],
    ["site", W],
    ["link", W],
  ] as const) {
    const r = await world.record({
      ownerId: A,
      workspaceId: ws,
      profileId: paper,
      title: `${name} title`,
      properties: { year: 2020 },
    });
    rec[name] = r.id;
  }
  for (const name of ["pub", "revoke", "far"]) {
    const res = await human.publish({
      resourceType: "entity",
      resourceId: rec[name]!,
    });
    expect(res.status).toBe("published");
  }
  // The person's live site, with one record on it.
  await world.fileInto(rec.site!, P, A);
  const c = await human.configureSite({
    projectId: P,
    config: {
      version: 1,
      collections: { paper: { sort: ["-year"], slugField: "title" } },
    },
  });
  if (c.status === "proposed") throw new Error("unreachable");
  siteId = c.siteId;
  await human.publishSite({ siteId });
  await human.publishToSite({ siteId, entityIds: [rec.site!] });
  // A link into P.
  const l = await human.share({
    resourceType: "entity",
    resourceId: rec.link!,
    anchorProjectId: P,
    audience: "link",
  });
  if (l.status === "proposed") throw new Error("unreachable");
  linkId = l.shareId!;
}, 120_000);

describe("a record's publication: unpublish and revoke need the grant", () => {
  it("unpublish by an app given nothing about sharing → 403, still published", async () => {
    await expectGrantRefusal(
      await post(reader(), "/shares/unpublish", {
        resourceType: "entity",
        resourceId: rec.pub,
      }),
      "update"
    );
    expect(await publication(rec.pub!)).toMatchObject({ state: "published" });
  });

  it("revoke (permanent) by an app given nothing about sharing → 403, the url lives", async () => {
    await expectGrantRefusal(
      await post(reader(), "/shares/publication/revoke", {
        resourceType: "entity",
        resourceId: rec.revoke,
      }),
      "delete"
    );
    expect(await publication(rec.revoke!)).toMatchObject({
      state: "published",
      revoked_at: null,
    });
  });

  it("a space the grant does not name → 403 for both, nothing changed", async () => {
    const body = { resourceType: "entity", resourceId: rec.far };
    await expectGrantRefusal(
      await post(narrower(), "/shares/unpublish", body),
      "update"
    );
    await expectGrantRefusal(
      await post(narrower(), "/shares/publication/revoke", body),
      "delete"
    );
    expect(await publication(rec.far!)).toMatchObject({
      state: "published",
      revoked_at: null,
    });
  });

  it("an app given share.update / share.delete in the record's space → both go through", async () => {
    const un = await post(narrower(), "/shares/unpublish", {
      resourceType: "entity",
      resourceId: rec.pub,
    });
    expect(un.status).toBe(200);
    expect(((await un.json()) as any).status).toBe("unpublished");
    const rv = await post(narrower(), "/shares/publication/revoke", {
      resourceType: "entity",
      resourceId: rec.revoke,
    });
    expect(rv.status).toBe(200);
    expect(((await rv.json()) as any).status).toBe("revoked");
    expect((await publication(rec.revoke!))!.revoked_at).not.toBeNull();
  });
});

describe("the same rung on the site and link doors", () => {
  it("site record unpublish, site unpublish and site revoke → 403, the site and its member stay live", async () => {
    await expectGrantRefusal(
      await post(reader(), `/shares/sites/${siteId}/unpublish`, {
        entityIds: [rec.site],
      }),
      "update"
    );
    await expectGrantRefusal(
      await post(reader(), `/shares/sites/${siteId}/unpublish`),
      "update"
    );
    await expectGrantRefusal(
      await post(reader(), `/shares/sites/${siteId}/revoke`),
      "delete"
    );
    expect(await shareRow(siteId)).toMatchObject({
      state: "published",
      revoked_at: null,
    });
    const live = (await world.members(siteId)).filter(
      (m) => m.resource_id === rec.site && m.state === "published"
    );
    expect(live).toHaveLength(1);
  });

  it("link revoke and unshare → 403, the link lives", async () => {
    await expectGrantRefusal(
      await post(reader(), `/shares/links/${linkId}/revoke`, {}),
      "delete"
    );
    await expectGrantRefusal(
      await post(reader(), "/shares/unshare", {
        resourceType: "entity",
        resourceId: rec.link,
        anchorProjectId: P,
      }),
      "delete"
    );
    expect((await shareRow(linkId))!.revoked_at).toBeNull();
  });

  it("an app given the verbs in W → each goes through", async () => {
    const un = await post(narrower(), `/shares/sites/${siteId}/unpublish`, {
      entityIds: [rec.site],
    });
    expect(un.status).toBe(200);
    expect(((await un.json()) as any).status).toBe("unpublished");
    const rv = await post(narrower(), `/shares/sites/${siteId}/revoke`);
    expect(rv.status).toBe(200);
    expect(((await rv.json()) as any).status).toBe("revoked");
    const lk = await post(narrower(), `/shares/links/${linkId}/revoke`, {});
    expect(lk.status).toBe(200);
    expect(((await lk.json()) as any).status).toBe("revoked");
    const us = await post(narrower(), "/shares/unshare", {
      resourceType: "entity",
      resourceId: rec.link,
      anchorProjectId: P,
    });
    expect(us.status).toBe(200);
  });
});
