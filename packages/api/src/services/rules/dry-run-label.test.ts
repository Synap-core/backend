import { describe, it, expect } from "vitest";
import { describeEventType, toPhysicalEvent } from "./dry-run.js";

/**
 * A dry-run sample's `label` is the ONLY user-facing text the replay produces.
 * These pin the two things that make it honest: it is past mood (history, not a
 * button), and no input can make it leak a raw machine token.
 */
describe("describeEventType", () => {
  it("renders the two physical message types the matcher is written against", () => {
    // These two strings are the whole reason `toPhysicalEvent` exists.
    expect(describeEventType("external_message.received.completed")).toBe(
      "External message received"
    );
    expect(describeEventType("channel_message.created.completed")).toBe(
      "Channel message created"
    );
  });

  it("renders the persisted message types", () => {
    expect(describeEventType("message.received")).toBe("Message received");
    expect(describeEventType("message.sent")).toBe("Message sent");
  });

  it("uses PAST mood — a sample is history, never an action to take", () => {
    // `resolveActionLabel("create", "imperative")` is "Create". A sample row
    // saying "Entity create" would describe a button, not a thing that happened.
    const label = describeEventType("entity.create.completed");
    expect(label).toBe("Entity created");
    expect(label).not.toContain("Create ");
  });

  it("drops a trailing `completed` but keeps every other phase", () => {
    expect(describeEventType("entity.create.completed")).toBe("Entity created");
    expect(describeEventType("entity.create.denied")).toBe(
      "Entity created — denied"
    );
    expect(describeEventType("entity.create.requested")).toBe(
      "Entity created — requested"
    );
  });

  it("never leaks a raw token, for any shape it has never seen", () => {
    for (const input of [
      "wholly_unknown.frobnicated.completed",
      "single",
      "a.b",
      "..",
      "",
    ]) {
      const out = describeEventType(input);
      // Words, never the machine string: no dots, no snake_case survivors.
      expect(out).not.toMatch(/[._]/);
      if (input.replace(/\./g, "").length > 0)
        expect(out.length).toBeGreaterThan(0);
    }
  });

  it("a two-segment type keeps its last segment as the verb, not as a phase", () => {
    // "requested" IS a phase token, but with only two segments it is the ACTION.
    // Popping it as a phase would leave "Access" with no verb at all.
    expect(describeEventType("access.requested")).toBe("Access requested");
  });

  /**
   * A sample's label MUST be derived from the physical type the predicate
   * matched, not from the stored type — otherwise the evidence contradicts the
   * count it is evidence for. This proves the two are genuinely different words
   * for the same row, so the choice is load-bearing and not cosmetic.
   */
  it("labels an inbound provider message by what the MATCHER saw", () => {
    const row = {
      type: "message.received",
      data: { externalSource: "gmail" },
    };
    const matchedAs = toPhysicalEvent(row).eventType;
    expect(matchedAs).toBe("external_message.received.completed");
    expect(describeEventType(matchedAs)).toBe("External message received");
    expect(describeEventType(matchedAs)).not.toBe(describeEventType(row.type));
  });
});
