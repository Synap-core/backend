import { describe, it, expect } from "vitest";
import {
  DEFERRED_OUTCOMES,
  DEFERRED_OUTCOME_TONE,
  deriveDeferredWritesReview,
  describeHeldWritesProposal,
  heldWritesPackName,
  isHeldWritesProposal,
  type DeferredWrite,
} from "../deferred-writes.js";
import {
  buildObjectActionTitle,
  resolveObjectNoun,
} from "../../vocabulary/index.js";

const AGENT = "0cf10d69-c16c-499a-8a1b-1f2e3d4c5b6a";
const PERSON = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const TASK_ID = "11111111-2222-4333-8444-555555555555";
const OTHER_PROPOSAL = "99999999-8888-4777-8666-555555555555";

const write = (
  ref: string,
  over: Partial<DeferredWrite> & { data?: Record<string, unknown> }
): DeferredWrite => ({
  ref,
  subjectType: "entity",
  action: "create",
  data: {},
  sessionId: null,
  agentUserId: AGENT,
  userId: PERSON,
  at: "2026-10-27T09:00:00.000Z",
  fingerprint: `fp-${ref}`,
  ...over,
});

/** A held-writes pack as `fileHeldWrites` stores it, after approval. */
const pack = {
  day: "2026-10-27",
  agentUserId: AGENT,
  source: "agent",
  deferredWrites: [
    write("w1", {
      data: { id: TASK_ID, profileSlug: "task", title: "Ship v2" },
    }),
    write("w2", { data: { profileSlug: "note" } }),
    write("w3", {
      subjectType: "focus_session",
      data: { goal: "Draft the launch post" },
    }),
    write("w4", {
      action: "update",
      data: { id: TASK_ID, profileSlug: "task", title: "Ship v3" },
    }),
    { ref: "broken", subjectType: "entity" },
  ],
  deferredOutcomes: {
    w1: { outcome: "applied", id: TASK_ID, at: "2026-10-27T10:00:00.000Z" },
    w2: {
      outcome: "proposed",
      proposalId: OTHER_PROPOSAL,
      at: "2026-10-27T10:00:00.000Z",
    },
    w3: {
      outcome: "refused",
      reason: "The project is archived.",
      at: "2026-10-27T10:00:00.000Z",
    },
  },
};

describe("deriveDeferredWritesReview", () => {
  it("titles each write with what replaying it does, imperative", () => {
    const review = deriveDeferredWritesReview(pack)!;
    expect(review.rows.map((r) => r.title)).toEqual([
      'Create Task "Ship v2"',
      "Create Note",
      'Create Session "Draft the launch post"',
      'Update Task "Ship v3"',
    ]);
  });

  it("a write with no name of its own is named by its kind's noun", () => {
    const row = deriveDeferredWritesReview(pack)!.rows[1]!;
    expect(row.name).toBe(resolveObjectNoun("note"));
    expect(row.kind).toBe("note");
  });

  it("counts an unreadable entry, never drops it silently", () => {
    const review = deriveDeferredWritesReview(pack)!;
    expect(review.rows).toHaveLength(4);
    expect(review.unreadable).toBe(1);
    expect(review.total).toBe(5);
  });

  it("maps each stored outcome onto its write, by ref", () => {
    const [w1, w2, w3, w4] = deriveDeferredWritesReview(pack)!.rows;
    expect(w1!.outcome?.outcome).toBe("applied");
    expect(w1!.recordId).toBe(TASK_ID);
    expect(w1!.objectKind).toBe("entity");
    expect(w2!.outcome).toMatchObject({
      outcome: "proposed",
      proposalId: OTHER_PROPOSAL,
    });
    expect(w3!.outcome).toMatchObject({
      outcome: "refused",
      reason: "The project is archived.",
    });
    // The session door's record kind is the session, not `focus_session`.
    expect(w3!.objectKind).toBe("session");
    // Not replayed (still pending): no outcome, nothing guessed.
    expect(w4!.outcome).toBeNull();
  });

  it("the record id is what the replay wrote, before the payload's own id", () => {
    const review = deriveDeferredWritesReview({
      deferredWrites: [
        write("s", { subjectType: "focus_session", data: { goal: "G" } }),
      ],
      deferredOutcomes: {
        s: { outcome: "applied", id: TASK_ID, at: "2026-10-27T10:00:00Z" },
      },
    })!;
    expect(review.rows[0]!.recordId).toBe(TASK_ID);
  });

  it("a write the reviewer left out reads as left out", () => {
    const review = deriveDeferredWritesReview({
      ...pack,
      deferredOutcomes: {},
      dispositions: { w2: { status: "reject" } },
    })!;
    expect(review.rows.map((r) => r.leftOut)).toEqual([
      false,
      true,
      false,
      false,
    ]);
  });

  it("is null for a proposal that keeps no writes", () => {
    expect(deriveDeferredWritesReview({ day: "2026-10-27" })).toBeNull();
    expect(deriveDeferredWritesReview(null)).toBeNull();
  });

  it("every outcome has a tone", () => {
    for (const o of DEFERRED_OUTCOMES) {
      expect(DEFERRED_OUTCOME_TONE[o]).toBeTruthy();
    }
    expect(DEFERRED_OUTCOME_TONE.applied).toBe("positive");
    expect(DEFERRED_OUTCOME_TONE.refused).toBe("negative");
  });
});

describe("describeHeldWritesProposal", () => {
  const row = {
    targetType: "agent",
    proposalType: "held_writes",
    targetName: null,
    agentName: "Claude Code",
    data: pack,
  };

  it("names the agent whose writes wait", () => {
    const d = describeHeldWritesProposal(row)!;
    expect(d.title).toBe(
      "Writes held for review: Claude Code, 2026-10-27, 5 items"
    );
    expect(d.agentName).toBe("Claude Code");
    expect(d.writes).toBe(5);
  });

  it("prefers the pod-resolved target name", () => {
    expect(
      describeHeldWritesProposal({ ...row, targetName: "Scout" })!.title
    ).toBe("Writes held for review: Scout, 2026-10-27, 5 items");
  });

  it("never an id, never the kind's noun as a name, never the raw token", () => {
    for (const name of [AGENT, "Agent", "  ", null]) {
      const d = describeHeldWritesProposal({
        ...row,
        targetName: name,
        agentName: name,
      })!;
      expect(d.agentName).toBeNull();
      expect(d.title).toBe("Writes held for review: 2026-10-27, 5 items");
      expect(d.title).not.toMatch(/held_writes|Held writes Agent/);
    }
  });

  it("is null for any other proposal", () => {
    expect(
      describeHeldWritesProposal({ ...row, proposalType: "join" })
    ).toBeNull();
    expect(isHeldWritesProposal({ ...row, targetType: "workspace" })).toBe(
      false
    );
    expect(isHeldWritesProposal(row)).toBe(true);
  });
});

describe("the held-writes pack's title (F6, founder 2026-10-27)", () => {
  it("names itself from its own data: the agent name the pod stored, the day, the writes it holds now", () => {
    expect(heldWritesPackName({ ...pack, agentName: "Claude Code" })).toBe(
      "Claude Code, 2026-10-27, 5 items"
    );
    expect(
      heldWritesPackName({
        ...pack,
        deferredWrites: pack.deferredWrites.slice(0, 1),
      })
    ).toBe("2026-10-27, 1 item");
    expect(heldWritesPackName({ deferredWrites: [] })).toBeUndefined();
  });

  it('every door titling it from proposalType + targetType + name reads the lead, never "Held writes Agent"', () => {
    const title = (mood: "imperative" | "past") =>
      buildObjectActionTitle({
        action: "held_writes",
        objectKind: "agent",
        objectName: heldWritesPackName({ ...pack, agentName: "Claude Code" }),
        mood,
      });
    expect(title("imperative")).toBe(
      "Writes held for review: Claude Code, 2026-10-27, 5 items"
    );
    expect(title("past")).toBe(
      "Writes held for review: Claude Code, 2026-10-27, 5 items"
    );
    expect(
      buildObjectActionTitle({ action: "held_writes", objectKind: "agent" })
    ).toBe("Writes held for review");
  });
});
