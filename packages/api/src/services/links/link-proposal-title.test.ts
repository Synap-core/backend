/**
 * A link proposal's name is words, never the edge's machine form — the
 * receipt session named after `session --blocked_by--> session` read
 * "session session" (dogfood e3c39721 §4). Driven through the receipt title
 * builder too, so the seam the defect lived in is the one asserted.
 */
import { describe, it, expect } from "vitest";
import { buildDerivedSessionTitle } from "@synap-core/types/focus-sessions";
import { buildObjectActionTitle } from "@synap-core/types/vocabulary";
import { linkProposalTitle } from "./link-proposal-title.js";

describe("linkProposalTitle", () => {
  it("names a dependency edge in words", () => {
    expect(
      linkProposalTitle({
        fromType: "session",
        linkType: "blocked_by",
        toType: "session",
      })
    ).toBe("Session blocked by session");
  });

  it("an unknown edge humanizes, never leaks its token", () => {
    const title = linkProposalTitle({
      fromType: "entity",
      linkType: "made_up_edge",
      toType: "tool",
    });
    expect(title).not.toMatch(/--|_|>/);
  });

  it("the receipt session it names reads as words, not 'session session'", () => {
    const name = linkProposalTitle({
      fromType: "session",
      linkType: "blocked_by",
      toType: "session",
    });
    const proposalTitle = buildObjectActionTitle({
      action: "create",
      objectKind: "link",
      objectName: name,
    });
    expect(
      buildDerivedSessionTitle({ kind: "receipt", doing: proposalTitle })
    ).toBe("Session blocked by session");
  });
});
