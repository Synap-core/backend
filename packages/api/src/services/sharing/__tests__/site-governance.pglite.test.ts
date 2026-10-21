/**
 * T8 + T9 — GOVERNANCE of publishing records into a site (collection door
 * C1b, D5), end to end on PGlite.
 *
 * Driven through the REAL `shares` tRPC router (`publishToSite`,
 * `unpublishFromSite`), the REAL Hub REST `POST /shares/sites/:id/publish`
 * (behind a stand-in for the auth middleware that runs the request inside
 * `runWithGrant` with a grant RESOLVED FROM REAL `grants` ROWS by the REAL
 * `GrantRepository.resolveForKey`), the REAL site core and the REAL
 * `share/create` approval executor; read back through the REAL manifest route.
 *
 * THE GATE is the thin adapter of `site-service.pglite.test.ts`: rung 0 is the
 * REAL `grantWriteDenial` on the gate's own input, then an agent goes through
 * the REAL `resolveAgentGovernanceDecision` (share.create is ADMIN-floored →
 * propose), a human is granted. What this cannot see: the gate's own proposal
 * insert / notifications, production Postgres.
 *
 * Pinned:
 *   T8 an agent's batch is exactly ONE proposal carrying ids and the site's
 *      project (never values), even under widening governance rules; nothing
 *      is written until approval; an editor who does not administer the
 *      project, a stranger and an unattributed key are refused, not proposed;
 *      a project-X-narrowed key is DENIED (not proposed) for project Y's site
 *      and proposes for its own; a workspace-narrowed key cannot propose a
 *      record of a space outside its grant;
 *   T9 approval re-plans EVERY record NOW on the proposal's subject: a record
 *      whose space's policy was tightened and one taken out of the project
 *      are skipped and reported (receipt `refusals`); the rest is LIVE AT
 *      ONCE (no token of its own); a site revoked meanwhile refuses the whole
 *      approval.
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
  const { resolveAgentGovernanceDecision } =
    await import("@synap/database/agent-governance");
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
      const agentUserId = opts.agentUserId as string | undefined;
      if (!agentUserId) return { granted: true };
      const gov = await resolveAgentGovernanceDecision({
        db: h.db as never,
        agentUserId,
        workspaceId: opts.workspaceId as string,
        subjectType: opts.subjectType as string,
        action: opts.action as string,
        preferAgentMetadataAutoApproveFor: true,
      } as never);
      if (gov.decision === "execute") return { granted: true };
      if (gov.decision === "deny") return { denied: true, reason: gov.reason };
      return {
        granted: false,
        proposalId: randomUUID(),
        proposalType: `${opts.subjectType}.${opts.action}`,
        summary: "",
        reasoning: "",
        reviewPath: "",
        reviewUrl: "",
      };
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
import { GrantRepository, runWithGrant } from "@synap/database";
import { sharesRouter } from "../../../routers/shares.js";
import { registerPublicSitesRoutes } from "../../../routers/hub-protocol/rest/public-sites.js";
import { registerSharesRoutes } from "../../../routers/hub-protocol/rest/shares.js";
import { proposalExecRegistry } from "../../../routers/proposals/execution-registry.js";
import {
  createSiteSchema,
  errOf,
  sitePolicy,
  siteWorld,
} from "./site-fixture.js";

// ── Principals / fixtures ──
const A = randomUUID(); // owner of W, W2 and every project; human
const AG = randomUUID(); // agent acting for A (editor of W)
const E = randomUUID(); // an EDITOR of W: not the project's owner, not admin
const R = randomUUID(); // a person with no access
const W = randomUUID(); // the home space
const W2 = randomUUID(); // another space A owns: records from there join P's site
const P = randomUUID(); // the site project
const P_KEY = randomUUID(); // the project a narrowed key is pinned to
const P_REV = randomUUID(); // a site revoked while a proposal waits

const caller = (ctx: Record<string, unknown>) =>
  sharesRouter.createCaller({
    authenticated: true,
    workspaceId: null,
    ...ctx,
  } as never);
const human = (userId: string) => caller({ userId });
const agent = caller({ userId: A, agentUserId: AG, keyType: "agent" });
const bareKey = caller({ userId: A, keyType: "user_pat" });

const publicApp = new OpenAPIHono();
registerPublicSitesRoutes(publicApp as never);
async function manifest(token: string) {
  const res = await publicApp.request(`/public/sites/${token}`);
  return { status: res.status, body: (await res.json()) as any };
}

function hubApp(ctx: Record<string, unknown>, grant?: unknown) {
  const app = new OpenAPIHono();
  app.use("/*", async (c, next) => {
    for (const [k, v] of Object.entries(ctx)) c.set(k as never, v as never);
    if (grant) return runWithGrant(grant as never, () => next());
    await next();
  });
  registerSharesRoutes(app as never);
  return app;
}
const SCOPES = ["hub-protocol.read", "hub-protocol.write"];
const agentCtx = {
  userId: A,
  agentUserId: AG,
  keyType: "agent",
  scopes: SCOPES,
};

/** A REAL grants row for a fresh key id, resolved by the REAL repository. */
async function keyGrant(narrow: {
  projectIds?: string[];
  workspaceIds?: string[];
}) {
  const keyId = randomUUID();
  await world.q(
    `insert into grants (id, api_key_id, principal_user_id, on_behalf_of, permissions, workspace_ids, project_ids, created_by, created_at)
     values ($1,$2,$3,$4,ARRAY['*'],$5::uuid[],$6::uuid[],$4, now())`,
    [
      randomUUID(),
      keyId,
      AG,
      A,
      narrow.workspaceIds ?? null,
      narrow.projectIds ?? null,
    ]
  );
  return new GrantRepository(h.db as never).resolveForKey(keyId);
}

const CONFIG = {
  version: 1,
  collections: { paper: { sort: ["-year"], slugField: "title" } },
};

let world: ReturnType<typeof siteWorld>;
let paper = "";
const sites: Record<string, { siteId: string; token: string }> = {};
const rec: Record<string, string> = {};

async function liveSite(projectId: string) {
  const c = await human(A).configureSite({ projectId, config: CONFIG });
  if (c.status === "proposed") throw new Error("unreachable");
  const live = await human(A).publishSite({ siteId: c.siteId });
  return { siteId: c.siteId, token: live.token! };
}

async function paperIn(
  name: string,
  workspaceId: string,
  projectId: string | null
) {
  const r = await world.record({
    ownerId: A,
    workspaceId,
    profileId: paper,
    title: `${name} title`,
    properties: { year: 2020, secretNote: `${name}-secret-value` },
  });
  if (projectId) await world.fileInto(r.id, projectId, A);
  rec[name] = r.id;
  return r.id;
}

function approve(payload: Record<string, unknown>) {
  const proposalId = randomUUID();
  return proposalExecRegistry.resolve("share/create", "create")!.execute({
    proposal: {
      id: proposalId,
      targetType: "share",
      proposalType: "create",
      data: { data: payload },
      subjectUserId: A,
      agentUserId: AG,
      workspaceId: W,
    },
    userId: A,
    input: { proposalId },
    deps: { emitProposalReviewed: vi.fn(), reportProposalOutcome: vi.fn() },
  } as never) as Promise<Record<string, any>>;
}

beforeAll(async () => {
  await createSiteSchema(h.client!);
  world = siteWorld(h.client!);
  for (const u of [A, E, R]) await world.user(u);
  await world.user(AG, "agent");
  await world.podOwner(A);
  await world.workspace(W, A, [
    [AG, "editor"],
    [E, "editor"],
  ]);
  await world.workspace(W2, A, [[AG, "editor"]]);
  for (const p of [P, P_KEY, P_REV]) await world.project(p, A, W);
  paper = await world.profile("paper");
  for (const ws of [W, W2]) {
    await human(A).setPolicy({ workspaceId: ws, policy: sitePolicy() });
  }
  sites.P = await liveSite(P);
  sites.KEY = await liveSite(P_KEY);
  sites.REV = await liveSite(P_REV);
  await paperIn("one", W, P);
  await paperIn("two", W, P);
  await paperIn("three", W2, P);
  await paperIn("unfiled", W, null);
  await paperIn("keyed", W, P_KEY);
  await paperIn("rev", W, P_REV);
}, 120_000);

describe("T8: who may publish records into a site", () => {
  it("an editor who does not administer the project, a stranger and an unattributed key are REFUSED, never proposed", async () => {
    const before = h.gateCalls.length;
    for (const who of [human(E), human(R), bareKey]) {
      const e = await errOf(
        who.publishToSite({ siteId: sites.P!.siteId, entityIds: [rec.one!] })
      );
      expect(e?.code).toBe("FORBIDDEN");
    }
    expect(h.gateCalls.length).toBe(before);
    expect(await world.members(sites.P!.siteId)).toHaveLength(0);
  });

  it("an agent's batch → exactly ONE proposal: ids + the site's project, never values; nothing written; an unpublishable record reported up front", async () => {
    const before = h.gateCalls.length;
    const res = await agent.publishToSite({
      siteId: sites.P!.siteId,
      entityIds: [rec.one!, rec.two!, rec.three!, rec.unfiled!],
      reasoning: "the lab wants its papers online",
    });
    expect(res.status).toBe("proposed");
    if (res.status !== "proposed") throw new Error("unreachable");
    expect(res.skipped).toEqual([
      expect.objectContaining({ entityId: rec.unfiled, code: "BAD_REQUEST" }),
    ]);
    expect(h.gateCalls.length - before).toBe(1);
    const gate = h.gateCalls.at(-1)!;
    expect(gate).toMatchObject({
      subjectType: "share",
      action: "create",
      agentUserId: AG,
      workspaceId: W,
      projectId: P,
    });
    expect(gate.data).toMatchObject({
      op: "publish_records",
      audience: "public",
      siteId: sites.P!.siteId,
      projectId: P,
      entityIds: [rec.one, rec.two, rec.three],
    });
    // Ids only: no snapshot value ever travels in the proposal.
    expect(JSON.stringify(gate.data)).not.toMatch(/title|secret-value/);
    expect(await world.members(sites.P!.siteId)).toHaveLength(0);
  });

  it("ADMIN floor: widening governance rules never let the agent publish directly", async () => {
    for (const [pattern, principal] of [
      ["*", "any"],
      ["share.create", "agent"],
    ] as const) {
      await world.q(
        `insert into governance_rules (id, principal_kind, agent_user_id, scope_kind, workspace_id, target_kind, target_pattern, verdict, created_by)
         values ($1,$2,$3,'workspace',$4,'action',$5,'auto','test')`,
        [randomUUID(), principal, principal === "agent" ? AG : null, W, pattern]
      );
    }
    const res = await agent.publishToSite({
      siteId: sites.P!.siteId,
      entityIds: [rec.one!],
    });
    expect(res.status).toBe("proposed");
    expect(await world.members(sites.P!.siteId)).toHaveLength(0);
  });
});

describe("T9: approval re-plans every record NOW, on the proposal's subject", () => {
  it("a tightened policy and a record taken out of the project are SKIPPED with a reason; the rest is live at once, with no token", async () => {
    await agent.publishToSite({
      siteId: sites.P!.siteId,
      entityIds: [rec.one!, rec.two!, rec.three!],
    });
    const payload = h.gateCalls.at(-1)!.data as Record<string, unknown>;
    // While the proposal waits: W2 stops publishing entities, `two` leaves P.
    await human(A).setPolicy({
      workspaceId: W2,
      policy: sitePolicy({ entityRead: "denied" }),
    });
    await world.unfile(rec.two!, P);

    const out = await approve(payload);
    expect(out).toMatchObject({
      success: true,
      primaryId: sites.P!.siteId,
      effect: { applied: "verified", rows: 1, subject: "share" },
    });
    expect(out.refusals).toHaveLength(2);
    expect(out.refusals.find((r: string) => r.includes(rec.two!))).toMatch(
      /not filed into the site's project/
    );
    expect(out.refusals.find((r: string) => r.includes(rec.three!))).toMatch(
      /exposure policy does not allow/
    );

    const rows = await world.members(sites.P!.siteId);
    expect(rows.map((r) => r.resource_id)).toEqual([rec.one]);
    expect(rows[0]).toMatchObject({
      state: "published",
      token_hash: null,
      token_prefix: null,
      published_collection: "paper",
      workspace_id: W,
      published_properties: { title: "one title", year: 2020 },
    });
    expect(out.effect.ids).toEqual([rows[0]!.id]);
    // Live at once, through the site's token.
    const m = await manifest(sites.P!.token);
    expect(m.body.collections).toEqual([
      expect.objectContaining({ key: "paper", count: 1 }),
    ]);
    await human(A).setPolicy({ workspaceId: W2, policy: sitePolicy() });
    await world.fileInto(rec.two!, P, A);
  });

  it("nothing publishable at approval → applied: none WITH the reason, never a silent success", async () => {
    await agent.publishToSite({
      siteId: sites.P!.siteId,
      entityIds: [rec.three!],
    });
    const payload = h.gateCalls.at(-1)!.data as Record<string, unknown>;
    await human(A).setPolicy({
      workspaceId: W2,
      policy: sitePolicy({ entityRead: "denied" }),
    });
    const out = await approve(payload);
    expect(out.effect).toMatchObject({ applied: "none" });
    expect(out.effect.reason).toMatch(/refusals/);
    expect(out.refusals).toHaveLength(1);
    expect(
      (await world.members(sites.P!.siteId)).map((r) => r.resource_id)
    ).toEqual([rec.one]);
    await human(A).setPolicy({ workspaceId: W2, policy: sitePolicy() });
  });

  it("a site REVOKED while the proposal waited refuses the whole approval", async () => {
    await agent.publishToSite({
      siteId: sites.REV!.siteId,
      entityIds: [rec.rev!],
    });
    const payload = h.gateCalls.at(-1)!.data as Record<string, unknown>;
    await human(A).revokeSite({ siteId: sites.REV!.siteId });
    const e = await errOf(approve(payload));
    expect(e?.code).toBe("BAD_REQUEST");
    expect(e?.message).toMatch(/revoked/);
    expect(await world.members(sites.REV!.siteId)).toHaveLength(0);
  });

  it("a malformed stored payload is refused, nothing published", async () => {
    for (const bad of [
      { op: "publish_records", audience: "public", siteId: sites.P!.siteId },
      {
        op: "publish_records",
        audience: "public",
        siteId: sites.P!.siteId,
        entityIds: [42],
      },
      {
        op: "publish_records",
        audience: "link",
        siteId: sites.P!.siteId,
        entityIds: [rec.two],
      },
    ]) {
      expect((await errOf(approve(bad)))?.code).toBe("PRECONDITION_FAILED");
    }
    expect(
      (await world.members(sites.P!.siteId)).map((r) => r.resource_id)
    ).toEqual([rec.one]);
  });
});

describe("T8: Hub REST with a key narrowed by REAL grants rows", () => {
  const post = (app: OpenAPIHono, siteId: string, entityIds: string[]) =>
    app.request(`/shares/sites/${siteId}/publish`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entityIds }),
    });

  it("a key pinned to project X proposes for X's site (202) — the grant sees the site's project", async () => {
    const app = hubApp(agentCtx, await keyGrant({ projectIds: [P_KEY] }));
    const res = await post(app, sites.KEY!.siteId, [rec.keyed!]);
    expect(res.status).toBe(202);
    expect(((await res.json()) as any).status).toBe("proposed");
    expect(h.gateCalls.at(-1)).toMatchObject({ projectId: P_KEY });
    expect(await world.members(sites.KEY!.siteId)).toHaveLength(0);
  });

  it("the same key for project Y's site → 403 DENIED by the grant, never proposed", async () => {
    const app = hubApp(agentCtx, await keyGrant({ projectIds: [P_KEY] }));
    const res = await post(app, sites.P!.siteId, [rec.two!]);
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error).toMatch(/grant does not allow/);
    expect(
      (await world.members(sites.P!.siteId)).map((r) => r.resource_id)
    ).toEqual([rec.one]);
  });

  it("a key bound to the home space cannot propose a record of a space outside its grant", async () => {
    const app = hubApp(agentCtx, await keyGrant({ workspaceIds: [W] }));
    const before = h.gateCalls.length;
    const denied = await post(app, sites.P!.siteId, [rec.three!]);
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as any).error).toMatch(
      new RegExp(`grant does not allow.*${W2}`)
    );
    expect(h.gateCalls.length).toBe(before);
    const ok = await post(app, sites.P!.siteId, [rec.two!]);
    expect(ok.status).toBe(202);
  });

  it("validation: no ids, too many ids, a non-uuid → 400 before any gate", async () => {
    const app = hubApp(agentCtx);
    const before = h.gateCalls.length;
    for (const ids of [
      [],
      Array.from({ length: 201 }, () => randomUUID()),
      ["nope"],
    ]) {
      expect((await post(app, sites.P!.siteId, ids)).status).toBe(400);
    }
    expect(h.gateCalls.length).toBe(before);
  });
});

describe("unpublishing records from a site narrows: direct for an agent", () => {
  it("agent unpublishFromSite → direct; the count drops; again → none", async () => {
    expect(
      await agent.unpublishFromSite({
        siteId: sites.P!.siteId,
        entityIds: [rec.one!],
      })
    ).toEqual({
      status: "unpublished",
      siteId: sites.P!.siteId,
      entityIds: [rec.one],
    });
    const m = await manifest(sites.P!.token);
    expect(m.body.collections[0].count).toBe(0);
    expect(
      await agent.unpublishFromSite({
        siteId: sites.P!.siteId,
        entityIds: [rec.one!],
      })
    ).toMatchObject({ status: "none", entityIds: [] });
  });

  it("a stranger cannot unpublish records from the site", async () => {
    expect(
      (
        await errOf(
          human(R).unpublishFromSite({
            siteId: sites.P!.siteId,
            entityIds: [rec.one!],
          })
        )
      )?.code
    ).toBe("FORBIDDEN");
  });
});
