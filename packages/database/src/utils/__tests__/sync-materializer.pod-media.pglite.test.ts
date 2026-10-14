/**
 * Replication never carries `systemData.media` / `mediaCopyFailures`: they
 * name documents in the SENDING pod's own storage. Driven through the real
 * `materializeEvent` upsert on PGlite (real `entities` table definition).
 *   - a peer's copies never land (they would make this pod's plan read the
 *     URL as copied, and nothing could draw them);
 *   - a later replica never wipes the copies THIS pod made.
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ db: null as unknown, client: null as unknown }));

vi.mock("../../client-pg.js", async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client;
  h.db = drizzle(client);
  return { db: h.db };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { entities } from "../../schema/entities.js";
const { materializeEvent } = await import("../sync-materializer.js");

type Q = {
  exec: (s: string) => Promise<unknown>;
  query: <T>(s: string, p?: unknown[]) => Promise<{ rows: T[] }>;
};
const q = () => h.client as Q;

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const ID = "00000000-0000-4000-8000-0000000000aa";
const PEER_COPY = { documentId: "peer-doc", sourceUrl: "https://x.test/a.png" };
const LOCAL_COPY = {
  documentId: "local-doc",
  sourceUrl: "https://x.test/a.png",
};

const event = (systemData: unknown, action = "create") => ({
  id: crypto.randomUUID(),
  type: `entity.${action}.completed`,
  subjectId: ID,
  subjectType: "entity",
  timestamp: new Date().toISOString(),
  userId: "u1",
  data: { userId: "u1", type: "note", title: "t", properties: {}, systemData },
});

const systemDataOf = async () =>
  (
    await q().query<{ system_data: Record<string, unknown> }>(
      `select system_data from entities where id = $1`,
      [ID]
    )
  ).rows[0]!.system_data;

beforeAll(async () => {
  await q().exec(ddlFor(entities as unknown as PgTable));
}, 60_000);

describe("sync materializer — pod-local media never replicates", () => {
  it("a peer's copies are stripped on create; other keys replicate", async () => {
    expect(
      await materializeEvent(
        event({ media: [PEER_COPY], mediaCopyFailures: [], kept: 1 }) as never,
        { checkConflicts: false }
      )
    ).toBe("applied");
    expect(await systemDataOf()).toEqual({ kept: 1 });
  });

  it("a later replica keeps the copies this pod made, and takes no peer copy", async () => {
    await q().query(`update entities set system_data = $1 where id = $2`, [
      JSON.stringify({ media: [LOCAL_COPY], kept: 1 }),
      ID,
    ]);
    await materializeEvent(
      event({ media: [PEER_COPY], kept: 2 }, "update") as never,
      { checkConflicts: false }
    );
    expect(await systemDataOf()).toEqual({ media: [LOCAL_COPY], kept: 2 });
  });
});
