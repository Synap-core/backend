/**
 * THE SESSION'S NAME AND PROJECT REACH A NEEDS-YOU ROW — on PGlite, through
 * the REAL select of `listOwedSlots` and the REAL mapper `signalFromOwedSlot`,
 * into the shared one-list rule (`needsYouRows`), with nothing hand-built in
 * between. A session owing two things is drawn as ONE card named by its
 * TITLE (not its goal) and railed in its project's colour: that only works if
 * the select reads `title` and the mapper projects both fields.
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
  const pg = drizzle(client);
  return { ...actual, db: pg, getDb: async () => pg };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { focusSessions } from "@synap/database";
import { listOwedSlots } from "../owed-outputs.js";
import { signalFromOwedSlot } from "../../signals/needs-you-union.js";
import { needsYouRows } from "@synap-core/types/needs-you";

const USER = "user-1";
const TITLED = randomUUID();
const UNTITLED = randomUUID();
const PROJECT = randomUUID();

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;
function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const def =
      c.name === "id"
        ? " default gen_random_uuid()"
        : c.name === "started_at" || c.name === "created_at"
          ? " default now()"
          : "";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}${def}`;
  });
  return `create table "${cfg.name}" (${cols.join(", ")});`;
}

const slots = (...labels: string[]) =>
  JSON.stringify(
    labels.map((label) => ({
      kind: "document",
      label,
      owner: "human",
      owedSince: "2026-09-01",
      blockedReason: "decision",
    }))
  );

beforeAll(async () => {
  await h.client!.exec(ddlFor(focusSessions as unknown as PgTable));
  await h.client!.query(
    `insert into focus_sessions (id, user_id, title, goal, project_id, status, origin, expected_outputs, agent_ids, metadata) values
      ($1, $3, 'Tracks-first', 'Move the whole project experience to tracks-first, end to end', $4, 'active', 'human', $5::jsonb, '{}', '{}'::jsonb),
      ($2, $3, null, 'Ship billing', null, 'active', 'human', $6::jsonb, '{}', '{}'::jsonb)`,
    [TITLED, UNTITLED, USER, PROJECT, slots("Pick a plan", "Approve copy"), slots("Sign contract")]
  );
}, 120_000);

describe("session title + project arrive on the needs-you row", () => {
  it("listOwedSlots → signalFromOwedSlot carries sessionTitle and sessionProjectId", async () => {
    const owed = await listOwedSlots({
      userId: USER,
      scope: { workspaceLens: undefined, projectLens: undefined },
      limit: 50,
    });
    const signals = owed.map((s) => signalFromOwedSlot(s));
    const titled = signals.filter((s) => s.target?.id === TITLED);
    expect(titled).toHaveLength(2);
    for (const s of titled) {
      expect(s.sessionTitle).toBe("Tracks-first");
      expect(s.sessionProjectId).toBe(PROJECT);
    }
    const untitled = signals.find((s) => s.target?.id === UNTITLED)!;
    // No title ⇒ the ONE display-name rule falls back to the goal.
    expect(untitled.sessionTitle).toBe("Ship billing");
    expect("sessionProjectId" in untitled).toBe(false);
  });

  it("the shared rule draws the two-slot session as ONE titled, railed card", async () => {
    const owed = await listOwedSlots({
      userId: USER,
      scope: { workspaceLens: undefined, projectLens: undefined },
      limit: 50,
    });
    const now = new Date("2026-09-02T00:00:00.000Z");
    // The pod's own order: a session's rows contiguous.
    const signals = owed
      .map((s) => signalFromOwedSlot(s, now))
      .sort((a, b) => (a.target!.id < b.target!.id ? -1 : 1));
    const rows = needsYouRows(signals).recent;
    const card = rows.find((r) => r.kind === "session");
    expect(card).toMatchObject({
      kind: "session",
      sessionId: TITLED,
      title: "Tracks-first",
      projectId: PROJECT,
      counts: [{ kind: "decision", count: 2 }],
    });
    const single = rows.find((r) => r.kind === "item");
    expect(single).toMatchObject({ kind: "item", session: { id: UNTITLED, title: "Ship billing" } });
  });
});
