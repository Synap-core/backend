import { describe, it, expect } from "vitest";
import {
  readSubjectLifecycle,
  resolveStageRef,
  stageForSubjectStatus,
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
