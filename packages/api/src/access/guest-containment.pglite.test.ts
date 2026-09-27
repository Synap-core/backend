/**
 * GUEST CONTAINMENT, end to end on PGlite, through the served doors.
 *
 * Every call goes through `coreRouter` with a context from the REAL
 * `createContext` (the factory both tRPC HTTP mounts use), so the guard, the
 * allowlist paths and the audience probe are the production ones; the audience
 * is the real SQL (`podGuestWhere` / `podReaderWhere`) on real rows. Stubbed:
 * governance (`checkPermissionOrPropose`: a human is granted), the audit log and
 * the split-brain probe. 0276 runs after the Drizzle DDL, so its CHECKs exist.
 *
 * Principals:
 *   A  — owner: pod_members owner, owns + member of W;
 *   M  — a participant: pod_members member;
 *   G  — a GUEST of project P (and nothing else);
 *   N  — a signed-in person with no membership; becomes a guest by REDEEMING
 *        a link (the real door), then accepts an owner's invite;
 *   PV — a project-only VIEWER of P (the federated project shape): not a guest;
 *   Z  — owns W2, where A has no membership.
 *
 * What this CANNOT see: realtime transport, production Postgres, Typesense.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
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
vi.mock("../utils/permission-check.js", () => ({
  checkPermissionOrPropose: vi.fn(async () => ({ granted: true })),
  previewPermissionDecision: vi.fn(),
  proposedMessageFor: vi.fn(() => "proposed"),
}));
vi.mock("../utils/audit-log.js", () => ({
  auditLog: vi.fn(async () => undefined),
}));
vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { entities, channels } from "@synap/database/schema";
import {
  ProjectRepository,
  RelationRepository,
  ExposureEdgeWriteRefused,
} from "@synap/database";
import {
  channelVisibilityWhere,
  canUserSeeChannel,
  listChannelAudienceUserIds,
} from "@synap/database/channel-visibility";
import { coreRouter } from "../root.js";
import { createContext } from "../context.js";
import { AccessContext } from "./context.js";
import { GUEST_REFUSED_MESSAGE } from "./guest-containment.js";
import { VISIBLE_TO } from "../utils/project-scope.js";
import {
  entityFloorWhere,
  entityWriteVisibleWhere,
} from "../routers/entities/helpers.js";

const A = randomUUID();
const M = randomUUID();
const G = randomUUID();
const N = randomUUID();
const PV = randomUUID();
const Z = randomUUID();
const W = randomUUID();
const W2 = randomUUID();
let P = "";

const E = randomUUID(); // W, body D, shared with P (visible_to)
const S = randomUUID(); // pod-wide (NULL workspace), A's, shared with P
const B = randomUUID(); // W, filed into P (belongs_to_project)
const U = randomUUID(); // W, no body
const D = randomUUID(); // E's body (W)
const D2 = randomUUID(); // unbound document (W)
const DZ = randomUUID(); // Z's document in W2
const EDGE_B = randomUUID(); // B -belongs_to_project-> P, owned by A
const EDGE_R = randomUUID(); // U -related_to-> B, owned by A
const CH_POD = randomUUID(); // pod-wide shared (external) channel
const CH_G = randomUUID(); // a channel the guest owns

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
    return `"${c.name}" ${type}${pk}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const q = (text: string, params?: unknown[]) => h.client!.query(text, params);
const count = async (text: string, params: unknown[]) =>
  ((await q(text, params)).rows[0] as { n: number }).n;

type Caller = Record<string, Record<string, (i: unknown) => Promise<unknown>>>;
async function as(userId: string): Promise<Caller> {
  const ctx = await createContext(new Request("http://pod.test/trpc"), {
    get: (key: string) =>
      key === "session"
        ? { identity: { id: userId, traits: { email: `${userId}@x.test` } } }
        : undefined,
  });
  return coreRouter.createCaller(ctx as never) as unknown as Caller;
}

/** The error a call ends in: `OK`, the guest refusal, or `CODE: message`. */
async function outcome(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "OK";
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (e.message === GUEST_REFUSED_MESSAGE) return "GUEST_REFUSED";
    return `${e.code ?? "ERR"}: ${e.message ?? String(err)}`;
  }
}

const audienceOf = (userId: string) =>
  AccessContext.operator({ userId }).audience();

async function idsWhere(where: unknown): Promise<Set<string>> {
  const rows = await (
    h.db as {
      select: (s: object) => {
        from: (t: object) => {
          where: (w: unknown) => Promise<{ id: string }[]>;
        };
      };
    }
  )
    .select({ id: entities.id })
    .from(entities)
    .where(where);
  return new Set(rows.map((r) => r.id));
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
        "../../../database/migrations/0276_exposure_substrate.sql"
      ),
      "utf8"
    )
  );

  for (const u of [A, M, G, N, PV, Z]) {
    await q(`insert into users (id, email) values ($1, $2)`, [
      u,
      `${u}@x.test`,
    ]);
  }
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'W',$2,'{}'::jsonb),($3,'W2',$4,'{}'::jsonb)`,
    [W, A, W2, Z]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner'),($4,$5,$6,'owner')`,
    [randomUUID(), W, A, randomUUID(), W2, Z]
  );
  await q(
    `insert into pod_members (id, user_id, pod_role) values ($1,$2,'owner'),($3,$4,'member')`,
    [randomUUID(), A, randomUUID(), M]
  );
  const repo = new ProjectRepository(h.db, {
    append: async () => undefined,
  } as never);
  P = (await repo.create({ name: "Portal", workspaceId: W, userId: A }, A)).id;

  for (const [id, ws, owner, doc] of [
    [E, W, A, D],
    [S, null, A, null],
    [B, W, A, null],
    [U, W, A, null],
  ] as const) {
    await q(
      `insert into entities (id, user_id, workspace_id, title, document_id) values ($1,$2,$3,'e',$4)`,
      [id, owner, ws, doc]
    );
  }
  for (const [id, ws, owner] of [
    [D, W, A],
    [D2, W, A],
    [DZ, W2, Z],
  ] as const) {
    await q(
      `insert into documents (id, user_id, workspace_id, title, type, current_version, content_revision) values ($1,$2,$3,'Doc','markdown',1,1)`,
      [id, owner, ws]
    );
  }
  await q(
    `insert into relations (id, user_id, workspace_id, source_entity_id, target_entity_id, type) values ($1,$2,$3,$4,$5,'belongs_to_project'),($6,$2,$3,$7,$4,'related_to')`,
    [EDGE_B, A, W, B, P, EDGE_R, U]
  );
  await q(
    `insert into project_members (id, project_id, user_id, role) values ($1,$2,$3,'guest'),($4,$2,$5,'viewer')`,
    [randomUUID(), P, G, randomUUID(), PV]
  );
  await q(
    `insert into channels (id, user_id, workspace_id, channel_type, title) values ($1,$2,null,'external','pod bridge'),($3,$4,null,'ai_thread','mine')`,
    [CH_POD, A, CH_G, G]
  );

  // Share E and the pod-wide S with P through the REAL share door (the one
  // writer allowed to mint `visible_to`).
  const asA = await as(A);
  for (const id of [E, S]) {
    const res = (await asA.shares.share({
      resourceType: "entity",
      resourceId: id,
      anchorProjectId: P,
      audience: "guest",
    })) as { status?: string };
    expect(res).toBeTruthy();
  }
  const edges = await count(
    `select count(*)::int as n from relations where type = 'visible_to' and target_entity_id = $1`,
    [P]
  );
  expect(edges).toBe(2);
}, 180_000);

describe("B1 — a guest cannot become a participant", () => {
  it("the principals resolve to the expected audiences", async () => {
    expect(await audienceOf(G)).toBe("guest");
    expect(await audienceOf(A)).toBe("member");
    expect(await audienceOf(M)).toBe("member");
    expect(await audienceOf(PV)).toBe("member");
  });

  it("guest → workspaces.create is refused and the guest STAYS a guest", async () => {
    const asG = await as(G);
    expect(await outcome(asG.workspaces.create({ name: "mine" }))).toBe(
      "GUEST_REFUSED"
    );
    expect(
      await count(
        `select count(*)::int as n from workspaces where owner_id = $1`,
        [G]
      )
    ).toBe(0);
    expect(
      await count(
        `select count(*)::int as n from workspace_members where user_id = $1`,
        [G]
      )
    ).toBe(0);
    expect(await audienceOf(G)).toBe("guest");
  });

  it("M7 — guest → apiKeys.create is refused; no key row exists", async () => {
    const asG = await as(G);
    expect(
      await outcome(
        asG.apiKeys.create({ keyName: "k", scope: ["hub-protocol.read"] })
      )
    ).toBe("GUEST_REFUSED");
    expect(
      await count(
        `select count(*)::int as n from api_keys where user_id = $1`,
        [G]
      )
    ).toBe(0);
  });

  it("redeeming a link makes a GUEST, never a participant", async () => {
    const asA = await as(A);
    const link = (await asA.shares.share({
      resourceType: "entity",
      resourceId: E,
      anchorProjectId: P,
      audience: "link",
    })) as { token?: string };
    expect(typeof link.token).toBe("string");
    const asN = await as(N);
    expect(await outcome(asN.shares.redeemLink({ token: link.token }))).toBe(
      "OK"
    );
    expect(await audienceOf(N)).toBe("guest");
    expect(
      await count(
        `select (select count(*) from workspaces where owner_id = $1)::int + (select count(*) from workspace_members where user_id = $1)::int + (select count(*) from pod_members where user_id = $1)::int as n`,
        [N]
      )
    ).toBe(0);
    // A second redeem by the now-guest is on the allowlist: it answers, it is
    // not refused.
    expect(
      await outcome((await as(N)).shares.redeemLink({ token: link.token }))
    ).toBe("OK");
  });

  it("an owner's invite is the door out: the guest accepts it and gets the participant floor", async () => {
    const token = `inv-${randomUUID()}`;
    await q(
      `insert into invites (id, token, email, workspace_id, role, type, invited_by, expires_at, created_at) values ($1,$2,$3,$4,'editor','workspace',$5, now() + interval '1 day', now())`,
      [randomUUID(), token, `${N}@x.test`, W, A]
    );
    const asN = await as(N);
    const accepted = await outcome(asN.workspaces.acceptInvite({ token }));
    expect(accepted).not.toBe("GUEST_REFUSED");
    expect(
      await count(
        `select count(*)::int as n from workspace_members where user_id = $1 and workspace_id = $2`,
        [N, W]
      )
    ).toBe(1);
    expect(await audienceOf(N)).toBe("member");
    // …and the guard now lets its mutations through (it fails later, on input).
    expect(await outcome((await as(N)).workspaces.create(undefined))).not.toBe(
      "GUEST_REFUSED"
    );
  });

  it("participants are UNCHANGED by the guard (owner, member, project viewer)", async () => {
    for (const u of [A, M, PV]) {
      const got = await outcome((await as(u)).workspaces.create(undefined));
      expect(got, u).not.toBe("GUEST_REFUSED");
      expect(got, u).toMatch(/^BAD_REQUEST/);
    }
  });
});

describe("H2 — sharing grants READ, never write", () => {
  it("a guest cannot write, delete or repoint the body of a shared pod-wide entity", async () => {
    const asG = await as(G);
    expect(await outcome(asG.entities.update({ id: S, title: "pwn" }))).toBe(
      "GUEST_REFUSED"
    );
    expect(await outcome(asG.entities.update({ id: S, documentId: DZ }))).toBe(
      "GUEST_REFUSED"
    );
    const [row] = (
      await q(`select title, document_id from entities where id = $1`, [S])
    ).rows as Array<{ title: string; document_id: string | null }>;
    expect(row).toEqual({ title: "e", document_id: null });
  });

  it("the write floor excludes the share branch; the read floor keeps it", async () => {
    // Guest: reads E and S through the share, can target nothing for a write.
    expect(await idsWhere(entityFloorWhere(G))).toEqual(new Set([E, S]));
    expect(await idsWhere(entityWriteVisibleWhere(G))).toEqual(new Set());
    // Project viewer: reads the shared E/S and the filed B; writes only B
    // (project content), never what was merely shared with the project.
    const pvRead = await idsWhere(entityFloorWhere(PV));
    expect([E, S, B].every((id) => pvRead.has(id))).toBe(true);
    const pvWrite = await idsWhere(entityWriteVisibleWhere(PV));
    expect(pvWrite.has(B)).toBe(true);
    expect(pvWrite.has(E)).toBe(false);
    expect(pvWrite.has(S)).toBe(false);
    // Owner: unchanged — the whole workspace plus their own pod-wide row.
    expect(await idsWhere(entityWriteVisibleWhere(A))).toEqual(
      new Set([E, S, B, U])
    );
  });

  it("an entity cannot be repointed at a document the caller may not edit, or at another object's body", async () => {
    const asA = await as(A);
    expect(
      await outcome(asA.entities.update({ id: U, documentId: DZ }))
    ).toMatch(/^NOT_FOUND/);
    expect(await outcome(asA.entities.update({ id: U, documentId: D }))).toBe(
      "FORBIDDEN: That document is already the body of another object."
    );
    const [row] = (
      await q(`select document_id from entities where id = $1`, [U])
    ).rows as Array<{ document_id: string | null }>;
    expect(row.document_id).toBeNull();
    // Control: an unbound, editable document of the same workspace passes the
    // check (whatever the rest of the update does in this harness).
    const ok = await outcome(asA.entities.update({ id: U, documentId: D2 }));
    expect(ok).not.toMatch(/already the body|another workspace|^NOT_FOUND/);
  });

  it("entities.create applies the same document check as update", async () => {
    await q(
      `insert into profiles (id, slug, profile_kind, scope, origin, is_active, display_name) values ($1,'note','kind','system','system',true,'Note') on conflict do nothing`,
      [randomUUID()]
    );
    const D3 = randomUUID(); // unbound, editable, same workspace
    await q(
      `insert into documents (id, user_id, workspace_id, title, type, current_version, content_revision) values ($1,$2,$3,'Doc','markdown',1,1)`,
      [D3, A, W]
    );
    const asA = await as(A);
    const create = (documentId: string) =>
      outcome(
        asA.entities.create({
          profileSlug: "note",
          title: "with a body",
          documentId,
          targetWorkspaceId: W,
          workspaceScoped: true,
        })
      );
    const before = await count(
      `select count(*)::int as n from entities where title = 'with a body'`,
      []
    );
    // Someone else's document in another workspace: not even visible.
    const hidden = await create(DZ);
    expect(hidden).toMatch(/^NOT_FOUND/);
    // Non-vacuity: the harness reaches the check (the profile resolved).
    expect(hidden).not.toMatch(/Profile/);
    // Another entity's body: refused, never shared through a second entity.
    expect(await create(D)).toBe(
      "FORBIDDEN: That document is already the body of another object."
    );
    expect(
      await count(
        `select count(*)::int as n from entities where title = 'with a body'`,
        []
      )
    ).toBe(before);
    // Control: an unbound, editable document of the same workspace passes the
    // check (whatever the rest of the create does in this harness).
    expect(await create(D3)).not.toMatch(
      /already the body|another workspace|^NOT_FOUND/
    );
  });
});

describe("H1 — no generic door mints or drops a visible_to edge", () => {
  it("relations.update refuses retyping INTO visible_to (editor/owner included)", async () => {
    const asA = await as(A);
    expect(
      await outcome(asA.relations.update({ id: EDGE_B, type: VISIBLE_TO }))
    ).toMatch(/^FORBIDDEN: visible_to is an exposure edge/);
    const [row] = (
      await q(`select type from relations where id = $1`, [EDGE_B])
    ).rows as Array<{ type: string }>;
    expect(row.type).toBe("belongs_to_project");
  });

  it("relations.update / delete refuse retyping or deleting an existing visible_to edge", async () => {
    const [edge] = (
      await q(
        `select id from relations where type = 'visible_to' and source_entity_id = $1`,
        [E]
      )
    ).rows as Array<{ id: string }>;
    const asA = await as(A);
    expect(
      await outcome(asA.relations.update({ id: edge.id, type: "related_to" }))
    ).toMatch(/^FORBIDDEN: visible_to is an exposure edge/);
    expect(await outcome(asA.relations.delete({ id: edge.id }))).toMatch(
      /^FORBIDDEN: visible_to is an exposure edge/
    );
    expect(
      await count(
        `select count(*)::int as n from relations where id = $1 and type = 'visible_to'`,
        [edge.id]
      )
    ).toBe(1);
  });

  it("an ordinary retype still works (control)", async () => {
    const asA = await as(A);
    expect(
      await outcome(asA.relations.update({ id: EDGE_R, type: "mentions" }))
    ).toBe("OK");
    const [row] = (
      await q(`select type from relations where id = $1`, [EDGE_R])
    ).rows as Array<{ type: string }>;
    expect(row.type).toBe("mentions");
  });

  it("the repository refuses visible_to for every writer but the share door", async () => {
    const repo = new RelationRepository(h.db, {
      append: async () => undefined,
    } as never);
    await expect(
      repo.create(
        {
          sourceEntityId: U,
          targetEntityId: P,
          type: VISIBLE_TO,
          workspaceId: W,
          userId: A,
        },
        A
      )
    ).rejects.toBeInstanceOf(ExposureEdgeWriteRefused);
    await expect(
      repo.update(EDGE_R, { type: VISIBLE_TO }, A)
    ).rejects.toBeInstanceOf(ExposureEdgeWriteRefused);
  });
});

describe("H3 — a guest reads no channel", () => {
  const visibleTo = async (userId: string) =>
    new Set(
      (
        await (
          h.db as {
            select: (s: object) => {
              from: (t: object) => {
                where: (w: unknown) => Promise<{ id: string }[]>;
              };
            };
          }
        )
          .select({ id: channels.id })
          .from(channels)
          .where(channelVisibilityWhere(userId))
      ).map((r) => r.id)
    );

  it("the pod-wide shared channel is visible to a participant, not to the guest", async () => {
    expect((await visibleTo(M)).has(CH_POD)).toBe(true);
    expect(await visibleTo(G)).toEqual(new Set());
    expect(await canUserSeeChannel(h.db as never, CH_POD, G)).toBe(false);
    expect(await canUserSeeChannel(h.db as never, CH_POD, M)).toBe(true);
  });

  it("not even a channel the guest owns", async () => {
    expect(await canUserSeeChannel(h.db as never, CH_G, G)).toBe(false);
  });

  it("the realtime audience of the channel excludes the guest (column form)", async () => {
    const audience = await listChannelAudienceUserIds(h.db as never, CH_POD);
    expect(audience).toContain(M);
    expect(audience).toContain(A);
    expect(audience).not.toContain(G);
  });
});
