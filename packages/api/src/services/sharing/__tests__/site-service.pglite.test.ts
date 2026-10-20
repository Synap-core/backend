/**
 * THE SITE DOORS (collection door C1a), end to end on PGlite.
 *
 * Driven through the REAL `shares` tRPC router (configureSite / publishSite /
 * rotateSiteToken / unpublishSite / revokeSite / siteStatus), the REAL Hub
 * REST `/shares/sites*` routes, the REAL site core, the REAL `share/create`
 * approval executor, the REAL 0276 + 0336 constraints and trigger — and read
 * back through the REAL manifest route `GET /public/sites/:siteToken`.
 *
 * THE GATE is the thin adapter of `publish-door.pglite.test.ts` with ONE
 * addition: rung 0 is the REAL `grantWriteDenial` (what the production gate
 * runs first), so a project-narrowed key is judged on what the site door
 * actually puts in the gate input. An agent then goes through the REAL
 * `resolveAgentGovernanceDecision` (share.create is ADMIN-floored → propose);
 * a human is granted. What this cannot see: the gate's own proposal insert /
 * notifications, production Postgres.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
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
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { grantOfScope, runWithGrant } from "@synap/database";
import { sharesRouter } from "../../../routers/shares.js";
import { registerPublicSitesRoutes } from "../../../routers/hub-protocol/rest/public-sites.js";
import { registerSharesRoutes } from "../../../routers/hub-protocol/rest/shares.js";
import { proposalExecRegistry } from "../../../routers/proposals/execution-registry.js";

// ── Principals / fixtures ──
const A = randomUUID(); // owner of W, owner of every project; human
const AG = randomUUID(); // agent acting for A
const E = randomUUID(); // an EDITOR of W: not the projects' owner, not admin
const R = randomUUID(); // a person with no access to W
const W = randomUUID(); // the home space
const W2 = randomUUID(); // another space A owns
const P = randomUUID(); // a project in W — the site of the lifecycle tests
const P_POD = randomUUID(); // a pod-wide project (no workspace)
const P_AG = randomUUID(); // the project the agent proposes a site for
const P_KEY = randomUUID(); // the project a narrowed key is pinned to
const P_OTHER = randomUUID(); // a project that key is NOT pinned to

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const pk = c.primary
      ? ` primary key${type === "uuid" ? " default gen_random_uuid()" : ""}`
      : "";
    const def =
      !c.primary && c.hasDefault
        ? type.startsWith("timestamp")
          ? " default now()"
          : type === "uuid"
            ? " default gen_random_uuid()"
            : ""
        : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const caller = (ctx: Record<string, unknown>) =>
  sharesRouter.createCaller({
    authenticated: true,
    workspaceId: null,
    ...ctx,
  } as never);
const human = (userId: string) => caller({ userId });
const agent = caller({ userId: A, agentUserId: AG, keyType: "agent" });
const bareKey = caller({ userId: A, keyType: "user_pat" });

async function errOf(p: Promise<unknown>) {
  try {
    await p;
    return null;
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { code: e.code, message: e.message };
  }
}

// The REAL manifest route.
const publicApp = new OpenAPIHono();
registerPublicSitesRoutes(publicApp as never);
async function manifest(token: string) {
  const res = await publicApp.request(`/public/sites/${token}`);
  return { status: res.status, body: (await res.json()) as any };
}

// The REAL Hub REST share routes, behind a stand-in for the auth middleware
// (which, for a key, runs the request inside `runWithGrant`).
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

const DEFAULT_KIND = {
  guest: { read: "direct" as const, create: "proposal" as const },
  link: { read: "direct" as const, create: "proposal" as const },
  public: { read: "denied" as const, create: "denied" as const, fields: [] },
};
const OPEN = (fields: string[]) => ({
  guest: DEFAULT_KIND.guest,
  link: DEFAULT_KIND.link,
  public: { read: "direct" as const, create: "denied" as const, fields },
});
// Sites open in W: a project publishes its `title` only (not `description`);
// records publish `title` and `year`.
const SITE_POLICY = {
  version: 1 as const,
  kinds: {
    entity: OPEN(["title", "year"]),
    document: DEFAULT_KIND,
    view: DEFAULT_KIND,
    project: OPEN(["title"]),
  },
};
const CONFIG = {
  version: 1,
  collections: {
    paper: { sort: ["-year", "title"], slugField: "title" },
    member: { pageSize: 50 },
  },
};

const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
async function siteRows(projectId: string) {
  const { rows } = await q<Record<string, any>>(
    `select * from resource_shares where resource_type='project' and resource_id=$1 order by created_at`,
    [projectId]
  );
  return rows;
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const m of [
    "0276_exposure_substrate.sql",
    "0336_site_collections.sql",
  ]) {
    await h.client!.exec(
      readFileSync(
        path.resolve(here, `../../../../../database/migrations/${m}`),
        "utf8"
      )
    );
  }
  for (const u of [A, E, R]) {
    await q(`insert into users (id, email, user_type) values ($1,$2,'human')`, [
      u,
      `${u}@example.test`,
    ]);
  }
  await q(
    `insert into users (id, email, user_type, agent_metadata) values ($1,$2,'agent','{}'::jsonb)`,
    [AG, `${AG}@agents.test`]
  );
  for (const ws of [W, W2]) {
    await q(
      `insert into workspaces (id, name, owner_id, settings) values ($1,'W',$2,'{}'::jsonb)`,
      [ws, A]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
      [randomUUID(), ws, A]
    );
  }
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'editor'),($4,$2,$5,'editor')`,
    [randomUUID(), W, AG, randomUUID(), E]
  );
  await q(
    `insert into pod_members (id, user_id, pod_role) values ($1,$2,'owner')`,
    [randomUUID(), A]
  );
  for (const [id, ws, name] of [
    [P, W, "Lab Site"],
    [P_POD, null, "Pod project"],
    [P_AG, W, "Agent project"],
    [P_KEY, W, "Key project"],
    [P_OTHER, W, "Other project"],
  ] as Array<[string, string | null, string]>) {
    await q(
      `insert into projects (id, user_id, workspace_id, name, description, status) values ($1,$2,$3,$4,'Internal plans','active')`,
      [id, A, ws, name]
    );
  }
  // A workspace kind, a pod-wide kind, and a role.
  for (const [slug, kind, scope] of [
    ["paper", "kind", "workspace"],
    ["person", "kind", "pod"],
    ["member", "role", "workspace"],
  ]) {
    await q(
      `insert into profiles (id, slug, display_name, profile_kind, entity_scope) values ($1,$2,$2,$3,$4)`,
      [randomUUID(), slug, kind, scope]
    );
  }
}, 120_000);

describe("guards: the policy, the owner, the home space, the config", () => {
  it("configure is REFUSED while the home space's policy denies a public project (the default)", async () => {
    const e = await errOf(
      human(A).configureSite({ projectId: P, config: CONFIG })
    );
    expect(e?.code).toBe("FORBIDDEN");
    expect(await siteRows(P)).toHaveLength(0);
    await human(A).setPolicy({ workspaceId: W, policy: SITE_POLICY });
  });

  it("only the project's owner (or a space owner/admin) configures: a stranger, an editor and an unattributed key cannot", async () => {
    for (const who of [human(R), human(E), bareKey]) {
      expect(
        (await errOf(who.configureSite({ projectId: P, config: CONFIG })))?.code
      ).toBe("FORBIDDEN");
    }
    expect(await siteRows(P)).toHaveLength(0);
  });

  it("home space: a pod-wide project must name one; a project with a space cannot name another", async () => {
    const none = await errOf(
      human(A).configureSite({ projectId: P_POD, config: CONFIG })
    );
    expect(none?.code).toBe("BAD_REQUEST");
    expect(none?.message).toMatch(/homeWorkspaceId/);
    const other = await errOf(
      human(A).configureSite({
        projectId: P,
        homeWorkspaceId: W2,
        config: CONFIG,
      })
    );
    expect(other?.code).toBe("BAD_REQUEST");
    expect(await siteRows(P_POD)).toHaveLength(0);
    expect(await siteRows(P)).toHaveLength(0);
  });

  it.each([
    ["an unknown profile", { version: 1, collections: { nope: {} } }],
    ["a pod-wide kind", { version: 1, collections: { person: {} } }],
    [
      "a sort on a field the space does not publish",
      { version: 1, collections: { paper: { sort: ["secret"] } } },
    ],
    [
      "a slug field the space does not publish",
      { version: 1, collections: { paper: { slugField: "secret" } } },
    ],
    [
      "an unknown key (strict)",
      { version: 1, collections: { paper: { filter: "x" } } },
    ],
    [
      "more than 16 collections",
      {
        version: 1,
        collections: Object.fromEntries(
          Array.from({ length: 17 }, (_, i) => [`c${i}`, {}])
        ),
      },
    ],
    ["a future version", { version: 2, collections: {} }],
  ])("config with %s → BAD_REQUEST, nothing written", async (_l, config) => {
    expect(
      (await errOf(human(A).configureSite({ projectId: P, config })))?.code
    ).toBe("BAD_REQUEST");
    expect(await siteRows(P)).toHaveLength(0);
  });
});

describe("the owner's lifecycle: configure → go live → rotate → unpublish → live again", () => {
  let siteId = "";
  let token = "";

  it("configure (human) → a DRAFT site row with NO token; the gate carries the project", async () => {
    const res = await human(A).configureSite({ projectId: P, config: CONFIG });
    if (res.status === "proposed") throw new Error("unreachable");
    expect(res).toMatchObject({
      status: "created",
      state: "draft",
      hasToken: false,
    });
    siteId = res.siteId;
    const gate = h.gateCalls.at(-1)!;
    expect(gate).toMatchObject({
      subjectType: "share",
      action: "create",
      workspaceId: W,
      projectId: P,
    });
    expect(gate.data).toMatchObject({
      op: "configure_site",
      audience: "public",
      resourceType: "project",
      resourceId: P,
      projectId: P,
    });
    const rows = await siteRows(P);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: siteId,
      audience: "public",
      state: "draft",
      workspace_id: W,
      site_share_id: null,
      token_hash: null,
      anchor_project_id: null,
    });
    expect(Object.keys(rows[0]!.site_config.collections).sort()).toEqual([
      "member",
      "paper",
    ]);
  });

  it("go live (human) → published, the token returned ONCE, metadata = the allowlist only", async () => {
    const res = await human(A).publishSite({ siteId });
    expect(res.status).toBe("published");
    expect(typeof res.token).toBe("string");
    token = res.token!;
    expect(res.metadataFields).toEqual(["title"]);
    const [row] = await siteRows(P);
    expect(row).toMatchObject({
      state: "published",
      token_hash: sha(token),
      token_prefix: token.slice(0, 6),
      published_properties: { title: "Lab Site" },
    });
    const m = await manifest(token);
    expect(m.status).toBe(200);
    expect(m.body.title).toBe("Lab Site");
  });

  it("going live again keeps the token (republished, none returned)", async () => {
    const res = await human(A).publishSite({ siteId });
    expect(res.status).toBe("republished");
    expect(res.token).toBeUndefined();
    expect((await siteRows(P))[0]!.token_hash).toBe(sha(token));
    expect((await manifest(token)).status).toBe(200);
  });

  it("go live and rotate are a signed-in person's acts: an agent and an API key are refused", async () => {
    for (const who of [agent, bareKey]) {
      expect((await errOf(who.publishSite({ siteId })))?.code).toBe(
        "FORBIDDEN"
      );
      expect((await errOf(who.rotateSiteToken({ siteId })))?.code).toBe(
        "FORBIDDEN"
      );
    }
    expect((await errOf(human(E).rotateSiteToken({ siteId })))?.code).toBe(
      "FORBIDDEN"
    );
    expect((await siteRows(P))[0]!.token_hash).toBe(sha(token));
  });

  it("rotate → a new token; the OLD one answers 404 at once", async () => {
    const res = await human(A).rotateSiteToken({ siteId });
    expect(res.token).not.toBe(token);
    expect((await manifest(token)).status).toBe(404);
    expect((await manifest(res.token)).status).toBe(200);
    token = res.token;
  });

  it("unpublish is direct for an agent (it narrows) → the manifest 404s; live again = the SAME token", async () => {
    expect(await agent.unpublishSite({ siteId })).toEqual({
      status: "unpublished",
      siteId,
    });
    expect((await manifest(token)).status).toBe(404);
    expect(await agent.unpublishSite({ siteId })).toEqual({
      status: "none",
      siteId,
    });
    const back = await human(A).publishSite({ siteId });
    expect(back.status).toBe("published");
    expect(back.token).toBeUndefined();
    expect((await manifest(token)).status).toBe(200);
  });

  it("a stranger can neither unpublish, revoke nor read the status", async () => {
    for (const p of [
      human(R).unpublishSite({ siteId }),
      human(R).revokeSite({ siteId }),
      human(R).siteStatus({ siteId }),
    ]) {
      expect((await errOf(p))?.code).toBe("FORBIDDEN");
    }
    expect((await manifest(token)).status).toBe(200);
  });

  it("status (owner) reports live, the prefix, the config and the counts — never the token", async () => {
    const st = await human(A).siteStatus({ projectId: P });
    expect(st).toMatchObject({
      siteId,
      projectId: P,
      homeWorkspaceId: W,
      state: "published",
      live: true,
      hasToken: true,
      tokenPrefix: token.slice(0, 6),
      metadataFields: ["title"],
      collections: [
        { key: "paper", count: 0 },
        { key: "member", count: 0 },
      ],
    });
    expect(JSON.stringify(st)).not.toContain(token);
    expect(JSON.stringify(st)).not.toContain(sha(token));
  });

  it("a pod-wide project publishes from the space its owner names", async () => {
    const res = await human(A).configureSite({
      projectId: P_POD,
      homeWorkspaceId: W,
      config: CONFIG,
    });
    if (res.status === "proposed") throw new Error("unreachable");
    expect((await siteRows(P_POD))[0]).toMatchObject({
      id: res.siteId,
      workspace_id: W,
    });
  });

  describe("revoke: permanent, with every member row, in one transaction", () => {
    it("revoke (agent, direct) → the site and its unrevoked members are revoked; another site's member is not", async () => {
      const other = (await siteRows(P_POD))[0]!.id as string;
      const member = (site: string, state: string) =>
        q(
          `insert into resource_shares (resource_type, resource_id, audience, state, created_by, site_share_id, published_collection, public_id, published_at, published_properties, workspace_id)
           values ('entity', $1, 'public', $2, $3, $4, 'paper', $5, now(), '{}'::jsonb, $6) returning id`,
          [
            randomUUID(),
            state,
            A,
            site,
            `p_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
            W,
          ]
        );
      await member(siteId, "published");
      await member(siteId, "draft");
      await member(other, "published");
      const res = await agent.revokeSite({ siteId });
      expect(res).toEqual({ status: "revoked", siteId, membersRevoked: 2 });
      const { rows } = await q<{
        site_share_id: string;
        revoked_at: Date | null;
        state: string;
      }>(
        `select site_share_id, revoked_at, state from resource_shares where site_share_id is not null`
      );
      for (const r of rows) {
        if (r.site_share_id === siteId) {
          expect(r.revoked_at).not.toBeNull();
          expect(r.state).toBe("draft");
        } else {
          expect(r.revoked_at).toBeNull();
          expect(r.state).toBe("published");
        }
      }
      expect((await siteRows(P))[0]).toMatchObject({ state: "draft" });
      expect((await siteRows(P))[0]!.revoked_at).not.toBeNull();
      expect((await manifest(token)).status).toBe(404);
    });

    it("a revoked site cannot go live or be re-tokened; configuring again makes a NEW site", async () => {
      expect((await errOf(human(A).publishSite({ siteId })))?.code).toBe(
        "BAD_REQUEST"
      );
      expect((await errOf(human(A).rotateSiteToken({ siteId })))?.code).toBe(
        "BAD_REQUEST"
      );
      expect(await agent.revokeSite({ siteId })).toEqual({
        status: "none",
        siteId,
        membersRevoked: 0,
      });
      const again = await human(A).configureSite({
        projectId: P,
        config: CONFIG,
      });
      if (again.status === "proposed") throw new Error("unreachable");
      expect(again.status).toBe("created");
      expect(again.siteId).not.toBe(siteId);
      const live = await human(A).publishSite({ siteId: again.siteId });
      expect(live.token).not.toBe(token);
      expect((await manifest(token)).status).toBe(404);
      expect((await manifest(live.token!)).status).toBe(200);
    });
  });
});

describe("an agent's site is ONE proposal; approval writes it WITHOUT a token", () => {
  it("agent configure → proposed (one gate call), nothing written", async () => {
    const before = h.gateCalls.length;
    const res = await agent.configureSite({
      projectId: P_AG,
      config: CONFIG,
      reasoning: "the lab wants its papers online",
    });
    expect(res.status).toBe("proposed");
    expect(h.gateCalls.length - before).toBe(1);
    expect(await siteRows(P_AG)).toHaveLength(0);
  });

  it("approval replays the plan on the subject → a draft site with no token; the owner then goes live", async () => {
    const payload = h.gateCalls.at(-1)!.data as Record<string, unknown>;
    const proposalId = randomUUID();
    const exec = proposalExecRegistry.resolve("share/create", "create");
    const out = await exec!.execute({
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
    } as never);
    expect(out).toMatchObject({
      success: true,
      effect: { applied: "verified", rows: 1 },
    });
    const [row] = await siteRows(P_AG);
    expect(row).toMatchObject({
      state: "draft",
      token_hash: null,
      token_prefix: null,
      workspace_id: W,
    });
    const st = await human(A).siteStatus({ siteId: row!.id });
    expect(st).toMatchObject({ live: false, hasToken: false });
    const live = await human(A).publishSite({ siteId: row!.id });
    expect(typeof live.token).toBe("string");
    expect((await manifest(live.token!)).status).toBe(200);
  });

  it("approval re-checks NOW: a policy tightened while it waited refuses it", async () => {
    await agent.configureSite({ projectId: P_OTHER, config: CONFIG });
    const payload = h.gateCalls.at(-1)!.data as Record<string, unknown>;
    await human(A).setPolicy({
      workspaceId: W,
      policy: {
        ...SITE_POLICY,
        kinds: { ...SITE_POLICY.kinds, project: DEFAULT_KIND },
      },
    });
    const proposalId = randomUUID();
    const e = await errOf(
      proposalExecRegistry.resolve("share/create", "create")!.execute({
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
      } as never)
    );
    expect(e?.code).toBe("FORBIDDEN");
    expect(await siteRows(P_OTHER)).toHaveLength(0);
    await human(A).setPolicy({ workspaceId: W, policy: SITE_POLICY });
  });
});

describe("Hub REST: a project-narrowed agent key proposes a site for ITS project only", () => {
  const keyApp = () =>
    hubApp(
      { userId: A, agentUserId: AG, keyType: "agent", scopes: SCOPES },
      grantOfScope({ permissions: ["*"], projectIds: [P_KEY] } as never)
    );
  const post = (app: OpenAPIHono, projectId: string) =>
    app.request("/shares/sites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId, config: CONFIG }),
    });

  it("its own project → 202 proposed (the grant sees the site's project)", async () => {
    const res = await post(keyApp(), P_KEY);
    expect(res.status).toBe(202);
    expect(((await res.json()) as any).status).toBe("proposed");
    expect(h.gateCalls.at(-1)).toMatchObject({ projectId: P_KEY });
    expect(await siteRows(P_KEY)).toHaveLength(0);
  });

  it("another project → 403 denied by the grant, never proposed", async () => {
    const res = await post(keyApp(), P_OTHER);
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error).toMatch(/grant does not allow/);
    expect(await siteRows(P_OTHER)).toHaveLength(0);
  });

  it("the owner's REST doors: status by project and by id, unpublish, revoke", async () => {
    const owner = hubApp({ userId: A, scopes: SCOPES });
    const byProject = await owner.request(`/shares/sites?projectId=${P_AG}`);
    expect(byProject.status).toBe(200);
    const st = (await byProject.json()) as any;
    expect(st).toMatchObject({ projectId: P_AG, live: true });
    expect((await owner.request(`/shares/sites/${st.siteId}`)).status).toBe(
      200
    );
    const none = await owner.request(`/shares/sites?projectId=${P_KEY}`);
    expect(none.status).toBe(200);
    expect(await none.json()).toBeNull();
    const un = await owner.request(`/shares/sites/${st.siteId}/unpublish`, {
      method: "POST",
    });
    expect(((await un.json()) as any).status).toBe("unpublished");
    const rv = await owner.request(`/shares/sites/${st.siteId}/revoke`, {
      method: "POST",
    });
    expect(((await rv.json()) as any).status).toBe("revoked");
  });
});
