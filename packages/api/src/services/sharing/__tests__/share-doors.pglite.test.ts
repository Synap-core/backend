/**
 * Sites W2 S3 — the owner share doors, end to end on PGlite.
 *
 * Driven through the REAL `shares` tRPC router (and the `relations.exposeToAnchor`
 * alias), the REAL share core, the REAL repositories, the REAL S2 access floor
 * (`scopedDb`), the REAL `share/create` approval executor and the REAL 0276
 * constraints + revoke-is-permanent trigger.
 *
 * THE GATE: `checkPermissionOrPropose` is replaced by a thin adapter that, for
 * an agent, calls the REAL `resolveAgentGovernanceDecision` (@synap/database)
 * against real `users` + `governance_rules` rows — the same resolver + engine
 * the production gate calls — and maps its verdict (execute → granted, propose
 * → a proposal id). A human is granted, exactly like the production gate's
 * non-agent path. So "a rule cannot make an agent's share direct" is proven
 * against stored rules, not a stub that answers "propose" by construction.
 * What this CANNOT see: the gate's own proposal insert / RBAC / notifications,
 * production Postgres, and the Hub REST transport (the Hub routes call the same
 * core functions).
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
        reasoning: gov.decision === "propose" ? (gov.reason ?? "") : "",
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

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { entities } from "@synap/database/schema";
import { ProjectRepository, WorkspaceRepository } from "@synap/database";
import { resolveAgentGovernanceDecision } from "@synap/database/agent-governance";
import { AccessContext, scopedDb } from "../../../access/index.js";
import { sharesRouter } from "../../../routers/shares.js";
import { relationsRouter } from "../../../routers/relations.js";
import { proposalExecRegistry } from "../../../routers/proposals/execution-registry.js";
import { resolveExposurePolicy } from "../exposure-policy.js";

// ── Principals ──
const A = randomUUID(); // owner of W; human
const AG = randomUUID(); // an AGENT user acting for A
const R = randomUUID(); // a person who redeems links (no other access)
const R2 = randomUUID(); // a second redeemer
const W = randomUUID();
let P = ""; // anchor project (W)
let P3 = ""; // another project (W)
let PP = ""; // pod-personal project (NULL workspace)

const E = randomUUID(); // entity to share (W)
const E_AG = randomUUID(); // entity the AGENT tries to share (W)
const U = randomUUID(); // unshared entity (W)
const ED = randomUUID(); // entity owning document D
const D = randomUUID(); // document of ED
const V = randomUUID(); // unpinned view (W)
const VP3 = randomUUID(); // view pinned to P3
const VS = randomUUID(); // a scoped surface

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
    // The share core inserts without these; the real schema has defaults.
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

const seenEntities = async (userId: string) =>
  new Set(
    (
      await scopedDb(AccessContext.operator({ userId })).findMany<{
        id: string;
      }>(entities)
    ).map((r) => r.id)
  );

async function seedRule(pattern: string, principal: "any" | "agent") {
  await q(
    `insert into governance_rules (id, principal_kind, agent_user_id, scope_kind, workspace_id, target_kind, target_pattern, verdict, created_by)
     values ($1,$2,$3,'workspace',$4,'action',$5,'auto','test')`,
    [randomUUID(), principal, principal === "agent" ? AG : null, W, pattern]
  );
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

  for (const u of [A, R, R2]) {
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

  const repo = new ProjectRepository(
    h.db as never,
    {
      append: async () => undefined,
    } as never
  );
  P = (await repo.create({ name: "Portal", workspaceId: W, userId: A }, A)).id;
  P3 = (await repo.create({ name: "Internal", workspaceId: W, userId: A }, A))
    .id;
  PP = (await repo.create({ name: "Mine", workspaceId: null, userId: A }, A))
    .id;

  for (const [id, doc] of [
    [E, null],
    [E_AG, null],
    [U, null],
    [ED, D],
  ] as const) {
    await q(
      `insert into entities (id, user_id, workspace_id, title, document_id) values ($1,$2,$3,'e',$4)`,
      [id, A, W, doc]
    );
  }
  await q(
    `insert into documents (id, user_id, workspace_id, title, type, current_version, content_revision) values ($1,$2,$3,'Doc','markdown',1,1)`,
    [D, A, W]
  );
  for (const [id, project, meta] of [
    [V, null, {}],
    [VP3, P3, {}],
    [VS, null, { scopedSurface: true }],
  ] as const) {
    await q(
      `insert into views (id, workspace_id, user_id, project_id, name, type, category, metadata) values ($1,$2,$3,$4,'v','table','structured',$5::jsonb)`,
      [id, W, A, project, JSON.stringify(meta)]
    );
  }
}, 120_000);

describe("the human owner shares DIRECTLY; a guest sees exactly what was shared", () => {
  let token = "";
  let shareId = "";

  it("owner link-share → created, token returned ONCE, exposure written", async () => {
    const res = await human(A).share({
      resourceType: "entity",
      resourceId: E,
      anchorProjectId: P,
      audience: "link",
    });
    expect(res).toMatchObject({ status: "created", audience: "link" });
    if (res.status === "proposed") throw new Error("unreachable");
    expect(typeof res.token).toBe("string");
    token = res.token!;
    shareId = res.shareId!;
    const edges = await q(
      `select count(*)::int as n from relations where source_entity_id=$1 and target_entity_id=$2 and type='visible_to'`,
      [E, P]
    );
    expect(edges.rows[0]).toEqual({ n: 1 });
    // The gate was asked about the ADMIN-floored pair.
    expect(h.gateCalls.at(-1)).toMatchObject({
      subjectType: "share",
      action: "create",
      workspaceId: W,
    });
  });

  it("the token is stored ONLY hashed — no column carries the plaintext", async () => {
    const { rows } = await q<Record<string, unknown>>(
      `select * from resource_shares where id=$1`,
      [shareId]
    );
    const row = rows[0]!;
    expect(row.public_token).toBeNull();
    expect(row.token_hash).toBe(
      createHash("sha256").update(token, "utf8").digest("hex")
    );
    for (const [col, value] of Object.entries(row)) {
      expect(JSON.stringify(value ?? null), col).not.toContain(token);
    }
    // non-vacuity: the scan did see the row's columns
    expect(Object.keys(row).length).toBeGreaterThan(10);
  });

  it("a second share of the same record is idempotent and never re-mints a token", async () => {
    const again = await human(A).share({
      resourceType: "entity",
      resourceId: E,
      anchorProjectId: P,
      audience: "link",
    });
    expect(again).toMatchObject({ status: "exists", shareId });
    expect("token" in again).toBe(false);
  });

  it("before redeeming, R sees nothing of W", async () => {
    const seen = await seenEntities(R);
    expect(seen.has(E)).toBe(false);
  });

  it("redeemLink makes R a GUEST (granted_via_share_id), and R then sees E — and not U", async () => {
    expect(await human(R).redeemLink({ token })).toEqual({
      status: "joined",
      projectId: P,
    });
    const { rows } = await q(
      `select role, granted_via_share_id from project_members where project_id=$1 and user_id=$2`,
      [P, R]
    );
    expect(rows).toEqual([{ role: "guest", granted_via_share_id: shareId }]);
    const seen = await seenEntities(R);
    expect(seen.has(E)).toBe(true);
    expect(seen.has(U)).toBe(false);
  });

  it("a second redeem is idempotent (one membership row)", async () => {
    expect(await human(R).redeemLink({ token })).toEqual({
      status: "already_member",
      projectId: P,
    });
    const { rows } = await q(
      `select count(*)::int as n from project_members where project_id=$1 and user_id=$2`,
      [P, R]
    );
    expect(rows[0]).toEqual({ n: 1 });
  });

  it("unknown, revoked and expired tokens get the IDENTICAL NOT_FOUND", async () => {
    // expired: a live link whose expiry has passed
    const expiring = await human(A).share({
      resourceType: "entity",
      resourceId: U,
      anchorProjectId: P,
      audience: "link",
      expiresAt: new Date(Date.now() + 60_000),
    });
    if (expiring.status === "proposed") throw new Error("unreachable");
    await q(
      `update resource_shares set expires_at = now() - interval '1 minute' where id=$1`,
      [expiring.shareId]
    );
    const unknown = await errOf(
      human(R2).redeemLink({ token: "x".repeat(43) })
    );
    const expired = await errOf(
      human(R2).redeemLink({ token: expiring.token! })
    );
    await human(A).revokeLink({ shareId });
    const revoked = await errOf(human(R2).redeemLink({ token }));
    expect(unknown).toEqual({
      code: "NOT_FOUND",
      message: "This link is not available.",
    });
    expect(expired).toEqual(unknown);
    expect(revoked).toEqual(unknown);
    const { rows } = await q(
      `select count(*)::int as n from project_members where user_id=$1`,
      [R2]
    );
    expect(rows[0]).toEqual({ n: 0 });
  });

  it("revoking a link does NOT remove the guest who already joined", async () => {
    const { rows } = await q(
      `select role from project_members where project_id=$1 and user_id=$2`,
      [P, R]
    );
    expect(rows).toEqual([{ role: "guest" }]);
  });

  it("revoke is PERMANENT: the row cannot be un-revoked, and sharing again mints a NEW row", async () => {
    const unrevoke = await errOf(
      q(`update resource_shares set revoked_at = null where id=$1`, [shareId])
    );
    expect(unrevoke?.message).toMatch(/revocation is permanent/);
    const rotate = await errOf(human(A).rotateLink({ shareId }));
    expect(rotate?.code).toBe("BAD_REQUEST");
    const reshared = await human(A).share({
      resourceType: "entity",
      resourceId: E,
      anchorProjectId: P,
      audience: "link",
    });
    expect(reshared).toMatchObject({ status: "created" });
    if (reshared.status === "proposed") throw new Error("unreachable");
    expect(reshared.shareId).not.toBe(shareId);
  });
});

describe("an AGENT's share is ALWAYS a proposal — and no governance rule widens it", () => {
  it("control: the same agent + rules DO auto-approve an ordinary write (the rules are live)", async () => {
    const ask = () =>
      resolveAgentGovernanceDecision({
        db: h.db as never,
        agentUserId: AG,
        workspaceId: W,
        subjectType: "document",
        action: "update",
        preferAgentMetadataAutoApproveFor: true,
      } as never);
    // `document.update` is NOT in DEFAULT_AUTO_APPROVE: without a rule it proposes…
    expect((await ask()).decision).toBe("propose");
    await seedRule("*", "any");
    await seedRule("relation.*", "any");
    await seedRule("entity.*", "agent");
    await seedRule("share.create", "agent");
    await seedRule("relation.expose", "agent");
    // …and with the seeded rules it executes.
    expect((await ask()).decision).toBe("execute");
  });

  it("agent share → proposal, nothing exposed, no link row", async () => {
    const res = await agent.share({
      resourceType: "entity",
      resourceId: E_AG,
      anchorProjectId: P,
      audience: "link",
    });
    expect(res.status).toBe("proposed");
    const edges = await q(
      `select count(*)::int as n from relations where source_entity_id=$1`,
      [E_AG]
    );
    expect(edges.rows[0]).toEqual({ n: 0 });
    const links = await q(
      `select count(*)::int as n from resource_shares where resource_id=$1`,
      [E_AG]
    );
    expect(links.rows[0]).toEqual({ n: 0 });
  });

  it("the exposeToAnchor alias files the same floored door for an agent", async () => {
    const res = await relationsRouter
      .createCaller({
        authenticated: true,
        userId: A,
        agentUserId: AG,
        keyType: "agent",
      } as never)
      .exposeToAnchor({ entityId: E_AG, anchorId: P });
    expect(res.status).toBe("proposed");
    expect(h.gateCalls.at(-1)).toMatchObject({
      subjectType: "share",
      action: "create",
      agentUserId: AG,
    });
  });

  it("approval applies it through the SAME core — link row created WITHOUT a token; the human then mints it", async () => {
    const res = await agent.share({
      resourceType: "entity",
      resourceId: E_AG,
      anchorProjectId: P,
      audience: "link",
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
      deps: {
        emitProposalReviewed: vi.fn(),
        reportProposalOutcome: vi.fn(),
      },
    } as never);
    expect(out).toMatchObject({
      success: true,
      effect: { applied: "verified" },
    });
    const { rows } = await q<{ id: string; token_hash: string | null }>(
      `select id, token_hash from resource_shares where resource_id=$1 and revoked_at is null`,
      [E_AG]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token_hash).toBeNull();
    const edges = await q(
      `select count(*)::int as n from relations where source_entity_id=$1 and type='visible_to'`,
      [E_AG]
    );
    expect(edges.rows[0]).toEqual({ n: 1 });
    // The agent cannot mint the secret…
    expect(
      (await errOf(agent.rotateLink({ shareId: rows[0]!.id })))?.code
    ).toBe("FORBIDDEN");
    // …the signed-in owner can, and it redeems.
    const minted = await human(A).rotateLink({ shareId: rows[0]!.id });
    expect(minted.token.length).toBeGreaterThan(20);
    expect(await human(R2).redeemLink({ token: minted.token })).toMatchObject({
      status: "joined",
    });
  });

  it("agents have no policy door and cannot redeem", async () => {
    expect(
      (await errOf(agent.setPolicy({ workspaceId: W, policy: null })))?.code
    ).toBe("FORBIDDEN");
    expect(
      (await errOf(agent.redeemLink({ token: "y".repeat(43) })))?.code
    ).toBe("FORBIDDEN");
  });

  it("revoke/unshare is direct for an agent too", async () => {
    const res = await agent.unshare({
      resourceType: "entity",
      resourceId: E_AG,
      anchorProjectId: P,
    });
    expect(res).toMatchObject({ status: "removed", revokedLinks: 1 });
    const edges = await q(
      `select count(*)::int as n from relations where source_entity_id=$1 and type='visible_to'`,
      [E_AG]
    );
    expect(edges.rows[0]).toEqual({ n: 0 });
  });

  it("an unattributed API key cannot share at all", async () => {
    const bare = sharesRouter.createCaller({
      authenticated: true,
      userId: A,
      keyType: "user_pat",
    } as never);
    expect(
      (
        await errOf(
          bare.share({
            resourceType: "entity",
            resourceId: U,
            anchorProjectId: P,
            audience: "guest",
          })
        )
      )?.code
    ).toBe("FORBIDDEN");
  });
});

describe("kinds, anchors and refusals", () => {
  it("a pod-personal project cannot anchor a share", async () => {
    const e = await errOf(
      human(A).share({
        resourceType: "entity",
        resourceId: U,
        anchorProjectId: PP,
        audience: "guest",
      })
    );
    expect(e?.code).toBe("BAD_REQUEST");
    expect(e?.message).toMatch(/pod-personal/);
  });

  it("view share sets exposed_at (+ pins to the anchor); unshare clears and unpins", async () => {
    await human(A).share({
      resourceType: "view",
      resourceId: V,
      anchorProjectId: P,
      audience: "guest",
    });
    let { rows } = await q<Record<string, unknown>>(
      `select project_id, exposed_at, exposed_by from views where id=$1`,
      [V]
    );
    expect(rows[0]!.project_id).toBe(P);
    expect(rows[0]!.exposed_at).not.toBeNull();
    expect(rows[0]!.exposed_by).toBe(A);
    await human(A).unshare({
      resourceType: "view",
      resourceId: V,
      anchorProjectId: P,
    });
    ({ rows } = await q(
      `select project_id, exposed_at from views where id=$1`,
      [V]
    ));
    expect(rows[0]).toEqual({ project_id: null, exposed_at: null });
  });

  it("a view pinned to ANOTHER project, and a scoped surface, are refused", async () => {
    for (const id of [VP3, VS]) {
      expect(
        (
          await errOf(
            human(A).share({
              resourceType: "view",
              resourceId: id,
              anchorProjectId: P,
              audience: "guest",
            })
          )
        )?.code,
        id
      ).toBe("BAD_REQUEST");
    }
  });

  it("a document share exposes its ENTITY (documents follow their entity)", async () => {
    const res = await human(A).share({
      resourceType: "document",
      resourceId: D,
      anchorProjectId: P,
      audience: "guest",
    });
    expect(res).toMatchObject({
      status: "created",
      resourceType: "entity",
      resourceId: ED,
    });
  });

  it("listShares is capped and never returns a token or hash", async () => {
    const list = await human(A).listShares({ anchorProjectId: P });
    expect(list.links.length).toBeGreaterThan(0);
    for (const l of list.links) {
      expect(l).not.toHaveProperty("tokenHash");
      expect(l).not.toHaveProperty("token");
    }
    expect(list.exposures.some((x) => x.resourceId === ED)).toBe(true);
  });
});

describe("settings.exposurePolicy", () => {
  it("default when absent: guest + link read, create only as proposal; public denied", async () => {
    const p = await human(A).getPolicy({ workspaceId: W });
    expect(p.entity.guest).toEqual({ read: "direct", create: "proposal" });
    expect(p.view.link).toEqual({ read: "direct", create: "proposal" });
    expect(p.project.public).toEqual({ read: "denied", create: "denied" });
  });

  it("the ceiling: public update/delete are not representable; a planted public.create 'direct' reads as 'proposal'", async () => {
    const e = await errOf(
      human(A).setPolicy({
        workspaceId: W,
        policy: {
          version: 1,
          kinds: { entity: { public: { update: "direct" } } },
        } as never,
      })
    );
    expect(e?.code).toBe("BAD_REQUEST");
    const resolved = resolveExposurePolicy({
      exposurePolicy: {
        kinds: {
          entity: {
            public: { read: "direct", create: "direct", update: "direct" },
          },
        },
      },
    });
    expect(resolved.entity.public).toEqual({
      read: "direct",
      create: "proposal",
    });
    expect(Object.keys(resolved.entity.public).sort()).toEqual([
      "create",
      "read",
    ]);
  });

  it("the owner's policy is enforced by the share door", async () => {
    await human(A).setPolicy({
      workspaceId: W,
      policy: { version: 1, kinds: { entity: { guest: { read: "denied" } } } },
    });
    const e = await errOf(
      human(A).share({
        resourceType: "entity",
        resourceId: U,
        anchorProjectId: P,
        audience: "guest",
      })
    );
    expect(e?.code).toBe("FORBIDDEN");
  });

  it("generic settings writes and package appliers can neither set nor erase it", async () => {
    const repo = new WorkspaceRepository(
      h.db as never,
      {
        append: async () => undefined,
      } as never
    );
    const stored = async () =>
      (
        await q<{ p: unknown }>(
          `select settings->'exposurePolicy' as p from workspaces where id=$1`,
          [W]
        )
      ).rows[0]!.p;
    const before = await stored();
    expect(before).not.toBeNull(); // set by the previous test
    const planted = {
      version: 1,
      kinds: { entity: { guest: { read: "direct" } } },
    };
    // mergeSettings — the applier door (create/reconcile-from-definition)
    await repo.mergeSettings(W, { exposurePolicy: planted } as never, A);
    expect(await stored()).toEqual(before);
    // update — the workspaces.update door (REPLACE semantics)
    await repo.update(
      W,
      { settings: { theme: "dark", exposurePolicy: planted } } as never,
      A
    );
    expect(await stored()).toEqual(before);
    // …and a round-trip WITHOUT the key does not erase it
    await repo.update(W, { settings: { theme: "light" } } as never, A);
    expect(await stored()).toEqual(before);
    // create — a template blob never seeds it
    const W2 = randomUUID();
    await repo.create(
      {
        id: W2,
        name: "W2",
        ownerId: A,
        settings: { exposurePolicy: planted },
      } as never,
      A
    );
    const { rows } = await q<{ p: unknown }>(
      `select settings->'exposurePolicy' as p from workspaces where id=$1`,
      [W2]
    );
    expect(rows[0]!.p).toBeNull();
    // …and on a workspace with NO stored policy, an update cannot plant one
    // (the stored-value carry-over alone would not stop it).
    await repo.update(
      W2,
      { settings: { theme: "dark", exposurePolicy: planted } } as never,
      A
    );
    await repo.mergeSettings(W2, { exposurePolicy: planted } as never, A);
    const after = await q<{ p: unknown }>(
      `select settings->'exposurePolicy' as p, settings->>'theme' as t from workspaces where id=$1`,
      [W2]
    );
    expect(after.rows[0]).toEqual({ p: null, t: "dark" });
  });

  it("only the workspace owner reads or writes it", async () => {
    expect((await errOf(human(R).getPolicy({ workspaceId: W })))?.code).toBe(
      "FORBIDDEN"
    );
  });
});
