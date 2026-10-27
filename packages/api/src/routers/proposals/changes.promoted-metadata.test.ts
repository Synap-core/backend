import { describe, expect, it } from "vitest";
import { buildProposalChanges } from "./changes.js";

/**
 * A promoted `metadata` key (a box declaration, `allowedHosts`) replaces the
 * raw `metadata` row on the review card. Every OTHER key of the bag keeps a
 * row of its own: a `readOnly: true` beside a box declaration makes every
 * agent run of the script automatic, and the person approving it must see it.
 */
describe("buildProposalChanges — a promotion never hides the rest of the bag", () => {
  it("a box skill with readOnly shows the box rows AND the readOnly row", () => {
    const paths = buildProposalChanges(
      {
        name: "chart_csv",
        executionMode: "box",
        metadata: {
          box: { language: "python", packages: [], hosts: [] },
          readOnly: true,
        },
      },
      "create"
    ).map((c) => c.path);
    expect(paths).toContain("metadata.box.runtime");
    expect(paths).toContain("metadata.readOnly");
    expect(paths).not.toContain("metadata");
    expect(paths).not.toContain("metadata.box");
  });

  it("an allowedHosts promotion keeps the other keys as rows too", () => {
    const changes = buildProposalChanges(
      {
        metadata: { allowedHosts: ["api.example.com"], readOnly: true },
      },
      "update"
    );
    expect(changes.map((c) => c.path)).toEqual([
      "metadata.allowedHosts",
      "metadata.readOnly",
    ]);
    expect(changes[1]).toMatchObject({ after: true });
  });
});
