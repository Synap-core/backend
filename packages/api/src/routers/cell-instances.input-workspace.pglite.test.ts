/**
 * `cellInstances.create` / `createHtmlCell` / `link` gate the workspace the
 * row LANDS in, not only the `X-Workspace-Id` header (audit F10), through the
 * REAL procedures on PGlite.
 *
 * Before the fix, `workspaceProcedure` vetted the header and the procedures
 * then wrote into `input.workspaceId`, unchecked: a member of space B put a
 * `trusted` html-embed cell (and its document) into space A, where A's members
 * see it. `link` (a protectedProcedure) vetted nothing and never checked the
 * cell or the entity.
 *
 *   WA: Alice owns it. Carol is a VIEWER there. Alice's cell C, entity E,
 *       document D live in WA.
 *   WB: Bob owns it. Bob has no role in WA.
 *
 * Real: workspaceProcedure, `assertWorkspaceWrite`, the access layer's read
 * floors (cell_instances, entities, documents).
 * Stubbed: `db`/`getDb` → a PGlite drizzle over every schema table; the event
 * repository (no-op); `createDocumentWithContent` (records the call: the
 * storage upload is not what this is about); the read-only guard; the audit log.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  docCreates: [] as Array<{ workspaceId: unknown }>,
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
  return {
    ...actual,
    db,
    getDb: async () => db,
    eventRepository: noop,
    createDocumentWithContent: vi.fn(
      async (_db: unknown, _ev: unknown, args: { workspaceId: unknown }) => {
        h.docCreates.push({ workspaceId: args.workspaceId });
        return { id: randomUUID() };
      }
    ),
  };
});
vi.mock("../utils/audit-log.js", () => ({ auditLog: vi.fn() }));
vi.mock("../utils/split-brain-service.js", () => ({
  isPodReadOnly: vi.fn().mockResolvedValue(false),
}));

import { pgliteAllTablesDdl } from "../__tests__/pglite-ddl.js";
import { cellInstancesRouter } from "./cell-instances.js";

const ALICE = randomUUID();
const BOB = randomUUID();
const CAROL = randomUUID();
const WA = randomUUID();
const WB = randomUUID();
const C = randomUUID();
const E = randomUUID();
const D = randomUUID();

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const caller = (userId: string, workspaceId: string | null) =>
  cellInstancesRouter.createCaller({
    authenticated: true,
    userId,
    workspaceId,
  } as never);

const cellsIn = async (ws: string) =>
  (
    await q<{ n: number }>(
      `select count(*)::int as n from cell_instances where workspace_id = $1`,
      [ws]
    )
  ).rows[0].n;

beforeAll(async () => {
  await h.client!.exec(pgliteAllTablesDdl());
  for (const [ws, owner] of [
    [WA, ALICE],
    [WB, BOB],
  ]) {
    await q(`insert into workspaces (id, name, owner_id) values ($1,$2,$3)`, [
      ws,
      `space ${ws.slice(0, 4)}`,
      owner,
    ]);
    await q(
      `insert into workspace_members (workspace_id, user_id, role) values ($1,$2,'owner')`,
      [ws, owner]
    );
  }
  await q(
    `insert into workspace_members (workspace_id, user_id, role) values ($1,$2,'viewer')`,
    [WA, CAROL]
  );
  await q(
    `insert into cell_instances (id, workspace_id, user_id, cell_type, config) values ($1,$2,$3,'note','{}'::jsonb)`,
    [C, WA, ALICE]
  );
  await q(
    `insert into entities (id, user_id, workspace_id, type, title) values ($1,$2,$3,'task','Alice task')`,
    [E, ALICE, WA]
  );
  await q(
    `insert into documents (id, user_id, workspace_id, title, type) values ($1,$2,$3,'Alice doc','text')`,
    [D, ALICE, WA]
  );
});

describe("cellInstances — the input workspace is gated, not only the header (F10)", () => {
  it("createHtmlCell: Bob (header = his own space) cannot write into Alice's space", async () => {
    const before = await cellsIn(WA);
    await expect(
      caller(BOB, WB).createHtmlCell({
        workspaceId: WA,
        html: "<script>parent.postMessage('x','*')</script>",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await cellsIn(WA)).toBe(before);
    expect(h.docCreates.filter((c) => c.workspaceId === WA)).toEqual([]);
  });

  it("create: Bob cannot write into Alice's space through the input", async () => {
    const before = await cellsIn(WA);
    await expect(
      caller(BOB, WB).create({ cellType: "note", workspaceId: WA })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await cellsIn(WA)).toBe(before);
  });

  it("create: a VIEWER of the space cannot write a cell there either", async () => {
    await expect(
      caller(CAROL, WA).create({ cellType: "note" })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("create: Bob cannot point a cell in his own space at Alice's document", async () => {
    const before = await cellsIn(WB);
    await expect(
      caller(BOB, WB).create({ cellType: "html-embed", sourceDocumentId: D })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await cellsIn(WB)).toBe(before);
  });

  it("link: Bob cannot stamp a relation into Alice's space", async () => {
    await expect(
      caller(BOB, null).link({ cellId: C, entityId: E, workspaceId: WA })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("link: Bob cannot link Alice's cell and entity from his own space", async () => {
    await expect(
      caller(BOB, WB).link({ cellId: C, entityId: E })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const { rows } = await q<{ n: number }>(
      `select count(*)::int as n from relations where source_cell_id = $1`,
      [C]
    );
    expect(rows[0].n).toBe(0);
  });

  it("the owner still creates and links in her own space (the floor is not a wall)", async () => {
    const before = await cellsIn(WA);
    const cell = await caller(ALICE, WA).create({
      cellType: "html-embed",
      sourceDocumentId: D,
    });
    expect(cell.workspaceId).toBe(WA);
    expect(await cellsIn(WA)).toBe(before + 1);
    const linked = await caller(ALICE, WA).link({ cellId: C, entityId: E });
    expect(linked.status).toBe("created");
  });
});
