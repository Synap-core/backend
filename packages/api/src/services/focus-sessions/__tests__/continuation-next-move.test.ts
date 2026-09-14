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
  deriveNextMove,
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
const output: PacketOutputItem = {
  kind: "document",
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
    blockedBy: ok<PacketChildItem>([]),
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
      input({ expectedOutputs: [doneSlot], blockedBy: ok([session("active")]) })
    );
    expect(move).toMatchObject({
      kind: "waiting_on_session",
      actor: "none",
      sessionId: "s-active",
    });
    expect(move.label).toContain("Ship pricing");
  });

  it("an empty session blocked by an open session waits rather than reading undeclared", () => {
    expect(
      deriveNextMove(input({ blockedBy: ok([session("paused")]) })).kind
    ).toBe("waiting_on_session");
  });

  it("a waiting session outranks open agent slots", () => {
    expect(
      deriveNextMove(
        input({
          expectedOutputs: [doneSlot],
          aiCanDo: ok([{ label: "Draft brief", kind: "document" }]),
          blockedBy: ok([session("active")]),
        })
      ).kind
    ).toBe("waiting_on_session");
  });

  it.each(["closed", "cancelled", "failed", "stale"])(
    "a blocker that is %s has settled and does not block",
    (status) => {
      expect(
        deriveNextMove(
          input({
            expectedOutputs: [doneSlot],
            blockedBy: ok([session(status)]),
          })
        ).kind
      ).toBe("ready_to_close");
    }
  );

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
          blockedBy: ok([session("active")]),
        })
      ).kind
    ).toBe("owed_slot");
  });

  it("a failed blockedBy read is unknown, never silently unblocked", () => {
    const move = deriveNextMove(
      input({ expectedOutputs: [doneSlot], blockedBy: down("could not read") })
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
          blockedBy: ok([session("active")]),
          children: ok([session("active", "Detour")]),
        })
      ).kind
    ).toBe("none");
  });
});
