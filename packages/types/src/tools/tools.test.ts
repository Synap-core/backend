import { describe, it, expect } from "vitest";
import { normalizeToolName, TOOL_KEY_PATTERN } from "./index.js";

describe("normalizeToolName — the one tool key", () => {
  it("folds case, spacing, accents and punctuation into one key", () => {
    expect(normalizeToolName("Google Calendar")).toBe("google-calendar");
    expect(normalizeToolName("  google   CALENDAR ")).toBe("google-calendar");
    expect(normalizeToolName("Notion.so")).toBe("notion-so");
    expect(normalizeToolName("Évernote")).toBe("evernote");
  });

  it("returns null when nothing usable remains", () => {
    expect(normalizeToolName("!!!")).toBeNull();
    expect(normalizeToolName("   ")).toBeNull();
  });

  it("every produced key satisfies the pattern the Control Plane accepts", () => {
    const long = normalizeToolName(`${"a".repeat(99)} b`);
    expect(long).not.toBeNull();
    expect(TOOL_KEY_PATTERN.test(long!)).toBe(true);
    expect(long!.endsWith("-")).toBe(false);
  });
});
