/**
 * The request story (option B): BEFORE groups repeats and folds what is past
 * the cap, NOW is the request itself (never also a past line), AFTER names
 * what moves, and a part whose read FAILED is named, never drawn as nothing.
 */
import { describe, expect, it } from "vitest";
import type { ActivityActor } from "../activity/index.js";
import { lensItemsOfClass } from "../lens/page-model.js";
import type { LensNeedsYouSignal, LensRow } from "../lens/rows.js";
import type { DevTimelineEvent } from "../units/timeline.js";
import { en } from "./copy.js";
import type {
  NeedsYouContextRead,
  RequestSessionContext,
} from "./request-context.js";
import {
  REQUEST_STORY_BEFORE_CAP,
  groupRequestEvents,
  requestStory,
  requestStoryLine,
} from "./request-story.js";

const S = "11111111-1111-4111-8111-111111111111";
const AGENT: ActivityActor = { kind: "agent", id: "a1", name: "Scout" };
const ME: ActivityActor = {
  kind: "human",
  id: "u1",
  name: "Antoine",
  isViewer: true,
};

let minute = 0;
const at = () => new Date(Date.UTC(2026, 10, 16, 9, minute++)).toISOString();
const refs = { sessionId: S };

const started = (): DevTimelineEvent => ({
  id: "start",
  kind: "session_started",
  at: at(),
  actor: AGENT,
  refs,
  title: "Pod-run delivery",
});
const checks = (id: string, result: "passed" | "failed"): DevTimelineEvent => ({
  id,
  kind: "checks_finished",
  at: at(),
  actor: { kind: "system", id: null, name: null },
  refs: { url: `https://ci/${id}` },
  checks: {
    repo: "o/r",
    sha: "abc1234",
    result,
    status: "success",
    pr: 7,
    job: null,
    workflow: "CI",
  },
});
const asked = (id: string, slot: string): DevTimelineEvent => ({
  id,
  kind: "slot_asked",
  at: at(),
  actor: AGENT,
  refs: { sessionId: S, slotLabel: slot },
  slot,
  askMode: "provide",
  blockedReason: "credential",
});
const answered = (id: string, slot: string): DevTimelineEvent => ({
  id,
  kind: "slot_answered",
  at: at(),
  actor: ME,
  refs: { sessionId: S, slotLabel: slot },
  slot,
  answerType: "provide",
  handedBack: true,
  relayed: false,
});

/** The owed ask as the pod sends it, made a lens row by THE shared adapter. */
function owedRow(over: Partial<LensNeedsYouSignal> = {}): LensRow {
  const signal: LensNeedsYouSignal = {
    id: `slot:${S}:github merge token`,
    kind: "owed-slot",
    title: "GitHub merge token",
    count: 1,
    repeatCount: 1,
    category: "ai",
    groupKey: `session:${S}`,
    ageBucket: "recent",
    sessionTitle: "Pod-run delivery",
    target: { kind: "session", id: S },
    unblocks: "Merging the delivery PR",
    blocks: {
      thing: { id: "t1", name: "Pod-run delivery" },
      statusNow: { key: "ready", label: "Ready" },
      statusNext: { key: "shipped", label: "Shipped" },
    },
    by: { kind: "agent", id: "a1", label: "Scout" },
    ...over,
  };
  return lensItemsOfClass([signal], "blocking")[0]!.row;
}

function contextOf(
  row: LensRow,
  session: Partial<RequestSessionContext>,
  rowOver: Partial<NeedsYouContextRead["rows"][string]> = {}
): NeedsYouContextRead {
  return {
    timelineItems: 20,
    sessions: {
      [S]: {
        timeline: { status: "ok", value: { events: [], olderExist: false } },
        aiCanDo: { status: "ok", value: { items: [], total: 0 } },
        waiting: { status: "ok", value: { items: [], total: 0 } },
        ...session,
      },
    },
    rows: {
      [row.key]: {
        sessionId: S,
        slotLabel: "GitHub merge token",
        proposalIds: [],
        proposalWaits: null,
        ...rowOver,
      },
    },
  };
}

const handedBack = (id: string, slot: string): DevTimelineEvent => ({
  id,
  kind: "slot_handed_back",
  at: at(),
  actor: ME,
  refs: { sessionId: S, slotLabel: slot },
  slot,
});
const OWN = "GitHub merge token";

describe("requestStory — before", () => {
  // Founder, 17 Nov 2026: the past is THIS request's, never the session's
  // other asks, proposals, checks or start.
  it("keeps only this request's own past, oldest first, its own ask never a past line", () => {
    const row = owedRow();
    // Newest first, as the timeline read returns it.
    const events = [
      started(),
      checks("c1", "failed"),
      checks("c2", "failed"),
      answered("own1", OWN),
      handedBack("own2", OWN),
      asked("read", "GitHub read token"),
      answered("other", "GitHub read token"),
      asked("self", OWN),
    ].reverse();
    const story = requestStory(
      row,
      contextOf(row, {
        timeline: { status: "ok", value: { events, olderExist: true } },
      })
    );
    expect(story.before.map((g) => g.key)).toEqual(["own1", "own2"]);
    expect(story.before[0]).toMatchObject({
      line: `Answered: ${OWN}`,
      actor: ME,
      door: { kind: "session", id: S },
    });
    const kept = story.before.flatMap((g) => g.events.map((e) => e.id));
    for (const other of ["start", "c1", "c2", "read", "other", "self"])
      expect(kept).not.toContain(other);
    expect(story.folded).toBeNull();
    // The read's oldest event is the session's start, not this request's:
    // no older events of THIS request can hide behind it.
    expect(story.olderExist).toBe(false);
    expect(story.timelineDoor).toEqual({ kind: "session", id: S });
  });

  it("older events of this request may exist only when its own events reach the read's edge", () => {
    const row = owedRow();
    const events = [answered("own1", OWN), asked("self", OWN)].reverse();
    const story = requestStory(
      row,
      contextOf(row, {
        timeline: { status: "ok", value: { events, olderExist: true } },
      })
    );
    expect(story.olderExist).toBe(true);
  });

  it(`keeps the ${REQUEST_STORY_BEFORE_CAP} own groups nearest Now and folds the rest as N more events`, () => {
    const row = owedRow();
    const events = [
      started(),
      answered("a", OWN),
      handedBack("b", OWN),
      answered("c", OWN),
      handedBack("d", OWN),
    ].reverse();
    const story = requestStory(
      row,
      contextOf(row, {
        timeline: { status: "ok", value: { events, olderExist: false } },
      })
    );
    expect(story.before.map((g) => g.key)).toEqual(["b", "c", "d"]);
    expect(story.folded).toEqual({
      groups: 1,
      events: 1,
      label: "1 more event",
    });
  });

  it("the head names who asked and what the session is for, as doors", () => {
    const row = owedRow();
    const story = requestStory(row, contextOf(row, {}));
    expect(story.head.by).toMatchObject({ id: "a1", label: "Scout" });
    expect(story.head.session).toEqual({
      id: S,
      title: "Pod-run delivery",
      door: { kind: "session", id: S },
    });
  });
});

describe("requestStory — the session chain stays in the session lens", () => {
  // The timeline's chain kinds (stage moves, spawns, runners, room posts:
  // decision D3) belong to the Operations session lens; a request's capped
  // Before tells its own acts.
  it("a session's story leaves out stage moves, spawns, runners and room posts", () => {
    const row: LensRow = { ...owedRow(), key: `session:${S}` };
    const chain: DevTimelineEvent[] = [
      {
        id: "stage",
        kind: "stage_moved",
        at: at(),
        actor: AGENT,
        refs,
        from: null,
        to: "build",
        via: "advance",
      },
      {
        id: "child",
        kind: "child_started",
        at: at(),
        actor: AGENT,
        refs,
        child: { id: "c", title: "Lane", status: "active" },
      },
      {
        id: "runner",
        kind: "runner_seen",
        at: at(),
        actor: AGENT,
        refs: { ...refs, runnerId: "claude-code:x" },
        runner: {
          harness: "claude-code",
          conversationId: "x",
          computer: "devbox",
          model: null,
          provider: null,
          state: "busy",
          lastSeenAt: at(),
        },
      },
      {
        id: "post",
        kind: "room_post",
        at: at(),
        actor: AGENT,
        refs: { ...refs, messageId: "m", channelId: "ch" },
        post: {
          form: "update",
          direction: null,
          intent: null,
          line: "checkpoint",
          truncated: false,
        },
      },
    ];
    const events = [started(), ...chain, checks("c1", "passed")].reverse();
    const story = requestStory(row, {
      ...contextOf(row, {
        timeline: { status: "ok", value: { events, olderExist: false } },
      }),
    });
    expect(story.before.map((g) => g.kind)).toEqual([
      "session_started",
      "checks_finished",
    ]);
    expect(story.folded).toBeNull();
  });
});

// Review a089b624: one history, one word for each act (S1 a refusal, S2 a
// decision through the vocabulary door, S3 "Not mine").
describe("requestStory — the past says each act as it was", () => {
  const refused = (id: string, slot: string): DevTimelineEvent => ({
    ...answered(id, slot),
    answerType: "declined",
    handedBack: true,
  });
  const decided = (
    id: string,
    decision: string,
    title: string | null
  ): DevTimelineEvent => ({
    id,
    kind: "decision_answered",
    at: at(),
    actor: ME,
    refs: { sessionId: S, proposalId: `p-${id}` },
    title,
    decision,
    note: null,
  });

  it("a refusal reads Refused, never Answered, and never groups with an answer", () => {
    expect(requestStoryLine(refused("r", "Budget"))).toBe("Refused: Budget");
    expect(requestStoryLine(answered("a", "Budget"))).toBe("Answered: Budget");
    const groups = groupRequestEvents([
      answered("a1", "Budget"),
      refused("r1", "Budget"),
      refused("r2", "Budget"),
    ]);
    expect(groups.map((g) => [g.line, g.count])).toEqual([
      ["Answered: Budget", 1],
      ["Refused: Budget", 2],
    ]);
  });

  it("a decision says the vocabulary's word for its status, in each locale", () => {
    expect(requestStoryLine(decided("d1", "rejected", "Ship it"))).toBe(
      "Rejected “Ship it”"
    );
    expect(requestStoryLine(decided("d2", "reverted", "Ship it"))).toBe(
      "Reverted “Ship it”"
    );
    expect(requestStoryLine(decided("d3", "approval_failed", null))).toBe(
      "Approval failed"
    );
    expect(requestStoryLine(decided("d4", "rejected", "Ship it"), "fr")).toBe(
      "Rejeté «\u00a0Ship it\u00a0»"
    );
  });

  // Review N3: "Proposed: Gap: search tools" said two colons. The title is
  // set apart by quotes, so the line holds only the title's own colons.
  it.each(["en", "fr"] as const)(
    "a titled decision quotes its title and adds no colon of its own (%s)",
    (locale) => {
      const title = "Gap: search tools miss archived notes";
      const asked: DevTimelineEvent = {
        id: "q1",
        kind: "decision_asked",
        at: at(),
        actor: ME,
        refs: { sessionId: S, proposalId: "p-q1" },
        title,
      } as DevTimelineEvent;
      const colons = (s: string) => s.split(":").length - 1;
      for (const line of [
        requestStoryLine(asked, locale),
        requestStoryLine(decided("d5", "rejected", title), locale),
      ]) {
        expect(line).toContain(title);
        expect(colons(line)).toBe(colons(title));
        // The title sits between an opening and a closing quote mark.
        const i = line.indexOf(title);
        expect(line.slice(0, i).trim()).toMatch(/[“«]$/);
        expect(line.slice(i + title.length).trim()).toMatch(/^[”»]/);
      }
    }
  );

  it("a slot handed back with Not mine is its own line", () => {
    const handedBack: DevTimelineEvent = {
      id: "nm",
      kind: "slot_handed_back",
      at: at(),
      actor: ME,
      refs: { sessionId: S, slotLabel: "Budget" },
      slot: "Budget",
    };
    expect(requestStoryLine(handedBack)).toBe("Not mine: Budget");
  });
});

describe("requestStory — now and after", () => {
  it("after: what it unblocks, the thing's status it holds back, the sessions that wait", () => {
    const row = owedRow();
    const story = requestStory(
      row,
      contextOf(row, {
        aiCanDo: {
          status: "ok",
          value: {
            items: [{ label: "Write the release notes", answered: false }],
            total: 1,
          },
        },
        waiting: {
          status: "ok",
          value: {
            items: [
              { id: "w1", title: "Relay pin bump", status: "active" },
              { id: "w2", title: "Deploy check", status: "paused" },
            ],
            total: 2,
          },
        },
      })
    );
    expect(story.now).toMatchObject({
      title: row.title,
      meanwhile: { label: "Meanwhile", text: "Write the release notes" },
    });
    expect(story.after.map((s) => s.kind)).toEqual([
      "unblocks",
      "thing",
      "sessions_wait",
    ]);
    expect(story.after[0]).toMatchObject({
      label: "Unblocks",
      text: "Merging the delivery PR",
    });
    expect(story.after[1]).toMatchObject({
      line: "Pod-run delivery can move on",
      statusNow: { key: "ready" },
      statusNext: { key: "shipped" },
      door: { kind: "entity", id: "t1" },
    });
    expect(story.after[2]).toMatchObject({
      line: "2 sessions wait on this",
      total: 2,
      sessions: [
        { id: "w1", door: { kind: "session", id: "w1" } },
        { id: "w2", door: { kind: "session", id: "w2" } },
      ],
    });
    expect(story.unreadable).toEqual([]);
  });

  it("a proposal an agent waits on says why, from the fate words", () => {
    const signal: LensNeedsYouSignal = {
      id: "cluster:x",
      kind: "proposal-cluster",
      title: "Install the GitHub tool",
      count: 1,
      repeatCount: 1,
      category: "governance",
      groupKey: null,
      ageBucket: "recent",
      target: { kind: "proposal", id: "p1" },
    };
    const row = lensItemsOfClass([signal], "blocking")[0]!.row;
    const story = requestStory(
      row,
      contextOf(
        row,
        {},
        {
          slotLabel: null,
          proposalIds: ["p1"],
          proposalWaits: {
            status: "ok",
            value: { waits: true, reason: "gate" },
          },
        }
      )
    );
    expect(story.after).toEqual([
      expect.objectContaining({ kind: "agent_waits", reason: "gate" }),
    ]);
  });

  it("without a context read: Now and the row's own After, nothing named unreadable", () => {
    const story = requestStory(owedRow(), null);
    expect(story.before).toEqual([]);
    expect(story.after.map((s) => s.kind)).toEqual(["unblocks", "thing"]);
    expect(story.unreadable).toEqual([]);
  });
});

describe("requestStory — a failed read is named, never empty", () => {
  it("each failed part is unreadable with its sentence, and draws no empty line", () => {
    const row = owedRow({ unblocks: null, blocks: null });
    const story = requestStory(
      row,
      contextOf(
        row,
        {
          timeline: { status: "unreadable" },
          aiCanDo: { status: "unreadable" },
          waiting: { status: "unreadable" },
        },
        { proposalWaits: { status: "unreadable" } }
      )
    );
    expect(story.unreadable).toEqual([
      { part: "timeline", line: en["needsYou.story.unreadable.timeline"] },
      { part: "aiCanDo", line: en["needsYou.story.unreadable.aiCanDo"] },
      {
        part: "proposalWaits",
        line: en["needsYou.story.unreadable.proposalWaits"],
      },
      { part: "waiting", line: en["needsYou.story.unreadable.waiting"] },
    ]);
    expect(story.before).toEqual([]);
    expect(story.after).toEqual([]);
  });

  it("a session the read did not answer is unreadable, not a quiet story", () => {
    const row = owedRow();
    const ctx = contextOf(row, {});
    delete ctx.sessions[S];
    expect(requestStory(row, ctx).unreadable.map((u) => u.part)).toEqual([
      "timeline",
      "aiCanDo",
      "waiting",
    ]);
  });
});

describe("requestStory — now.subject: the object the request is about", () => {
  it("an in-pod subject carries its door, title and media", () => {
    const row = owedRow();
    const story = requestStory(
      row,
      contextOf(
        row,
        {},
        {
          subject: {
            status: "ok",
            value: {
              kind: "entity",
              id: "fd587f94-bada-4ffb-a794-11ab43ec4b16",
              title: "S11 board",
              profileSlug: "file",
              media: { via: "stored", documentId: "d1", mime: "image/png" },
            },
          },
        }
      )
    );
    expect(story.now.subject).toEqual({
      kind: "entity",
      id: "fd587f94-bada-4ffb-a794-11ab43ec4b16",
      title: "S11 board",
      profileSlug: "file",
      media: { via: "stored", documentId: "d1", mime: "image/png" },
      door: { kind: "entity", id: "fd587f94-bada-4ffb-a794-11ab43ec4b16" },
      url: null,
    });
    expect(story.unreadable).toEqual([]);
  });

  it("a link subject opens its url, not a door", () => {
    const row = owedRow();
    const story = requestStory(
      row,
      contextOf(
        row,
        {},
        {
          subject: {
            status: "ok",
            value: { kind: "url", url: "https://x.test/a" },
          },
        }
      )
    );
    expect(story.now.subject).toEqual({
      kind: "url",
      url: "https://x.test/a",
      door: null,
    });
  });

  it("no subject = null and nothing unreadable; a failed subject read is named", () => {
    const row = owedRow();
    expect(requestStory(row, contextOf(row, {})).now.subject).toBeNull();
    const failed = requestStory(
      row,
      contextOf(row, {}, { subject: { status: "unreadable" } })
    );
    expect(failed.now.subject).toBeNull();
    expect(failed.unreadable).toEqual([
      { part: "subject", line: en["needsYou.story.unreadable.subject"] },
    ]);
  });
});

// Founder, 17 Nov 2026: the rail is drawn only when the story says something
// the head and the decision bar do not; a single own event that IS the
// status folds into the status mark.
describe("requestStory — rail and status", () => {
  const proposalRow = () =>
    lensItemsOfClass(
      [
        {
          id: "cluster:p1",
          kind: "proposal-cluster",
          title: "Install Tool “github-merge”",
          count: 1,
          repeatCount: 1,
          category: "governance",
          groupKey: null,
          ageBucket: "recent",
          target: { kind: "proposal", id: "p1" },
        } satisfies LensNeedsYouSignal,
      ],
      "blocking"
    )[0]!.row;
  const decision = (
    id: string,
    proposalId: string,
    what: string
  ): DevTimelineEvent => ({
    id,
    kind: "decision_answered",
    at: at(),
    actor: { kind: "system", id: null, name: null },
    refs: { sessionId: S, proposalId },
    title: "Install Tool “github-merge”",
    decision: what,
    note: null,
  });
  const proposalCtx = (row: LensRow, events: DevTimelineEvent[]) =>
    contextOf(
      row,
      { timeline: { status: "ok", value: { events, olderExist: false } } },
      { slotLabel: null, proposalIds: ["p1"] }
    );

  it("the founder's screen: approval failed once, nothing waits → no rail, the event is the status", () => {
    const row = proposalRow();
    const failed = decision("f1", "p1", "approval_failed");
    const events = [
      started(),
      decision("other", "p2", "approved"),
      checks("c1", "passed"),
      failed,
    ].reverse();
    const story = requestStory(row, proposalCtx(row, events));
    expect(story.before).toEqual([]);
    expect(story.status?.key).toBe("f1");
    expect(story.status?.at).toBe(failed.at);
    expect(story.rail).toBe(false);
  });

  it("an own step that is not the status → rail", () => {
    const row = proposalRow();
    // Its approval failed, then it was applied and reverted: the revert is
    // the status, the failure a step of its own past.
    const events = [
      decision("f1", "p1", "approval_failed"),
      decision("r1", "p1", "reverted"),
    ].reverse();
    const story = requestStory(row, proposalCtx(row, events));
    expect(story.status?.key).toBe("r1");
    expect(story.before.map((g) => g.key)).toEqual(["f1"]);
    expect(story.rail).toBe(true);
  });

  it("a next step beyond the plain consequence → rail (unblocks, a thing, sessions waiting)", () => {
    expect(requestStory(owedRow(), null).rail).toBe(true);
    const flat = owedRow({ unblocks: null, blocks: null });
    expect(requestStory(flat, contextOf(flat, {})).rail).toBe(false);
    expect(
      requestStory(
        flat,
        contextOf(flat, {
          waiting: {
            status: "ok",
            value: {
              items: [{ id: "w1", title: "Ship", status: "active" }],
              total: 1,
            },
          },
        })
      ).rail
    ).toBe(true);
  });

  it("an agent waiting on it is not a next step: still no rail", () => {
    const row = proposalRow();
    const story = requestStory(
      row,
      contextOf(
        row,
        {},
        {
          slotLabel: null,
          proposalIds: ["p1"],
          proposalWaits: {
            status: "ok",
            value: { waits: true, reason: "gate" },
          },
        }
      )
    );
    expect(story.after.map((s) => s.kind)).toEqual(["agent_waits"]);
    expect(story.rail).toBe(false);
  });
});
