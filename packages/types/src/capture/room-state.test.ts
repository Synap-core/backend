import { describe, it, expect } from "vitest";
import { deriveCaptureRoomState, type CaptureRoomMessage } from "./index.js";

const SESSION = "11111111-1111-4111-8111-111111111111";
const QUESTION_ID = "22222222-2222-4222-8222-222222222222";
const OWNER = "owner";
const E1 = "33333333-3333-4333-8333-333333333333";

type RowIn = {
  tempId: string;
  title: string;
  profileSlug?: string;
  label?: "certain" | "likely" | "unsure";
  dismissed?: boolean;
  properties?: Record<string, unknown>;
};

let clock = 0;
const msg = (
  metadata: unknown,
  extra: Partial<CaptureRoomMessage> = {}
): CaptureRoomMessage => {
  clock += 1000;
  return {
    id: extra.id ?? `m${clock}`,
    role: "assistant",
    content: "",
    metadata,
    timestamp: new Date(clock).toISOString(),
    ...extra,
  };
};
const result = (
  round: number,
  rows: RowIn[],
  extra: Partial<CaptureRoomMessage> = {}
) =>
  msg(
    {
      capturePart: {
        kind: "capture_result",
        v: 1,
        sessionId: SESSION,
        round,
        rows: rows.map((r) => ({
          tempId: r.tempId,
          profileSlug: r.profileSlug ?? "task",
          title: r.title,
          why: null,
          updatesExisting: false,
          dismissed: r.dismissed ?? false,
          ...(r.label ? { label: r.label } : {}),
          ...(r.properties ? { properties: r.properties } : {}),
        })),
        truncated: false,
        notice: null,
      },
    },
    extra
  );
const filed = (
  round: number,
  rows: Array<{
    tempId: string;
    title: string;
    outcome: string;
    entityId?: string | null;
    proposalId?: string | null;
  }>,
  projectId: string | null = null
) =>
  msg({
    capturePart: {
      kind: "capture_filed",
      v: 1,
      sessionId: SESSION,
      round,
      rows: rows.map((r) => ({
        entityId: r.entityId ?? null,
        proposalId: r.proposalId ?? null,
        ...r,
      })),
      truncated: false,
      workspaceId: null,
      projectId,
    },
  });
const question = (status: "open" | "answered" = "open", id = QUESTION_ID) =>
  msg(
    {
      capturePart: {
        kind: "capture_question",
        v: 1,
        sessionId: SESSION,
        round: 1,
        question: "Which one?",
        chips: [],
        partialCount: 0,
        status,
      },
    },
    { id }
  );
const said = (content: string, userId = OWNER) =>
  msg(null, { role: "user", content, userId });

const stateOf = (rows: ReturnType<typeof deriveCaptureRoomState>["rows"]) =>
  rows.map((r) => [r.row.title, r.state, r.carried]);

describe("deriveCaptureRoomState — rows", () => {
  it("matches a receipt by ROUND and tempId: a reused tempId is a different record", () => {
    const state = deriveCaptureRoomState([
      result(1, [{ tempId: "t1", title: "Call Marie" }]),
      filed(1, [
        { tempId: "t1", title: "Call Marie", outcome: "created", entityId: E1 },
      ]),
      result(2, [{ tempId: "t1", title: "Buy milk" }]),
    ]);
    expect(stateOf(state.rows)).toEqual([
      ["Buy milk", "suggested", false],
      ["Call Marie", "filed", true],
    ]);
    expect(state.owed).toEqual({
      question: false,
      rows: 1,
      status: "suggested",
    });
  });

  it("a record filed in round 1 and re-proposed as t2 stays filed — or becomes its update when changed", () => {
    const base = [
      result(1, [{ tempId: "t1", title: "Call Marie" }]),
      filed(1, [
        { tempId: "t1", title: "Call Marie", outcome: "created", entityId: E1 },
      ]),
    ];
    const same = deriveCaptureRoomState([
      ...base,
      result(2, [
        { tempId: "t2", title: "call marie" },
        { tempId: "t1", title: "Buy milk" },
      ]),
    ]);
    expect(
      same.rows.map((r) => [r.row.tempId, r.state, r.entityId, r.carried])
    ).toEqual([
      ["t2", "filed", E1, false],
      ["t1", "suggested", null, false],
    ]);
    expect(same.owed.rows).toBe(1);

    const changed = deriveCaptureRoomState([
      ...base,
      result(2, [
        { tempId: "t2", title: "Call Marie", properties: { due: "friday" } },
      ]),
    ]);
    expect(changed.rows).toHaveLength(1);
    expect(changed.rows[0]).toMatchObject({
      state: "suggested",
      updatesEntityId: E1,
      owed: true,
    });
  });

  it("a held row stays held across rounds, with its review", () => {
    const state = deriveCaptureRoomState([
      result(1, [{ tempId: "t1", title: "Call Marie" }]),
      filed(1, [
        {
          tempId: "t1",
          title: "Call Marie",
          outcome: "proposed",
          proposalId: "p1",
        },
      ]),
      result(2, [{ tempId: "t3", title: "Call Marie" }]),
    ]);
    expect(state.rows.map((r) => [r.state, r.proposalId])).toEqual([
      ["awaiting_approval", "p1"],
    ]);
    expect(state.owed.status).toBeNull();
  });

  it("states: dismissed → rejected, failed → failed and still owed", () => {
    const state = deriveCaptureRoomState([
      result(1, [
        { tempId: "t1", title: "A", dismissed: true },
        { tempId: "t2", title: "B" },
      ]),
      filed(1, [{ tempId: "t2", title: "B", outcome: "failed" }]),
    ]);
    expect(stateOf(state.rows)).toEqual([
      ["A", "rejected", false],
      ["B", "failed", false],
    ]);
    expect(state.owed.rows).toBe(1);
  });

  it("of two results of the same round, the later message wins", () => {
    const state = deriveCaptureRoomState([
      result(1, [{ tempId: "t1", title: "Old" }]),
      result(1, [{ tempId: "t1", title: "New" }]),
    ]);
    expect(state.rows.map((r) => r.row.title)).toEqual(["New"]);
  });

  it("a pod receipt outranks a client's own copy", () => {
    const messages = [
      result(1, [{ tempId: "t1", title: "A" }]),
      filed(1, [{ tempId: "t1", title: "A", outcome: "failed" }]),
    ];
    const state = deriveCaptureRoomState(messages, {
      fallbackReceipts: [
        {
          round: 1,
          rows: [
            {
              tempId: "t1",
              title: "A",
              outcome: "created",
              entityId: E1,
              proposalId: null,
            },
          ],
        },
      ],
    });
    expect(state.rows[0]!.state).toBe("failed");
    const local = deriveCaptureRoomState([messages[0]!], {
      fallbackReceipts: [
        {
          round: 1,
          rows: [
            {
              tempId: "t1",
              title: "A",
              outcome: "created",
              entityId: E1,
              proposalId: null,
            },
          ],
        },
      ],
    });
    expect(local.rows[0]).toMatchObject({ state: "filed", entityId: E1 });
  });
});

describe("deriveCaptureRoomState — what is owed", () => {
  it("unsure leftovers never keep a capture unfinished; likely and unlabelled ones do", () => {
    const unsureOnly = deriveCaptureRoomState([
      result(1, [
        { tempId: "t1", title: "A", label: "certain" },
        { tempId: "t2", title: "B", label: "unsure" },
      ]),
      filed(1, [
        { tempId: "t1", title: "A", outcome: "created", entityId: E1 },
      ]),
    ]);
    expect(unsureOnly.owed).toEqual({ question: false, rows: 0, status: null });
    expect(unsureOnly.rows[1]).toMatchObject({
      state: "suggested",
      owed: false,
    });

    const likely = deriveCaptureRoomState([
      result(1, [
        { tempId: "t1", title: "A", label: "likely" },
        { tempId: "t2", title: "B" },
        { tempId: "t3", title: "C", label: "unsure" },
      ]),
    ]);
    expect(likely.owed).toEqual({
      question: false,
      rows: 2,
      status: "suggested",
    });
  });

  it("records produced with no receipt anywhere are an older filing — nothing is owed", () => {
    const messages = [result(1, [{ tempId: "t1", title: "A" }])];
    expect(
      deriveCaptureRoomState(messages, { producedRecords: true }).owed.status
    ).toBeNull();
    expect(deriveCaptureRoomState(messages).owed.status).toBe("suggested");
  });
});

describe("deriveCaptureRoomState — the question", () => {
  it("a question a newer result moved past is closed", () => {
    const state = deriveCaptureRoomState([
      question("open"),
      result(1, [{ tempId: "t1", title: "A", label: "unsure" }]),
    ]);
    expect(state.question?.open).toBe(false);
    expect(state.owed.status).toBeNull();
  });

  it("an open question after the result is owed first", () => {
    const state = deriveCaptureRoomState([
      result(1, [{ tempId: "t1", title: "A" }]),
      question("open"),
    ]);
    expect(state.question?.open).toBe(true);
    expect(state.owed).toEqual({
      question: true,
      rows: 1,
      status: "needs_answer",
    });
  });

  it("an answered question is closed even while its status still reads open", () => {
    const state = deriveCaptureRoomState([
      question("open"),
      msg({
        capturePart: {
          kind: "capture_answer",
          v: 1,
          sessionId: SESSION,
          questionMessageId: QUESTION_ID,
          answer: { type: "skip" },
        },
      }),
    ]);
    expect(state.question?.open).toBe(false);
  });
});

describe("deriveCaptureRoomState — note, comments, receipt", () => {
  it("the note is the first plain owner message before any part; comments come after the first part only", () => {
    const note = said("Idea: a post about sovereignty");
    const early = said("also mention relay");
    const r1 = result(1, [{ tempId: "t1", title: "A" }]);
    const c1 = said("make it a post");
    const peer = said("I disagree", "someone-else");
    const r2 = result(2, [{ tempId: "t1", title: "A" }]);
    const c2 = said("and tag Synap");
    const state = deriveCaptureRoomState([c2, r2, peer, c1, r1, early, note], {
      ownerId: OWNER,
    });
    expect(state.isCaptureRoom).toBe(true);
    expect(state.note).toEqual({
      messageId: note.id,
      text: "Idea: a post about sovereignty",
    });
    expect(state.comments.map((c) => c.text)).toEqual([
      "make it a post",
      "and tag Synap",
    ]);
    expect(state.commentsSinceResult.map((c) => c.text)).toEqual([
      "and tag Synap",
    ]);
  });

  it("a client-marked note wins; a room with no part is not a capture room and has no comments", () => {
    const plain = said("hello");
    const marked = msg(
      { captureNote: { noteId: null, attachments: 0 } },
      { role: "user", content: "The note" }
    );
    const state = deriveCaptureRoomState([plain, marked]);
    expect(state.note?.text).toBe("The note");
    expect(state.isCaptureRoom).toBe(false);
    expect(state.comments).toEqual([]);
  });

  it("the receipt carries the newest project a filing linked", () => {
    const state = deriveCaptureRoomState([
      result(1, [
        { tempId: "t1", title: "A" },
        { tempId: "t2", title: "B" },
      ]),
      filed(
        1,
        [{ tempId: "t1", title: "A", outcome: "created", entityId: E1 }],
        "proj-1"
      ),
      filed(
        1,
        [{ tempId: "t2", title: "B", outcome: "created", entityId: E1 }],
        null
      ),
    ]);
    expect(state.receipt).toEqual({
      round: 1,
      workspaceId: null,
      projectId: "proj-1",
    });
  });
});
