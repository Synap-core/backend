/**
 * CAPTURE ROOM — what the agent replying to a comment sees, and what a re-read
 * takes from the room, on a real Postgres (PGlite).
 *
 * The room is built by the REAL writers (`persistCaptureResult`,
 * `ensureSessionChannel`), the note is a staged text source on the session's
 * run manifest (as `recordStructureIntake` leaves it), and the turn entries are
 * read back through the same `TurnContextSchema` the send door forwards.
 *
 * Stubbed: `emitChatEvent` (realtime fan-out).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const holder = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const mocked = { ...actual };
  Object.defineProperty(mocked, "db", {
    get: () => holder.db,
    enumerable: true,
  });
  return mocked;
});
vi.mock("../../../utils/chat-realtime-broadcast.js", () => ({
  emitChatEvent: () => undefined,
}));

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { SQL } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import {
  focusSessions,
  channels,
  channelMembers,
  messages,
  users,
  documents,
  documentVersions,
  links,
} from "@synap/database";
import { persistCaptureResult } from "../capture-result-part.js";
import {
  planCaptureCommentTurn,
  readCaptureRoom,
  readRestructureRoom,
  withCaptureTurnEntries,
  listUnfinishedCaptures,
} from "../capture-room.js";
import { persistCaptureQuestion } from "../capture-clarification.js";
import { TurnContextSchema } from "../../../routers/channels/helpers.js";

const USER = "user-1";
const OTHER = "user-2";
const NOTE = "idea of content for synap: a post about sovereign data";

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

let client: PGlite;
const q = async <T>(sql: string, params?: unknown[]) =>
  (await client.query<T>(sql, params)).rows;

beforeEach(async () => {
  client = new PGlite();
  const tables = {
    focusSessions,
    channels,
    messages,
    channelMembers,
    users,
    documents,
    documentVersions,
    links,
  };
  for (const t of Object.values(tables)) {
    await client.exec(ddlFor(t as unknown as PgTable));
  }
  await client.exec(
    `create unique index on channel_members (channel_id, member_id);`
  );
  holder.db = drizzle(client, { schema: tables });
});

/** A capture session whose run staged `note` as its text source. */
async function seedCapture(note: string | null = NOTE): Promise<string> {
  const sourceIds: string[] = [];
  if (note !== null) {
    const [doc] = await q<{ id: string }>(
      `insert into documents (user_id, title, type, metadata)
       values ($1, 'Note', 'markdown', $2::jsonb) returning id`,
      [
        USER,
        JSON.stringify({
          intakeSource: {
            version: 1,
            kind: "text",
            contentHash: "h",
            sessionId: null,
            door: "capture",
          },
        }),
      ]
    );
    await q(
      `insert into document_versions (document_id, version, content, author_id)
       values ($1, 1, $2, $3)`,
      [doc!.id, note, USER]
    );
    sourceIds.push(doc!.id);
  }
  const [row] = await q<{ id: string }>(
    `insert into focus_sessions (user_id, goal, status, metadata)
     values ($1, 'Capture', 'active', $2::jsonb) returning id`,
    [
      USER,
      JSON.stringify({
        intake: { door: "capture", correlationKey: "k1" },
        run: { sourceDocumentIds: sourceIds },
      }),
    ]
  );
  return row!.id;
}

async function postComment(channelId: string, userId: string, text: string) {
  await q(
    `insert into messages (channel_id, role, content, user_id, previous_hash, hash, timestamp)
     values ($1, 'user', $2, $3, '', 'h', now() + interval '1 second')`,
    [channelId, text, userId]
  );
}

const PROPOSALS = [
  { tempId: "t1", profileSlug: "post", title: "Sovereign data post" },
  { tempId: "t2", profileSlug: "task", title: "Draft the outline" },
];

function entryValue(
  entries: ReadonlyArray<{ key: string; value: unknown }>,
  key: string
) {
  return entries.find((e) => e.key === key)?.value;
}

describe("planCaptureCommentTurn — the agent replying to a comment sees the note and the suggestions", () => {
  it("carries the note text and every current suggestion with its state", async () => {
    const sessionId = await seedCapture();
    const { channelId } = await persistCaptureResult({
      sessionId,
      userId: USER,
      proposals: PROPOSALS,
      dedupCandidates: {},
      dedupSkipped: false,
    });
    await postComment(channelId, USER, "make it about relay instead");

    const plan = await planCaptureCommentTurn({ channelId, userId: USER });
    expect(plan).not.toBeNull();
    expect(plan!.agentType).toBe("meta");
    expect(entryValue(plan!.entries, "capture.note")).toBe(NOTE);
    expect(entryValue(plan!.entries, "capture.suggestions")).toEqual([
      "Suggested · Post · Sovereign data post",
      "Suggested · Task · Draft the outline",
    ]);
    expect(entryValue(plan!.entries, "capture.round")).toBe(1);
    // What the send door forwards passes the IS-twinned contract.
    const forwarded = withCaptureTurnEntries(undefined, plan!.entries);
    expect(TurnContextSchema.safeParse(forwarded).success).toBe(true);
  });

  it("a filed row reads Filed and a dismissed one Rejected", async () => {
    const sessionId = await seedCapture();
    const { channelId } = await persistCaptureResult({
      sessionId,
      userId: USER,
      proposals: PROPOSALS,
      dedupCandidates: {},
      dedupSkipped: false,
    });
    await q(
      `update messages set metadata = jsonb_set(metadata, '{capturePart,rows,1,dismissed}', 'true')
       where metadata -> 'capturePart' ->> 'kind' = 'capture_result'`
    );
    await q(
      `insert into messages (channel_id, role, content, user_id, previous_hash, hash, metadata)
       values ($1, 'system', 'Filed 1', $2, '', 'h', $3::jsonb)`,
      [
        channelId,
        USER,
        JSON.stringify({
          capturePart: {
            kind: "capture_filed",
            v: 1,
            sessionId,
            round: 1,
            rows: [
              {
                tempId: "t1",
                entityId: "e-1",
                proposalId: null,
                outcome: "created",
                title: "Sovereign data post",
              },
            ],
            truncated: false,
            workspaceId: null,
            projectId: null,
          },
        }),
      ]
    );
    const plan = await planCaptureCommentTurn({ channelId, userId: USER });
    expect(entryValue(plan!.entries, "capture.suggestions")).toEqual([
      "Filed · Post · Sovereign data post",
      "Rejected · Task · Draft the outline",
    ]);
  });

  it("a co-member's message runs no capture turn (the owner's corrections only)", async () => {
    const sessionId = await seedCapture();
    const { channelId } = await persistCaptureResult({
      sessionId,
      userId: USER,
      proposals: PROPOSALS,
      dedupCandidates: {},
      dedupSkipped: false,
    });
    expect(await planCaptureCommentTurn({ channelId, userId: OTHER })).toBe(
      null
    );
  });

  it("a session room with no capture part is not a capture room", async () => {
    const sessionId = await seedCapture();
    const [ch] = await q<{ id: string }>(
      `insert into channels (user_id, title, channel_type) values ($1, 'Room', 'group') returning id`,
      [USER]
    );
    await q(`update focus_sessions set channel_id = $1 where id = $2`, [
      ch!.id,
      sessionId,
    ]);
    expect(
      await planCaptureCommentTurn({ channelId: ch!.id, userId: USER })
    ).toBe(null);
  });

  it("a photo-only capture carries the suggestions and no note — never a guessed one", async () => {
    const sessionId = await seedCapture(null);
    const { channelId } = await persistCaptureResult({
      sessionId,
      userId: USER,
      proposals: PROPOSALS,
      dedupCandidates: {},
      dedupSkipped: false,
    });
    const plan = await planCaptureCommentTurn({ channelId, userId: USER });
    expect(entryValue(plan!.entries, "capture.note")).toBeUndefined();
    expect(entryValue(plan!.entries, "capture.suggestions")).toHaveLength(2);
  });
});

describe("readCaptureRoom — the comments a re-read takes", () => {
  it("returns the owner's comments AFTER the latest result, oldest first", async () => {
    const sessionId = await seedCapture();
    const { channelId } = await persistCaptureResult({
      sessionId,
      userId: USER,
      proposals: PROPOSALS,
      dedupCandidates: {},
      dedupSkipped: false,
    });
    await q(
      `insert into messages (channel_id, role, content, user_id, previous_hash, hash, timestamp)
       values ($1, 'user', 'before the result', $2, '', 'h', now() - interval '1 hour')`,
      [channelId, USER]
    );
    await q(
      `insert into messages (channel_id, role, content, user_id, previous_hash, hash, timestamp)
       values ($1, 'user', 'first', $2, '', 'h', now() + interval '1 second'),
              ($1, 'user', 'second', $2, '', 'h', now() + interval '2 seconds'),
              ($1, 'user', 'not mine', $3, '', 'h', now() + interval '3 seconds'),
              ($1, 'assistant', 'the AI', $2, '', 'h', now() + interval '4 seconds')`,
      [channelId, USER, OTHER]
    );
    const room = await readCaptureRoom({ channelId, ownerId: USER });
    expect(room.commentsSinceResult).toEqual(["first", "second"]);
  });
});

describe("readRestructureRoom — what a re-read of a capture session sends", () => {
  it("comments since the round, and only the still-open rows to refine", async () => {
    const sessionId = await seedCapture();
    const { channelId } = await persistCaptureResult({
      sessionId,
      userId: USER,
      proposals: [
        ...PROPOSALS,
        { tempId: "t3", profileSlug: "note", title: "Dropped" },
      ],
      dedupCandidates: {},
      dedupSkipped: false,
    });
    await q(
      `update messages set metadata = jsonb_set(metadata, '{capturePart,rows,2,dismissed}', 'true')
       where metadata -> 'capturePart' ->> 'kind' = 'capture_result'`
    );
    await q(
      `insert into messages (channel_id, role, content, user_id, previous_hash, hash, metadata)
       values ($1, 'system', 'Filed 1', $2, '', 'h', $3::jsonb)`,
      [
        channelId,
        USER,
        JSON.stringify({
          capturePart: {
            kind: "capture_filed",
            v: 1,
            sessionId,
            round: 1,
            rows: [
              {
                tempId: "t1",
                entityId: "e-1",
                proposalId: null,
                outcome: "created",
                title: "Sovereign data post",
              },
            ],
            truncated: false,
            workspaceId: null,
            projectId: null,
          },
        }),
      ]
    );
    await postComment(channelId, USER, "the outline is due friday");

    const round = await readRestructureRoom({ sessionId, userId: USER });
    expect(round?.comments).toEqual(["the outline is due friday"]);
    expect(round?.previousEntities?.map((e) => e.tempId)).toEqual(["t2"]);
  });

  it("no comments: nothing to steer, no rows sent", async () => {
    const sessionId = await seedCapture();
    await persistCaptureResult({
      sessionId,
      userId: USER,
      proposals: PROPOSALS,
      dedupCandidates: {},
      dedupSkipped: false,
    });
    expect(await readRestructureRoom({ sessionId, userId: USER })).toEqual({
      comments: [],
    });
  });

  it("another user's session reads as no room", async () => {
    const sessionId = await seedCapture();
    expect(await readRestructureRoom({ sessionId, userId: OTHER })).toBe(null);
  });
});

describe("listUnfinishedCaptures — what Needs-you shows", () => {
  const filedPart = (sessionId: string, tempIds: string[]) =>
    JSON.stringify({
      capturePart: {
        kind: "capture_filed",
        v: 1,
        sessionId,
        round: 1,
        rows: tempIds.map((tempId) => ({
          tempId,
          entityId: `e-${tempId}`,
          proposalId: null,
          outcome: "created",
          title: tempId,
        })),
        truncated: false,
        workspaceId: null,
        projectId: null,
      },
    });
  const result = (sessionId: string) =>
    persistCaptureResult({
      sessionId,
      userId: USER,
      proposals: PROPOSALS,
      dedupCandidates: {},
      dedupSkipped: false,
    });

  it("unfiled suggestions read `suggested`, an open question `needs_answer`; settled ones are absent", async () => {
    const owing = await seedCapture();
    await result(owing);

    const asking = await seedCapture();
    await persistCaptureQuestion({
      sessionId: asking,
      userId: USER,
      followUp: "Which project?",
      partialCount: 1,
      refine: { text: NOTE },
    });

    const settled = await seedCapture();
    const { channelId } = await result(settled);
    await q(
      `insert into messages (channel_id, role, content, user_id, previous_hash, hash, metadata, timestamp)
       values ($1, 'system', 'Filed 2', $2, '', 'h', $3::jsonb, now() + interval '1 second')`,
      [channelId, USER, filedPart(settled, ["t1", "t2"])]
    );

    // Filed before receipts existed: it produced records, the room holds no receipt.
    const legacy = await seedCapture();
    await result(legacy);
    await q(
      `insert into links (id, from_type, from_id, to_type, to_id, link_type, metadata)
       values (gen_random_uuid(), 'session', $1, 'entity', 'e-old', 'produced', '{}'::jsonb)`,
      [legacy]
    );

    const stale = await seedCapture();
    await result(stale);
    await q(
      `update focus_sessions set updated_at = now() - interval '30 days' where id = $1`,
      [stale]
    );

    const { captures, truncated } = await listUnfinishedCaptures({
      userId: USER,
    });
    expect(truncated).toBe(false);
    expect(
      Object.fromEntries(captures.map((c) => [c.sessionId, c.status]))
    ).toEqual({ [owing]: "suggested", [asking]: "needs_answer" });
    expect(await listUnfinishedCaptures({ userId: OTHER })).toEqual({
      captures: [],
      truncated: false,
    });
  });
});
