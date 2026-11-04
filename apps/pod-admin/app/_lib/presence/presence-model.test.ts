/**
 * The proof-of-presence retry (W3): an approval the pod refuses for its proof
 * is proved and sent again with that proof; any other failure is the door's
 * own; a refused proof is never resent; a declined batch item stops the asks.
 */
import { describe, expect, it, vi } from "vitest";
import type {
  PresenceProof,
  PresenceRefusalCode,
} from "@synap-core/types/presence";
import {
  MAX_PROOFS,
  PresenceDeclined,
  PresenceRefusedError,
  approveEachWithPresence,
  approveWithPresence,
  presenceRefusal,
  type PresenceProgress,
  type PresenceSubject,
} from "./presence-model";

/** A tRPC client error as `init-trpc.ts` shapes a presence refusal. */
function trpcRefusal(reasonCode: string, code = "FORBIDDEN") {
  return Object.assign(new Error("Confirm it is you"), {
    data: { code, reasonCode, proposalId: "p1" },
  });
}

function proofs() {
  let n = 0;
  const asked: Array<{ subject: PresenceSubject; refusal: string }> = [];
  const prove = vi.fn(
    async (
      subject: PresenceSubject,
      refusal: PresenceRefusalCode,
      _progress?: PresenceProgress
    ): Promise<PresenceProof> => {
      asked.push({ subject, refusal });
      n += 1;
      return {
        kind: "device_key",
        challengeId: `c${n}`,
        keyId: "k",
        signature: `s${n}`,
      };
    }
  );
  return { prove, asked };
}

describe("presenceRefusal", () => {
  it("reads a tRPC refusal's reasonCode and a REST refusal's code", () => {
    expect(presenceRefusal(trpcRefusal("PRESENCE_REQUIRED"))).toBe(
      "PRESENCE_REQUIRED"
    );
    expect(
      presenceRefusal(new PresenceRefusedError("PRESENCE_USED", "used"))
    ).toBe("PRESENCE_USED");
  });

  it("is null for any other refusal", () => {
    expect(presenceRefusal(trpcRefusal("REVIEW_ON_ITS_PAGE"))).toBeNull();
    expect(presenceRefusal(new Error("boom"))).toBeNull();
    expect(presenceRefusal(null)).toBeNull();
  });
});

describe("approveWithPresence", () => {
  it("an approval the pod takes needs no proof", async () => {
    const { prove } = proofs();
    const attempt = vi.fn(async () => "ok");
    await expect(
      approveWithPresence({ subject: { proposalId: "p1" }, prove, attempt })
    ).resolves.toBe("ok");
    expect(prove).not.toHaveBeenCalled();
    expect(attempt).toHaveBeenCalledWith(undefined);
  });

  it("PRESENCE_REQUIRED → asks for THIS subject, approves again with the proof", async () => {
    const { prove, asked } = proofs();
    const attempt = vi.fn(async (presence?: PresenceProof) => {
      if (!presence) throw trpcRefusal("PRESENCE_REQUIRED");
      return presence.challengeId;
    });
    await expect(
      approveWithPresence({
        subject: { pendingKeyId: "key-1" },
        prove,
        attempt,
      })
    ).resolves.toBe("c1");
    expect(asked).toEqual([
      { subject: { pendingKeyId: "key-1" }, refusal: "PRESENCE_REQUIRED" },
    ]);
  });

  it("a refused proof is never resent: a new one is asked, saying why", async () => {
    const { prove, asked } = proofs();
    const sent: Array<string | undefined> = [];
    const attempt = vi.fn(async (presence?: PresenceProof) => {
      sent.push(presence?.challengeId);
      if (!presence) throw trpcRefusal("PRESENCE_REQUIRED");
      if (presence.challengeId === "c1") throw trpcRefusal("PRESENCE_EXPIRED");
      return "ok";
    });
    await approveWithPresence({
      subject: { proposalId: "p1" },
      prove,
      attempt,
    });
    expect(sent).toEqual([undefined, "c1", "c2"]);
    expect(asked.map((a) => a.refusal)).toEqual([
      "PRESENCE_REQUIRED",
      "PRESENCE_EXPIRED",
    ]);
  });

  it("stops after MAX_PROOFS refused proofs, with the pod's refusal", async () => {
    const { prove } = proofs();
    const attempt = vi.fn(async () => {
      throw trpcRefusal("PRESENCE_INVALID");
    });
    await expect(
      approveWithPresence({ subject: { proposalId: "p1" }, prove, attempt })
    ).rejects.toMatchObject({ data: { reasonCode: "PRESENCE_INVALID" } });
    expect(prove).toHaveBeenCalledTimes(MAX_PROOFS);
    expect(attempt).toHaveBeenCalledTimes(MAX_PROOFS + 1);
  });

  it("any other failure is thrown as is, nothing asked", async () => {
    const { prove } = proofs();
    const conflict = trpcRefusal("STALE", "CONFLICT");
    await expect(
      approveWithPresence({
        subject: { proposalId: "p1" },
        prove,
        attempt: async () => {
          throw conflict;
        },
      })
    ).rejects.toBe(conflict);
    expect(prove).not.toHaveBeenCalled();
  });

  it("the person declining is the approval's failure: nothing sent again", async () => {
    const declined = new PresenceDeclined("Not approved");
    const attempt = vi.fn(async () => {
      throw trpcRefusal("PRESENCE_REQUIRED");
    });
    await expect(
      approveWithPresence({
        subject: { proposalId: "p1" },
        prove: async () => {
          throw declined;
        },
        attempt,
      })
    ).rejects.toBe(declined);
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});

interface Item {
  id: string;
  ok: boolean;
  code?: string;
}

const refusalOf = (r: Item) =>
  !r.ok && r.code?.startsWith("PRESENCE_")
    ? { id: r.id, code: r.code as PresenceRefusalCode }
    : null;

describe("approveEachWithPresence", () => {
  it("proves and resends each refused item alone, in place, with 'n of total'", async () => {
    const { prove } = proofs();
    const retryOne = vi.fn(
      async (id: string, presence: PresenceProof): Promise<Item> => ({
        id,
        ok: presence.challengeId.startsWith("c"),
      })
    );
    const out = await approveEachWithPresence<Item>({
      results: [
        { id: "a", ok: true },
        { id: "b", ok: false, code: "PRESENCE_REQUIRED" },
        { id: "c", ok: false, code: "NOT_FOUND" },
        { id: "d", ok: false, code: "PRESENCE_REQUIRED" },
      ],
      refusalOf,
      subjectOf: (id) => ({ proposalId: id }),
      prove,
      retryOne,
    });
    expect(out).toEqual([
      { id: "a", ok: true },
      { id: "b", ok: true },
      { id: "c", ok: false, code: "NOT_FOUND" },
      { id: "d", ok: true },
    ]);
    expect(retryOne.mock.calls.map((c) => c[0])).toEqual(["b", "d"]);
    expect(prove.mock.calls.map((c) => c[2])).toEqual([
      { index: 1, total: 2 },
      { index: 2, total: 2 },
    ]);
  });

  it("a declined item stops the asks; the rest stay as the pod answered", async () => {
    const prove = vi.fn(async () => {
      throw new PresenceDeclined("no");
    });
    const retryOne = vi.fn();
    const results: Item[] = [
      { id: "b", ok: false, code: "PRESENCE_REQUIRED" },
      { id: "d", ok: false, code: "PRESENCE_REQUIRED" },
    ];
    const out = await approveEachWithPresence<Item>({
      results,
      refusalOf,
      subjectOf: (id) => ({ proposalId: id }),
      prove,
      retryOne,
    });
    expect(out).toEqual(results);
    expect(prove).toHaveBeenCalledTimes(1);
    expect(retryOne).not.toHaveBeenCalled();
  });

  it("an item refused again is asked again, never past MAX_PROOFS", async () => {
    const { prove } = proofs();
    const retryOne = vi.fn(async (id: string): Promise<Item> => ({
      id,
      ok: false,
      code: "PRESENCE_USED",
    }));
    await approveEachWithPresence<Item>({
      results: [{ id: "b", ok: false, code: "PRESENCE_REQUIRED" }],
      refusalOf,
      subjectOf: (id) => ({ proposalId: id }),
      prove,
      retryOne,
    });
    expect(prove).toHaveBeenCalledTimes(MAX_PROOFS);
    expect(prove.mock.calls[1]![1]).toBe("PRESENCE_USED");
  });
});
