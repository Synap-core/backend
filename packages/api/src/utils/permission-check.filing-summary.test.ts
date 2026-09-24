import { describe, expect, it } from "vitest";
import { buildProposalSummary } from "./permission-check.js";

/**
 * An agent's FILING proposal says it is a move and names where — not the
 * generic "Update session" a reviewer cannot act on. The payload shape is the
 * one `updateFocusSession` sends (`projectId` + display-only `projectName`),
 * pinned end-to-end in `file-session-into-project.pglite.test.ts`.
 */
describe("buildProposalSummary — filing a session", () => {
  it("names the project it files into", () => {
    expect(
      buildProposalSummary("focus_session", "update", {
        id: "s",
        goal: "Ship the work shell",
        projectId: "p",
        projectName: "Synap",
      })
    ).toBe('File session "Ship the work shell" into "Synap"');
  });

  it("says unfile for a null projectId", () => {
    expect(
      buildProposalSummary("focus_session", "update", {
        id: "s",
        goal: "Ship the work shell",
        projectId: null,
      })
    ).toBe('Unfile session "Ship the work shell"');
  });

  it("an update that does not touch the project keeps its old title", () => {
    expect(
      buildProposalSummary("focus_session", "update", {
        id: "s",
        goal: "Ship the work shell",
        progress: 40,
      })
    ).not.toMatch(/^File|^Unfile/);
  });

  it("a close still reads as a completion even when it carries projectId", () => {
    expect(
      buildProposalSummary("focus_session", "update", {
        id: "s",
        goal: "Ship",
        status: "closed",
        projectId: "p",
      })
    ).toBe('Complete session "Ship"');
  });
});
