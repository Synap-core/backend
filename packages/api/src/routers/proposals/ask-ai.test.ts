/**
 * `proposals.askAi` — the ONE server door behind "Ask AI to resolve this".
 *
 * What this file proves, and what it deliberately does not:
 *
 *  - AUTHORIZATION is a FLOOR, not a step: a proposal the caller may not see
 *    must not produce a channel, a message or a turn. Asserted by driving the
 *    real function with the real gate REJECTING, and checking all three
 *    collaborators were never called — the failure mode being an ordering bug
 *    where the channel is resolved before the gate.
 *  - The turn starts through the ONE door `triggerAutoRespond`. Asserted both
 *    behaviourally (the spy) and by source scan (no bare `getBoss().send`),
 *    which is what the `a2ai-one-door` tripwire enforces globally.
 *  - IDEMPOTENCY under double-tap: an UNANSWERED seed already in the thread
 *    must not produce a second turn.
 *
 * NOT covered, measured rather than implied:
 *
 *  - The real SQL predicates behind `assertProposalVisibleTo` and the channel
 *    upsert. Both are mocked at their module seam; they have their own tests
 *    (`proposal-idor-gate.test.ts`, `resolve-or-create-channel.*`). This file
 *    tests THIS door's wiring, which is where a gate gets skipped.
 *  - The idempotency QUERY itself. The `db.select()` fake returns its rows
 *    regardless of `.where()` / `.orderBy()`, so this file cannot see a wrong
 *    channel filter or a wrong sort column — and the sort column was in fact
 *    wrong on the first pass (`messages.createdAt`, a column that does not
 *    exist; `messages` clocks on `timestamp`). The TYPECHECK caught it, not
 *    these tests. Recorded here because a reader would otherwise assume the
 *    green suite covered it.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const h = vi.hoisted(() => ({
  proposalRow: null as Record<string, unknown> | null,
  latestMessages: [] as Array<{ id: string; role: string; content: string }>,
  visibilityError: null as unknown,
  /** Membership row the fallback-workspace check reads. null ⇒ not a member. */
  membership: { id: "m-1" } as Record<string, unknown> | null,
  /** Idempotency keys `postChannelMessage` has ALREADY inserted under. Models
   *  the real `ON CONFLICT DO NOTHING` on the deterministic message id. */
  insertedKeys: new Set<string>(),
}));

vi.mock("../../utils/proposal-visibility.js", () => ({
  assertProposalVisibleTo: vi.fn(async () => {
    if (h.visibilityError) throw h.visibilityError;
  }),
}));

vi.mock("../../utils/resolve-or-create-channel.js", () => ({
  resolveOrCreateChannel: vi.fn(async () => ({ id: "chan-1" })),
}));

// Models the REAL mechanism the door now relies on: an explicit
// `idempotencyKey` becomes a DETERMINISTIC message id, and the insert is
// `ON CONFLICT DO NOTHING` — so the second writer of the same key gets
// `duplicate-ignored` instead of a second row. The fake keys off the same
// string the door passes, so a door that stopped passing one (or passed a
// per-call-unique one) stops being serialised here exactly as in production.
vi.mock("../../services/messaging/post-message.js", () => ({
  postChannelMessage: vi.fn(async (p: { idempotencyKey?: string }) => {
    const key = p.idempotencyKey ?? Math.random().toString();
    const duplicate = h.insertedKeys.has(key);
    h.insertedKeys.add(key);
    return {
      success: true as const,
      messageId: "msg-1",
      channelId: "chan-1",
      ackState: duplicate
        ? ("duplicate-ignored" as const)
        : ("applied" as const),
      ...(duplicate ? { priorMessageId: "msg-1" } : {}),
    };
  }),
}));

vi.mock("../../utils/trigger-auto-respond.js", () => ({
  triggerAutoRespond: vi.fn(async () => true),
}));

vi.mock("@synap/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@synap/database")>();
  const chain = (rows: unknown[]) => {
    const self: Record<string, unknown> = {
      from: () => self,
      where: () => self,
      orderBy: () => self,
      limit: () => self,
      then: (
        resolve: (v: unknown[]) => unknown,
        reject?: (e: unknown) => unknown
      ) => Promise.resolve(rows).then(resolve, reject),
    };
    return self;
  };
  const query = {
    proposals: { findFirst: async () => h.proposalRow },
    workspaceMembers: { findFirst: async () => h.membership },
  };
  // NO `transaction` is exposed. The door must not open one: it used to hold a
  // pool connection across `postChannelMessage`, which runs its own queries on
  // the ambient `db`, so at concurrency >= pool size every holder waited for a
  // connection only another holder could release. A door that reintroduces
  // `db.transaction(...)` here throws "is not a function" rather than passing.
  return {
    ...actual,
    db: {
      query,
      select: () => chain(h.latestMessages),
    },
  };
});

const { assertProposalVisibleTo } =
  await import("../../utils/proposal-visibility.js");
const { resolveOrCreateChannel } =
  await import("../../utils/resolve-or-create-channel.js");
const { postChannelMessage } =
  await import("../../services/messaging/post-message.js");
const { triggerAutoRespond } =
  await import("../../utils/trigger-auto-respond.js");
const { askAiAboutProposal, ASK_AI_SEED, isAskAiSeed } =
  await import("./ask-ai.js");

const PROPOSAL = "11111111-2222-3333-4444-555555555555";
const USER = "user-1";

beforeEach(() => {
  vi.clearAllMocks();
  h.visibilityError = null;
  h.latestMessages = [];
  h.membership = { id: "m-1" };
  h.insertedKeys = new Set<string>();
  h.proposalRow = {
    id: PROPOSAL,
    workspaceId: "ws-1",
    status: "approval_failed",
    sessionId: null,
  };
});

describe("AUTHORIZATION NEGATIVE — a proposal the caller cannot see", () => {
  it("opens NO channel, posts NO message, starts NO turn", async () => {
    h.visibilityError = new TRPCError({
      code: "FORBIDDEN",
      message: "Not authorized to view this proposal",
    });

    await expect(
      askAiAboutProposal({ proposalId: PROPOSAL, userId: USER })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    // The whole point: the gate is a FLOOR. Resolving the channel first and
    // gating after would still throw — and would still have created a channel
    // bound to a proposal the caller may not see.
    expect(resolveOrCreateChannel).not.toHaveBeenCalled();
    expect(postChannelMessage).not.toHaveBeenCalled();
    expect(triggerAutoRespond).not.toHaveBeenCalled();
  });

  it("a NOT_FOUND from the gate propagates unchanged (no existence oracle)", async () => {
    h.visibilityError = new TRPCError({
      code: "NOT_FOUND",
      message: "Proposal not found",
    });
    await expect(
      askAiAboutProposal({ proposalId: PROPOSAL, userId: USER })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(resolveOrCreateChannel).not.toHaveBeenCalled();
  });

  it("NON-VACUITY: the SAME call succeeds once the gate admits the caller", async () => {
    const out = await askAiAboutProposal({
      proposalId: PROPOSAL,
      userId: USER,
    });
    expect(out.channelId).toBe("chan-1");
    expect(assertProposalVisibleTo).toHaveBeenCalledWith(
      PROPOSAL,
      USER,
      expect.anything()
    );
  });
});

describe("the happy path", () => {
  it("resolves the PROPOSAL-BOUND thread, seeds it, and starts ONE turn", async () => {
    const out = await askAiAboutProposal({
      proposalId: PROPOSAL,
      userId: USER,
    });

    expect(resolveOrCreateChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: USER,
        contextObjectType: "proposal",
        contextObjectId: PROPOSAL,
        workspaceId: "ws-1",
      })
    );
    expect(postChannelMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "chan-1",
        role: "user",
        userId: USER,
        triggerAI: false,
      })
    );
    // THE ONE DOOR, at the message it just posted.
    expect(triggerAutoRespond).toHaveBeenCalledTimes(1);
    expect(triggerAutoRespond).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "chan-1",
        userMessageId: "msg-1",
        sourceUserId: USER,
      })
    );
    expect(out).toEqual({
      channelId: "chan-1",
      seeded: true,
      triggered: true,
    });
  });

  it("appends the user's note to the seed", async () => {
    await askAiAboutProposal({
      proposalId: PROPOSAL,
      userId: USER,
      note: "I already reconnected Google.",
    });
    const posted = vi.mocked(postChannelMessage).mock.calls[0]![0]!;
    expect(posted.content).toContain(ASK_AI_SEED);
    expect(posted.content).toContain("I already reconnected Google.");
  });

  it("falls back to the caller's workspace when the proposal has none", async () => {
    h.proposalRow = { ...h.proposalRow!, workspaceId: null };
    await askAiAboutProposal({
      proposalId: PROPOSAL,
      userId: USER,
      fallbackWorkspaceId: "ws-active",
    });
    expect(resolveOrCreateChannel).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-active" })
    );
  });

  it("REFUSES a fallback workspace the caller is NOT a member of", async () => {
    // `assertProposalVisibleTo` proves the caller may see the PROPOSAL. It
    // proves nothing about the workspace they NAMED — and filing the thread
    // into a workspace discloses the proposal to that workspace's members. So
    // a pod-wide proposal plus a typed workspace id was an unchecked
    // disclosure door.
    h.proposalRow = { ...h.proposalRow!, workspaceId: null };
    h.membership = null;
    await expect(
      askAiAboutProposal({
        proposalId: PROPOSAL,
        userId: USER,
        fallbackWorkspaceId: "ws-someone-elses",
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(resolveOrCreateChannel).not.toHaveBeenCalled();
    expect(postChannelMessage).not.toHaveBeenCalled();
    expect(triggerAutoRespond).not.toHaveBeenCalled();
  });

  it("does NOT re-check the proposal's OWN workspace against membership", async () => {
    // The pod placed it there, not this request. Re-gating it would break the
    // ordinary case for a pod-visible proposal the caller is not a member of.
    h.membership = null; // would refuse if the check applied here
    await askAiAboutProposal({ proposalId: PROPOSAL, userId: USER });
    expect(resolveOrCreateChannel).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws-1" })
    );
  });

  it("REFUSES rather than guessing a workspace when there is none at all", async () => {
    h.proposalRow = { ...h.proposalRow!, workspaceId: null };
    await expect(
      askAiAboutProposal({ proposalId: PROPOSAL, userId: USER })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // Filing the thread into a guessed workspace grants its members sight of
    // the proposal — refusing is the safe answer, never picking one.
    expect(resolveOrCreateChannel).not.toHaveBeenCalled();
  });
});

describe("IDEMPOTENCY under double-tap", () => {
  it("does not post a second seed while one is unanswered", async () => {
    h.latestMessages = [{ id: "m-prev", role: "user", content: ASK_AI_SEED }];
    const out = await askAiAboutProposal({
      proposalId: PROPOSAL,
      userId: USER,
    });
    expect(out).toEqual({
      channelId: "chan-1",
      seeded: false,
      triggered: false,
    });
    expect(postChannelMessage).not.toHaveBeenCalled();
    expect(triggerAutoRespond).not.toHaveBeenCalled();
  });

  it("serialises the read+post pair with an idempotencyKey, not a lock", async () => {
    // Read-then-write is a race: two taps arriving together both read "no
    // seed" and both post — two agent turns answering one question, and two
    // proposals against the daily cap. It is the WRITE that closes it now: the
    // key names the message the decision was made against, so both taps derive
    // the same deterministic message id and only one insert lands.
    h.latestMessages = [
      { id: "m-prev", role: "assistant", content: "answered" },
    ];
    await askAiAboutProposal({ proposalId: PROPOSAL, userId: USER });
    expect(postChannelMessage).toHaveBeenCalledTimes(1);
    const key = vi.mocked(postChannelMessage).mock.calls[0]![0]!.idempotencyKey;
    expect(key).toBe(`ask-ai:${PROPOSAL}:m-prev`);
  });

  it("the key CHANGES once the thread has moved on (asking again still works)", async () => {
    h.latestMessages = [{ id: "m-1", role: "assistant", content: "a" }];
    await askAiAboutProposal({ proposalId: PROPOSAL, userId: USER });
    h.latestMessages = [{ id: "m-2", role: "assistant", content: "b" }];
    await askAiAboutProposal({ proposalId: PROPOSAL, userId: USER });
    const keys = vi
      .mocked(postChannelMessage)
      .mock.calls.map((c) => c[0]!.idempotencyKey);
    expect(new Set(keys).size).toBe(2);
    expect(triggerAutoRespond).toHaveBeenCalledTimes(2);
  });

  it("the door opens NO transaction — it must not pin a pool connection", async () => {
    // The `@synap/database` fake exposes no `transaction`, so reintroducing
    // `db.transaction(...)` across `postChannelMessage` (which queries the
    // ambient `db`) fails here instead of deadlocking the pool in production.
    const { db } = await import("@synap/database");
    expect(
      (db as unknown as Record<string, unknown>).transaction
    ).toBeUndefined();
    await expect(
      askAiAboutProposal({ proposalId: PROPOSAL, userId: USER })
    ).resolves.toMatchObject({ seeded: true });
  });

  it("two CONCURRENT taps produce exactly ONE seed and ONE trigger", async () => {
    // The WORST case, and the one a lock used to be needed for: both taps read
    // the SAME last message (neither sees the other's write), so both call
    // through. The shared deterministic key is what makes the second insert a
    // no-op — `postChannelMessage` is called twice, exactly one row lands, and
    // exactly one turn starts.
    h.latestMessages = [
      { id: "m-prev", role: "assistant", content: "answered" },
    ];
    const results = await Promise.all([
      askAiAboutProposal({ proposalId: PROPOSAL, userId: USER }),
      askAiAboutProposal({ proposalId: PROPOSAL, userId: USER }),
    ]);
    expect(results.filter((r) => r.seeded)).toHaveLength(1);
    // Both taps REACHED the writer — this is not a test that got lucky on
    // ordering; the de-duplication happened at the insert, where it must.
    expect(postChannelMessage).toHaveBeenCalledTimes(2);
    expect(triggerAutoRespond).toHaveBeenCalledTimes(1);
  });

  it("DOES seed again once the agent has replied", async () => {
    h.latestMessages = [
      { id: "m-prev", role: "assistant", content: "Here is why it failed…" },
    ];
    const out = await askAiAboutProposal({
      proposalId: PROPOSAL,
      userId: USER,
    });
    expect(out.seeded).toBe(true);
    expect(triggerAutoRespond).toHaveBeenCalledTimes(1);
  });

  it("isAskAiSeed is derived from the seed constant, not a second literal", () => {
    expect(isAskAiSeed("user", ASK_AI_SEED)).toBe(true);
    expect(isAskAiSeed("user", `${ASK_AI_SEED}\n\nplus a note`)).toBe(true);
    expect(isAskAiSeed("assistant", ASK_AI_SEED)).toBe(false);
    expect(isAskAiSeed("user", "something else")).toBe(false);
    expect(isAskAiSeed("user", null)).toBe(false);
  });
});

describe("the ONE-DOOR rule, structurally", () => {
  const raw = readFileSync(
    fileURLToPath(new URL("./ask-ai.ts", import.meta.url)),
    "utf8"
  );
  /**
   * COMMENTS STRIPPED FIRST. The module's docblock names the anti-pattern it
   * avoids ("never a bare `getBoss().send(A2AI_TRIGGER_QUEUE)`"), so a
   * whole-file scan trips on the prose that documents the rule — the exact
   * comment-scanning trap `.claude/rules/guards-and-tests.md` records.
   */
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("NON-VACUITY: comment-stripping did not empty the scan", () => {
    expect(src.length).toBeGreaterThan(800);
    expect(src).toContain("triggerAutoRespond(");
    expect(src).toContain("assertProposalVisibleTo(");
    // …and it DID remove prose the raw file carries.
    expect(raw).toContain("a2ai-one-door");
    expect(src).not.toContain("a2ai-one-door");
  });

  it("never enqueues the A2AI trigger itself", () => {
    expect(src).not.toContain("getBoss(");
    expect(src).not.toContain("A2AI_TRIGGER");
  });

  it("does not revise, retry or re-approve the proposal", () => {
    // The founder's rule: repair is NOT revise-in-place. A fix arrives as a
    // NEW proposal. This door must therefore contain no write to the row.
    expect(src).not.toContain("updateProposal");
    expect(src).not.toContain("mergeProposalRevision");
    expect(src).not.toContain("db.update(proposals)");
  });
});
