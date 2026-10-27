import { describe, expect, it } from "vitest";
import { buildProposalSummary } from "./permission-check.js";

/**
 * The sentence a person approves for a box skill says it runs on their
 * computer, with its packages and hosts. A declaration that does not parse
 * keeps the "runs on your computer" clause: a failed read is not "nothing to
 * say".
 */
describe("buildProposalSummary — a box skill", () => {
  it("names the packages and the hosts", () => {
    expect(
      buildProposalSummary("skill", "create", {
        name: "chart_csv",
        executionMode: "box",
        metadata: {
          box: {
            language: "python",
            packages: [{ name: "pandas", version: "2.2.3" }],
            hosts: ["api.example.com"],
          },
        },
      })
    ).toContain(
      "runs on your computer in a box (python, pandas==2.2.3; may reach api.example.com"
    );
  });

  it("an unreadable declaration still says it runs on your computer", () => {
    expect(
      buildProposalSummary("skill", "create", {
        name: "chart_csv",
        executionMode: "box",
        metadata: { box: { language: "cobol" } },
      })
    ).toContain(
      "runs on your computer in a box (its declaration could not be read)"
    );
  });
});
