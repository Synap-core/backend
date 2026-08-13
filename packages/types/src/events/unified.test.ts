import { describe, it, expect } from "vitest";
import { validateEventPattern, MESSAGE_ALIAS_PATTERNS } from "./unified.js";

describe("validateEventPattern", () => {
  describe("message alias (proactive-from-messages trigger)", () => {
    // The regression this suite exists for: `message.received` is the DOCUMENTED
    // cross-transport trigger the runtime matcher (matchesMessageAlias) fires on,
    // but its action segment "received" is outside the CRUD vocab. Before the fix,
    // the authoring door rejected the very pattern proactive-from-messages needs.
    it("accepts every canonical message-alias pattern", () => {
      for (const pattern of MESSAGE_ALIAS_PATTERNS) {
        expect(validateEventPattern(pattern)).toBe(pattern);
      }
    });

    it("accepts the documented `message.received` form specifically", () => {
      expect(validateEventPattern("message.received")).toBe("message.received");
    });

    it("still rejects an unknown action on the message subject", () => {
      // `message` is a real CRUD subject, so only the alias set escapes the
      // strict action check — a bogus verb must still throw.
      expect(() => validateEventPattern("message.frobnicate")).toThrow(
        /not a recognised EventAction/
      );
    });
  });

  describe("connector subjects (domain-verb actions)", () => {
    it("accepts the physical inbound-message events the alias covers", () => {
      expect(validateEventPattern("external_message.received.completed")).toBe(
        "external_message.received.completed"
      );
      expect(validateEventPattern("channel_message.created.completed")).toBe(
        "channel_message.created.completed"
      );
    });
  });

  describe("strict CRUD taxonomy still enforced", () => {
    it("accepts a well-formed CRUD pattern", () => {
      expect(validateEventPattern("entity.create.completed")).toBe(
        "entity.create.completed"
      );
    });

    it("rejects an unknown subject", () => {
      expect(() => validateEventPattern("entities.create.completed")).toThrow(
        /not a recognised SubjectType/
      );
    });

    it("rejects an unknown action on a CRUD subject", () => {
      expect(() => validateEventPattern("entity.frobnicate.completed")).toThrow(
        /not a recognised EventAction/
      );
    });
  });
});
