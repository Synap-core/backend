import { describe, expect, it } from "vitest";
import {
  batchOf,
  exitOf,
  focusedRow,
  isRemoval,
  liveAskSlot,
  reviewCounts,
  reviewFilterOf,
  reviewGroupOf,
  reviewRows,
  rowsInView,
  summarizeBatch,
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

  it("an app request opens the request, and expires at its lease", () => {
    const [row] = reviewRows([appRequest], new Map());
    expect(row!.detail).toEqual({ kind: "app-request", requestId: "r1" });
    expect(row!.nounKind).toBe("application");
    expect(row!.expiresAt).toBe("2026-10-12T10:30:00.000Z");
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
