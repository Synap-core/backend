import { describe, expect, it } from "vitest";
import {
  FATE_COPY,
  PROPOSAL_WAIT_REASONS,
  REVIEW_LATER_AFTER_DAYS,
  fateEndsWithSession,
  isReviewLater,
  isSessionBoundDraft,
  proposalFate,
  type ProposalFateInput,
} from "../fate.js";
import { isDocumentEditProposal } from "../intent.js";

const NOW = Date.parse("2026-10-26T12:00:00.000Z");
const DAY = 24 * 3_600_000;
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString();

const row = (over: Partial<ProposalFateInput>): ProposalFateInput => ({
  proposalClass: "objectWork",
  lifetimeHours: null,
  createdAt: at(DAY),
  targetType: "entity",
  proposalType: "update",
  sessionId: null,
  now: NOW,
  ...over,
});

describe("proposalFate — each row names the rule it rules out", () => {
  it("an ephemeral with a lifetime expires at createdAt + lifetime", () => {
    expect(
      proposalFate(row({ proposalClass: "ephemeral", lifetimeHours: 24, createdAt: at(18 * 3_600_000) }))
    ).toEqual({
      kind: "expires",
      expiresAt: new Date(NOW + 6 * 3_600_000).toISOString(),
      orSessionEnd: false,
    });
  });

  it("an ephemeral IN a session goes at the earlier of its clock and the session's end", () => {
    const fate = proposalFate(
      row({ proposalClass: "ephemeral", lifetimeHours: 24, sessionId: "s1" })
    );
    expect(fate).toMatchObject({ kind: "expires", orSessionEnd: true });
  });

  it("a document draft in a session dies with it — even past 7 days", () => {
    // Rules out "review_later first": the close sweep retires it, so the pile
    // would promise a wait that never happens.
    expect(
      proposalFate(
        row({ targetType: "document", proposalType: "section_update", sessionId: "s1", createdAt: at(9 * DAY) })
      )
    ).toEqual({ kind: "dies_with_session" });
  });

  it("a document draft with NO session is plain object work", () => {
    expect(
      proposalFate(row({ targetType: "document", proposalType: "section_update" })).kind
    ).toBe("until_decided");
  });

  it("objectWork untouched past 7 days moves to Review later, since day 7", () => {
    const createdAt = at(9 * DAY);
    expect(proposalFate(row({ createdAt }))).toEqual({
      kind: "review_later",
      since: new Date(Date.parse(createdAt) + REVIEW_LATER_AFTER_DAYS * DAY).toISOString(),
    });
  });

  it("exactly 7 days old is still in the count (strictly greater-than)", () => {
    expect(proposalFate(row({ createdAt: at(7 * DAY) })).kind).toBe("until_decided");
  });

  it.each(["curatorial", "governance", "access", null])(
    "a %s proposal never moves to Review later",
    (proposalClass) => {
      expect(proposalFate(row({ proposalClass, createdAt: at(30 * DAY) })).kind).toBe(
        "until_decided"
      );
    }
  );

  it("an unreadable createdAt starts no clock — it fails toward keeping", () => {
    expect(
      proposalFate(row({ proposalClass: "ephemeral", lifetimeHours: 24, createdAt: "nope" })).kind
    ).toBe("until_decided");
    expect(proposalFate(row({ createdAt: "nope" })).kind).toBe("until_decided");
  });

  it("isReviewLater is the fate, nothing else", () => {
    expect(isReviewLater(row({ createdAt: at(8 * DAY) }))).toBe(true);
    expect(isReviewLater(row({ createdAt: at(6 * DAY) }))).toBe(false);
    expect(
      isReviewLater(row({ proposalClass: "ephemeral", lifetimeHours: 24, createdAt: at(8 * DAY) }))
    ).toBe(false);
  });

  it("isSessionBoundDraft is the one document-edit classifier", () => {
    expect(isSessionBoundDraft).toBe(isDocumentEditProposal);
  });
});

describe("fateEndsWithSession — the close moment's one reading", () => {
  it.each([
    ["a session-bound draft", { kind: "dies_with_session" }, true],
    ["an ask that ends with its session", { kind: "ends_with_session" }, true],
    [
      "an expiry its session's end may come first",
      { kind: "expires", expiresAt: at(-DAY), orSessionEnd: true },
      true,
    ],
    [
      "an expiry with no session",
      { kind: "expires", expiresAt: at(-DAY), orSessionEnd: false },
      false,
    ],
    ["a proposal that waits for a decision", { kind: "until_decided" }, false],
    ["Review later", { kind: "review_later", since: at(DAY) }, false],
    ["no fate stamped", null, false],
  ] as const)("%s", (_n, fate, want) => {
    expect(fateEndsWithSession(fate)).toBe(want);
  });

  it("agrees with proposalFate on a document edit filed in a session", () => {
    const fate = proposalFate(
      row({ targetType: "document", proposalType: "update", sessionId: "s1" })
    );
    expect(fate.kind).toBe("dies_with_session");
    expect(fateEndsWithSession(fate)).toBe(true);
  });
});

describe("FATE_COPY — the Review later fold and the wait reasons", () => {
  it("says the fold's clock in its caption, from the same constant", () => {
    expect(FATE_COPY.reviewLaterCaption).toBe(
      `Untouched for ${REVIEW_LATER_AFTER_DAYS} days · not in your count`
    );
    expect(FATE_COPY.reviewLaterFold(3)).toBe("Review later · 3");
    expect(FATE_COPY.reviewLaterPile).toBe("Review later");
  });

  it("words every wait reason the pod sends, with no em dash", () => {
    for (const reason of PROPOSAL_WAIT_REASONS) {
      expect(FATE_COPY.waitReason[reason]).toMatch(/\S/);
    }
    const strings = Object.values(FATE_COPY).flatMap((v) =>
      typeof v === "function"
        ? [(v as (a: never) => string)("x" as never)]
        : typeof v === "string"
          ? [v]
          : Object.values(v)
    );
    for (const text of strings) expect(text).not.toContain("—");
  });
});
