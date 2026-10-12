/**
 * A relay note capture reaches Needs-you — driven through the doors relay
 * calls, on a real Postgres (PGlite).
 *
 * Relay opens a note's session with `focusSessions.create` + `ensureChannel`
 * (`relay-app/src/features/note-capture/capture-session.ts`) and structures
 * into it; that session carries NO intake stamp. The Needs-you read used to
 * key on `metadata.intake.door = 'capture'`, so these rows never appeared.
 * The rule is now the room itself: it holds a capture part.
 *
 * Real: `focusSessions.create` (→ `createFocusSession`), `focusSessions.
 * ensureChannel` (→ `ensureSessionChannel`), `persistCaptureResult` (the part
 * `capture.structure` writes), `listUnfinishedCaptures`,
 * `signalFromUnfinishedCapture`. Tables are generated from the Drizzle schema.
 *
 * Stubbed, and why: the read-only (split-brain) guard and the governance /
 * project-placement / spawn-link doors `createFocusSession` calls (each owns
 * its own tests and connections); realtime emit.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  client: null as null | {
    exec: (sql: string) => Promise<unknown>;
    query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  },
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const schema = await import("@synap/database/schema");
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = new PGlite();
  h.client = client as unknown as typeof h.client;
  const db = drizzle(client, { schema: schema as never });
  return {
    ...actual,
    db,
    getDb: async () => db,
    recordSessionSpawn: async () => ({
      linked: true,
      suspendedIntentRecorded: false,
    }),
    resolveSessionProjectPlacement: async (
      _db: unknown,
      input: { explicitProjectId?: string | null }
    ) => ({ projectId: input.explicitProjectId ?? null }),
  };
});
vi.mock("../../../utils/split-brain-service.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, isPodReadOnly: async () => false };
});
vi.mock("../../../utils/permission-check.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    checkPermissionOrPropose: async () => ({ granted: true }),
  };
});
vi.mock("../../../utils/domain-event-bridge.js", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, emitHubRealtimeEvent: () => undefined };
});
vi.mock("../../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: () => undefined,
}));

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { db } from "@synap/database";
import { focusSessionsRouter } from "../../../routers/focus-sessions.js";
import { persistCaptureResult } from "../capture-result-part.js";
import { listUnfinishedCaptures } from "../capture-room.js";
import { signalFromUnfinishedCapture } from "../../signals/needs-you-union.js";

const USER = "relay-user";
const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    const def = c.primary
      ? type === "uuid"
        ? " primary key default gen_random_uuid()"
        : " primary key"
      : t.startsWith("timestamp") && c.hasDefault
        ? " default now()"
        : "";
    return `"${c.name}" ${type}${def}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const q = <T>(sql: string, params?: unknown[]) =>
  h.client!.query<T>(sql, params).then((r) => r.rows);

const sessions = () =>
  focusSessionsRouter.createCaller({
    db,
    authenticated: true,
    userId: USER,
  } as never);

/** What relay does for a note: open a session, mint its room, structure into it. */
async function relayNoteCapture(goal: string): Promise<string> {
  const created = (await sessions().create({ goal, forceCreate: true })) as {
    id: string;
  };
  await sessions().ensureChannel({ sessionId: created.id });
  await persistCaptureResult({
    sessionId: created.id,
    userId: USER,
    proposals: [{ tempId: "t1", profileSlug: "task", title: "Call Marie" }],
    dedupCandidates: {},
    dedupSkipped: false,
  });
  return created.id;
}

describe("a relay note capture is a Needs-you row", () => {
  beforeAll(async () => {
    const tables = (Object.values(schema) as unknown[]).filter(
      (v): v is PgTable =>
        !!v &&
        typeof v === "object" &&
        Symbol.for("drizzle:IsDrizzleTable") in (v as object)
    );
    const names = tables.map((t) => getTableConfig(t).name);
    for (const n of ["focus_sessions", "channels", "messages", "links"]) {
      expect(names).toContain(n);
    }
    for (const t of tables) await h.client!.exec(ddlFor(t));
    await h.client!.exec(
      `create unique index on channel_members (channel_id, member_id);`
    );
  });
  beforeEach(async () => {
    await h.client!.exec(
      "delete from messages; delete from channels; delete from channel_members; delete from focus_sessions; delete from links;"
    );
  });

  it("the session relay opened carries no intake stamp, and its room still reaches Needs-you", async () => {
    const sessionId = await relayNoteCapture("Call Marie about the venue");
    const [row] = await q<{ door: string | null; channel_id: string | null }>(
      `select metadata -> 'intake' ->> 'door' as door, channel_id from focus_sessions where id = $1`,
      [sessionId]
    );
    expect(row!.door).toBeNull();
    expect(row!.channel_id).not.toBeNull();

    const { captures } = await listUnfinishedCaptures({ userId: USER });
    expect(captures.map((c) => [c.sessionId, c.status])).toEqual([
      [sessionId, "suggested"],
    ]);
    const signal = signalFromUnfinishedCapture(captures[0]!);
    expect(signal).toMatchObject({
      kind: "capture",
      target: { kind: "session", id: sessionId, view: "room" },
      captureStatus: "suggested",
    });
  });

  it("a closed session, or a room with no capture part, is not one", async () => {
    const closed = await relayNoteCapture("Closed capture");
    await q(`update focus_sessions set status = 'closed' where id = $1`, [
      closed,
    ]);
    const plain = (await sessions().create({
      goal: "Just a chat",
      forceCreate: true,
    })) as { id: string };
    await sessions().ensureChannel({ sessionId: plain.id });

    expect((await listUnfinishedCaptures({ userId: USER })).captures).toEqual(
      []
    );
  });
});
