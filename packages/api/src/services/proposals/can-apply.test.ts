/**
 * `proposalCannotApply`, the one filing check (plan 8032a127 D1): how it
 * finds a kind's entry, reads the payload the approval reads, and files as
 * before on a read that fails. The door wiring is
 * `can-apply.pglite.test.ts`; the entries' approval twins are tripwire
 * `filing-and-approval-share-the-check`.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { TRPCError } from "@trpc/server";

const h = vi.hoisted(() => ({
  playbook: async (_c: string, _p: Record<string, unknown>): Promise<void> => {},
  seen: [] as Array<{ changeType: string; payload: Record<string, unknown> }>,
}));

vi.mock("../../routers/playbooks.js", () => ({
  assertRevisedPlaybookPayload: async (
    changeType: string,
    payload: Record<string, unknown>
  ) => {
    h.seen.push({ changeType, payload });
    return h.playbook(changeType, payload);
  },
}));

const {
  proposalCannotApply,
  isCheckedProposalKind,
  filingRefusalOf,
  ProposalCannotApplyError,
} = await import("./can-apply.js");

const base = {
  targetId: "00000000-0000-4000-8000-000000000001",
  userId: "human-1",
  workspaceId: null,
};

describe("proposalCannotApply", () => {
  beforeEach(() => {
    h.seen.length = 0;
    h.playbook = async () => {};
  });

  it("reads the envelope's inner payload, as the approval does", async () => {
    await proposalCannotApply({
      ...base,
      targetType: "playbook",
      proposalType: "update",
      data: { targetType: "playbook", changeType: "update", data: { id: "p" } },
    });
    expect(h.seen).toEqual([{ changeType: "update", payload: { id: "p" } }]);
  });

  it("a definition the approval refuses is refused, with its sentence", async () => {
    h.playbook = async () => {
      throw new TRPCError({ code: "BAD_REQUEST", message: "stages: bad" });
    };
    expect(
      await proposalCannotApply({
        ...base,
        targetType: "playbook",
        proposalType: "create",
        data: { data: { name: "x" } },
      })
    ).toEqual({ reasonCode: "INVALID_PLAYBOOK", message: "stages: bad" });
  });

  it("a read that FAILS files as before: never refused on a fact not read", async () => {
    h.playbook = async () => {
      throw new Error("connection terminated");
    };
    expect(
      await proposalCannotApply({
        ...base,
        targetType: "playbook",
        proposalType: "update",
        data: { data: { id: "p" } },
      })
    ).toBeNull();
    expect(h.seen).toHaveLength(1);
  });

  it("a flat payload is read as it is (a command)", async () => {
    expect(
      await proposalCannotApply({
        ...base,
        targetType: "command",
        proposalType: "execute",
        data: { command: "rm -rf /" },
      })
    ).toMatchObject({ reasonCode: "COMMAND_REFUSED" });
  });

  it("a kind with no entry files as before, and a revision of it is not judged", async () => {
    expect(
      await proposalCannotApply({
        ...base,
        targetType: "entity",
        proposalType: "create",
        data: { data: { title: "x" } },
      })
    ).toBeNull();
    expect(isCheckedProposalKind("entity", "create")).toBe(false);
  });

  it("is keyed like the approve executors: exact key, then the bare type", () => {
    expect(isCheckedProposalKind("playbook", "update")).toBe(true);
    // `capability.run` is registered under the bare proposal type.
    expect(isCheckedProposalKind("capability", "capability.run")).toBe(true);
    expect(isCheckedProposalKind("playbook", "run")).toBe(false);
  });
});

describe("the refusal a filing throws", () => {
  it("is a BAD_REQUEST that carries its code, and only it is read back", () => {
    const err = new ProposalCannotApplyError({
      reasonCode: "UNKNOWN_RECIPE",
      message: "no such recipe",
    });
    expect(err.code).toBe("BAD_REQUEST");
    expect(filingRefusalOf(err)).toEqual({
      reasonCode: "UNKNOWN_RECIPE",
      message: "no such recipe",
    });
    expect(
      filingRefusalOf(new TRPCError({ code: "BAD_REQUEST", message: "x" }))
    ).toBeNull();
    expect(filingRefusalOf(new Error("x"))).toBeNull();
  });
});
