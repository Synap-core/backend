import { describe, it, expect } from "vitest";
import {
  NOTIFICATION_EVENT_TYPE_MAP,
  NOTIFICATION_EVENT_SOURCE,
} from "../notification-event-map.js";
import { NOTIFICATION_REGISTRY_MAP } from "../registry.js";

/**
 * The map's KEYS are notification types and its VALUES are event types. Both
 * halves are plain strings, so nothing in the type system stops a typo on
 * either side — and both failure modes are silent.
 *
 * `NotificationDef.type` is deliberately a plain `string` (the registry is an
 * open table, see registry.ts), so there is no union to declare the keys
 * against. This test is that check: a key with no registry entry maps a
 * notification that can never be raised, and reads as coverage while providing
 * none.
 */
describe("NOTIFICATION_EVENT_TYPE_MAP", () => {
  it("every key is a REAL notification type from the registry", () => {
    for (const key of Object.keys(NOTIFICATION_EVENT_TYPE_MAP)) {
      expect(
        NOTIFICATION_REGISTRY_MAP.has(key),
        `"${key}" is mapped to an event type but is not in NOTIFICATION_REGISTRY — ` +
          `it can never be raised, so the mapping is dead`
      ).toBe(true);
    }
  });

  it("no mapped event type ends in `.validated`", () => {
    // `.validated` triggers the materializer's async DB-write hook
    // (setup-event-broadcasting.ts), which exists for ENTITY MUTATIONS. An
    // alert occurrence routed through it would run a materializer over a
    // payload that is not a mutation. The file documents this rule; this
    // enforces it, because the suffix is the whole trigger and a plain
    // `Record<string, string>` accepts it happily.
    for (const [key, eventType] of Object.entries(
      NOTIFICATION_EVENT_TYPE_MAP
    )) {
      expect(
        eventType.endsWith(".validated"),
        `"${key}" maps to "${eventType}" — a \`.validated\` suffix fires the ` +
          `materializer hook. Use ".completed" (a probe observed a terminal ` +
          `state) or ".requested" (something now awaits a human).`
      ).toBe(false);
    }
  });

  it("every mapped event type follows the three-segment spine grammar", () => {
    for (const [key, eventType] of Object.entries(
      NOTIFICATION_EVENT_TYPE_MAP
    )) {
      expect(
        eventType,
        `"${key}" maps to "${eventType}", which is not <domain>.<action>.<phase>`
      ).toMatch(/^[a-z_]+\.[a-z_]+\.(completed|requested)$/);
    }
  });

  it("the event source is the system lane, not a user request", () => {
    expect(NOTIFICATION_EVENT_SOURCE).toBe("system");
  });
});
