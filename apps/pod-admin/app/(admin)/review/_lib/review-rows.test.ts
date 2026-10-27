import { describe, expect, it } from "vitest";
import {
  agentGroups,
  batchOf,
  bookkeepingSuggestion,
  exitOf,
  itemCount,
  keepAllOf,
  oldestAt,
  packageGroups,
  sessionGroups,
  focusedRow,
  isRemoval,
  liveAskSlot,
  reviewChipCounts,
  reviewCounts,
  reviewFilterOf,
  reviewGroupOf,
  reviewRows,
  reviewRowMembers,
  reviewSessionOf,
  rowsInView,
  summarizeBatch,
  NEEDS_YOU_PAGE_LIMIT,
  type ProposalFacts,
  type ReviewSignal,
} from "./review-rows";

function sig(
  over: Partial<ReviewSignal> & { id: string; kind: string }
): ReviewSignal {
  return {
    title: over.id,
    count: 1,
    groupKey: null,
    ageBucket: "recent",
    repeatCount: 1,
    occurredAt: "2026-10-12T10:00:00.000Z",
    category: "governance",
    target: null,
    ...over,
  };
}

function cluster(id: string, over: Partial<ReviewSignal> = {}): ReviewSignal {
  return sig({
    id,
    kind: "proposal-cluster",
    class: "objectWork",
    target: { kind: "proposal", id: `${id}-p1` },
    proposalIds: [`${id}-p1`],
    ...over,
  });
}

function facts(
  id: string,
  over: Partial<ProposalFacts> = {}
): [string, ProposalFacts] {
  return [
    id,
    {
      id,
      proposalType: "create",
      targetType: "track",
      viewerCanReview: true,
      agentName: "Claude",
      workspaceName: "Synap",
      ...over,
    },
  ];
}

const issuer = sig({
  id: "access:issuer:i1",
  kind: "access-request",
  class: "access",
  title: 'Connect Trusted issuer "auth.example.com"',
  target: { kind: "issuer", id: "i1" },
  access: {
    subject: "issuer",
    name: "auth.example.com",
    from: "https://auth.example.com",
  },
});

const appRequest = sig({
  id: "access:application:r1",
  kind: "access-request",
  class: "access",
  target: { kind: "connection-request", id: "r1" },
  access: {
    subject: "application",
    name: "Acme CRM",
    from: "https://crm.acme.test",
  },
  occurredAt: "2026-10-12T10:00:00.000Z",
  lifetimeHours: 0.5,
});

const ask = sig({
  id: "slot:s1:headline",
  kind: "owed-slot",
  category: "ai",
  title: "Pick the headline",
  target: { kind: "session", id: "s1" },
  source: { kind: "session", id: "s1", label: "Content OS session" },
});

describe("reviewGroupOf — Access · Changes · Asks", () => {
  it("files access requests and access-class proposals under Access", () => {
    expect(reviewGroupOf(issuer)).toBe("access");
    expect(reviewGroupOf(cluster("c", { class: "access" }))).toBe("access");
  });
  it("files every other proposal under Changes, and the rest under Asks", () => {
    expect(reviewGroupOf(cluster("c"))).toBe("changes");
    expect(reviewGroupOf(ask)).toBe("asks");
    expect(reviewGroupOf(sig({ id: "n", kind: "notification" }))).toBe("asks");
  });
});

describe("reviewRows", () => {
  it("an issuer opens its drawer, says where it asks from, and is never inline or batched", () => {
    const [row] = reviewRows([issuer], new Map());
    expect(row).toMatchObject({
      group: "access",
      nounKind: "issuer",
      where: "https://auth.example.com",
      detail: { kind: "issuer", issuerId: "i1" },
      inlineApprove: false,
      batchIds: null,
      expiresAt: null,
    });
  });

  it("an entity proposal's row names the thing's kind, not the generic \"entity\"", () => {
    const [row] = reviewRows(
      [cluster("c")],
      new Map([
        facts("c-p1", {
          targetType: "entity",
          requestData: { profileSlug: "task" },
        }),
      ])
    );
    expect(row!.nounKind).toBe("task");
  });

  it("an app request opens the request, and expires at its lease", () => {
    const [row] = reviewRows([appRequest], new Map());
    expect(row!.detail).toEqual({ kind: "app-request", requestId: "r1" });
    expect(row!.nounKind).toBe("application");
    expect(row!.expiresAt).toBe("2026-10-12T10:30:00.000Z");
  });

  it("a change whose moment passed is history: no inline Approve, no batch", () => {
    const ephemeral = cluster("c9", { lifetimeHours: 1 });
    const asked = Date.parse(ephemeral.occurredAt as string);
    const [live] = reviewRows(
      [ephemeral],
      new Map([facts("c9-p1")]),
      asked + 30 * 60_000
    );
    expect(live).toMatchObject({
      expired: false,
      inlineApprove: true,
      batchIds: ["c9-p1"],
    });
    const [lapsed] = reviewRows(
      [ephemeral],
      new Map([facts("c9-p1")]),
      asked + 8 * 3_600_000
    );
    expect(lapsed).toMatchObject({
      expired: true,
      inlineApprove: false,
      batchIds: null,
      // Its page still opens, and says how it ended.
      detail: { kind: "proposal", proposalId: "c9-p1" },
    });
  });

  it("a change the viewer may approve: names who and where, approves inline, batches", () => {
    const [row] = reviewRows([cluster("c1")], new Map([facts("c1-p1")]));
    expect(row).toMatchObject({
      group: "changes",
      nounKind: "track",
      who: "Claude",
      where: "Synap",
      detail: { kind: "proposal", proposalId: "c1-p1" },
      inlineApprove: true,
      batchIds: ["c1-p1"],
    });
  });

  it("an app is named first, with the human it acts for; never an id", () => {
    const [row] = reviewRows(
      [cluster("c1")],
      new Map([facts("c1-p1", { appName: "Acme", authorName: "Ana" })])
    );
    expect(row!.who).toBe("Acme, for Ana");
    const [unknown] = reviewRows([cluster("c2")], new Map());
    expect(unknown!.who).toBeNull();
    expect(unknown!.nounKind).toBe("proposal");
  });

  it("an agent's change names the AGENT and the person it acts for", () => {
    // The facts as `proposals.list` serves them for an agent's write: the
    // legacy coalesce carries the agent-user name too, and must not be read.
    const [row] = reviewRows(
      [cluster("c1")],
      new Map([
        facts("c1-p1", {
          agentName: null,
          authorName: "Claude-code",
          agentActorName: "Claude Code on devbox",
          principal: { kind: "delegated", name: "Antoine" },
        }),
      ])
    );
    expect(row!.who).toBe("Claude Code on devbox, for Antoine");
  });

  it("a removal is never approved inline — but may still join a batch", () => {
    const [row] = reviewRows(
      [cluster("c1")],
      new Map([facts("c1-p1", { proposalType: "delete" })])
    );
    expect(row!.inlineApprove).toBe(false);
    expect(row!.batchIds).toEqual(["c1-p1"]);
  });

  it("a create whose twin is a record is decided on its page, never inline or batched", () => {
    const twinData = {
      duplicateCheck: {
        status: "possible",
        subject: "entity",
        candidates: [
          {
            ref: "record",
            id: "e-1",
            kind: "person",
            title: "Léa",
            why: "same_name",
          },
        ],
      },
    };
    const [twin, plain] = reviewRows(
      [cluster("c1"), cluster("c2")],
      new Map([
        facts("c1-p1", { targetType: "entity", data: twinData }),
        facts("c2-p1", { targetType: "entity", data: {} }),
      ])
    );
    expect(twin).toMatchObject({ inlineApprove: false, batchIds: null });
    expect(plain).toMatchObject({ inlineApprove: true, batchIds: ["c2-p1"] });
  });

  it("a skill, an automation or a rule is decided on its page, never inline or batched", () => {
    // Approving a skill turns it on (the one-approval rule): only its page
    // shows its code or its instructions whole.
    const request = (data: Record<string, unknown>) => ({
      targetType: "skill",
      changeType: "create",
      requestId: "r",
      data,
    });
    const rows = reviewRows(
      [
        cluster("c1"),
        cluster("c2"),
        cluster("c3"),
        cluster("c4", { count: 2, proposalIds: ["c4-p1", "c4-p2"] }),
        cluster("c5"),
        cluster("c6"),
        cluster("c7"),
      ],
      new Map([
        // An agent's code skill, as the gate stores it (request envelope).
        facts("c1-p1", {
          targetType: "skill",
          proposalType: "skill.create",
          data: request({ kind: "code", code: "return 1;" }),
        }),
        // A declarative verb runs a call on a tool: the same rule.
        facts("c2-p1", {
          targetType: "skill",
          proposalType: "create",
          data: request({
            kind: "declarative",
            providerSpec: { tool: "apify_api" },
          }),
        }),
        // A teaching skill's prose lands in an agent's prompt: its page too.
        facts("c3-p1", {
          targetType: "skill",
          proposalType: "create",
          data: request({ kind: "instruction", body: "Be brief." }),
        }),
        // One acting member keeps the whole cluster on its page.
        facts("c4-p1", { targetType: "track" }),
        facts("c4-p2", {
          targetType: "skill",
          proposalType: "create",
          data: { kind: "code", code: "return 2;" },
        }),
        // A rewrite of a skill agents already run.
        facts("c5-p1", {
          targetType: "skill",
          proposalType: "update",
          data: { data: { id: "s-1", body: "Ignore the brief." } },
        }),
        // A capture graph that sets up an automation.
        facts("c6-p1", {
          targetType: "entity",
          proposalType: "capture.graph",
          data: {
            operations: [
              { op: "create_entity", profileSlug: "note", title: "x" },
              { op: "create_automation", ref: "a", name: "Daily" },
            ],
          },
        }),
        // Anti-vacuity: a plain record may still be approved from the row.
        facts("c7-p1", { targetType: "entity", data: {} }),
      ])
    );
    const plain = rows.pop()!;
    for (const row of rows) {
      expect(row).toMatchObject({ inlineApprove: false, batchIds: null });
      expect(row!.detail).toMatchObject({ kind: "proposal" });
    }
    expect(plain).toMatchObject({ inlineApprove: true, batchIds: ["c7-p1"] });
    // The batch door takes nothing from the page-only rows.
    expect(
      batchOf([...rows, plain], new Set([...rows, plain].map((r) => r.key)))
        .proposalIds
    ).toEqual(["c7-p1"]);
  });

  it("a member the viewer may not approve keeps the whole row out of inline and batch", () => {
    const [row] = reviewRows(
      [cluster("c1", { count: 2, proposalIds: ["a", "b"] })],
      new Map([facts("a"), facts("b", { viewerCanReview: false })])
    );
    expect(row!.inlineApprove).toBe(false);
    expect(row!.batchIds).toBeNull();
  });

  it("a cluster whose sample is not the whole cluster is decided in the drawer only", () => {
    const [row] = reviewRows(
      [cluster("c1", { count: 30, proposalIds: ["a", "b"] })],
      new Map([facts("a"), facts("b")])
    );
    expect(row!.inlineApprove).toBe(false);
    expect(row!.batchIds).toBeNull();
    expect(row!.detail).toEqual({ kind: "proposal", proposalId: "c1-p1" });
  });

  it("an access-class proposal (an agent connecting) is never inline, never batched", () => {
    const [row] = reviewRows(
      [cluster("c1", { class: "access" })],
      new Map([
        facts("c1-p1", { proposalType: "connect", targetType: "agent" }),
      ])
    );
    expect(row).toMatchObject({
      group: "access",
      nounKind: "agent",
      inlineApprove: false,
      batchIds: null,
    });
  });

  it("an agent's question is answered here, never inline or batched", () => {
    const [row] = reviewRows([ask], new Map());
    expect(row).toMatchObject({
      group: "asks",
      nounKind: "owed",
      where: "Content OS session",
      detail: {
        kind: "ask",
        sessionId: "s1",
        label: "Pick the headline",
        slot: { sessionId: "s1", label: "Pick the headline", ask: null },
      },
      inlineApprove: false,
      batchIds: null,
    });
  });

  it("a criterion slot is graded on the scorecard, so it opens where it lives", () => {
    const [row] = reviewRows([{ ...ask, slotKind: "criterion" }], new Map());
    expect(row!.detail).toEqual({
      kind: "open",
      door: { kind: "session", id: "s1" },
    });
  });

  it("finds the live question an open ask names, and null once it moved on", () => {
    const rows = reviewRows(
      [
        {
          ...ask,
          ask: { mode: "confirm", prompt: "Ship it?" },
        },
      ],
      new Map()
    );
    expect(
      liveAskSlot(rows, { sessionId: "s1", label: "Pick the headline" })?.ask
    ).toEqual({ mode: "confirm", prompt: "Ship it?" });
    expect(liveAskSlot(rows, { sessionId: "s1", label: "Other" })).toBeNull();
  });

  it("keeps the server's order", () => {
    const rows = reviewRows([ask, issuer, cluster("c1")], new Map());
    expect(rows.map((r) => r.key)).toEqual([
      "slot:s1:headline",
      "access:issuer:i1",
      "c1",
    ]);
  });
});

describe("chips, views and focus", () => {
  const rows = reviewRows(
    [issuer, appRequest, cluster("c1"), cluster("c2"), ask],
    new Map([facts("c1-p1"), facts("c2-p1")])
  );

  it("counts each chip from the same rows", () => {
    expect(reviewCounts(rows)).toEqual({
      all: 5,
      access: 2,
      changes: 2,
      asks: 1,
    });
    expect(rowsInView(rows, "changes").map((r) => r.key)).toEqual(["c1", "c2"]);
    expect(rowsInView(rows, "all")).toHaveLength(5);
  });

  it("All says the pod's count, the nav badge's; groups count the page", () => {
    expect(reviewChipCounts(rows, { needsYou: 5, truncated: false })).toEqual({
      all: "5",
      access: "2",
      changes: "2",
      asks: "1",
    });
    expect(reviewChipCounts(rows, null).all).toBe("5");
  });

  it("a full page: All is the pod's number, a group's count is a floor", () => {
    const full = reviewRows(
      Array.from({ length: NEEDS_YOU_PAGE_LIMIT }, (_, i) => cluster(`f${i}`)),
      new Map()
    );
    expect(reviewChipCounts(full, { needsYou: 149, truncated: true })).toEqual({
      all: "149+",
      access: undefined,
      changes: "100+",
      asks: undefined,
    });
    // Narrowed (no pod count): the page's own number, as a floor.
    expect(reviewChipCounts(full, null).all).toBe("100+");
  });

  it("reads ?type=, and anything unknown is All", () => {
    expect(reviewFilterOf("access")).toBe("access");
    expect(reviewFilterOf("history")).toBe("history");
    expect(reviewFilterOf("queue")).toBe("all");
    expect(reviewFilterOf(null)).toBe("all");
  });

  it("?focus= finds a row by its signal, its target or a member proposal", () => {
    expect(focusedRow(rows, "i1")?.key).toBe("access:issuer:i1");
    expect(focusedRow(rows, "c2-p1")?.key).toBe("c2");
    expect(focusedRow(rows, "slot:s1:headline")?.key).toBe("slot:s1:headline");
    expect(focusedRow(rows, "nope")).toBeNull();
  });
});

describe("batch", () => {
  const rows = reviewRows(
    [
      issuer,
      cluster("c1"),
      cluster("c2", { count: 2, proposalIds: ["x", "y"] }),
    ],
    new Map([facts("c1-p1"), facts("x"), facts("y")])
  );

  it("acts only on batchable rows — an access row is never swept in", () => {
    const b = batchOf(rows, new Set(["access:issuer:i1", "c1", "c2"]));
    expect(b.rows.map((r) => r.key)).toEqual(["c1", "c2"]);
    expect(b.proposalIds).toEqual(["c1-p1", "x", "y"]);
    expect(b.tooMany).toBe(false);
  });

  it("reports failures per ROW, with the pod's own reason", () => {
    const b = batchOf(rows, new Set(["c1", "c2"]));
    expect(
      summarizeBatch(b.rows, [
        { proposalId: "c1-p1", success: true },
        { proposalId: "x", success: true },
        { proposalId: "y", success: false, error: "Target was deleted" },
      ])
    ).toEqual({
      approved: 1,
      failures: [{ title: "c2", error: "Target was deleted" }],
    });
  });
});

describe("isRemoval", () => {
  it("reads the proposal's own type and a capability run's verb", () => {
    expect(isRemoval({ proposalType: "delete" })).toBe(true);
    expect(isRemoval({ proposalType: "archive" })).toBe(true);
    expect(isRemoval({ proposalType: "create" })).toBe(false);
    expect(
      isRemoval({
        proposalType: "capability.run",
        data: { verbId: "entity.delete" },
      })
    ).toBe(true);
    expect(
      isRemoval({
        proposalType: "capability.run",
        data: { verbId: "entity.create" },
      })
    ).toBe(false);
  });
});

describe("exitOf — an ask's door keeps the view it asks for", () => {
  it("a capture's Intake Room door opens the room, not the plain session", () => {
    const [row] = reviewRows(
      [
        sig({
          id: "capture:s9",
          kind: "capture",
          category: "ai",
          target: { kind: "session", id: "s9", view: "room" },
        }),
      ],
      new Map()
    );
    expect(row!.detail).toEqual({
      kind: "open",
      door: { kind: "session", id: "s9", view: "room" },
    });
    expect(
      exitOf({
        kind: "open",
        door: { kind: "session", id: "s9", view: "room" },
      }).href
    ).toBe("synap://open/session/s9?view=room");
  });

  it("a session door with no view stays on the web page", () => {
    expect(
      exitOf({ kind: "open", door: { kind: "session", id: "s1" } }).href
    ).toBe("/open/session/s1");
  });

  it("drops a view the allowlist does not know", () => {
    expect(
      exitOf({
        kind: "open",
        door: { kind: "session", id: "s1", view: "nonsense" },
      }).href
    ).toBe("/open/session/s1");
  });
});

describe("?session= — Review narrowed to one session", () => {
  const SESSION = "44444444-4444-4444-8444-444444444444";

  it("a uuid narrows; anything else is no filter (the read takes .uuid())", () => {
    expect(reviewSessionOf(SESSION)).toBe(SESSION);
    expect(reviewSessionOf("s1")).toBeNull();
    expect(reviewSessionOf("")).toBeNull();
    expect(reviewSessionOf(null)).toBeNull();
  });

  it("a cluster row decides its members; the signal id is not one", () => {
    const [row] = reviewRows(
      [cluster("c1", { count: 2, proposalIds: ["c1-p1", "c1-p2"] })],
      new Map()
    );
    expect(reviewRowMembers(row!)).toEqual(["c1-p1", "c1-p2"]);
  });
});

describe("Review by package (founder B-1)", () => {
  const AGENT = { kind: "agent" as const, id: "agent-1", label: "Claude Code" };
  const inSession = (id: string, sessionId: string, over = {}) =>
    cluster(id, {
      groupKey: `session:${sessionId}`,
      sessionTitle: `Session ${sessionId}`,
      by: AGENT,
      ...over,
    });
  const known = new Map([
    facts("book-1-p1", { proposalType: "update", targetType: "focus_session" }),
    facts("book-2-p1", { proposalType: "update", targetType: "focus_session" }),
    facts("hand-1-p1", {
      proposalType: "assign_agent",
      targetType: "focus_session",
    }),
    facts("know-1-p1", { proposalType: "import.graph", targetType: "entity" }),
  ]);

  it("files each row under the package the pod stamped", () => {
    const rows = reviewRows(
      [cluster("x", { package: "releases" } as Partial<ReviewSignal>)],
      new Map([facts("x-p1")])
    );
    expect(rows[0]?.package).toBe("releases");
  });

  it("classifies a row itself when the pod is older than the stamp", () => {
    const rows = reviewRows(
      [inSession("book-1", "s1"), inSession("hand-1", "s2"), ask],
      known
    );
    expect(rows.map((r) => r.package)).toEqual([
      "bookkeeping",
      "hand-offs",
      "questions",
    ]);
  });

  it("groups in the FIXED order, stakes first, and leaves out empty packages", () => {
    const rows = reviewRows(
      [inSession("book-1", "s1"), inSession("know-1", "s1"), ask],
      known
    );
    expect(packageGroups(rows).map((g) => g.package)).toEqual([
      "questions",
      "knowledge",
      "bookkeeping",
    ]);
  });

  it("folds by session and by agent, the rows with none last", () => {
    const rows = reviewRows(
      [
        inSession("book-1", "s1"),
        inSession("book-2", "s2"),
        inSession("know-1", "s1"),
        cluster("loose", { by: null }),
      ],
      new Map([...known, facts("loose-p1")])
    );
    expect(
      sessionGroups(rows).map((g) => [g.id, g.title, g.rows.length])
    ).toEqual([
      ["s1", "Session s1", 2],
      ["s2", "Session s2", 1],
      [null, null, 1],
    ]);
    expect(agentGroups(rows).map((g) => [g.id, g.rows.length])).toEqual([
      ["agent-1", 3],
      [null, 1],
    ]);
  });

  it("counts items, not rows, and finds the oldest", () => {
    const rows = reviewRows(
      [
        inSession("book-1", "s1", {
          count: 3,
          proposalIds: ["a", "b", "c"],
          occurredAt: "2026-10-01T00:00:00.000Z",
        }),
        inSession("book-2", "s2"),
      ],
      known
    );
    expect(itemCount(rows)).toBe(4);
    expect(oldestAt(rows)).toBe("2026-10-01T00:00:00.000Z");
  });

  it("Keep all takes batchable rows only, never past one batch", () => {
    const many = Array.from({ length: 3 }, (_, i) =>
      inSession(`big-${i}`, "s1", {
        count: 20,
        proposalIds: Array.from({ length: 20 }, (_, j) => `big-${i}-${j}`),
      })
    );
    const viewer = new Map(
      many.flatMap((m) =>
        (m.proposalIds ?? []).map((id) =>
          facts(id, { proposalType: "update", targetType: "focus_session" })
        )
      )
    );
    const rows = reviewRows(many, viewer);
    const keep = keepAllOf(rows);
    // 20 + 20 fit one batch of 50; the third row would make 60.
    expect(keep.proposalIds).toHaveLength(40);
    expect(keep.left).toBe(1);
  });

  it("suggests keeping bookkeeping as one only when every row can be kept", () => {
    const rows = reviewRows(
      [inSession("book-1", "s1"), inSession("book-2", "s2")],
      known
    );
    expect(bookkeepingSuggestion(rows)).toMatchObject({
      count: 2,
      sessions: 2,
    });
    const notMine = reviewRows(
      [inSession("book-1", "s1"), inSession("book-2", "s2")],
      new Map([
        facts("book-1-p1", {
          proposalType: "update",
          targetType: "focus_session",
        }),
        facts("book-2-p1", {
          proposalType: "update",
          targetType: "focus_session",
          viewerCanReview: false,
        }),
      ])
    );
    expect(bookkeepingSuggestion(notMine)).toBeNull();
  });
});
