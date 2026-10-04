/**
 * loadSessionActivity on PGlite — the REAL SQL of every sub-read, against
 * tables generated from the Drizzle definitions.
 *
 * Fixture rows are chosen where naive rules DISAGREE with the right one:
 *   - a tool call and its result with DIFFERENT step ids (the IS's real shape)
 *     — an id-matching pairing would leave the call running forever;
 *   - a cancelled error frame — "every error frame is a failure" would draw one;
 *   - an EXTERNAL agent's write (is_agent, no turn) — a turn-only read misses it;
 *   - a write authorized by a HUMAN-approved proposal — "every source verbatim"
 *     tells it twice; an auto-approved receipt — "every proposal" tells it twice;
 *   - a session event in a workspace the reader cannot see — "every event with
 *     the session id" leaks it;
 *   - the turn's OWN assistant reply in the room — "every agent message is a
 *     note" duplicates the turn;
 *   - a session-progress update event — "every session event is lifecycle"
 *     floods the record;
 *   - a session with MORE turns than the turns source reads (26 > 25), each
 *     with its own reply — "a note is a message no READ turn replied with"
 *     shows the oldest turn's reply as a note;
 *   - a pending proposal the viewer's own agent filed in a workspace the
 *     viewer is not a member of — the bare membership lens drops it, while
 *     Needs-you (LENS ∪ OWNERSHIP) counts it.
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
  const db = drizzle(client);
  return { ...actual, db, getDb: async () => db };
});

import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import * as schema from "@synap/database/schema";
import { deriveRunActivity } from "@synap-core/types/run-activity";
import { loadSessionActivity } from "../session-activity.js";
import { getRun } from "../index.js";

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

const OWNER = "owner-act";
const STRANGER = "stranger-act";
const AGENT = "agent-act";
const WS = randomUUID();
const WS_HIDDEN = randomUUID();
const S = randomUUID();
const ROOM = randomUUID();
const T1 = randomUUID();
const T2 = randomUUID();
const T1_REPLY = randomUUID();
const P_PENDING = randomUUID();
const P_APPROVED = randomUUID();
const P_AUTO = randomUUID();
const ENTITY = randomUUID();

const at = (min: number) =>
  new Date(Date.UTC(2026, 9, 4, 10, min)).toISOString();

async function event(over: {
  type: string;
  subjectType: string;
  subjectId: string;
  data?: Record<string, unknown>;
  userId?: string;
  workspaceId?: string;
  proposalId?: string | null;
  min: number;
}) {
  await q(
    `insert into events (id, timestamp, type, subject_id, subject_type, data, user_id, is_agent, agent_user_id, workspace_id, proposal_id, session_id)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7, true, $8, $9, $10, $11)`,
    [
      randomUUID(),
      at(over.min),
      over.type,
      over.subjectId,
      over.subjectType,
      JSON.stringify(over.data ?? {}),
      over.userId ?? OWNER,
      AGENT,
      over.workspaceId ?? WS,
      over.proposalId ?? null,
      S,
    ]
  );
}

async function turnEvent(
  turnId: string,
  seq: number,
  type: string,
  payload: unknown,
  min: number
) {
  await q(
    `insert into chat_turn_events (id, turn_id, seq, event_id, type, payload, created_at)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [
      randomUUID(),
      turnId,
      seq,
      randomUUID(),
      type,
      JSON.stringify(payload),
      at(min),
    ]
  );
}

async function proposal(
  id: string,
  status: string,
  min: number,
  title: string
) {
  await q(
    `insert into proposals (id, workspace_id, target_type, target_id, proposal_type, data, status, agent_user_id, session_id, created_at, reviewed_at)
     values ($1, $2, 'entity', $3, 'create', $4::jsonb, $5, $6, $7, $8, $8)`,
    [
      id,
      WS,
      randomUUID(),
      JSON.stringify({
        targetName: title,
        data: { profileSlug: "task", title },
      }),
      status,
      AGENT,
      S,
      at(min),
    ]
  );
}

beforeAll(async () => {
  const tables = (Object.values(schema) as unknown[]).filter(
    (v): v is PgTable =>
      !!v && typeof v === "object" && Symbol.for("drizzle:IsDrizzleTable") in v
  );
  const byName = new Map(tables.map((t) => [getTableConfig(t).name, t]));
  for (const n of [
    "focus_sessions",
    "chat_turns",
    "chat_turn_events",
    "events",
    "proposals",
    "messages",
  ])
    expect(byName.has(n)).toBe(true);
  for (const t of byName.values()) await h.client!.exec(ddlFor(t));

  await q(
    `insert into users (id, user_type, name) values ($1,'human','Owner'),($2,'human','Stranger'),($3,'agent','Claude Code')`,
    [OWNER, STRANGER, AGENT]
  );
  await q(
    `insert into workspaces (id, name, owner_id, settings) values ($1,'W',$2,'{}'::jsonb),($3,'H',$4,'{}'::jsonb)`,
    [WS, OWNER, WS_HIDDEN, STRANGER]
  );
  await q(
    `insert into workspace_members (id, workspace_id, user_id, role) values ($1,$2,$3,'owner'),($4,$5,$6,'owner')`,
    [randomUUID(), WS, OWNER, randomUUID(), WS_HIDDEN, STRANGER]
  );

  await q(
    `insert into focus_sessions (id, user_id, workspace_id, goal, status, metadata, expected_outputs, channel_id, created_at, updated_at, started_at)
     values ($1, $2, $3, 'Launch the site', 'active', '{}'::jsonb, $4::jsonb, $5, $6, $6, $6)`,
    [
      S,
      OWNER,
      WS,
      JSON.stringify([
        { label: "Brand approval", owner: "human", owedSince: at(9) },
        { label: "Copy deck", owner: "agent" },
        { label: "Done slot", owner: "human", status: "done" },
      ]),
      ROOM,
      at(0),
    ]
  );
  await q(
    `insert into channels (id, user_id, workspace_id, channel_type, context_object_type, context_object_id, created_at, updated_at)
     values ($1, $2, $3, 'group', 'focus_session', $4, now(), now())`,
    [ROOM, OWNER, WS, S]
  );

  // T1: finished turn — a call + its result (different ids), and a Stop.
  await q(
    `insert into chat_turns (id, channel_id, user_id, request_id, user_message_id, assistant_message_id, status, started_at, updated_at)
     values ($1,$2,$3,$4,$5,$6,'completed',$7,$7), ($8,$2,$3,$9,$10,$11,'running',$12,$12)`,
    [
      T1,
      ROOM,
      OWNER,
      randomUUID(),
      randomUUID(),
      T1_REPLY,
      at(1),
      T2,
      randomUUID(),
      randomUUID(),
      randomUUID(),
      at(20),
    ]
  );
  await turnEvent(
    T1,
    1,
    "step",
    {
      step: {
        id: "tool-call-1-a",
        type: "tool_call",
        toolName: "search_unified",
        title: "Searching your workspace…",
        status: "running",
      },
    },
    2
  );
  await turnEvent(
    T1,
    2,
    "step",
    {
      step: {
        id: "tool-result-1-b",
        type: "tool_result",
        toolName: "search_unified",
        toolOutput: [1, 2],
        status: "complete",
      },
    },
    3
  );
  await turnEvent(
    T1,
    3,
    "step",
    { step: { id: "think-1", type: "thinking", content: "pondering" } },
    3
  );
  await turnEvent(T1, 4, "error", { code: "cancelled", message: "Stopped" }, 4);
  // T2: in flight — a call with no result yet.
  await turnEvent(
    T2,
    1,
    "step",
    {
      step: {
        id: "tool-call-2-a",
        type: "tool_call",
        toolName: "send_email",
        title: "Drafting the email…",
        status: "running",
      },
    },
    21
  );

  // Events: an external agent's write, a write behind a HUMAN-approved
  // proposal, a progress update (not lifecycle), a close (lifecycle), and a
  // session event in a workspace the owner cannot see.
  await event({
    type: "entity.create.completed",
    subjectType: "entity",
    subjectId: ENTITY,
    data: { profileSlug: "task", title: "Ship it" },
    min: 5,
  });
  await event({
    type: "entity.create.completed",
    subjectType: "entity",
    subjectId: randomUUID(),
    data: { profileSlug: "task", title: "Launch" },
    proposalId: P_APPROVED,
    min: 11,
  });
  await event({
    type: "focus_session.update.completed",
    subjectType: "focus_session",
    subjectId: S,
    min: 6,
  });
  await event({
    type: "focus_session.create.completed",
    subjectType: "focus_session",
    subjectId: S,
    min: 0,
  });
  await event({
    type: "entity.create.completed",
    subjectType: "entity",
    subjectId: randomUUID(),
    data: { profileSlug: "task", title: "Secret" },
    userId: STRANGER,
    workspaceId: WS_HIDDEN,
    min: 7,
  });
  await event({
    type: "entity.create.requested",
    subjectType: "entity",
    subjectId: randomUUID(),
    min: 8,
  });

  await proposal(P_PENDING, "pending", 12, "Update launch date");
  await proposal(P_APPROVED, "approved", 10, "Launch");
  await proposal(P_AUTO, "auto_approved", 13, "Receipt");

  await q(
    `insert into messages (id, channel_id, role, author_type, content, user_id, timestamp)
     values ($1,$2,'assistant','ai_agent','The full reply',$3,$4), ($5,$2,'assistant','ai_agent',$6,$3,$7)`,
    [
      T1_REPLY,
      ROOM,
      OWNER,
      at(4),
      randomUUID(),
      "\nProgress: drafted the hero copy\nmore detail",
      at(14),
    ]
  );
});

describe("loadSessionActivity — merge", () => {
  it("merges every source, oldest first, through the shared projections", async () => {
    const wire = await loadSessionActivity({ userId: OWNER, roster: true }, S);
    expect(wire).not.toBeNull();
    const kinds = wire!.items.map(
      (i) => `${i.kind}:${i.title ?? i.objectTitle ?? i.action}`
    );
    expect(kinds).toEqual([
      "lifecycle:create",
      "tool:Searching your workspace",
      "write:Ship it",
      "ask:Brand approval",
      "decision:Launch",
      "decision:Update launch date",
      "note:Progress: drafted the hero copy",
      "tool:Drafting the email",
    ]);
    expect(wire!.unreadable).toEqual([]);
  });

  it("settles a call by its result even though their ids differ", async () => {
    const wire = await loadSessionActivity({ userId: OWNER, roster: true }, S);
    const search = wire!.items.find((i) => i.action === "search_unified");
    expect(search?.status).toBe("done");
    const email = wire!.items.find((i) => i.action === "send_email");
    expect(email?.status).toBe("running");
  });

  it("reports the in-flight turn as a FACT and names the external agent", async () => {
    const wire = await loadSessionActivity({ userId: OWNER, roster: true }, S);
    expect(wire!.live.turnInFlight).toBe(true);
    // WHICH turn — the pod knows it; the derivation need not guess.
    expect(wire!.live.turnId).toBe(T2);
    const write = wire!.items.find((i) => i.kind === "write");
    expect(write?.actor).toEqual({
      id: AGENT,
      name: "Claude Code",
      isAgent: true,
    });
    const view = deriveRunActivity(wire!);
    expect(view.now?.mode).toBe("now");
    expect(view.now?.label).toBe("Drafting the email");
    expect(view.waiting.map((s) => s.kind)).toEqual(["ask", "decision"]);
  });

  it("never leaks a session event from a workspace the reader cannot see", async () => {
    const wire = await loadSessionActivity({ userId: OWNER, roster: true }, S);
    expect(wire!.items.some((i) => i.objectTitle === "Secret")).toBe(false);
  });
});

describe("loadSessionActivity — windows and floors", () => {
  it("never shows an older turn's own reply as a note, past the turn cap", async () => {
    const S_LONG = randomUUID();
    const ROOM_LONG = randomUUID();
    await q(
      `insert into focus_sessions (id, user_id, workspace_id, goal, status, metadata, expected_outputs, channel_id, created_at, updated_at, started_at)
       values ($1, $2, $3, 'Long chat', 'active', '{}'::jsonb, '[]'::jsonb, $4, $5, $5, $5)`,
      [S_LONG, OWNER, WS, ROOM_LONG, at(0)]
    );
    // 26 finished turns — one more than the turns source reads — each with
    // its own assistant reply in the room.
    for (let i = 0; i < 26; i++) {
      const reply = randomUUID();
      await q(
        `insert into chat_turns (id, channel_id, user_id, request_id, user_message_id, assistant_message_id, status, started_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,'completed',$7,$7)`,
        [
          randomUUID(),
          ROOM_LONG,
          OWNER,
          randomUUID(),
          randomUUID(),
          reply,
          at(i),
        ]
      );
      await q(
        `insert into messages (id, channel_id, role, author_type, content, user_id, timestamp)
         values ($1,$2,'assistant','ai_agent',$3,$4,$5)`,
        [reply, ROOM_LONG, `Reply ${i}`, OWNER, at(i)]
      );
    }
    const wire = await loadSessionActivity(
      { userId: OWNER, roster: true },
      S_LONG
    );
    expect(wire!.unreadable).toEqual([]);
    expect(wire!.truncated).toBe(true); // the turns source hit its cap
    expect(wire!.items.filter((i) => i.kind === "note")).toEqual([]);
  });

  it("lists the viewer's own agent's proposal outside a member workspace", async () => {
    const P_OWN_HIDDEN = randomUUID();
    await q(
      `insert into proposals (id, workspace_id, target_type, target_id, proposal_type, data, status, created_by, session_id, created_at)
       values ($1, $2, 'entity', $3, 'create', $4::jsonb, 'pending', $5, $6, $7)`,
      [
        P_OWN_HIDDEN,
        WS_HIDDEN,
        randomUUID(),
        JSON.stringify({ targetName: "Mine elsewhere" }),
        OWNER,
        S,
        at(15),
      ]
    );
    try {
      const wire = await loadSessionActivity(
        { userId: OWNER, roster: true },
        S
      );
      expect(
        wire!.items.find((i) => i.proposalId === P_OWN_HIDDEN)?.status
      ).toBe("pending");
    } finally {
      await q(`delete from proposals where id = $1`, [P_OWN_HIDDEN]);
    }
  });
});

describe("loadSessionActivity — access and failure", () => {
  it("a session the reader may not open is null, never an empty list", async () => {
    expect(
      await loadSessionActivity({ userId: STRANGER, roster: true }, S)
    ).toBeNull();
  });

  it("a FAILED source is named in `unreadable`; the rest still render", async () => {
    await h.client!.exec(`alter table messages rename to messages_gone`);
    try {
      const wire = await loadSessionActivity(
        { userId: OWNER, roster: true },
        S
      );
      expect(wire!.unreadable).toEqual(["notes"]);
      expect(wire!.items.some((i) => i.kind === "tool")).toBe(true);
      expect(wire!.items.some((i) => i.kind === "note")).toBe(false);
      // The flat list (CLI / Hub REST) says it is partial — never a silent
      // short list.
      const detail = await getRun({
        userId: OWNER,
        flowType: "session",
        id: S,
        roster: true,
      });
      const last = detail!.activity[detail!.activity.length - 1]!;
      expect(last.kind).toBe("partial");
      expect(last.label).toBe("Partly unreadable: Notes");
    } finally {
      await h.client!.exec(`alter table messages_gone rename to messages`);
    }
  });
});

describe("runs.get for a session run", () => {
  it("returns the activity, not a single lifecycle marker", async () => {
    const detail = await getRun({
      userId: OWNER,
      flowType: "session",
      id: S,
      roster: true,
    });
    expect(detail).not.toBeNull();
    expect(detail!.activity.length).toBeGreaterThan(1);
    expect(detail!.activity[0]!.kind).toBe("lifecycle");
    expect(detail!.sessionActivity?.items.length).toBe(
      detail!.activity.length - 1
    );
    // ONE representation: the wire carries the facts; a flat item carries
    // the words, never a second copy of the wire item.
    expect(detail!.activity.slice(1).every((a) => a.detail === null)).toBe(
      true
    );
    expect(detail!.activity.some((a) => a.kind === "partial")).toBe(false);
    // Labelled by the ONE derivation, never the raw token.
    const write = detail!.activity.find((a) => a.kind === "write");
    expect(write?.label).toBe('Created Task "Ship it"');
  });
});
