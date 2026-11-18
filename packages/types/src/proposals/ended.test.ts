import { describe, expect, it } from "vitest";
import {
  PROPOSAL_END_REASONS,
  proposalEnded,
  proposalEndLine,
  proposalItemsLeft,
  proposalWho,
  type ProposalWhoRow,
} from "./ended.js";
import { en, fr } from "./copy.js";
import {
  PROPOSAL_STATUSES,
  UNDECIDED_PROPOSAL_STATUSES,
  isProposalUndecided,
} from "./attention.js";

describe("proposalEnded — the one stamp, else the old keys", () => {
  it("reads the stamp the status door writes", () => {
    expect(
      proposalEnded({
        status: "withdrawn",
        data: {
          ended: {
            reason: "superseded",
            by: "agent",
            at: "2026-11-18T10:00:00.000Z",
            supersededBy: "p-new",
          },
        },
      })
    ).toEqual({
      reason: "superseded",
      by: "agent",
      at: "2026-11-18T10:00:00.000Z",
      supersededBy: "p-new",
    });
  });

  it("is null for a status that did not end with nobody deciding", () => {
    for (const status of PROPOSAL_STATUSES) {
      if (status === "withdrawn" || status === "expired") continue;
      expect(
        proposalEnded({ status, data: { ended: { reason: "lapsed" } } })
      ).toBeNull();
    }
  });

  it("derives an old withdrawn row from the keys each helper wrote", () => {
    const at = new Date("2026-11-01T00:00:00.000Z");
    expect(
      proposalEnded({
        status: "withdrawn",
        data: {
          supersededBy: "p2",
          withdrawReason: "Replaced by a newer version",
        },
        updatedAt: at,
      })
    ).toEqual({
      reason: "superseded",
      by: "system",
      at: at.toISOString(),
      supersededBy: "p2",
    });
    expect(
      proposalEnded({
        status: "withdrawn",
        data: { withdrawReason: "Sent directly", closedByMessageId: "m1" },
      })?.reason
    ).toBe("sent_outside");
    expect(
      proposalEnded({
        status: "withdrawn",
        data: { withdrawnReason: "scope_request_changed" },
      })?.reason
    ).toBe("request_changed");
    expect(
      proposalEnded({
        status: "withdrawn",
        data: { withdrawReason: "not needed" },
        reviewedBy: "u1",
      })
    ).toMatchObject({
      reason: "author",
      by: "person",
      withdrawReason: "not needed",
    });
  });

  it("derives an old expired row; an unknown expiry is its moment passing", () => {
    expect(
      proposalEnded({
        status: "expired",
        data: { expiredBy: "record_landed", supersededByEntityId: "e1" },
      })
    ).toMatchObject({ reason: "record_landed", landedEntityId: "e1" });
    for (const by of ["session_ended", "lifecycle_move", "agent_attached"]) {
      expect(
        proposalEnded({ status: "expired", data: { expiredBy: by } })?.reason
      ).toBe(by);
    }
    expect(
      proposalEnded({
        status: "expired",
        data: { expiredByCleanupPack: "pack1" },
      })?.reason
    ).toBe("cleanup_pack");
    expect(
      proposalEnded({ status: "expired", data: { data: { goalLoopOf: "t1" } } })
        ?.reason
    ).toBe("goal_ended");
    expect(proposalEnded({ status: "expired", data: null })?.reason).toBe(
      "lapsed"
    );
  });

  it("a stamp with an unknown reason falls back to the old keys", () => {
    expect(
      proposalEnded({
        status: "expired",
        data: { ended: { reason: "nope" }, expiredBy: "session_ended" },
      })?.reason
    ).toBe("session_ended");
  });
});

describe("proposalEndLine — one sentence per reason, in each locale", () => {
  it("every reason has its words in English and French", () => {
    for (const reason of PROPOSAL_END_REASONS) {
      if (reason === "author") continue; // names who: its own test below
      const key = `proposals.ended.${reason}` as const;
      expect(en[key]).toBeTruthy();
      expect(fr[key]).toBeTruthy();
      const row = {
        status: "expired",
        data: { ended: { reason, by: "system", at: "2026-11-18T00:00:00Z" } },
      };
      expect(proposalEndLine(row, "en")?.text).toBe(en[key]);
      expect(proposalEndLine(row, "fr")?.text).toBe(fr[key]);
    }
  });

  it("carries the doors and the author's own words", () => {
    expect(
      proposalEndLine(
        {
          status: "withdrawn",
          data: {
            ended: {
              reason: "superseded",
              by: "agent",
              at: "2026-11-18T00:00:00Z",
              supersededBy: "p-new",
              withdrawReason: "A newer version replaces it",
            },
          },
        },
        "en"
      )
    ).toEqual({
      reason: "superseded",
      text: "Replaced by a newer version",
      door: { kind: "proposal", id: "p-new", label: "Open the newer version" },
      supersededBy: "p-new",
      withdrawReason: "A newer version replaces it",
    });
  });

  it("is null for a decided or undecided row", () => {
    expect(proposalEndLine({ status: "approved" })).toBeNull();
    expect(proposalEndLine({ status: "pending" })).toBeNull();
  });

  it("an author's withdrawal names who took it back, never 'whoever'", () => {
    const stamp = (by: string) => ({
      ended: { reason: "author", by, at: "2026-11-18T00:00:00Z" },
    });
    expect(
      proposalEndLine(
        { status: "withdrawn", data: stamp("agent"), agentActorName: "Scout" },
        "en"
      )?.text
    ).toBe("Taken back by Scout");
    expect(
      proposalEndLine(
        {
          status: "withdrawn",
          data: stamp("person"),
          approverName: "Alice",
          agentActorName: "Scout",
        },
        "fr"
      )?.text
    ).toBe("Repris par Alice");
    // An agent's own take-back names no reviewer (F2): still the agent, not Synap.
    expect(
      proposalEndLine(
        { status: "withdrawn", data: stamp("system"), agentActorName: "Scout" },
        "en"
      )?.text
    ).toBe("Taken back by Scout");
    expect(
      proposalEndLine({ status: "withdrawn", data: stamp("person") }, "en")
        ?.text
    ).toBe(en["proposals.ended.authorUnnamed"]);
    for (const line of [en, fr])
      for (const words of Object.values(line))
        expect(words.toLowerCase()).not.toContain("whoever");
  });

  it("names the session, goal and record as doors where the row has their ids", () => {
    const end = (reason: string, over: Record<string, unknown> = {}) =>
      proposalEndLine(
        {
          status: "expired",
          data: { ended: { reason, by: "system", at: "2026-11-18T00:00:00Z" } },
          ...over,
        } as ProposalWhoRow,
        "en"
      );
    expect(end("session_ended", { sessionId: "s1" })?.door).toEqual({
      kind: "session",
      id: "s1",
      label: "Open the session",
    });
    // A stage gate or a hand-off targets its session.
    expect(
      end("agent_attached", {
        sessionId: "s-parent",
        targetType: "focus_session",
        targetId: "s2",
      })?.sessionId
    ).toBe("s2");
    expect(end("lapsed", { sessionId: "s1" })?.sessionId).toBeUndefined();
    expect(end("lapsed", { sessionId: "s1" })?.door).toBeUndefined();
    expect(
      proposalEndLine(
        {
          status: "expired",
          data: {
            ended: { reason: "goal_ended", by: "system", at: "x" },
            data: { goalLoopOf: "g1" },
          },
        },
        "fr"
      )?.door
    ).toEqual({ kind: "track", id: "g1", label: "Ouvrir l’objectif" });
    expect(
      proposalEndLine(
        {
          status: "expired",
          data: { expiredBy: "record_landed", supersededByEntityId: "e1" },
        },
        "en"
      )?.door
    ).toEqual({ kind: "entity", id: "e1", label: "Open the record" });
  });

  it("gives a lapsed request its next step", () => {
    expect(
      proposalEndLine({ status: "expired", data: null }, "en")?.text
    ).toMatch(/Ask again/);
  });
});

describe("a helper's English is never quoted as its author's words", () => {
  it("an app revoke and a consent read as the reason they name", () => {
    expect(
      proposalEnded({
        status: "withdrawn",
        data: {
          ended: {
            reason: "request_changed",
            by: "person",
            at: "x",
            withdrawReason: "The app was revoked.",
          },
        },
      })
    ).toMatchObject({ reason: "app_revoked" });
    expect(
      proposalEnded({
        status: "withdrawn",
        data: {
          ended: {
            reason: "request_changed",
            by: "person",
            at: "x",
            withdrawReason: "Superseded by a new consent.",
          },
        },
      })
    ).toMatchObject({ reason: "superseded" });
    for (const words of [
      "The app was revoked.",
      "Superseded by a new consent.",
      "Nothing in it is left to tidy.",
    ]) {
      const ended = proposalEnded({
        status: "withdrawn",
        data: { withdrawReason: words },
        reviewedBy: "u1",
      });
      expect(ended?.reason).not.toBe("author");
      expect(ended?.withdrawReason).toBeUndefined();
    }
  });

  it("an author's own words are kept, even one that names an object key", () => {
    expect(
      proposalEnded({
        status: "withdrawn",
        data: { withdrawReason: "constructor" },
      })
    ).toMatchObject({ reason: "author", withdrawReason: "constructor" });
  });
});

describe("proposalWho — one who per decided or ended request", () => {
  const row = (over: Record<string, unknown>) =>
    ({ agentActorName: "Scout", ...over }) as ProposalWhoRow;

  it("a person's decision is 'Decided by' them", () => {
    for (const status of ["approved", "rejected", "reverted", "approval_failed"])
      expect(proposalWho(row({ status, approverName: "Alice" }), "en")).toEqual(
        { kind: "decided", name: "Alice", text: "Decided by Alice" }
      );
    expect(
      proposalWho(row({ status: "approved", approverName: "Alice" }), "fr")
        ?.text
    ).toBe("Décidé par Alice");
  });

  it("an auto-approved write credits the standing rule", () => {
    expect(proposalWho(row({ status: "auto_approved" }), "en")).toEqual({
      kind: "rule",
      name: null,
      text: "Approved by a standing rule",
    });
  });

  it("a failed receipt nobody approved names the agent who asked", () => {
    expect(proposalWho(row({ status: "approval_failed" }), "en")).toEqual({
      kind: "asked",
      name: "Scout",
      text: "Asked by Scout",
    });
    expect(
      proposalWho({ status: "approval_failed" }, "en")
    ).toBeNull();
  });

  it("a withdrawal names who withdrew it, from the stamp's by", () => {
    const withdrawn = (by: string, over: Record<string, unknown> = {}) =>
      proposalWho(
        row({
          status: "withdrawn",
          data: { ended: { reason: "superseded", by, at: "x" } },
          ...over,
        }),
        "en"
      );
    expect(withdrawn("agent")?.text).toBe("Withdrawn by Scout");
    expect(withdrawn("person", { approverName: "Alice" })?.text).toBe(
      "Withdrawn by Alice"
    );
    expect(withdrawn("system")).toEqual({
      kind: "withdrawn",
      name: "Synap",
      text: "Withdrawn by Synap",
    });
    // A person ended it and no name was read: nobody is guessed.
    expect(withdrawn("person", { agentActorName: null })).toBeNull();
  });

  it("never says 'Decided by' for an end nobody decided", () => {
    for (const status of ["withdrawn", "expired", "approval_failed"]) {
      const who = proposalWho(
        row({ status, data: { ended: { reason: "lapsed", by: "system", at: "x" } } }),
        "en"
      );
      expect(who?.kind).not.toBe("decided");
      expect(who?.text ?? "").not.toMatch(/Decided/);
    }
  });

  it("an expiry and a pending request name nobody", () => {
    expect(
      proposalWho(row({ status: "expired", approverName: "Alice" }), "en")
    ).toBeNull();
    expect(proposalWho(row({ status: "pending" }), "en")).toBeNull();
  });
});

describe("proposalItemsLeft — what a failed plan could not roll back", () => {
  it("reads the compensation report, defensively", () => {
    expect(
      proposalItemsLeft({
        planFailure: {
          compensation: {
            notCompensated: [
              { kind: "entity", id: "e1", reason: "boom" },
              { kind: "session", id: "s1" },
              { kind: "", id: "x" },
              "junk",
            ],
          },
        },
      })
    ).toEqual([
      { kind: "entity", id: "e1" },
      { kind: "session", id: "s1" },
    ]);
    expect(proposalItemsLeft(null)).toEqual([]);
    expect(proposalItemsLeft({ planFailure: {} })).toEqual([]);
  });
});

describe("isProposalUndecided — the one predicate", () => {
  it("pending and a failed approval are undecided, in any case", () => {
    expect([...UNDECIDED_PROPOSAL_STATUSES]).toEqual([
      "pending",
      "approval_failed",
    ]);
    expect(isProposalUndecided("pending")).toBe(true);
    expect(isProposalUndecided(" APPROVAL_FAILED ")).toBe(true);
  });

  it("every other status, an unknown one and none are not", () => {
    for (const status of PROPOSAL_STATUSES) {
      if (status === "pending" || status === "approval_failed") continue;
      expect(isProposalUndecided(status)).toBe(false);
    }
    expect(isProposalUndecided("validated")).toBe(false);
    expect(isProposalUndecided(null)).toBe(false);
    expect(isProposalUndecided(undefined)).toBe(false);
  });
});
