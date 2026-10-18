/**
 * `diagnose.resolveOpen` — the tRPC door the desktop uses to follow a bare-id
 * link (`synap://open/<uuid>`), because its remote-pod transport (the Kratos
 * cookie) is not accepted by Hub REST auth.
 *
 * Drives the REAL router → the REAL `resolveOpenTarget` → the REAL
 * `browserRouteFor`; only the prober is stubbed. Pins the three answers:
 * found (routable label), not found (`unknown`), and a FAILED probe → a thrown
 * `INTERNAL_SERVER_ERROR` — never a calm `unknown`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ID = "4d3e8f37-d33b-4ec6-8146-a071ab37136a";

// A plain switchable stub, not a `vi.fn` (see resolve.route.test.ts: a hoisted
// rejecting `vi.fn` fails the test under this vitest even when caught).
const probe = vi.hoisted(() => ({
  impl: (async () => null) as (...args: unknown[]) => Promise<unknown>,
  calls: [] as unknown[][],
}));

vi.mock(
  "../services/diagnose/resolve-object-kind.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../services/diagnose/resolve-object-kind.js")
    >()),
    resolveObjectKind: (...args: unknown[]) => {
      probe.calls.push(args);
      return probe.impl(...args);
    },
  })
);

const { diagnoseRouter } = await import("./diagnose.js");
const caller = diagnoseRouter.createCaller({
  userId: "user-1",
  authenticated: true,
  workspaceId: null,
} as never);

describe("diagnose.resolveOpen", () => {
  beforeEach(() => {
    probe.impl = async () => null;
    probe.calls = [];
  });

  it("found: returns the routable label + run params, floored on the ctx user", async () => {
    probe.impl = async () => ({
      kind: "playbook_run",
      id: ID,
      displayName: "Weekly digest",
      workspaceId: "ws-1",
      updatedAt: new Date("2026-10-17T09:00:00Z"),
    });
    const out = await caller.resolveOpen({ id: ID });
    expect(out).toEqual({
      type: "run",
      id: ID,
      displayName: "Weekly digest",
      workspaceId: "ws-1",
      updatedAt: new Date("2026-10-17T09:00:00Z"),
      openable: true,
      params: { flowType: "playbook" },
    });
    // The ctx user is the floor — the client never supplies it.
    expect(probe.calls).toEqual([[ID, "user-1"]]);
  });

  it("not found: the honest `unknown` answer", async () => {
    const out = await caller.resolveOpen({ id: ID });
    expect(out).toEqual({
      type: "unknown",
      id: ID,
      displayName: null,
      workspaceId: null,
      updatedAt: null,
      openable: false,
    });
  });

  it("a FAILED probe throws INTERNAL_SERVER_ERROR, never a calm `unknown`", async () => {
    probe.impl = async () => {
      throw new Error("connection terminated");
    };
    await expect(caller.resolveOpen({ id: ID })).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
    });
  });

  it("a non-uuid id is refused before any probe runs", async () => {
    await expect(
      caller.resolveOpen({ id: "not-a-uuid" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(probe.calls).toEqual([]);
  });
});
