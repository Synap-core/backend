import { describe, it, expect } from "vitest";
import {
  readSubjectLifecycle,
  resolveStageRef,
  stageForSubjectStatus,
  stagesMapSubjectStatus,
  subjectStatusOwner,
} from "./index.js";

const STAGES = [
  { key: "idea", name: "Idea" },
  { key: "draft", name: "Draft", subjectStatus: "drafting" },
  { key: "publish", name: "Publish", subjectStatus: "published" },
];

describe("stage ↔ subject lifecycle helpers", () => {
  it("resolveStageRef: key first, then a case-insensitive name, never a guess", () => {
    expect(resolveStageRef(STAGES, "draft")).toBe("draft");
    expect(resolveStageRef(STAGES, "PUBLISH")).toBe("publish");
    expect(resolveStageRef(STAGES, "nope")).toBeNull();
    expect(resolveStageRef(STAGES, "")).toBeNull();
  });

  it("stageForSubjectStatus: the stage a value corresponds to, or null", () => {
    expect(stageForSubjectStatus(STAGES, "published")).toBe("publish");
    expect(stageForSubjectStatus(STAGES, "idea")).toBeNull();
    expect(stageForSubjectStatus(STAGES, 3)).toBeNull();
  });

  it("stageForSubjectStatus (D2): a status a stage's APPROVED work reaches stands at the NEXT stage", () => {
    const PRODUCE = [
      { key: "brief", name: "Brief" },
      { key: "script", name: "Script", onApproved: "Scripted" },
      {
        key: "draft",
        name: "Draft",
        subjectStatus: "In Draft",
        gate: { kind: "human" },
      },
      {
        key: "review",
        name: "Review",
        subjectStatus: "Review",
        gate: { kind: "human" },
      },
      { key: "schedule", name: "Schedule", onApproved: "Scheduled" },
      {
        key: "publish",
        name: "Publish",
        gate: { kind: "human" },
        onApproved: "Published",
      },
    ];
    expect(stageForSubjectStatus(PRODUCE, "Scripted")).toBe("draft");
    expect(stageForSubjectStatus(PRODUCE, "In Draft")).toBe("draft");
    expect(stageForSubjectStatus(PRODUCE, "Review")).toBe("review");
    expect(stageForSubjectStatus(PRODUCE, "Scheduled")).toBe("publish");
    // The LAST stage's reached status stands on itself (the run does not close).
    expect(stageForSubjectStatus(PRODUCE, "Published")).toBe("publish");
    expect(stageForSubjectStatus(PRODUCE, "Idea")).toBeNull();
    expect(subjectStatusOwner(PRODUCE, "Scripted")).toEqual({
      ownerKey: "script",
      via: "reach",
      standsAt: "draft",
    });
    expect(subjectStatusOwner(PRODUCE, " Review ")).toEqual({
      ownerKey: "review",
      via: "enter",
      standsAt: "review",
    });
  });

  it("a stage that ENTERS a value outranks a LATER stage reaching it; first in order wins", () => {
    const S = [
      { key: "a", onApproved: "x" },
      { key: "b", subjectStatus: "x" },
      { key: "c", subjectStatus: "y" },
      { key: "d", onApproved: "y" },
    ];
    expect(subjectStatusOwner(S, "x")).toMatchObject({
      ownerKey: "a",
      standsAt: "b",
    });
    expect(subjectStatusOwner(S, "y")).toMatchObject({
      ownerKey: "c",
      via: "enter",
    });
  });

  it("stagesMapSubjectStatus: either field ties a run to its subject's lifecycle", () => {
    expect(stagesMapSubjectStatus([{ key: "a", onApproved: "x" }])).toBe(true);
    expect(stagesMapSubjectStatus([{ key: "a", subjectStatus: "x" }])).toBe(
      true
    );
    expect(stagesMapSubjectStatus([{ key: "a" }, null])).toBe(false);
  });

  it("readSubjectLifecycle is tolerant of stored junk", () => {
    expect(
      readSubjectLifecycle({
        profileSlug: "post",
        statusProperty: " post-status ",
        humanOnlyStatuses: ["idea", 4, ""],
      })
    ).toEqual({
      profileSlug: "post",
      statusProperty: "post-status",
      humanOnlyStatuses: ["idea"],
    });
    expect(readSubjectLifecycle(null)).toEqual({
      profileSlug: null,
      statusProperty: null,
      humanOnlyStatuses: [],
    });
  });
});
