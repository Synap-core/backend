/**
 * The SETTLED-worker-target predicate, executed. `session-output-edges.test.ts`
 * feeds the readers hand-built rows, so it cannot see whether the SQL column
 * `settled` is computed right; this drives the real reader over real rows.
 * Rules out: a settled worker target still read as a wait; an OPEN worker
 * target or a plain `targets` edge dropped by the same predicate.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  return { ...actual, db: drizzle(client) };
});

import type { PgTable } from "drizzle-orm/pg-core";
import { focusSessions, links } from "@synap/database";
import { getSessionOutputDependencies } from "../session-output-edges.js";
import { pgliteTableDdl } from "../../../__tests__/pglite-ddl.js";

const USER = "user-edges-1";
const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params);

beforeAll(async () => {
  for (const t of [focusSessions, links])
    await h.client!.exec(pgliteTableDdl(t as unknown as PgTable));
}, 60_000);

async function session(): Promise<string> {
  const id = randomUUID();
  await q(
    `insert into focus_sessions (id, user_id, goal, status) values ($1, $2, 'g', 'active')`,
    [id, USER]
  );
  return id;
}
async function edge(
  from: string,
  to: string,
  linkType: string,
  metadata: Record<string, unknown> = {}
) {
  await q(
    `insert into links (from_type, from_id, to_type, to_id, link_type, metadata)
     values ('session', $1, 'entity', $2, $3, $4::jsonb)`,
    [from, to, linkType, JSON.stringify(metadata)]
  );
}

describe("worker targets in the output-dependency read", () => {
  it("settled ⇒ no wait; open worker target and plain targets ⇒ wait", async () => {
    const producer = await session();
    const settledWorker = await session();
    const openWorker = await session();
    const plain = await session();
    const x = randomUUID();
    await edge(producer, x, "produced");
    await edge(settledWorker, x, "targets", {
      role: "worker_target",
      result: "skipped",
    });
    await edge(openWorker, x, "targets", { role: "worker_target" });
    await edge(plain, x, "targets", { role: "input" });

    const map = await getSessionOutputDependencies(
      [producer, settledWorker, openWorker, plain],
      USER
    );
    expect(map.get(settledWorker)).toBeUndefined();
    expect(map.get(openWorker)!.waitsOnOutputs).toEqual([
      { entityId: x, producerSessionId: producer },
    ]);
    expect(map.get(plain)!.waitsOnOutputs).toHaveLength(1);
    expect(
      map
        .get(producer)!
        .outputsWaitedOnBy.map((w) => w.dependentSessionId)
        .sort()
    ).toEqual([openWorker, plain].sort());
  });
});
