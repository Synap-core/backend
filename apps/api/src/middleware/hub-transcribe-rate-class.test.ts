/**
 * `POST /api/hub/files/:entityId/transcribe` spends one paid speech-to-text
 * call per request, so it is budgeted in the AI class (`ai_interactive`,
 * 60 / 5 min per key by default), never in `crud` (500 / 15 min).
 *
 * Path-only, like every class but the public doors: the method is not read.
 * Its neighbours (the signed-URL GET, the upload doors) stay in `crud`.
 */
import { describe, it, expect } from "vitest";
import { classifyRateLimitPath } from "./rate-limit-classes.js";

const ID = "6f1c1a52-6b7e-4c7e-9f63-2f0f6a2d8c11";

describe("hub transcription rate class", () => {
  it("classifies the transcribe door on both hub mounts as AI", () => {
    expect(
      classifyRateLimitPath(`/api/hub/files/${ID}/transcribe`, "POST")
    ).toBe("ai_interactive");
    expect(
      classifyRateLimitPath(`/api/hub-protocol/files/${ID}/transcribe`, "POST")
    ).toBe("ai_interactive");
  });

  it("leaves the other /files doors in crud", () => {
    expect(classifyRateLimitPath(`/api/hub/files/${ID}/url`, "GET")).toBe(
      "crud"
    );
    expect(classifyRateLimitPath("/api/hub/files", "POST")).toBe("crud");
    expect(classifyRateLimitPath("/api/hub/files/uploads", "POST")).toBe(
      "crud"
    );
  });
});
