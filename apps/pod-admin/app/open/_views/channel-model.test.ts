import { describe, expect, it } from "vitest";
import { resolveObjectNoun } from "@synap-core/types/vocabulary";
import { linkedObjectChip, messageAuthor, readingOrder } from "./channel-model";

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

describe("linkedObjectChip", () => {
  const SID = "11111111-1111-4111-8111-111111111111";

  it("is a door to the object, named by its title", () => {
    expect(
      linkedObjectChip({ type: "session", id: SID, title: "  Ship 0.7.2 " })
    ).toEqual({ objectKind: "session", id: SID, label: "Ship 0.7.2" });
  });

  it("names an object it may not read (no title) by its kind, never a token", () => {
    for (const type of ["session", "entity", "focus_session_x"]) {
      const label = linkedObjectChip({ type, id: SID, title: "  " })?.label;
      expect(label).toBe(resolveObjectNoun(type));
      expect(label).not.toBe(type);
      expect(label).not.toBe("");
    }
  });

  it("draws nothing for a conversation that belongs to nothing", () => {
    expect(linkedObjectChip(null)).toBeNull();
    expect(linkedObjectChip(undefined)).toBeNull();
    expect(
      linkedObjectChip({ type: "session", id: "", title: "x" })
    ).toBeNull();
  });
});
