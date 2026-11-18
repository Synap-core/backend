/**
 * The needs-you request context on PGlite — the REAL `readNeedsYouContext`
 * over sessions, slots, a blocked_by edge, a proposal and the objects the
 * requests are about. Every table is generated from the Drizzle definitions.
 *
 * Fixture rows sit where the candidate rules DISAGREE:
 *   - a slot whose `ref` names the person's own file entity (an image), and
 *     one whose `ref` names ANOTHER person's entity — a read that resolves
 *     refs without the floor serves that entity's title;
 *   - a proposal row whose proposal targets the same file — its subject is
 *     the target, read in the same entity read as the slot's;
 *   - another person's session — read as unreadable, never as empty;
 *   - a page of one session and a page of three sessions with more refs —
 *     a read per row issues more queries for the bigger page.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

const h = vi.hoisted(() => {
  const state = {
    client: null as null | {
      exec: (sql: string) => Promise<unknown>;
      query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
    },
    db: null as unknown,
    /** Queries the database saw (counted while `counting`). */
    queries: 0,
    counting: false,
    failTimeline: false,
    async init(): Promise<unknown> {
      if (!state.db) {
        const { PGlite } = await import("@electric-sql/pglite");
        const { drizzle } = await import("drizzle-orm/pglite");
        const schema = await import("@synap/database/schema");
        const client = new PGlite();
        const query = client.query.bind(client);
        // Every statement drizzle sends goes through `query`.
        (client as { query: unknown }).query = (...args: unknown[]) => {
          if (state.counting) state.queries += 1;
          return (query as (...a: unknown[]) => Promise<unknown>)(...args);
        };
        state.client = client as unknown as typeof state.client;
        // With the schema: `scopedDb` reads through `db.query.<table>`.
        state.db = drizzle(client, { schema });
      }
      return state.db;
    },
    async clientPgModule() {
      const db = await state.init();
      return {
        db,
        sql: undefined,
        getDb: async () => db,
        setCurrentUser: async () => undefined,
        clearCurrentUser: async () => undefined,
        closeDatabase: async () => undefined,
      };
    },
  };
  return state;
});

vi.mock("../../../../database/dist/client-pg.js", () => h.clientPgModule());
vi.mock("../../../../database/src/client-pg.js", () => h.clientPgModule());
vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const pg = await h.init();
  return { ...actual, db: pg, getDb: async () => pg };
});
// The timeline part, failed on demand: the rest of the context still answers.
vi.mock("../timeline/read-timeline.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../timeline/read-timeline.js")>();
  return {
    ...actual,
    readSessionTimelines: (
      ...args: Parameters<typeof actual.readSessionTimelines>
    ) =>
      h.failTimeline
        ? Promise.reject(new Error("timeline down"))
        : actual.readSessionTimelines(...args),
  };
});

import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { FOCUS_SESSION_SLOT_ASKED_EVENT_TYPE } from "../focus-sessions/lifecycle-events.js";
import {
  readNeedsYouContext,
  type NeedsYouContextRow,
} from "./needs-you-context.js";

const BASIC =
  /^(text|uuid|jsonb|json|boolean|integer|bigint|real|numeric|timestamp|date|varchar|double precision|smallint)/;

function ddlFor(table: PgTable): string {
  const cfg = getTableConfig(table);
  const cols = cfg.columns.map((c) => {
    const t = c.getSQLType();
    const type = BASIC.test(t) ? t.replace(/\(.*\)/, "") : "text";
    return `"${c.name}" ${type}${c.primary ? " primary key" : ""}`;
  });
  return `create table if not exists "${cfg.name}" (${cols.join(", ")});`;
}

const q = (sql: string, params?: unknown[]) => h.client!.query(sql, params);

const USER = "user-ctx";
const OTHER = "user-ctx-other";
const S = {
  main: randomUUID(),
  waiter: randomUUID(),
  second: randomUUID(),
  third: randomUUID(),
  others: randomUUID(),
};
const FILE_PROFILE = randomUUID();
const FILE = randomUUID();
const FILE_DOC = randomUUID();
const FOREIGN = randomUUID();
const DOC = randomUUID();
const PROPOSAL = randomUUID();
const NOW = Date.now();
const at = (min: number) => new Date(NOW + min * 60_000);

async function session(
  id: string,
  user: string,
  title: string,
  outputs: unknown = []
) {
  await q(
    `insert into focus_sessions (id, user_id, title, goal, status, origin, expected_outputs, metadata, started_at, created_at, updated_at)
     values ($1, $2, $3, 'g', 'active', 'user', $4::jsonb, '{}'::jsonb, $5, $5, $5)`,
    [id, user, title, JSON.stringify(outputs), at(-60)]
  );
}

async function slotAsked(sessionId: string, slot: string, min: number) {
  await q(
    `insert into events (id, type, user_id, subject_id, subject_type, data, timestamp)
     values ($1, $2, $3, $4, 'focus_session', $5::jsonb, $6)`,
    [
      randomUUID(),
      FOCUS_SESSION_SLOT_ASKED_EVENT_TYPE,
      USER,
      sessionId,
      JSON.stringify({
        sessionId,
        expectedLabel: slot,
        ask: { mode: "confirm" },
        blockedReason: "decision",
      }),
      at(min),
    ]
  );
}

async function entity(
  id: string,
  user: string,
  title: string,
  props: Record<string, unknown> = {},
  documentId: string | null = null
) {
  await q(
    `insert into entities (id, user_id, profile_id, type, title, document_id, properties, system_data, created_at, updated_at)
     values ($1, $2, $3, 'file', $4, $5, $6::jsonb, '{}'::jsonb, $7, $7)`,
    [id, user, FILE_PROFILE, title, documentId, JSON.stringify(props), at(-50)]
  );
}

const owedSlot = (label: string, ref?: unknown) => ({
  kind: "decision",
  label,
  owner: "human",
  status: "pending",
  ...(ref ? { ref } : {}),
});

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable => is(v, PgTable)
  );
  for (const t of tables) await h.client!.exec(ddlFor(t));

  await q(
    `insert into profiles (id, slug, display_name, ui_hints) values ($1, 'file', 'File', '{}'::jsonb)`,
    [FILE_PROFILE]
  );
  await entity(
    FILE,
    USER,
    "S11 board, old vs current",
    { mimeType: "image/png" },
    FILE_DOC
  );
  await entity(FOREIGN, OTHER, "Someone else's secret plan");
  await q(
    `insert into documents (id, user_id, title, mime_type, created_at, updated_at)
     values ($1, $2, 'Timing sheet', 'application/pdf', $3, $3)`,
    [DOC, USER, at(-40)]
  );

  await session(S.main, USER, "Launch film", [
    owedSlot("S11 board", { kind: "entity", id: FILE }),
    owedSlot("Secret", { kind: "entity", id: FOREIGN }),
    { kind: "document", label: "Write the motion spec", status: "pending" },
  ]);
  await session(S.waiter, USER, "Element building");
  await q(
    `insert into links (id, created_by, from_type, from_id, to_type, to_id, link_type, created_at)
     values ($1, $2, 'session', $3, 'session', $4, 'blocked_by', $5)`,
    [randomUUID(), USER, S.waiter, S.main, at(-30)]
  );
  await session(S.second, USER, "Second", [
    owedSlot("Timing", { kind: "document", id: DOC }),
  ]);
  await session(S.third, USER, "Third", [
    owedSlot("Link", { url: "https://example.test/a" }),
  ]);
  await session(S.others, OTHER, "Not yours", [owedSlot("Theirs")]);
  await slotAsked(S.main, "S11 board", -20);
  await slotAsked(S.main, "Secret", -10);

  await q(
    `insert into proposals (id, workspace_id, target_type, target_id, proposal_type, data, status, session_id, created_by, created_at, updated_at)
     values ($1, null, 'entity', $3, 'update', '{}'::jsonb, 'pending', $4, $2, $5, $5)`,
    [PROPOSAL, USER, FILE, S.main, at(-5)]
  );
});

const slotRow = (
  sessionId: string,
  label: string,
  slotRef?: NeedsYouContextRow["slotRef"]
): NeedsYouContextRow => ({
  id: `slot:${sessionId}:${label.toLowerCase()}`,
  kind: "owed-slot",
  title: label,
  target: { kind: "session", id: sessionId },
  groupKey: `session:${sessionId}`,
  ...(slotRef ? { slotRef } : {}),
});

const ROWS: NeedsYouContextRow[] = [
  slotRow(S.main, "S11 board", { kind: "entity", id: FILE }),
  slotRow(S.main, "Secret", { kind: "entity", id: FOREIGN }),
  {
    id: `proposal:${PROPOSAL}`,
    kind: "proposal-cluster",
    title: "Update the S11 board",
    target: { kind: "proposal", id: PROPOSAL },
    proposalIds: [PROPOSAL],
  },
  slotRow(S.others, "Theirs"),
];

const reader = { userId: USER };

describe("readNeedsYouContext — the parts of each row's story", () => {
  it("per session: the newest timeline items, what the agent does meanwhile, who waits", async () => {
    const ctx = await readNeedsYouContext(ROWS, reader);
    const main = ctx.sessions[S.main]!;
    expect(main.timeline).toMatchObject({ status: "ok" });
    if (main.timeline.status !== "ok") throw new Error("unreachable");
    expect(
      main.timeline.value.events
        .filter((e) => e.kind === "slot_asked")
        .map((e) => (e.kind === "slot_asked" ? e.slot : null))
    ).toEqual(["Secret", "S11 board"]);
    expect(main.aiCanDo).toEqual({
      status: "ok",
      value: {
        items: [{ label: "Write the motion spec", answered: false }],
        total: 1,
      },
    });
    expect(main.waiting).toEqual({
      status: "ok",
      value: {
        items: [{ id: S.waiter, title: "Element building", status: "active" }],
        total: 1,
      },
    });
    // The proposal row joins its session through the proposal.
    expect(ctx.rows[`proposal:${PROPOSAL}`]).toMatchObject({
      sessionId: S.main,
      proposalIds: [PROPOSAL],
    });
  });

  it("another person's session reads unreadable, never empty", async () => {
    const ctx = await readNeedsYouContext(ROWS, reader);
    expect(ctx.sessions[S.others]).toEqual({
      timeline: { status: "unreadable" },
      aiCanDo: { status: "unreadable" },
      waiting: { status: "ok", value: { items: [], total: 0 } },
    });
  });
});

describe("readNeedsYouContext — subject: the object a request is about", () => {
  it("a slot's ref resolves to the object with its kind and media", async () => {
    const ctx = await readNeedsYouContext(ROWS, reader);
    expect(ctx.rows[ROWS[0]!.id]!.subject).toEqual({
      status: "ok",
      value: {
        kind: "entity",
        id: FILE,
        title: "S11 board, old vs current",
        profileSlug: "file",
        media: { via: "stored", documentId: FILE_DOC, mime: "image/png" },
      },
    });
  });

  it("a proposal row's subject is its target", async () => {
    const ctx = await readNeedsYouContext(ROWS, reader);
    expect(ctx.rows[`proposal:${PROPOSAL}`]!.subject).toMatchObject({
      status: "ok",
      value: { kind: "entity", id: FILE },
    });
  });

  it("a ref the reader cannot read is absent, and its title is never served", async () => {
    const ctx = await readNeedsYouContext(ROWS, reader);
    expect(ctx.rows[ROWS[1]!.id]).not.toHaveProperty("subject");
    expect(JSON.stringify(ctx)).not.toContain("secret plan");
    // The owner reads it.
    const theirs = await readNeedsYouContext([ROWS[1]!], { userId: OTHER });
    expect(theirs.rows[ROWS[1]!.id]!.subject).toMatchObject({
      status: "ok",
      value: { title: "Someone else's secret plan" },
    });
  });

  it("no ref: no subject", async () => {
    const ctx = await readNeedsYouContext(ROWS, reader);
    expect(ctx.rows[ROWS[3]!.id]).not.toHaveProperty("subject");
  });

  it("a document and a link resolve too", async () => {
    const ctx = await readNeedsYouContext(
      [
        slotRow(S.second, "Timing", { kind: "document", id: DOC }),
        slotRow(S.third, "Link", { url: "https://example.test/a" }),
        slotRow(S.third, "Script", { url: "javascript:alert(1)" }),
      ],
      reader
    );
    expect(ctx.rows[`slot:${S.second}:timing`]!.subject).toEqual({
      status: "ok",
      value: { kind: "document", id: DOC, title: "Timing sheet" },
    });
    expect(ctx.rows[`slot:${S.third}:link`]!.subject).toEqual({
      status: "ok",
      value: { kind: "url", url: "https://example.test/a" },
    });
    // A link that is not http(s) is never drawn.
    expect(ctx.rows[`slot:${S.third}:script`]).not.toHaveProperty("subject");
  });
});

describe("readNeedsYouContext — a failed part is unreadable, never empty", () => {
  it("the timeline fails: its part is unreadable for every session, the rest answers", async () => {
    h.failTimeline = true;
    try {
      const ctx = await readNeedsYouContext(ROWS, reader);
      expect(ctx.sessions[S.main]!.timeline).toEqual({ status: "unreadable" });
      expect(ctx.sessions[S.main]!.aiCanDo.status).toBe("ok");
      expect(ctx.rows[ROWS[0]!.id]!.subject?.status).toBe("ok");
    } finally {
      h.failTimeline = false;
    }
  });

  it("the runner and room-post reads are never made: their failure leaves the story readable", async () => {
    // The card's story does not show who stamped in or what the room said
    // (`NEEDS_YOU_TIMELINE_WITHHELD`): those sources are not read at all, so
    // a fault only they meet must not take the timeline down with them.
    await h.client!.exec(
      `alter table session_runners rename to session_runners_away;
       alter table messages rename column message_category to message_category_away`
    );
    try {
      const ctx = await readNeedsYouContext(ROWS, reader);
      expect(ctx.sessions[S.main]!.timeline.status).toBe("ok");
    } finally {
      await h.client!.exec(
        `alter table session_runners_away rename to session_runners;
         alter table messages rename column message_category_away to message_category`
      );
    }
  });

  it("the subject read fails: the subject is unreadable, the rest answers", async () => {
    // A fault only the subject read meets: it selects `system_data`. Renaming
    // `profiles` would also fail the timeline, which reads room posts through
    // the channel floor and so the entity floor (it reads `profiles`).
    await h.client!.exec(
      `alter table entities rename column system_data to system_data_away`
    );
    try {
      const ctx = await readNeedsYouContext(ROWS, reader);
      expect(ctx.rows[ROWS[0]!.id]!.subject).toEqual({ status: "unreadable" });
      expect(ctx.rows[ROWS[3]!.id]).not.toHaveProperty("subject");
      expect(ctx.sessions[S.main]!.timeline.status).toBe("ok");
    } finally {
      await h.client!.exec(
        `alter table entities rename column system_data_away to system_data`
      );
    }
  });
});

describe("readNeedsYouContext — batched: one read per part for the whole page", () => {
  async function queriesFor(rows: NeedsYouContextRow[]): Promise<number> {
    h.queries = 0;
    h.counting = true;
    try {
      await readNeedsYouContext(rows, reader);
    } finally {
      h.counting = false;
    }
    return h.queries;
  }

  it("three sessions and more refs cost the same queries as one", async () => {
    const small = await queriesFor([
      slotRow(S.main, "S11 board", { kind: "entity", id: FILE }),
      ROWS[2]!,
      slotRow(S.second, "Timing", { kind: "document", id: DOC }),
    ]);
    const big = await queriesFor([
      ...ROWS,
      slotRow(S.second, "Timing", { kind: "document", id: DOC }),
      slotRow(S.waiter, "Another", { kind: "entity", id: FOREIGN }),
      slotRow(S.third, "Link", { url: "https://example.test/a" }),
    ]);
    expect(small).toBeGreaterThan(0);
    expect(big).toBe(small);
  });
});
