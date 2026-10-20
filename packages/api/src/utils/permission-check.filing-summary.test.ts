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

/**
 * A session update names its session by the display-only `sessionName` its
 * door resolved (`session-update-goal.ts`), never by a goal it may be
 * changing — the payload carries `goal` only for a real goal change.
 */
describe("buildProposalSummary — a session update names the session", () => {
  it("a project filing uses sessionName over a changing goal", () => {
    expect(
      buildProposalSummary("focus_session", "update", {
        id: "s",
        sessionName: "Commercial foundations",
        goal: "A new goal being proposed",
        previousGoal: "The old goal",
        projectId: "p",
        projectName: "Launch",
      })
    ).toBe('File session "Commercial foundations" into "Launch"');
  });

  it("a track filing with no goal in the payload still names the session", () => {
    expect(
      buildProposalSummary("focus_session", "update", {
        id: "s",
        sessionName: "Commercial foundations",
        trackId: "t",
        trackName: "Win the first clients",
      })
    ).toBe('File "Commercial foundations" into Win the first clients');
  });

  it("a plain update is named by sessionName, not by a rename's new title", () => {
    expect(
      buildProposalSummary("focus_session", "update", {
        id: "s",
        sessionName: "Commercial foundations",
        title: "Revenue apps",
        progress: 40,
      })
    ).toContain('"Commercial foundations"');
  });
});
