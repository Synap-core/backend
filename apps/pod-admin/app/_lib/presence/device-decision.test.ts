/**
 * The device door with the proof (W3 slice 2): an approval of a computer is
 * proved up front, its challenge naming `device_request:<requestId>`; a
 * denial is sent as is; a PRESENCE_* refusal from the route (its
 * `reasonCode`) is proved and sent again.
 */
import { describe, expect, it, vi } from "vitest";
import type { PresenceProof } from "@synap-core/types/presence";
import { sendDeviceDecision } from "./device-decision";
import type { ProvePresence } from "./presence-model";

const PROOF: PresenceProof = {
  kind: "device_key",
  challengeId: "00000000-0000-4000-8000-000000000001",
  keyId: "00000000-0000-4000-8000-0000000000aa",
  signature: "sig",
};

function route(answer: (body: Record<string, unknown>) => [number, unknown]) {
  const bodies: Array<Record<string, unknown>> = [];
  const post = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    const [status, json] = answer(body);
    return new Response(JSON.stringify(json), { status });
  }) as typeof fetch;
  return { post, bodies };
}

const APPROVE = {
  decision: "approve" as const,
  requestId: "req-1",
  userCode: "ABCDEFGH",
  computerName: "MacBook-Pro",
};

describe("sendDeviceDecision", () => {
  it("an approval carries its proof on the first POST, named for this request", async () => {
    const { post, bodies } = route(() => [200, { status: "approved" }]);
    const prove = vi.fn<ProvePresence>(async () => PROOF);
    expect(
      await sendDeviceDecision({ decision: APPROVE, post, prove })
    ).toBeNull();
    expect(bodies).toEqual([{ ...APPROVE, presence: PROOF }]);
    expect(prove.mock.calls[0]![0]).toMatchObject({
      request: { kind: "device_request", id: "req-1" },
    });
    expect(prove.mock.calls[0]![3]).toEqual({ upFront: true });
  });

  it("a denial asks for nothing", async () => {
    const { post, bodies } = route(() => [200, { status: "denied" }]);
    const prove = vi.fn<ProvePresence>();
    await sendDeviceDecision({
      decision: { ...APPROVE, decision: "deny" },
      post,
      prove,
    });
    expect(prove).not.toHaveBeenCalled();
    expect(bodies[0]).not.toHaveProperty("presence");
  });

  it("the route's PRESENCE_REQUIRED is proved and sent again", async () => {
    const { post, bodies } = route((body) =>
      body.presence
        ? [200, { status: "approved" }]
        : [403, { error: "Confirm it is you", reasonCode: "PRESENCE_REQUIRED" }]
    );
    // Up front nothing could be proved here; then the pod asks.
    const prove = vi.fn<ProvePresence>(async (_s, _r, _p, options) =>
      options?.upFront ? null : PROOF
    );
    expect(
      await sendDeviceDecision({ decision: APPROVE, post, prove })
    ).toBeNull();
    expect(bodies.map((b) => "presence" in b)).toEqual([false, true]);
  });

  it("any other refusal is the page's words", async () => {
    const { post } = route(() => [409, { error: "Already decided." }]);
    expect(
      await sendDeviceDecision({
        decision: APPROVE,
        post,
        prove: async () => null,
      })
    ).toBe("Already decided.");
  });
});
