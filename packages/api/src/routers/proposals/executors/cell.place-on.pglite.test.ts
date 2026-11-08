/**
 * `cell/define` with `placeOn` — approving defines the cell AND places it as a
 * tile on a bento view, in ONE act (design b199a3a4, Question 2, slice 4).
 *
 * The REAL executor, the REAL `defineCell` (the one writer), the REAL view
 * floor (`assertViewAccess`) and the REAL placement, on PGlite. Stubbed: the
 * executor registry (to reach the executor), the telemetry report, the
 * realtime fan-out (recorded, to see what was announced).
 *
 * Rows rule out:
 *   - an approval that defines the cell and places it nowhere (`placeOn`
 *     dropped by the executor);
 *   - a refused placement that leaves an ORPHAN cell: refused before any write
 *     (view missing, not a bento, another space, an approver who may not write
 *     it) and refused INSIDE the act (the view row is not the approver's to
 *     change: the cell write already ran and must roll back with it);
 *   - a refused act that still marks the proposal approved, or announces a
 *     cell that is not there;
 *   - a second placement of the same cell adding a second tile.
 */
import { randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  registered: new Map<string, { execute: (a: unknown) => Promise<unknown> }>(),
  events: [] as string[],
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema });
  return { ...actual, db, getDb: async () => db };
});
vi.mock("../execution-registry.js", () => ({
  registerProposalExecutor: (e: {
    key: string;
    execute: (a: unknown) => Promise<unknown>;
  }) => h.registered.set(e.key, e),
}));
vi.mock("./shared.js", () => ({ reportApproved: () => undefined }));
vi.mock("../../../utils/domain-event-bridge.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitHubRealtimeEvent: (e: { eventType: string; subjectId: string }) =>
    h.events.push(`${e.eventType} ${e.subjectId}`),
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";

const { registerCellExecutors } = await import("./cell.js");
registerCellExecutors();

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
      c.name === "created_at" || c.name === "updated_at"
        ? " default now()"
        : c.name === "is_active"
          ? " default true"
          : c.name === "default_size"
            ? ` default '{"w":6,"h":4}'::jsonb`
            : c.name === "content_kind"
              ? " default 'widget'"
              : "";
    return `"${c.name}" ${type}${pk}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const OWNER = randomUUID();
const COLLEAGUE = randomUUID();
const STRANGER = randomUUID();
const CRM = randomUUID();
const OTHER = randomUUID();
/** The CRM's Health bento, the owner's, already holding one tile. */
const HEALTH = randomUUID();
/** A bento in the CRM space a colleague made: the owner may write the space, not this row. */
const COLLEAGUE_BENTO = randomUUID();
const TABLE_VIEW = randomUUID();
const OTHER_BENTO = randomUUID();

const q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

const HTML = "<!doctype html><html><body><p>Replies by week</p></body></html>";
const EXISTING_TILE = {
  id: "b1",
  kind: "widget",
  widgetType: "stat-card",
  pos: { x: 0, y: 0, w: 12, h: 3 },
};

async function view(
  id: string,
  ws: string,
  owner: string,
  type: string,
  config: object
) {
  await q(
    `insert into views (id, user_id, workspace_id, name, type, category, config, metadata)
     values ($1,$2,$3,$4,$5,'composite',$6::jsonb,'{}'::jsonb)`,
    [id, owner, ws, `${type} ${id.slice(0, 4)}`, type, JSON.stringify(config)]
  );
}

async function proposal(typeKey: string, placeOn: unknown): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into proposals (id, workspace_id, target_type, target_id, proposal_type, data, status, created_by)
     values ($1,$2,'cell',$3,'cell.define',$4::jsonb,'pending',$5)`,
    [
      id,
      CRM,
      typeKey,
      JSON.stringify({
        data: {
          // As the doors file it: no typeKey, so the cell lands under the
          // key derived from its name (`generated:<slug>`), which a payload
          // may not mint itself (namespaced-type-key.ts).
          name: typeKey.replace(/^generated:/, ""),
          rendererSource: HTML,
          workspaceId: CRM,
          contentKind: "widget",
          ...(placeOn === undefined ? {} : { placeOn }),
        },
      }),
      OWNER,
    ]
  );
  return id;
}

async function approve(proposalId: string, userId = OWNER) {
  const [row] = (
    await q<{ workspace_id: string; data: unknown }>(
      `select workspace_id, data from proposals where id = $1`,
      [proposalId]
    )
  ).rows;
  return h.registered.get("cell/define")!.execute({
    proposal: {
      id: proposalId,
      workspaceId: row!.workspace_id,
      data: row!.data,
    },
    userId,
    input: { proposalId },
    deps: { emitProposalReviewed: () => undefined },
  });
}

const cellRows = async (typeKey: string) =>
  (
    await q<{ id: string }>(
      `select id from widget_definitions where type_key = $1`,
      [typeKey]
    )
  ).rows.length;
const statusOf = async (id: string) =>
  (
    await q<{ status: string }>(`select status from proposals where id = $1`, [
      id,
    ])
  ).rows[0]!.status;
const blocksOf = async (viewId: string) =>
  (
    await q<{ config: { blocks: Array<Record<string, unknown>> } }>(
      `select config from views where id = $1`,
      [viewId]
    )
  ).rows[0]!.config.blocks;

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));
  await h.client!.exec(
    `create unique index wd_key_ws on widget_definitions (type_key, workspace_id);`
  );
  for (const [ws, name] of [
    [CRM, "CRM"],
    [OTHER, "Other"],
  ] as const) {
    await q(
      `insert into workspaces (id, name, owner_id, settings) values ($1,$2,$3,'{}'::jsonb)`,
      [ws, name, OWNER]
    );
    await q(
      `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner')`,
      [randomUUID(), ws, OWNER]
    );
  }
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'editor')`,
    [randomUUID(), CRM, COLLEAGUE]
  );
  await view(HEALTH, CRM, OWNER, "bento", { blocks: [EXISTING_TILE] });
  await view(COLLEAGUE_BENTO, CRM, COLLEAGUE, "bento", { blocks: [] });
  await view(TABLE_VIEW, CRM, OWNER, "table", {});
  await view(OTHER_BENTO, OTHER, OWNER, "bento", { blocks: [] });
}, 120_000);

beforeEach(() => {
  h.events.length = 0;
});

describe("cell/define with placeOn — define and place in one act", () => {
  it("approving defines the cell AND adds its tile to the view, below the others", async () => {
    const id = await proposal("generated:replies-by-week", {
      viewId: HEALTH,
      viewName: "Health",
    });
    await expect(approve(id)).resolves.toEqual({ success: true });

    expect(await cellRows("generated:replies-by-week")).toBe(1);
    const blocks = await blocksOf(HEALTH);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual(EXISTING_TILE);
    expect(blocks[1]).toMatchObject({
      kind: "widget",
      widgetType: "generated:replies-by-week",
      pos: { x: 0, y: 3, w: 6, h: 4 },
    });
    expect(await statusOf(id)).toBe("approved");
    // Announced once committed: the cell, then the view.
    expect(h.events).toEqual([
      "widget_definition.create.completed generated:replies-by-week",
      `view.update.completed ${HEALTH}`,
    ]);
  });

  it("placing a cell the view already shows adds no second tile", async () => {
    const id = await proposal("generated:replies-by-week", { viewId: HEALTH });
    await approve(id);
    expect(
      (await blocksOf(HEALTH)).filter(
        (b) => b.widgetType === "generated:replies-by-week"
      )
    ).toHaveLength(1);
  });

  it.each([
    ["the view is missing", randomUUID(), OWNER, /not found/],
    ["the view is not a bento", TABLE_VIEW, OWNER, /bento/],
    ["the view is in another space", OTHER_BENTO, OWNER, /own space/],
    ["the approver may not write the view", HEALTH, STRANGER, /may not write/],
  ])(
    "REFUSED before any write when %s: no cell, proposal still pending",
    async (_why, viewId, approver, message) => {
      const typeKey = `generated:refused-${randomUUID().slice(0, 8)}`;
      const id = await proposal(typeKey, { viewId });
      await expect(approve(id, approver)).rejects.toThrow(message);
      expect(await cellRows(typeKey)).toBe(0);
      expect(await statusOf(id)).toBe("pending");
      expect(h.events).toEqual([]);
    }
  );

  it("ROLLED BACK when the view write is refused inside the act: the cell written first is gone too", async () => {
    // The owner may write the CRM space (the preflight passes), but the view
    // row is the colleague's: the tile write refuses after the cell write.
    const typeKey = "generated:rolled-back";
    const id = await proposal(typeKey, { viewId: COLLEAGUE_BENTO });
    await expect(approve(id)).rejects.toThrow(/not yours to change/);
    expect(await cellRows(typeKey)).toBe(0);
    expect(await blocksOf(COLLEAGUE_BENTO)).toEqual([]);
    expect(await statusOf(id)).toBe("pending");
    expect(h.events).toEqual([]);
  });

  it("a malformed placeOn is refused, never read as 'place nowhere'", async () => {
    const typeKey = "generated:malformed";
    const id = await proposal(typeKey, { viewId: "not-a-uuid" });
    await expect(approve(id)).rejects.toThrow(/malformed/);
    expect(await cellRows(typeKey)).toBe(0);
  });

  it("CONTROL: without placeOn the cell is defined and no view changes", async () => {
    const before = await blocksOf(HEALTH);
    const id = await proposal("generated:unplaced", undefined);
    await approve(id);
    expect(await cellRows("generated:unplaced")).toBe(1);
    expect(await blocksOf(HEALTH)).toEqual(before);
  });
});
