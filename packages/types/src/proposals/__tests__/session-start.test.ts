/**
 * A run on a playbook starts a session — the ONE classification the pod's
 * display and every renderer read, and the ONE subject reader the approval
 * executor fans out over.
 */
import { describe, expect, it } from "vitest";
import {
  isPlaybookSessionStartProposal,
  readRunSubjectIds,
} from "../session-start.js";

describe("isPlaybookSessionStartProposal", () => {
  it("is a run on a playbook", () => {
    expect(isPlaybookSessionStartProposal({ targetType: "playbook", proposalType: "run" })).toBe(true);
  });
  it("is not an edit of a playbook, nor a run of anything else", () => {
    expect(isPlaybookSessionStartProposal({ targetType: "playbook", proposalType: "update" })).toBe(false);
    expect(isPlaybookSessionStartProposal({ targetType: "capability", proposalType: "run" })).toBe(false);
    expect(isPlaybookSessionStartProposal({ targetType: "automation", proposalType: "run" })).toBe(false);
  });
});

describe("readRunSubjectIds", () => {
  it("reads a batch's subjects, else the one subject", () => {
    expect(readRunSubjectIds({ subjectIds: ["a", "", 3, "b"], subjectId: "a" })).toEqual(["a", "b"]);
    expect(readRunSubjectIds({ subjectId: "a" })).toEqual(["a"]);
    expect(readRunSubjectIds({ params: {} })).toEqual([]);
    expect(readRunSubjectIds(undefined)).toEqual([]);
  });
});
