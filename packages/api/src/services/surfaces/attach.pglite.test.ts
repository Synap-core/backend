/**
 * Attached surfaces (Surfaces P3) on PGlite, through the REAL tRPC doors
 * (`surfaces.attach | detach | create | forObject`), the real endpoint floor
 * (`checkLinkEndpointsVisible`: the views, cell-instance and entity rules),
 * the real `links` writes and the real reader. Governance is stubbed with its
 * two outcomes: an agent call PROPOSES, a person's call is allowed. The
 * approval half is the real apply (`applyApprovedSurfaceLink`,
 * `applyCreateSurface`) on the payload the gate was handed.
 *
 *   W   — Alice owns it, Bob is an editor. Deal E lives in W.
 *   WB  — Bob's alone.
 *
 * Not seen: production Postgres constraints, the proposal row the gate files
 * (`permission-check.ts`), the views door's canvas path (a cell body is made
 * here; views are created by fixture).
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  permCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  const noop = new Proxy(
    {},
    { get: (_t, k) => (k === "then" ? undefined : async () => undefined) }
  );
  return { ...actual, db, getDb: async () => db, eventRepository: noop };
});
vi.mock("../../utils/permission-check.js", () => ({
  checkPermissionOrPropose: vi.fn(async (args: Record<string, unknown>) => {
    h.permCalls.push(args);
    return args.agentUserId
      ? { proposalId: `proposal-${h.permCalls.length}` }
      : { allowed: true };
  }),
  previewPermissionDecision: vi.fn(async () => ({ decision: "allow" })),
  proposedMessageFor: vi.fn(() => "proposed"),
}));
vi.mock("../../utils/domain-mutation.js", () => ({
  recordDomainMutation: vi.fn(async () => undefined),
}));

import { pgliteAllTablesDdl } from "../../__tests__/pglite-ddl.js";
import { surfacesRouter } from "../../routers/surfaces.js";
import { entitiesRouter } from "../../routers/entities.js";
import { applyApprovedSurfaceLink } from "./attach.js";
import { applyCreateSurface } from "./create.js";

const ALICE = randomUUID();
const BOB = randomUUID();
const AGENT = randomUUID();
const W = randomUUID();
const WB = randomUUID();
const E = randomUUID(); // a deal in W
const V_RADAR = randomUUID(); // Alice's view in W
const V_BOB_PRIVATE = randomUUID(); // Bob's view in WB: Alice cannot see it
const V_AGENT = randomUUID(); // the view an agent attaches
const V_DETACH = randomUUID();

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const caller = (userId: string, agent = false) =>
  surfacesRouter.createCaller({
    authenticated: true,
    userId,
    workspaceId: null,
    ...(agent ? { agentUserId: AGENT } : {}),
  } as never);

const attachedIds = async (userId: string) =>
  (await caller(userId).forObject({ kind: "entity", id: E })).rows
    .filter((r) => r.relation === "attached" && r.source === "attaches")
    .map((r) => r.id);

const edges = async () =>
  (
    await q<{ to_id: string }>(
      `select to_id from links where from_type='entity' and from_id=$1 and link_type='attaches'`,
      [E]
    )
  ).rows.map((r) => r.to_id);

beforeAll(async () => {
  await h.client!.exec(pgliteAllTablesDdl());
  // The one production constraint the attachment's ON CONFLICT names.
  await h.client!.exec(
    `create unique index on links (from_type, from_id, to_type, to_id, link_type)`
  );
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'W',$2,'{}'::jsonb), ($3,'WB',$4,'{}'::jsonb)`,
    [W, ALICE, WB, BOB]
  );
  await q(
    `insert into workspace_members (workspace_id, user_id, role) values ($1,$2,'owner'), ($1,$3,'editor'), ($4,$3,'owner')`,
    [W, ALICE, BOB, WB]
  );
  await q(
    `insert into entities (id, user_id, workspace_id, type, title) values ($1,$2,$3,'deal','Seed round')`,
    [E, ALICE, W]
  );
  for (const [id, ws, owner, name] of [
    [V_RADAR, W, ALICE, "Investor radar"],
    [V_BOB_PRIVATE, WB, BOB, "Bob's notes board"],
    [V_AGENT, W, ALICE, "Pipeline"],
    [V_DETACH, W, ALICE, "Old board"],
  ] as const) {
    await q(
      `insert into views (id, workspace_id, user_id, name, type, category) values ($1,$2,$3,$4,'table','structured')`,
      [id, ws, owner, name]
    );
  }
}, 60_000);

beforeEach(() => {
  h.permCalls.length = 0;
});

describe("surfaces.attach / detach / forObject (links `attaches`)", () => {
  it("a person attaches a view to a deal: one edge, governed as surface/attach, found by forObject", async () => {
    const res = await caller(ALICE).attach({
      anchor: { kind: "entity", id: E },
      surface: { type: "view", id: V_RADAR },
      label: "Radar",
    });
    expect(res).toMatchObject({
      status: "attached",
      openUrl: `/open/entity/${E}?surface=${V_RADAR}`,
    });
    expect(h.permCalls).toHaveLength(1);
    expect(h.permCalls[0]).toMatchObject({
      subjectType: "surface",
      action: "attach",
      workspaceId: W,
      data: {
        anchor: { kind: "entity", id: E },
        surface: { type: "view", id: V_RADAR },
      },
    });
    const again = await caller(ALICE).attach({
      anchor: { kind: "entity", id: E },
      surface: { type: "view", id: V_RADAR },
    });
    expect(again.status).toBe("exists");

    const { rows } = await caller(ALICE).forObject({ kind: "entity", id: E });
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: V_RADAR,
          body: "view",
          viewType: "table",
          relation: "attached",
          title: "Radar",
          source: "attaches",
          openUrl: `/open/entity/${E}?surface=${V_RADAR}`,
        }),
      ])
    );
  });

  it("an agent's attach is a proposal (nothing written); its approval writes the edge", async () => {
    const res = await caller(ALICE, true).attach({
      anchor: { kind: "entity", id: E },
      surface: { type: "view", id: V_AGENT },
    });
    expect(res).toMatchObject({ status: "proposed" });
    expect(h.permCalls[0]).toMatchObject({
      agentUserId: AGENT,
      subjectType: "surface",
      action: "attach",
    });
    expect(await edges()).not.toContain(V_AGENT);
    expect(await attachedIds(ALICE)).not.toContain(V_AGENT);

    const applied = await applyApprovedSurfaceLink({
      action: "attach",
      data: h.permCalls[0]!.data as Record<string, unknown>,
      ownerUserId: ALICE,
      proposalId: randomUUID(),
    });
    expect(applied).toEqual({ ok: true, rows: 1 });
    expect(await attachedIds(ALICE)).toContain(V_AGENT);
  });

  it("detach takes it off (the view stays); a second detach is `absent`, nothing filed", async () => {
    await caller(ALICE).attach({
      anchor: { kind: "entity", id: E },
      surface: { type: "view", id: V_DETACH },
    });
    expect(await attachedIds(ALICE)).toContain(V_DETACH);
    h.permCalls.length = 0;
    const res = await caller(ALICE).detach({
      anchor: { kind: "entity", id: E },
      surface: { type: "view", id: V_DETACH },
    });
    expect(res).toEqual({ status: "detached" });
    expect(h.permCalls[0]).toMatchObject({
      subjectType: "surface",
      action: "detach",
    });
    expect(await attachedIds(ALICE)).not.toContain(V_DETACH);
    const view = await q(`select id from views where id=$1`, [V_DETACH]);
    expect(view.rows).toHaveLength(1);
    h.permCalls.length = 0;
    const again = await caller(ALICE).detach({
      anchor: { kind: "entity", id: E },
      surface: { type: "view", id: V_DETACH },
    });
    expect(again).toEqual({ status: "absent" });
    expect(h.permCalls).toHaveLength(0);
  });

  it("a co-worker who cannot see the surface does not see it on the shared deal", async () => {
    // Bob puts his private board (in WB, where Alice has no seat) on the deal.
    const res = await caller(BOB).attach({
      anchor: { kind: "entity", id: E },
      surface: { type: "view", id: V_BOB_PRIVATE },
    });
    expect(res.status).toBe("attached");
    expect(await attachedIds(BOB)).toContain(V_BOB_PRIVATE);
    expect(await attachedIds(ALICE)).not.toContain(V_BOB_PRIVATE);
  });

  it("a surface you cannot see is refused before governance (same answer as a missing one)", async () => {
    await expect(
      caller(ALICE).attach({
        anchor: { kind: "entity", id: E },
        surface: { type: "view", id: V_BOB_PRIVATE },
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      caller(ALICE).attach({
        anchor: { kind: "entity", id: E },
        surface: { type: "view", id: randomUUID() },
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(h.permCalls).toHaveLength(0);
  });
});

describe("surfaces.create (one act: the body and its edge)", () => {
  it("a person makes a cell for the deal: a cell instance in the deal's space, attached", async () => {
    const res = await caller(ALICE).create({
      anchor: { kind: "entity", id: E },
      body: "cell",
      title: "Next step",
      spec: { cellKey: "entity-header" },
    });
    expect(res).toMatchObject({
      status: "created",
      surface: { type: "cell_instance" },
    });
    const id = (res as { surface: { id: string } }).surface.id;
    expect(h.permCalls[0]).toMatchObject({
      subjectType: "surface",
      action: "create",
      workspaceId: W,
    });
    const cell = await q<{ workspace_id: string; cell_type: string; user_id: string }>(
      `select workspace_id, cell_type, user_id from cell_instances where id=$1`,
      [id]
    );
    expect(cell.rows[0]).toEqual({
      workspace_id: W,
      cell_type: "entity-header",
      user_id: ALICE,
    });
    const { rows } = await caller(ALICE).forObject({ kind: "entity", id: E });
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id,
          body: "cell",
          relation: "attached",
          cellKey: "entity-header",
          title: "Next step",
        }),
      ])
    );
  });

  it("an agent's create is ONE proposal; its approval makes the body under the reserved id", async () => {
    const res = await caller(ALICE, true).create({
      anchor: { kind: "entity", id: E },
      body: "cell",
      title: "Agent cell",
      spec: { cellKey: "entity-header" },
    });
    expect(res).toMatchObject({ status: "proposed" });
    expect(h.permCalls).toHaveLength(1);
    const data = h.permCalls[0]!.data as Record<string, unknown>;
    const reserved = data.surfaceId as string;
    const none = await q(`select id from cell_instances where id=$1`, [reserved]);
    expect(none.rows).toHaveLength(0);

    const made = await applyCreateSurface({
      ownerUserId: ALICE,
      agentUserId: AGENT,
      data,
      proposalId: randomUUID(),
    });
    expect(made).toMatchObject({
      ok: true,
      surface: { type: "cell_instance", id: reserved },
    });
    // A second approval finds the same body and the same edge.
    const twice = await applyCreateSurface({
      ownerUserId: ALICE,
      agentUserId: AGENT,
      data,
      proposalId: randomUUID(),
    });
    expect(twice).toMatchObject({ ok: true });
    const edgesTo = await q(
      `select id from links where link_type='attaches' and to_id=$1`,
      [reserved]
    );
    expect(edgesTo.rows).toHaveLength(1);
    expect(await attachedIds(ALICE)).toContain(reserved);
  });

  it("refuses an HTML artifact with no page, before governance", async () => {
    await expect(
      caller(ALICE).create({
        anchor: { kind: "entity", id: E },
        body: "html",
        title: "Deck",
        spec: {},
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(h.permCalls).toHaveLength(0);
  });
});

describe("entities.setEntityRenderer (aliased onto the attach door)", () => {
  const detailLooks = async () =>
    (
      await q<{ to_id: string; cell_type: string }>(
        `select l.to_id, c.cell_type from links l join cell_instances c on c.id::text = l.to_id
         where l.from_type='entity' and l.from_id=$1 and l.link_type='attaches'
           and l.to_type='cell_instance' and l.metadata->>'slot' = 'detail'`,
        [E]
      )
    ).rows;
  const setLook = (cellKey: string | null) =>
    entitiesRouter
      .createCaller({
        authenticated: true,
        userId: ALICE,
        workspaceId: W,
      } as never)
      .setEntityRenderer({
        entityId: E,
        ref: cellKey ? { kind: "cell", cellKey } : null,
      });

  it("writes the look as the entity's detail attachment, replaces it, and clears it", async () => {
    const res = await setLook("entity-header");
    expect(res).toMatchObject({ status: "applied" });
    expect(h.permCalls[0]).toMatchObject({
      subjectType: "entity",
      action: "renderer.set",
    });
    expect((await detailLooks()).map((r) => r.cell_type)).toEqual([
      "entity-header",
    ]);
    // The mirror the not-yet-moved clients read.
    const [row] = (
      await q<{ system_data: { renderer?: { cellKey?: string } } }>(
        `select system_data from entities where id=$1`,
        [E]
      )
    ).rows;
    expect(row!.system_data.renderer?.cellKey).toBe("entity-header");
    // forObject names it once, as attached in slot detail.
    const { rows } = await caller(ALICE).forObject({ kind: "entity", id: E });
    expect(
      rows.filter((r) => r.slot === "detail" && r.relation === "attached")
    ).toHaveLength(1);

    await setLook("entity-properties");
    expect((await detailLooks()).map((r) => r.cell_type)).toEqual([
      "entity-properties",
    ]);

    await setLook(null);
    expect(await detailLooks()).toEqual([]);
  });
});
