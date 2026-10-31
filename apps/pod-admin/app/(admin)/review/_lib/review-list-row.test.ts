/**
 * The line under a Review row's title. Under "Group by Work" it opens with
 * the decision the row asks; when the object's kind reads the same word
 * (a Knowledge item in Knowledge), the word is said once.
 */
import { describe, expect, it, vi } from "vitest";
import { secondaryLine } from "./review-list-row";
import type { ReviewRow } from "./review-rows";

vi.mock("next/navigation", () => ({
  usePathname: () => "/review",
  useRouter: () => ({ replace() {}, push() {} }),
  useSearchParams: () => new URLSearchParams(""),
}));

function row(over: Partial<ReviewRow>): ReviewRow {
  return {
    key: "r1",
    package: "knowledge",
    nounKind: "knowledge",
    title: "NEG_REF leaves the tree at the negctl ref",
    who: "Claude Code",
    where: null,
    reason: null,
    count: 1,
    occurredAt: null,
    expiresAt: null,
    expired: false,
    ...over,
  } as ReviewRow;
}

describe("secondaryLine", () => {
  it("says a package and a kind that read the same word once", () => {
    expect(secondaryLine(row({}), { showPackage: true })).toBe(
      "Knowledge · Claude Code"
    );
  });

  it("keeps both when they differ", () => {
    expect(
      secondaryLine(row({ package: "bookkeeping", nounKind: "session" }), {
        showPackage: true,
      })
    ).toBe("Bookkeeping · Job · Claude Code");
  });

  it("leaves the package out under Group by Package", () => {
    expect(secondaryLine(row({}))).toBe("Knowledge · Claude Code");
  });
});
