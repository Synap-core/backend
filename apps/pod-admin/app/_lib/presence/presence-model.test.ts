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
  asksUpFront,
  needsPresence,
  presenceRefusal,
  proveEachUpFront,
  type ProvePresence,
  type PresenceProgress,
  type ProveOptions,
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
      _progress?: PresenceProgress,
      _options?: ProveOptions
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

describe("needsPresence (the pod's own test)", () => {
  it("a sensitive approval or a request filed as the person; nothing else", () => {
    expect(
      needsPresence({ targetType: "agent", proposalType: "connect" })
    ).toBe(true);
    expect(
      needsPresence({ targetType: "entity", proposalType: "delete" })
    ).toBe(true);
    expect(
      needsPresence({
        targetType: "governance_rule",
        proposalType: "governance.widen",
      })
    ).toBe(true);
    expect(
      needsPresence({ targetType: "entity", proposalType: "create" })
    ).toBe(false);
    expect(
      needsPresence({
        targetType: "entity",
        proposalType: "create",
        data: { asPerson: true },
      })
    ).toBe(true);
    expect(needsPresence({})).toBe(false);
  });

  it("W5: a row the pod switched off is not asked; the rest still is", () => {
    const choice = {
      approvalsOff: ["focus_session/dev.deploy_approval", "governance."],
      actionsOff: [],
    };
    const deploy = {
      targetType: "focus_session",
      proposalType: "dev.deploy_approval",
    };
    expect(needsPresence(deploy)).toBe(true);
    expect(needsPresence(deploy, choice)).toBe(false);
    expect(
      needsPresence(
        { targetType: "governance_rule", proposalType: "governance.widen" },
        choice
      )
    ).toBe(false);
    expect(
      needsPresence({ targetType: "entity", proposalType: "delete" }, choice)
    ).toBe(true);
    // Filed as the person: always asked, whatever the pod switched off.
    expect(needsPresence({ ...deploy, data: { asPerson: true } }, choice)).toBe(
      true
    );
    // Unread or failed read: the lists as written.
    expect(needsPresence(deploy, null)).toBe(true);
  });
});

describe("asksUpFront (W5)", () => {
  const choice = { approvalsOff: [], actionsOff: ["apiKeys.create"] };
  it("a switched-off action goes without a proof; others are asked", () => {
    expect(
      asksUpFront({ action: { path: "apiKeys.create", input: {} } }, choice)
    ).toBe(false);
    expect(
      asksUpFront({ action: { path: "apiKeys.rotate", input: {} } }, choice)
    ).toBe(true);
    expect(
      asksUpFront({ action: { path: "apiKeys.create", input: {} } }, null)
    ).toBe(true);
  });
  it("a request a door decides is always asked", () => {
    expect(
      asksUpFront({ request: { kind: "presence_mode", id: "report" } }, choice)
    ).toBe(true);
    expect(asksUpFront({ proposalId: "p1" }, choice)).toBe(true);
  });
});

describe("up front", () => {
  it("a sensitive approval carries its proof on the FIRST try", async () => {
    const { prove } = proofs();
    const attempt = vi.fn(async (presence?: PresenceProof) =>
      presence ? "ok" : "unproved"
    );
    await expect(
      approveWithPresence({
        subject: { proposalId: "p1" },
        prove,
        attempt,
        upFront: true,
      })
    ).resolves.toBe("ok");
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(prove.mock.calls[0]![3]).toEqual({ upFront: true });
  });

  it("when the person cannot prove here (null), it goes without and the pod decides", async () => {
    const attempt = vi.fn(async (presence?: PresenceProof) =>
      presence ? "proved" : "report mode let it through"
    );
    await expect(
      approveWithPresence({
        subject: { proposalId: "p1" },
        prove: async () => null,
        attempt,
        upFront: true,
      })
    ).resolves.toBe("report mode let it through");
  });

  it("declining up front approves nothing", async () => {
    const attempt = vi.fn();
    await expect(
      approveWithPresence({
        subject: { proposalId: "p1" },
        prove: async () => {
          throw new PresenceDeclined("no");
        },
        attempt,
        upFront: true,
      })
    ).rejects.toBeInstanceOf(PresenceDeclined);
    expect(attempt).not.toHaveBeenCalled();
  });

  it("proveEachUpFront: one ask per item with 'n of total'; a null item is left out", async () => {
    let n = 0;
    const prove = vi.fn<ProvePresence>(async () =>
      ++n === 2 ? null : proofOf(n)
    );
    const out = await proveEachUpFront({
      ids: ["a", "b", "c"],
      subjectOf: (id) => ({ proposalId: id }),
      prove,
    });
    expect(Object.keys(out)).toEqual(["a", "c"]);
    expect(prove.mock.calls.map((c) => c[2])).toEqual([
      { index: 1, total: 3 },
      { index: 2, total: 3 },
      { index: 3, total: 3 },
    ]);
  });
});

function proofOf(n: number): PresenceProof {
  return {
    kind: "device_key",
    challengeId: `c${n}`,
    keyId: "k",
    signature: `s${n}`,
  };
}
