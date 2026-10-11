/**
 * SESSION KIND — the SQL half, EXECUTED, against the TypeScript half.
 *
 * `session-kind.test.ts` checks the SQL half at the compiled-text level and
 * says what that cannot prove: which rows Postgres actually returns. A clause
 * present in one half and missing from the other compiles fine and reads fine.
 * Here every fixture row is inserted and read back through
 * `sessionKindWhere(kind)` for each kind; the kind whose predicate returns it
 * must be exactly the kind `projectSessionKind` gives it, and exactly one.
 *
 * The discriminating rows for follow ≠ run (2026-10-12) are the FOLLOWED
 * session (work) beside the two followed-looking runs (playbook origin, an
 * automation run id): the old rule and a too-loose new one each misfile one of
 * them.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
  db: null as unknown,
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  h.db = drizzle(client, {
    schema: { focusSessions: actual.focusSessions as never },
  });
  return { ...actual, db: h.db, getDb: async () => h.db };
});

import type { PgTable } from "drizzle-orm/pg-core";
import { db, focusSessions, inArray, and } from "@synap/database";
import {
  SESSION_KINDS,
  projectSessionKind,
  sessionKindWhere,
  type SessionKind,
} from "../session-kind.js";
import { pgliteTableDdl } from "../../../__tests__/pglite-ddl.js";
import { FIXTURES } from "./session-kind.fixtures.js";

const rows = FIXTURES.map((f) => ({ ...f, id: randomUUID() }));

beforeAll(async () => {
  await h.client!.exec(pgliteTableDdl(focusSessions as unknown as PgTable));
  for (const r of rows) {
    await h.client!.query(
      `insert into focus_sessions (id, user_id, goal, status, origin, playbook_id, metadata)
       values ($1, 'u-1', 'g', $2, $3, $4, $5::jsonb)`,
      [
        r.id,
        r.row.status,
        r.row.origin ?? null,
        // The column is uuid; only presence matters to the kind.
        r.row.playbookId ? randomUUID() : null,
        r.row.metadata == null ? null : JSON.stringify(r.row.metadata),
      ]
    );
  }
}, 60_000);

/** The kinds whose SQL predicate returns this row. */
async function sqlKindsOf(): Promise<Map<string, SessionKind[]>> {
  const out = new Map<string, SessionKind[]>(rows.map((r) => [r.id, []]));
  for (const kind of SESSION_KINDS) {
    const found = await (db as typeof import("@synap/database").db)
      .select({ id: focusSessions.id })
      .from(focusSessions)
      .where(
        and(
          inArray(
            focusSessions.id,
            rows.map((r) => r.id)
          ),
          sessionKindWhere(kind)
        )
      );
    for (const { id } of found) out.get(id)!.push(kind);
  }
  return out;
}

describe("sessionKindWhere, executed — the SQL half agrees with projectSessionKind", () => {
  it("NON-VACUITY: every fixture was inserted, and the followed rows are among them", async () => {
    const { rows: n } = await h.client!.query<{ c: number }>(
      `select count(*)::int as c from focus_sessions`
    );
    expect(n[0]!.c).toBe(FIXTURES.length);
    expect(
      FIXTURES.filter(
        (f) =>
          (f.row.metadata as Record<string, unknown> | null)?.followedVia !=
          null
      ).length
    ).toBeGreaterThanOrEqual(3);
  });

  it.each(rows.map((r) => [r.name, r] as const))(
    "%s: exactly one SQL kind, and it is the TypeScript kind",
    async (_name, r) => {
      const kinds = (await sqlKindsOf()).get(r.id);
      expect(kinds).toEqual([projectSessionKind(r.row)]);
      expect(kinds).toEqual([r.kind]);
    }
  );
});
