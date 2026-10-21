/**
 * The hub entity-UPDATE answer names what landed (decision C5).
 *
 * THE DEFECT: an applied `updateEntity` answered `{ status: "updated",
 * message: "Entity updated", proposalId: undefined }` — no entity, no fields,
 * and the same words for a call that sent nothing at all. Raycast read it as
 * an entity (`Updated entity "undefined"`); the IS's outcome reader classed it
 * `requested`.
 *
 * Driven through the real hub caller (`createHubProtocolCaller`, the builder
 * the MCP adapter and the Hub REST door use) → `entities.update` on PGlite,
 * every table from the schema. The gate is a recorder that grants (a human
 * caller) — its decision has its own suites.
 */
import { describe, it, expect, vi, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";

const holder = vi.hoisted(() => ({
  db: undefined as unknown,
  gateCalls: 0,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked = {
    ...actual,
    registerIdentitySignals: async () => undefined,
    getDb: async () => holder.db,
    eventRepository: { append: async () => undefined },
    ProfileResolutionService: class extends (actual.ProfileResolutionService as new (
      db: unknown
    ) => object) {
      async getEffectiveLifecycle() {
        return null;
      }
    },
  };
  Object.defineProperty(mocked, "db", {
    get: () => holder.db,
    enumerable: true,
  });
  return mocked;
});
vi.mock("@synap/events", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  emitSideEffects: vi.fn(async () => undefined),
  getBoss: () => ({ send: async () => null }),
}));
vi.mock("../../../utils/permission-check.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  checkPermissionOrPropose: vi.fn(async () => {
    holder.gateCalls++;
    return { granted: true };
  }),
}));
vi.mock("../../../utils/audit-log.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  auditLog: vi.fn(async () => undefined),
}));
vi.mock("../../../utils/domain-mutation.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  recordDomainMutation: vi.fn(async () => null),
}));
vi.mock("../../../utils/split-brain-service.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isPodReadOnly: vi.fn(async () => false),
}));
vi.mock("../../../utils/property-relation-sync.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  syncPropertyToRelations: vi.fn(async () => undefined),
}));

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { buildUpdateWriteReceipt } from "../update-write-receipt.js";

const USER = randomUUID();
let client: PGlite;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const columns = cfg.columns.map((c) => {
    let type = c.getSQLType();
    if (/vector/.test(type) || c.columnType === "PgEnumColumn") type = "text";
    let def = "";
    const d = c.default as unknown;
    if (d !== undefined && !(d instanceof SQL)) {
      if (typeof d === "string") def = ` default '${d.replace(/'/g, "''")}'`;
      else if (typeof d === "number" || typeof d === "boolean")
        def = ` default ${d}`;
      else if (type.endsWith("[]")) def = ` default '{}'`;
      else def = ` default '${JSON.stringify(d).replace(/'/g, "''")}'::jsonb`;
    } else if (type.startsWith("timestamp") && c.hasDefault) {
      def = " default now()";
    } else if (c.primary && type === "uuid") {
      def = " default gen_random_uuid()";
    }
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${columns.join(", ")});`;
}

beforeAll(async () => {
  client = new PGlite();
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const t of byName.values()) await client.exec(ddlFor(t));
  await client.query(`insert into users (id, email) values ($1, $2)`, [
    USER,
    "owner@example.test",
  ]);
  holder.db = drizzle(client, { schema });
}, 120_000);

async function insertEntity(): Promise<string> {
  const id = randomUUID();
  await client.query(
    `insert into entities (id, user_id, workspace_id, type, title, properties)
     values ($1,$2,null,'note','Old title',$3::jsonb)`,
    [id, USER, JSON.stringify({ owner: "ann", stale: "x" })]
  );
  return id;
}

async function hub() {
  const { createHubProtocolCaller } =
    await import("../../mcp/handlers/shared.js");
  return createHubProtocolCaller(USER, ["mcp.read", "mcp.write"]);
}

describe("hub updateEntity — the applied answer names what landed", () => {
  it("names the entity, the fields written and their stored values", async () => {
    const entityId = await insertEntity();

    const out = (await (
      await hub()
    ).entities.updateEntity({
      entityId,
      userId: USER,
      title: "New title",
      metadata: { owner: "bo" },
      deleteProperties: ["stale"],
    })) as Record<string, any>;

    expect(out).toMatchObject({
      status: "updated",
      entityId,
      title: "New title",
      written: {
        title: "New title",
        properties: { owner: "bo" },
        documentId: null,
      },
      writeReceipt: {
        state: "applied",
        entityId,
        landed: ["title", "properties.owner", "removed.stale"],
      },
    });
    // The old answer's always-undefined proposalId is gone from this branch.
    expect("proposalId" in out).toBe(false);
  });

  it("an EMPTY patch is refused and writes nothing — never 'Entity updated'", async () => {
    const entityId = await insertEntity();
    const before = holder.gateCalls;

    const err = await (
      await hub()
    ).entities
      .updateEntity({ entityId, userId: USER, metadata: {} })
      .catch((e: unknown) => e);

    expect(err).toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("Nothing to update"),
    });
    expect(holder.gateCalls).toBe(before);
    const { rows } = await client.query<{ title: string }>(
      `select title from entities where id = $1`,
      [entityId]
    );
    expect(rows[0]!.title).toBe("Old title");
  });
});

describe("buildUpdateWriteReceipt — a proposed status move is not 'landed'", () => {
  it("names the status key under `proposed` and calls the write partial", () => {
    expect(
      buildUpdateWriteReceipt({
        entityId: "e1",
        patch: { title: "T", metadata: { stage: "won", owner: "bo" } },
        // The status stayed where it was (the move went to review).
        writtenProperties: { stage: "open", owner: "bo" },
        statusMoveProposed: true,
      })
    ).toEqual({
      state: "partial",
      entityId: "e1",
      landed: ["title", "properties.owner"],
      proposed: ["properties.stage"],
    });
  });

  it("without a proposed move, every sent field is landed", () => {
    expect(
      buildUpdateWriteReceipt({
        entityId: "e1",
        patch: { preview: "D", documentId: "d1", metadata: { stage: "won" } },
        writtenProperties: { stage: "won" },
        statusMoveProposed: false,
      })
    ).toEqual({
      state: "applied",
      entityId: "e1",
      landed: ["description", "documentId", "properties.stage"],
    });
  });
});
