import { describe, expect, it } from "vitest";
import { requiresOf } from "./requires-of.js";

describe("requiresOf: the one read of a playbook's or a step's required tools", () => {
  it("adds the step's list to the playbook's, as a set, step first", () => {
    expect(
      requiresOf(
        { requires: ["media-ffmpeg", "yt-dlp"] },
        { requires: ["whisper", "media-ffmpeg"] }
      )
    ).toEqual(["whisper", "media-ffmpeg", "yt-dlp"]);
  });

  it("reads stored jsonb as data: no list, or entries that are not keys, give nothing", () => {
    expect(requiresOf(null)).toEqual([]);
    expect(requiresOf({ requires: "media-ffmpeg" })).toEqual([]);
    expect(requiresOf({ requires: [1, null, "", "media-ffmpeg"] }, {})).toEqual([
      "media-ffmpeg",
    ]);
  });
});
