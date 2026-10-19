import { describe, expect, it } from "vitest";
import { messageAuthor, readingOrder } from "./channel-model";

const msg = (extra: Partial<Parameters<typeof messageAuthor>[0]>) => ({
  id: "m",
  role: "user",
  content: "hi",
  timestamp: "2026-10-19T10:00:00Z",
  ...extra,
});

describe("messageAuthor", () => {
  it("names each kind of writer in plain words", () => {
    expect(messageAuthor(msg({ authorType: "human" }))).toBe("Person");
    expect(messageAuthor(msg({ role: "assistant" }))).toBe("Agent");
    expect(messageAuthor(msg({ authorType: "ai_agent" }))).toBe("Agent");
    expect(messageAuthor(msg({ role: "system" }))).toBe("Synap");
    expect(messageAuthor(msg({ authorType: "bot" }))).toBe("Synap");
  });

  it("names an outside contact by where they wrote from", () => {
    expect(
      messageAuthor(msg({ authorType: "external", externalSource: "whatsapp" }))
    ).toBe("Whatsapp contact");
    expect(messageAuthor(msg({ authorType: "external" }))).toBe(
      "Outside contact"
    );
  });
});

describe("readingOrder", () => {
  it("puts the newest message last without touching the input", () => {
    const newestFirst = [3, 2, 1];
    expect(readingOrder(newestFirst)).toEqual([1, 2, 3]);
    expect(newestFirst).toEqual([3, 2, 1]);
  });
});
