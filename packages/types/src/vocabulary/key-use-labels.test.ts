import { describe, expect, it } from "vitest";
import {
  KEY_USE_LABELS,
  OBJECT_KINDS,
  resolveKeyUseLabel,
  resolveObjectIcon,
  resolveObjectNoun,
  resolveObjectNounPlural,
} from "./index.js";

describe("resolveKeyUseLabel — where a key is used, in words", () => {
  it("names each use", () => {
    expect(resolveKeyUseLabel("hub")).toBe(
      "A program, script or site (Hub API)"
    );
    expect(resolveKeyUseLabel("mcp")).toBe("An AI client over MCP");
    expect(resolveKeyUseLabel("n8n")).toBe("n8n");
    expect(Object.keys(KEY_USE_LABELS)).toEqual([
      "hub",
      "mcp",
      "n8n",
      "n8n-analyze",
      "realtime",
      "chat",
      "skills",
    ]);
  });

  it("humanizes an unknown use instead of leaking it, and is empty for none", () => {
    expect(resolveKeyUseLabel("web_hooks")).toBe("Web hooks");
    expect(resolveKeyUseLabel("")).toBe("");
    expect(resolveKeyUseLabel(null)).toBe("");
  });
});

describe("the Activity noun (the event log, not the calendar)", () => {
  it("is its own kind, apart from the calendar's event", () => {
    expect(resolveObjectNoun("activity")).toBe("Activity");
    expect(resolveObjectNounPlural("activity")).toBe("Activity");
    expect(resolveObjectIcon("activity")).toBe("Activity");
    // The calendar kind is untouched.
    expect(resolveObjectNoun("event")).toBe("Event");
    expect(resolveObjectNounPlural("event")).toBe("Events");
    expect(OBJECT_KINDS.event?.icon).toBe("Calendar");
  });
});
