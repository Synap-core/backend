import { describe, it, expect } from "vitest";
import {
  isTemplateNameTwin,
  preferTrackTemplates,
  templateKindFields,
  wantsTrackTemplate,
} from "./template-kind.js";

const TWIN = {
  name: "GRP Business Model Interrogation",
  scope: "session" as const,
};
const TRACK = { name: "Business Model (GRP)", scope: "project" as const };
const OTHER = { name: "Weekly review", scope: "session" as const };

describe("template kind (X1)", () => {
  it("labels rows through the vocabulary door; NULL scope reads as session", () => {
    expect(templateKindFields("project")).toEqual({
      scope: "project",
      templateKind: "Track template",
    });
    expect(templateKindFields(null)).toEqual({
      scope: "session",
      templateKind: "Work template",
    });
  });

  it("the live GRP pair are name twins; unrelated names are not", () => {
    expect(isTemplateNameTwin(TWIN.name, TRACK.name)).toBe(true);
    expect(isTemplateNameTwin(OTHER.name, TRACK.name)).toBe(false);
  });

  it("a project lens or a project/track word asks for tracks", () => {
    expect(wantsTrackTemplate({ projectId: "p" })).toBe(true);
    expect(wantsTrackTemplate({ intentText: "start the GRP track" })).toBe(
      true
    );
    expect(wantsTrackTemplate({ intentText: "GRP interrogation" })).toBe(false);
  });

  it("under a track signal the track template moves above ITS twin only", () => {
    const ranked = [OTHER, TWIN, TRACK];
    expect(preferTrackTemplates(ranked, true)).toEqual([OTHER, TRACK, TWIN]);
  });

  it("without the signal the ranker's order is untouched", () => {
    const ranked = [TWIN, TRACK];
    expect(preferTrackTemplates(ranked, false)).toEqual([TWIN, TRACK]);
  });

  it("never jumps an unrelated session template", () => {
    const ranked = [OTHER, TRACK];
    expect(preferTrackTemplates(ranked, true)).toEqual([OTHER, TRACK]);
  });
});
