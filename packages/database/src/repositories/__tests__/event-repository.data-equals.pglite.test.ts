/**
 * `searchEvents({ dataEquals })` as REAL SQL on PGlite: the predicate runs in
 * the query, before LIMIT and OFFSET. The kinds interleave in time, so a
 * filter applied after paging (or no filter) returns another row on each
 * page asked here; only an SQL predicate returns the rows of the kind.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { EventRepository } from "../event-repository.js";

let pg: PGlite;
let repo: EventRepository;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`CREATE TABLE events (
    id text PRIMARY KEY,
    type text NOT NULL,
    subject_type text,
    subject_id text,
    user_id text,
    data jsonb,
    metadata jsonb,
    source text,
    timestamp timestamptz NOT NULL
  );`);
  const rows: Array<[string, string, string, string]> = [
    // id, type, proposalType, timestamp (newest first)
    ["m1", "presence.missing", "agent/connect", "2026-11-05T10:00:00Z"],
    ["m3", "presence.missing", "apiKeys.create", "2026-11-05T09:30:00Z"],
    ["m2", "presence.missing", "agent/connect", "2026-11-05T09:00:00Z"],
    ["o1", "entity.create.completed", "apiKeys.create", "2026-11-05T11:00:00Z"],
  ];
  for (const [id, type, kind, ts] of rows) {
    await pg.query(
      `INSERT INTO events (id, type, data, timestamp)
       VALUES ($1, $2, jsonb_build_object('proposalType', $3::text), $4)`,
      [id, type, kind, ts]
    );
  }
  repo = new EventRepository({
    unsafe: async (sql: string, params: unknown[]) =>
      (await pg.query(sql, params)).rows,
  } as never);
});

describe("searchEvents dataEquals — filtered in SQL, before paging", () => {
  it("returns the older row of the kind on a one-row page", async () => {
    const rows = await repo.searchEvents({
      eventType: "presence.missing",
      dataEquals: { key: "proposalType", value: "apiKeys.create" },
      limit: 1,
    });
    expect(rows.map((r) => r.id)).toEqual(["m3"]);
  });

  it("pages within the kind", async () => {
    const rows = await repo.searchEvents({
      eventType: "presence.missing",
      dataEquals: { key: "proposalType", value: "agent/connect" },
      limit: 1,
      offset: 1,
    });
    expect(rows.map((r) => r.id)).toEqual(["m2"]);
  });

  it("matches nothing for a value no row holds", async () => {
    const rows = await repo.searchEvents({
      eventType: "presence.missing",
      dataEquals: { key: "proposalType", value: "nothing" },
      limit: 10,
    });
    expect(rows).toEqual([]);
  });
});
