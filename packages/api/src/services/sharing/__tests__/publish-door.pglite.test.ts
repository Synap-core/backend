/**
 * Sites W5a — the PUBLISH door, end to end on PGlite.
 *
 * Driven through the REAL `shares` tRPC router (publish / unpublish), the REAL
 * Hub REST `/shares/publish` route, the REAL publish core, the REAL
 * `share/create` approval executor, the REAL 0276 constraints +
 * revoke-is-permanent trigger — and read back through the REAL W3 public route
 * `GET /public/shares/:token`. Nothing between the owner's click and the served
 * bytes is hand-built.
 *
 * THE GATE is the same thin adapter as `share-doors.pglite.test.ts`: an agent
 * goes through the REAL `resolveAgentGovernanceDecision` against stored
 * `governance_rules`; a human is granted (the production gate's non-agent path).
 * What this cannot see: the gate's own proposal insert / notifications,
 * production Postgres, object-storage checkpoints (every version is inline).
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
  return {
    checkPermissionOrPropose: vi.fn(async (opts: Record<string, unknown>) => {
      h.gateCalls.push(opts);
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
        reasonCode: gov.decision === "propose" ? gov.reasonCode : undefined,
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
import { sharesRouter } from "../../../routers/shares.js";
import { registerPublicSharesRoutes } from "../../../routers/hub-protocol/rest/public-shares.js";
import { registerSharesRoutes } from "../../../routers/hub-protocol/rest/shares.js";
import { proposalExecRegistry } from "../../../routers/proposals/execution-registry.js";
import { PUBLIC_NOT_FOUND_BODY } from "../public-read.js";

// ── Principals / fixtures ──
const A = randomUUID(); // owner of W; human
const AG = randomUUID(); // agent acting for A
const R = randomUUID(); // a person with no access to W
const W = randomUUID();
const EP = randomUUID(); // the record published by the owner
const DP = randomUUID(); // its document
const V1 = randomUUID(); // older checkpoint
const V2 = randomUUID(); // LATEST checkpoint → the pin
const U = randomUUID(); // an unshared entity referenced by EP's properties
const E_AG = randomUUID(); // the record the agent publishes
const E_REST = randomUUID(); // the record published over Hub REST
// A VIEW whose id ALSO names a live document (EP's): the discriminating input
// for "only records are publishable" — without the kind check the lookup would
// resolve it as that document's entity and reach the policy (a FORBIDDEN, not
// the BAD_REQUEST this refusal owes). A fresh id would 404 either way.
const VIEW = DP;

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

const human = (userId: string) =>
  sharesRouter.createCaller({
    authenticated: true,
    userId,
    workspaceId: null,
  } as never);
const agent = sharesRouter.createCaller({
  authenticated: true,
  userId: A,
  agentUserId: AG,
  keyType: "agent",
  workspaceId: null,
} as never);

async function errOf(p: Promise<unknown>) {
  try {
    await p;
    return null;
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { code: e.code, message: e.message };
  }
}

// The REAL W3 public read route.
const publicApp = new OpenAPIHono();
registerPublicSharesRoutes(publicApp as never);
async function readPublic(token: string) {
  const res = await publicApp.request(`/public/shares/${token}`);
  return { status: res.status, body: (await res.json()) as any };
}

// The REAL Hub REST share routes, behind a stand-in for the auth middleware.
function hubApp(ctx: Record<string, unknown>) {
  const app = new OpenAPIHono();
  app.use("/*", async (c, next) => {
    for (const [k, v] of Object.entries(ctx)) c.set(k as never, v as never);
    await next();
  });
  registerSharesRoutes(app as never);
  return app;
}

const ALLOW_ENTITY_PUBLIC = {
  version: 1 as const,
  kinds: {
    entity: {
      public: {
        read: "direct" as const,
        // `secretNote` is deliberately NOT here; `ownerId` / `related` /
        // `nested` are, to prove the snapshot re-filters identity, ids and
        // non-scalars even when an owner allowlists them.
        fields: [
          "title",
          "tagline",
          "price",
          "live",
          "ownerId",
          "related",
          "nested",
        ],
      },
    },
  },
};

async function publicRow(entityId: string) {
  const { rows } = await q<Record<string, any>>(
    `select * from resource_shares where resource_id=$1 and audience='public' order by created_at`,
    [entityId]
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
  await h.client!.exec(
    readFileSync(
      path.resolve(
        here,
        "../../../../../database/migrations/0276_exposure_substrate.sql"
      ),
      "utf8"
    )
  );
  for (const u of [A, R]) {
    await q(`insert into users (id, email, user_type) values ($1,$2,'human')`, [
      u,
      `${u}@example.test`,
    ]);
  }
  await q(
    `insert into users (id, email, user_type, agent_metadata) values ($1,$2,'agent','{}'::jsonb)`,
    [AG, `${AG}@agents.test`]
  );
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'W',$2,'{}'::jsonb)`,
    [W, A]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner'),($4,$2,$5,'editor')`,
    [randomUUID(), W, A, randomUUID(), AG]
  );
  await q(
    `insert into pod_members (id, user_id, pod_role) values ($1,$2,'owner')`,
    [randomUUID(), A]
  );
  await q(
    `insert into documents (id, user_id, workspace_id, title, type, current_version, content_revision) values ($1,$2,$3,'Doc','markdown',2,2)`,
    [DP, A, W]
  );
  await q(
    `insert into document_versions (id, document_id, version, content, author, author_id, created_at) values
       ($1,$3,1,'old body','human',$4, now() - interval '1 day'),
       ($2,$3,2,'# Body v2','human',$4, now())`,
    [V1, V2, DP, A]
  );
  await q(
    `insert into entities (id, user_id, workspace_id, title, document_id, properties) values ($1,$2,$3,'Launch plan',$4,$5::jsonb)`,
    [
      EP,
      A,
      W,
      DP,
      JSON.stringify({
        tagline: "Hello",
        price: 42,
        live: true,
        secretNote: "do not publish",
        ownerId: "someone-internal",
        related: U,
        nested: { a: 1 },
      }),
    ]
  );
  for (const id of [U, E_AG, E_REST]) {
    await q(
      `insert into entities (id, user_id, workspace_id, title, properties) values ($1,$2,$3,'Other','{"tagline":"agent"}'::jsonb)`,
      [id, A, W]
    );
  }
  await q(
    `insert into views (id, workspace_id, user_id, name, type, category, metadata) values ($1,$2,$3,'v','table','structured','{}'::jsonb)`,
    [VIEW, W, A]
  );
}, 120_000);

describe("policy: the default denies public, and the owner's policy is enforced", () => {
  it("publish is REFUSED while the workspace policy denies public (the default)", async () => {
    const e = await errOf(
      human(A).publish({ resourceType: "entity", resourceId: EP })
    );
    expect(e?.code).toBe("FORBIDDEN");
    expect(await publicRow(EP)).toHaveLength(0);
  });

  it("allowing entities does not allow documents (per-kind policy)", async () => {
    await human(A).setPolicy({ workspaceId: W, policy: ALLOW_ENTITY_PUBLIC });
    const e = await errOf(
      human(A).publish({ resourceType: "document", resourceId: DP })
    );
    expect(e?.code).toBe("FORBIDDEN");
    expect(await publicRow(EP)).toHaveLength(0);
  });

  it("a view is not publishable; a stranger cannot publish; an unattributed key cannot", async () => {
    const viewErr = await errOf(
      human(A).publish({ resourceType: "view", resourceId: VIEW })
    );
    expect(viewErr?.code).toBe("BAD_REQUEST");
    expect(viewErr?.message).toMatch(/views and projects/);
    expect(
      (
        await errOf(
          human(R).publish({ resourceType: "entity", resourceId: EP })
        )
      )?.code
    ).toBe("FORBIDDEN");
    const bare = sharesRouter.createCaller({
      authenticated: true,
      userId: A,
      keyType: "user_pat",
      workspaceId: null,
    } as never);
    expect(
      (await errOf(bare.publish({ resourceType: "entity", resourceId: EP })))
        ?.code
    ).toBe("FORBIDDEN");
    expect(await publicRow(EP)).toHaveLength(0);
  });
});

describe("the owner publishes DIRECTLY and the W3 read serves the SNAPSHOT", () => {
  let token = "";

  it("publish → published, token returned ONCE, row = public/published/pinned/snapshot", async () => {
    const res = await human(A).publish({
      resourceType: "entity",
      resourceId: EP,
    });
    if (res.status === "proposed") throw new Error("unreachable");
    expect(res.status).toBe("published");
    expect(typeof res.token).toBe("string");
    token = res.token!;
    expect(res.publishedFields.sort()).toEqual([
      "live",
      "price",
      "tagline",
      "title",
    ]);
    expect(h.gateCalls.at(-1)).toMatchObject({
      subjectType: "share",
      action: "create",
      workspaceId: W,
    });
    const rows = await publicRow(EP);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row).toMatchObject({
      audience: "public",
      state: "published",
      anchor_project_id: null,
      published_document_version_id: V2,
      public_token: null,
      token_hash: createHash("sha256").update(token, "utf8").digest("hex"),
    });
    expect(row.published_at).toBeTruthy();
    // EXACTLY the allowlisted scalar keys: no secretNote (not allowlisted), no
    // ownerId (identity), no related (an id), no nested (not a scalar).
    expect(row.published_properties).toEqual({
      title: "Launch plan",
      tagline: "Hello",
      price: 42,
      live: true,
    });
  });

  it("GET /public/shares/:token serves the snapshot + the pinned body", async () => {
    const { status, body } = await readPublic(token);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      resourceType: "entity",
      title: "Launch plan",
      properties: { tagline: "Hello", price: 42, live: true },
      body: { format: "markdown", content: "# Body v2" },
    });
    expect(JSON.stringify(body)).not.toContain("do not publish");
    expect(JSON.stringify(body)).not.toContain(U);
  });

  it("a later edit of the live record does NOT publish itself", async () => {
    await q(
      `update entities set properties = jsonb_set(properties, '{tagline}', '"Changed"') where id=$1`,
      [EP]
    );
    expect((await readPublic(token)).body.properties.tagline).toBe("Hello");
  });

  it("re-publishing takes a NEW snapshot at the SAME url, without re-minting", async () => {
    const res = await human(A).publish({
      resourceType: "entity",
      resourceId: EP,
    });
    if (res.status === "proposed") throw new Error("unreachable");
    expect(res.status).toBe("republished");
    expect("token" in res).toBe(false);
    expect(res.hasToken).toBe(true);
    expect((await readPublic(token)).body.properties.tagline).toBe("Changed");
    expect(await publicRow(EP)).toHaveLength(1);
  });

  it("unpublish → back to draft, and the url answers the UNIFORM 404", async () => {
    const res = await human(A).unpublish({
      resourceType: "entity",
      resourceId: EP,
    });
    expect(res.status).toBe("unpublished");
    const rows = await publicRow(EP);
    expect(rows[0]!.state).toBe("draft");
    const miss = await readPublic(token);
    const unknown = await readPublic("tok-never-minted-" + "z".repeat(30));
    expect(miss.status).toBe(404);
    expect(miss).toEqual(unknown);
    expect(miss.body).toEqual(PUBLIC_NOT_FOUND_BODY);
    // idempotent
    expect(
      (await human(A).unpublish({ resourceType: "entity", resourceId: EP }))
        .status
    ).toBe("none");
  });

  it("publishing again restores the SAME url (the token was kept)", async () => {
    const res = await human(A).publish({
      resourceType: "entity",
      resourceId: EP,
    });
    if (res.status === "proposed") throw new Error("unreachable");
    expect(res.status).toBe("published");
    expect("token" in res).toBe(false);
    expect((await readPublic(token)).status).toBe(200);
  });

  it("REVOKED stays 404: unpublish/publish never un-revoke; a new publication gets a NEW url", async () => {
    // No revoke door for publications yet (W5a scope): revoke at the row, the
    // way any future door will — the 0276 trigger then freezes it.
    const [row] = await publicRow(EP);
    await q(
      `update resource_shares set revoked_at = now(), revoked_by=$2 where id=$1`,
      [row!.id, A]
    );
    expect((await readPublic(token)).status).toBe(404);
    expect(
      (await human(A).unpublish({ resourceType: "entity", resourceId: EP }))
        .status
    ).toBe("none");
    const again = await human(A).publish({
      resourceType: "entity",
      resourceId: EP,
    });
    if (again.status === "proposed") throw new Error("unreachable");
    expect(again.status).toBe("published");
    expect(again.shareId).not.toBe(row!.id);
    expect(typeof again.token).toBe("string");
    expect(again.token).not.toBe(token);
    // The old url stays dead; the old row is untouched (still revoked, still published-state frozen).
    expect((await readPublic(token)).status).toBe(404);
    const [old] = (await publicRow(EP)).filter((r) => r.id === row!.id);
    expect(old!.revoked_at).toBeTruthy();
    expect((await readPublic(again.token!)).status).toBe(200);
  });
});

describe("an AGENT's publish is ALWAYS a proposal — even under widening rules", () => {
  it("agent publish → proposal, no row, even with `*` / `share.create` rules seeded", async () => {
    for (const [pattern, principal] of [
      ["*", "any"],
      ["share.create", "agent"],
      ["entity.*", "agent"],
    ] as const) {
      await q(
        `insert into governance_rules (id, principal_kind, agent_user_id, scope_kind, workspace_id, target_kind, target_pattern, verdict, created_by)
         values ($1,$2,$3,'workspace',$4,'action',$5,'auto','test')`,
        [randomUUID(), principal, principal === "agent" ? AG : null, W, pattern]
      );
    }
    const res = await agent.publish({
      resourceType: "entity",
      resourceId: E_AG,
    });
    expect(res.status).toBe("proposed");
    expect(h.gateCalls.at(-1)).toMatchObject({
      subjectType: "share",
      action: "create",
      agentUserId: AG,
      data: expect.objectContaining({ audience: "public", op: "publish" }),
    });
    expect(await publicRow(E_AG)).toHaveLength(0);
  });

  it("approval publishes through the SAME core WITHOUT a token; the owner's publish then mints it", async () => {
    const res = await agent.publish({
      resourceType: "entity",
      resourceId: E_AG,
    });
    expect(res.status).toBe("proposed");
    const payload = h.gateCalls.at(-1)!.data as Record<string, unknown>;
    const proposalId = randomUUID();
    const exec = proposalExecRegistry.resolve("share/create", "create");
    expect(exec?.key).toBe("share/create");
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
      effect: { applied: "verified" },
    });
    const rows = await publicRow(E_AG);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ state: "published", token_hash: null });
    expect(rows[0]!.published_properties).toEqual({
      title: "Other",
      tagline: "agent",
    });
    const minted = await human(A).publish({
      resourceType: "entity",
      resourceId: E_AG,
    });
    if (minted.status === "proposed") throw new Error("unreachable");
    expect(minted.status).toBe("republished");
    expect(typeof minted.token).toBe("string");
    expect((await readPublic(minted.token!)).status).toBe(200);
  });

  it("unpublish is direct for an agent (it only narrows)", async () => {
    const res = await agent.unpublish({
      resourceType: "entity",
      resourceId: E_AG,
    });
    expect(res.status).toBe("unpublished");
    expect((await publicRow(E_AG))[0]!.state).toBe("draft");
  });
});

describe("Hub REST doors", () => {
  it("POST /shares/publish: an agent key gets 202 proposed; the signed-in owner gets 200 + token", async () => {
    const asAgent = hubApp({
      userId: A,
      agentUserId: AG,
      keyType: "agent",
      scopes: ["hub-protocol.write"],
    });
    const r1 = await asAgent.request("/shares/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resourceType: "entity", resourceId: E_REST }),
    });
    expect(r1.status).toBe(202);
    expect(((await r1.json()) as any).status).toBe("proposed");
    expect(await publicRow(E_REST)).toHaveLength(0);

    const asOwner = hubApp({ userId: A, scopes: ["hub-protocol.write"] });
    const r2 = await asOwner.request("/shares/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resourceType: "entity", resourceId: E_REST }),
    });
    expect(r2.status).toBe(200);
    const b2 = (await r2.json()) as any;
    expect(b2.status).toBe("published");
    expect((await readPublic(b2.token)).status).toBe(200);

    const r3 = await asOwner.request("/shares/unpublish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resourceType: "entity", resourceId: E_REST }),
    });
    expect(r3.status).toBe(200);
    expect((await readPublic(b2.token)).status).toBe(404);
  });
});
