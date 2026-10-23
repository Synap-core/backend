/**
 * `deriveNextMove` — the ONE rule behind `continuation.nextMove`. Pure, so
 * driven directly with packet sections in their wire shape.
 *
 * The defect this pins: an EMPTY session (no declared outputs, nothing
 * produced), a session BLOCKED by another open session, and a parent whose
 * sub-session is still open all read `ready_to_close`, telling an agent to
 * close work that was never planned or cannot finish yet.
 */

import { describe, it, expect } from "vitest";
import type { ExpectedOutput } from "@synap/playbooks";
import {
  deriveOpenBlockers,
  type DependencyNodeState,
} from "@synap-core/types/connections";
import {
  deriveNextMove,
  type NextMoveBlockers,
  type PacketChildItem,
  type PacketOutputItem,
  type PacketProposalItem,
  type PacketSection,
  type PacketSlotItem,
} from "../continuation-packet.js";

const ok = <T>(items: T[]): PacketSection<T> => ({
  status: "ok",
  total: items.length,
  items,
});
const down = <T>(reason: string): PacketSection<T> => ({
  status: "unavailable",
  reason,
});

const session = (status: string, title = "Ship pricing"): PacketChildItem => ({
  id: `s-${status}`,
  title,
  status,
  statusLabel: status[0]!.toUpperCase() + status.slice(1),
});
/**
 * What holds the session up, derived by THE dependency rule from the blockers'
 * own states — never a hand-built `OpenBlocker`, so a fixture cannot claim a
 * blocker the rule would have cleared (or the reverse).
 */
const blockers = (
  ...list: Array<{ kind?: string; id?: string } & DependencyNodeState>
): NextMoveBlockers => {
  const refs = list.map((b, i) => ({
    kind: b.kind ?? "session",
    id: b.id ?? `s-${b.status}-${i}`,
    state: b,
  }));
  return {
    status: "ok",
    items: deriveOpenBlockers(
      { kind: "session", id: "self" },
      refs.map((r) => ({
        fromType: "session",
        fromId: "self",
        toType: r.kind,
        toId: r.id,
        linkType: "blocked_by",
      })),
      (ref) => refs.find((r) => r.kind === ref.kind && r.id === ref.id)?.state
    ),
  };
};
const blocker = (status: string, title = "Ship pricing") =>
  blockers({ id: `s-${status}`, status, title });

const output: PacketOutputItem = {
  kind: "document",
  noun: "Document",
  glyph: "▤",
  refId: "d-1",
  title: "Pricing notes",
};
const doneSlot = {
  kind: "document",
  label: "Brief",
  status: "done",
} as ExpectedOutput;
const retiredSlot = {
  kind: "document",
  label: "Old brief",
  retiredAt: "2026-09-01T00:00:00.000Z",
} as ExpectedOutput;

function input(over: Partial<Parameters<typeof deriveNextMove>[0]> = {}) {
  return {
    status: "active",
    owedSlots: ok<PacketSlotItem>([]),
    pendingProposals: ok<PacketProposalItem>([]),
    aiCanDo: ok<PacketSlotItem>([]),
    blockers: blockers(),
    expectedOutputs: [] as ExpectedOutput[],
    outputs: ok<PacketOutputItem>([]),
    children: ok<PacketChildItem>([]),
    ...over,
  };
}

describe("deriveNextMove", () => {
  it("an empty open session is undeclared, not ready to close", () => {
    const move = deriveNextMove(input());
    expect(move.kind).toBe("undeclared");
    expect(move.actor).toBe("ai");
  });

  /**
   * FOUNDER DECISION (2026-09-20): when everything the session promised is
   * produced, the work is finished PENDING THE PERSON'S REVIEW — so the move
   * belongs to them, not to the agent that produced it.
   *
   * DISCRIMINATING against the rule it replaces: `ready_to_close` carried
   * `actor: "ai"`, which is what every needs-you reader keys on
   * (`selectNextMoveBanner` promotes the first row whose move is the user's;
   * the workbench/continue card renders "Next move · You" off the same field),
   * so the old rule routed a finished session into the AI's lane. The two rules
   * agree on `kind` and disagree ONLY here — asserting the kind cannot tell
   * them apart, which is why every fixture below asserts the actor.
   *
   * The `undeclared` sibling keeps `actor: "ai"` (pinned at :72): declaring what
   * a session should produce IS the agent's job. A fixture that flipped both
   * would rule out nothing.
   */
  it("every declared output done is the PERSON's move, not the AI's", () => {
    const move = deriveNextMove(input({ expectedOutputs: [doneSlot] }));
    expect(move).toMatchObject({ kind: "ready_to_close", actor: "user" });
    // The label must name what the person is being asked to do. "None: ready to
    // close" described the agent's empty queue, not an ask.
    expect(move.label).toMatch(/review/i);
  });

  /**
   * `readyToClose` is ONE object returned from TWO branches: declared slots all
   * satisfied, and no live declared slot but produced outputs / a closed
   * sub-session. Both mean the same thing — evidence of work, nothing owed,
   * pending or left to produce — so both are the person's acceptance and the
   * shared object is correct. Pinned from the SECOND branch too, so a future
   * split cannot flip one back to the agent unnoticed (the fixture above only
   * reaches the first).
   */
  it("the undeclared-but-produced branch is the person's move too", () => {
    expect(deriveNextMove(input({ outputs: ok([output]) }))).toMatchObject({
      kind: "ready_to_close",
      actor: "user",
    });
    expect(
      deriveNextMove(input({ children: ok([session("closed", "Detour")]) }))
    ).toMatchObject({ kind: "ready_to_close", actor: "user" });
  });

  it("an OWED slot is the person's move and is NOT ready to close", () => {
    const move = deriveNextMove(
      input({
        expectedOutputs: [doneSlot],
        owedSlots: ok([{ label: "Stripe key", kind: "credential" }]),
      })
    );
    expect(move).toMatchObject({ kind: "owed_slot", actor: "user" });
  });

  it("an open AGENT slot stays the AI's move, never ready to close", () => {
    const move = deriveNextMove(
      input({
        expectedOutputs: [doneSlot],
        aiCanDo: ok([{ label: "Draft brief", kind: "document" }]),
      })
    );
    expect(move).toMatchObject({ kind: "agent_slot", actor: "ai" });
  });

  it("a failed outputs read is never handed to the person as ready", () => {
    const move = deriveNextMove(
      input({ outputs: down("outputs read failed") })
    );
    expect(move).toMatchObject({ kind: "unknown", actor: "none" });
    expect(move.reason).toContain("outputs read failed");
  });

  it("an undeclared session that produced an output is ready to close", () => {
    expect(deriveNextMove(input({ outputs: ok([output]) })).kind).toBe(
      "ready_to_close"
    );
  });

  it("an undeclared session with only settled sub-sessions is ready to close", () => {
    expect(
      deriveNextMove(input({ children: ok([session("closed", "Detour")]) }))
        .kind
    ).toBe("ready_to_close");
  });

  // Live repro (session 266aeea9 after its child 5e99cb00 was cancelled): a
  // cancelled child produced nothing, so it is no evidence of work.
  it.each(["cancelled", "failed", "stale"])(
    "an undeclared parent whose only sub-session is %s is undeclared, not ready to close",
    (status) => {
      expect(
        deriveNextMove(input({ children: ok([session(status, "Detour")]) }))
          .kind
      ).toBe("undeclared");
    }
  );

  it("a closed sub-session beside cancelled ones is still evidence of work", () => {
    expect(
      deriveNextMove(
        input({
          children: ok([
            session("cancelled", "Dropped"),
            session("closed", "Detour"),
          ]),
        })
      ).kind
    ).toBe("ready_to_close");
  });

  it("declared work with nothing left is ready to close", () => {
    expect(deriveNextMove(input({ expectedOutputs: [doneSlot] })).kind).toBe(
      "ready_to_close"
    );
  });

  it("a declared set of ONLY retired slots is undeclared", () => {
    expect(
      deriveNextMove(input({ expectedOutputs: [retiredSlot, retiredSlot] }))
        .kind
    ).toBe("undeclared");
  });

  it("a retired slot beside a live declared one is still ready to close", () => {
    expect(
      deriveNextMove(input({ expectedOutputs: [retiredSlot, doneSlot] })).kind
    ).toBe("ready_to_close");
  });

  it("blocked by an OPEN session waits on it, naming the blocker", () => {
    const move = deriveNextMove(
      input({ expectedOutputs: [doneSlot], blockers: blocker("active") })
    );
    expect(move).toMatchObject({
      kind: "waiting_on_session",
      actor: "none",
      sessionId: "s-active",
    });
    expect(move.label).toContain("Ship pricing");
  });

  it("an empty session blocked by an open session waits rather than reading undeclared", () => {
    expect(deriveNextMove(input({ blockers: blocker("paused") })).kind).toBe(
      "waiting_on_session"
    );
  });

  it("a waiting session outranks open agent slots", () => {
    expect(
      deriveNextMove(
        input({
          expectedOutputs: [doneSlot],
          aiCanDo: ok([{ label: "Draft brief", kind: "document" }]),
          blockers: blocker("active"),
        })
      ).kind
    ).toBe("waiting_on_session");
  });

  it("a CLOSED blocker delivered and does not block", () => {
    expect(
      deriveNextMove(
        input({ expectedOutputs: [doneSlot], blockers: blocker("closed") })
      ).kind
    ).toBe("ready_to_close");
  });

  /**
   * FOUNDER DECISION (2026-10-22): a blocker that ENDED WITHOUT DELIVERING
   * does not clear. The rule this replaces read `cancelled` / `failed` exactly
   * like `closed` — `ready_to_close` here, i.e. "accept work built on a
   * prerequisite that never happened". Discriminating on kind AND actor: the
   * re-plan is the AI's move, never the person's acceptance.
   */
  it.each(["cancelled", "failed"])(
    "a blocker that ended %s is DROPPED: re-plan, naming it, never ready to close",
    (status) => {
      const move = deriveNextMove(
        input({ expectedOutputs: [doneSlot], blockers: blocker(status) })
      );
      expect(move).toMatchObject({
        kind: "blocker_dropped",
        actor: "ai",
        sessionId: `s-${status}`,
      });
      expect(move.label).toContain("Ship pricing");
      expect(move.reason).toMatch(/without delivering/);
    }
  );

  it("a dropped blocker outranks an open one and open agent slots", () => {
    expect(
      deriveNextMove(
        input({
          aiCanDo: ok([{ label: "Draft brief", kind: "document" }]),
          blockers: blockers(
            { id: "b-open", status: "active", title: "Still going" },
            { id: "b-gone", status: "cancelled", title: "Never happened" }
          ),
        })
      )
    ).toMatchObject({ kind: "blocker_dropped", sessionId: "b-gone" });
  });

  it("a dropped NON-session blocker re-plans too, without a session door", () => {
    const move = deriveNextMove(
      input({
        expectedOutputs: [doneSlot],
        blockers: blockers({
          kind: "track",
          id: "t-1",
          status: "archived",
          title: "Pricing track",
        }),
      })
    );
    expect(move).toMatchObject({ kind: "blocker_dropped", actor: "ai" });
    expect(move.sessionId).toBeUndefined();
  });

  // `stale` is resumable, not ended: it still holds — as WAITING, not dropped.
  it("a STALE blocker still holds the session (waiting, not dropped)", () => {
    expect(
      deriveNextMove(
        input({ expectedOutputs: [doneSlot], blockers: blocker("stale") })
      ).kind
    ).toBe("waiting_on_session");
  });

  it("declared work done but an OPEN sub-session waits on it, naming the child", () => {
    const move = deriveNextMove(
      input({
        expectedOutputs: [doneSlot],
        children: ok([
          session("closed", "Old detour"),
          session("active", "Pricing detour"),
        ]),
      })
    );
    expect(move).toMatchObject({
      kind: "waiting_on_session",
      actor: "none",
      sessionId: "s-active",
    });
    expect(move.label).toContain("Pricing detour");
    expect(move.reason).toContain("sub-session is still open");
  });

  it("the parent's own open agent slot outranks an open sub-session", () => {
    expect(
      deriveNextMove(
        input({
          aiCanDo: ok([{ label: "Draft brief", kind: "document" }]),
          children: ok([session("active", "Pricing detour")]),
        })
      ).kind
    ).toBe("agent_slot");
  });

  it("a failed children read is unknown even with declared work done", () => {
    const move = deriveNextMove(
      input({ expectedOutputs: [doneSlot], children: down("could not read") })
    );
    expect(move.kind).toBe("unknown");
    expect(move.reason).toContain("could not read");
  });

  it("an owed human slot still wins over a blocker", () => {
    expect(
      deriveNextMove(
        input({
          owedSlots: ok([{ label: "Stripe key", kind: "credential" }]),
          blockers: blocker("active"),
        })
      ).kind
    ).toBe("owed_slot");
  });

  it("a failed blockers read is unknown, never silently unblocked", () => {
    const move = deriveNextMove(
      input({
        expectedOutputs: [doneSlot],
        blockers: { status: "unavailable", reason: "could not read" },
      })
    );
    expect(move.kind).toBe("unknown");
    expect(move.reason).toContain("could not read");
  });

  it("with no declared outputs, a failed outputs read is unknown, not undeclared", () => {
    expect(deriveNextMove(input({ outputs: down("x") })).kind).toBe("unknown");
  });

  it("a terminal session is none, whatever blocks it or runs under it", () => {
    expect(
      deriveNextMove(
        input({
          status: "closed",
          blockers: blocker("active"),
          children: ok([session("active", "Detour")]),
        })
      ).kind
    ).toBe("none");
  });
});
