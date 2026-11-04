/**
 * The pending agent-key doors with the proof (W3), against the pod's REST
 * answers as `setup.ts` gives them: a refusal is `{error, code}` with 403 on
 * the one-key door, and `{outcome: "refused", code}` per key on the batch.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PresenceProof } from "@synap-core/types/presence";
import { approvePendingKey, approvePendingKeys } from "./pending-key-approval";
import type { ProvePresence } from "./presence-model";

const POD = "https://pod.example.test";
const proof = (n: number): PresenceProof => ({
  kind: "device_key",
  challengeId: `00000000-0000-4000-8000-00000000000${n}`,
  keyId: "00000000-0000-4000-8000-0000000000aa",
  signature: `sig${n}`,
});

type Body = Record<string, unknown> | undefined;

function stubFetch(answer: (url: string, body: Body) => [number, unknown]) {
  const calls: Array<{ url: string; body: Body }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { body?: string }) => {
      const body = init.body ? (JSON.parse(init.body) as Body) : undefined;
      calls.push({ url, body });
      const [status, json] = answer(url, body);
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => json,
      };
    })
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("approvePendingKey", () => {
  it("403 PRESENCE_REQUIRED → proves the key, approves again with the page's choices AND the proof", async () => {
    const calls = stubFetch((_url, body) =>
      body?.presence
        ? [200, { ok: true }]
        : [403, { error: "Confirm it is you", code: "PRESENCE_REQUIRED" }]
    );
    let n = 0;
    const prove: ProvePresence = vi.fn(async () => proof(++n));
    await approvePendingKey({
      podUrl: POD,
      keyId: "key-1",
      body: { alsoDisconnect: ["x"] },
      prove,
    });
    expect(prove).toHaveBeenCalledWith(
      { pendingKeyId: "key-1" },
      "PRESENCE_REQUIRED",
      undefined
    );
    expect(calls.map((c) => c.url)).toEqual([
      `${POD}/api/hub/setup/agent/pending/key-1/approve`,
      `${POD}/api/hub/setup/agent/pending/key-1/approve`,
    ]);
    expect(calls[0]!.body).toEqual({ alsoDisconnect: ["x"] });
    expect(calls[1]!.body).toEqual({
      alsoDisconnect: ["x"],
      presence: proof(1),
    });
  });

  it("any other refusal is the page's error, nothing asked", async () => {
    stubFetch(() => [409, { error: "A newer request is waiting" }]);
    const prove: ProvePresence = vi.fn();
    await expect(
      approvePendingKey({ podUrl: POD, keyId: "key-1", prove })
    ).rejects.toThrow("A newer request is waiting");
    expect(prove).not.toHaveBeenCalled();
  });
});

describe("approvePendingKeys", () => {
  it("proves each refused key and resends it alone with presenceByKey", async () => {
    const calls = stubFetch((_url, body) => {
      if (!body?.presenceByKey) {
        return [
          200,
          {
            approved: 1,
            results: [
              { keyId: "a", outcome: "approved" },
              { keyId: "b", outcome: "refused", code: "PRESENCE_REQUIRED" },
              { keyId: "c", outcome: "not_found" },
            ],
          },
        ];
      }
      return [
        200,
        { approved: 1, results: [{ keyId: "b", outcome: "approved" }] },
      ];
    });
    const prove: ProvePresence = vi.fn(async () => proof(1));
    const out = await approvePendingKeys({
      podUrl: POD,
      keyIds: ["a", "b", "c"],
      prove,
    });
    expect(calls[1]!.body).toEqual({
      keyIds: ["b"],
      presenceByKey: { b: proof(1) },
    });
    expect(out).toEqual({
      approved: 2,
      results: [
        { keyId: "a", outcome: "approved" },
        { keyId: "b", outcome: "approved" },
        { keyId: "c", outcome: "not_found" },
      ],
    });
  });
});
