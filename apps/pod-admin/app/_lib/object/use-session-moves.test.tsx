/**
 * Every status move reaches its own door: the real `useSessionMoves`, driven
 * with each move `sessionMoves` offers, against a tRPC client that records
 * which procedure was called with what. A move that drifted to another door
 * (a draft accepted by writing `status`, a close that skipped the close door)
 * reads here as the wrong procedure.
 */
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const { calls } = vi.hoisted(() => ({
  calls: [] as Array<[string, unknown]>,
}));

vi.mock("../../../lib/trpc", () => {
  const door = (name: string) => ({
    useMutation: () => ({
      mutate: (input: unknown) => calls.push([name, input]),
      isPending: false,
      error: null,
    }),
  });
  return {
    trpc: {
      useUtils: () => ({}),
      focusSessions: {
        acceptFromTriage: door("acceptFromTriage"),
        discardFromTriage: door("discardFromTriage"),
        update: door("update"),
        close: door("close"),
        cancel: door("cancel"),
      },
    },
  };
});

import { sessionMoves, type SessionMove } from "./session-status";
import { useSessionMoves } from "./use-session-moves";

const ID = "6f1c2c1e-0000-4000-8000-000000000001";

function sent(m: SessionMove): [string, unknown] {
  let api: ReturnType<typeof useSessionMoves> | undefined;
  function Harness() {
    api = useSessionMoves(ID);
    return null;
  }
  renderToStaticMarkup(<Harness />);
  calls.length = 0;
  api!.run(m);
  expect(calls).toHaveLength(1);
  return calls[0]!;
}

function movesOf(status: string, pending = false): SessionMove[] {
  const m = sessionMoves({
    status,
    triage: { pending },
    viewerRole: "owner",
  });
  return [m.primary!, ...m.more];
}

describe("useSessionMoves — each move through its own door", () => {
  it("accepts and discards a draft through the triage doors", () => {
    const [accept, discard] = movesOf("active", true);
    expect(sent(accept!)).toEqual(["acceptFromTriage", { sessionId: ID }]);
    expect(sent(discard!)).toEqual(["discardFromTriage", { sessionId: ID }]);
  });

  it("closes, pauses and cancels a running session", () => {
    const [close, pause, cancel] = movesOf("active");
    expect(sent(close!)).toEqual(["close", { id: ID }]);
    expect(sent(pause!)).toEqual(["update", { id: ID, status: "paused" }]);
    expect(sent(cancel!)).toEqual(["cancel", { sessionId: ID }]);
  });

  it("resumes a paused session and starts an appointment", () => {
    const [resume] = movesOf("paused");
    expect(sent(resume!)).toEqual(["update", { id: ID, status: "active" }]);
    const [start] = movesOf("scheduled");
    expect(sent(start!)).toEqual(["update", { id: ID, status: "active" }]);
  });
});
