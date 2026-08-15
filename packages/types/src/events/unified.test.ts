import { describe, it, expect } from "vitest";
import {
  validateEventPattern,
  MESSAGE_ALIAS_PATTERNS,
  OBSERVATION_NAMESPACES,
} from "./unified.js";

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

  describe("observation namespaces (unified trigger hop)", () => {
    // The regression this suite exists for — the SECOND occurrence of the exact
    // split `message.received` had. The observations door accepted `dev.commit`
    // and the trigger hop enqueued it verbatim; the runtime matcher matched it
    // fine. But the authoring door rejected `dev.*`, so NO automation able to
    // receive an observation could ever be created. The hop fired into a
    // permanently empty receiver set — a feature that is live, correct at both
    // ends, and unreachable in the middle.
    //
    // Dogfooded: `synap_create_automation` with eventPattern "dev.commit"
    // returned `subject "dev" is not a recognised SubjectType`.
    it.each([...OBSERVATION_NAMESPACES])(
      "accepts an exact + wildcard pattern for the %s namespace",
      (ns) => {
        expect(validateEventPattern(`${ns}.commit`)).toBe(`${ns}.commit`);
        expect(validateEventPattern(`${ns}.*`)).toBe(`${ns}.*`);
      }
    );

    it("accepts a three-segment observation type", () => {
      // Observation types are producer-defined and may carry a third segment
      // (e.g. `ci.workflow_run.success`) — the strict phase vocab must not apply.
      expect(validateEventPattern("ci.workflow_run.success")).toBe(
        "ci.workflow_run.success"
      );
    });

    it("still rejects an UNREGISTERED namespace", () => {
      // The escape hatch is the registered set, not "any dotted string" — an
      // unknown producer must not be able to author a listener for a namespace
      // the observations door would refuse to write.
      expect(() => validateEventPattern("bogus.commit")).toThrow(
        /not a recognised SubjectType/
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
