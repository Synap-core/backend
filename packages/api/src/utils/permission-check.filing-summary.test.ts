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

describe("buildProposalSummary — close and hand-off name the session too", () => {
  it("a close is named by sessionName over its goal", () => {
    expect(
      buildProposalSummary("focus_session", "update", {
        id: "s",
        sessionName: "Commercial foundations",
        goal: "Map and lock the commercial foundations (ICP, offer and pricing)",
        status: "closed",
      })
    ).toBe('Complete session "Commercial foundations"');
  });

  it("a hand-off is named by sessionName over its goal", () => {
    expect(
      buildProposalSummary("focus_session", "assign_agent", {
        id: "s",
        sessionName: "Commercial foundations",
        goal: "Map and lock the commercial foundations",
        addAgentId: "a",
        agentName: "Worker",
      })
    ).toBe('Hand session "Commercial foundations" to Worker');
  });
});

/**
 * A filing names EVERY place it changes — track step, project, space — in one
 * title (`sessionFilingSummary`), never only the first.
 */
describe("buildProposalSummary — a filing names every place it changes", () => {
  it("project + space", () => {
    expect(
      buildProposalSummary("focus_session", "update", {
        id: "s",
        sessionName: "Shell work",
        projectId: "p",
        projectName: "Synap",
        workspaceId: "w",
        workspaceName: "Builder",
      })
    ).toBe(
      'File session "Shell work" into "Synap" and move it to Space "Builder"'
    );
  });

  it("a space move alone says move, not update", () => {
    expect(
      buildProposalSummary("focus_session", "update", {
        id: "s",
        sessionName: "Shell work",
        workspaceId: "w",
        workspaceName: "Builder",
      })
    ).toBe('Move Session "Shell work" to Space "Builder"');
  });

  it("make it personal", () => {
    expect(
      buildProposalSummary("focus_session", "update", {
        id: "s",
        sessionName: "Shell work",
        workspaceId: null,
      })
    ).toBe('Make session "Shell work" personal');
  });

  it("track + an explicit project the track did not set + space", () => {
    expect(
      buildProposalSummary("focus_session", "update", {
        id: "s",
        sessionName: "Shell work",
        trackId: "t",
        trackName: "Win the first clients",
        stageName: "Pitch",
        projectId: null,
        workspaceId: "w",
        workspaceName: "Builder",
      })
    ).toBe(
      'File "Shell work" into Win the first clients · Pitch and take it out of its project and move it to Space "Builder"'
    );
  });
});
