import { describe, expect, it } from "vitest";
import {
  PROPOSAL_END_REASONS,
  proposalEnded,
  proposalEndLine,
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
      supersededBy: "p-new",
      withdrawReason: "A newer version replaces it",
    });
  });

  it("is null for a decided or undecided row", () => {
    expect(proposalEndLine({ status: "approved" })).toBeNull();
    expect(proposalEndLine({ status: "pending" })).toBeNull();
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
