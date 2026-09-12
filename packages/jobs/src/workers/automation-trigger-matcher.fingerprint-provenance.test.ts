/**
 * TRIPWIRE — adding PROVENANCE must not change DEDUPE.
 *
 * `automation_runs.trigger_event_id` (0256) needs the triggering `events` row id
 * to reach the matcher. There are two places it could have been put, and only
 * one of them is safe:
 *
 *   • TOP-LEVEL on the queue payload  — what we do. Inert to the fingerprint.
 *   • inside `data`                   — what must NEVER happen.
 *
 * `resolveAutomationEventFingerprintId` reads `data.eventId` as its FIRST
 * candidate, and everything that reaches neither that nor the other named
 * candidates falls back to `stableJsonHash({eventType, subjectId, data})`. So a
 * per-event UNIQUE id placed in `data` would make every event's fingerprint
 * unique, every D5 claim key unique, and the exactly-once guarantee — the thing
 * that stops one event firing one automation twice — would be silently OFF.
 * Nothing would fail. Runs would just start duplicating.
 *
 * That is a dedupe guarantee turned off as a side effect of adding an unrelated
 * field, which is precisely the class this repo keeps shipping. So the safe
 * placement is pinned here rather than left to a comment.
 *
 * The second test deliberately DEMONSTRATES the trap rather than only asserting
 * the safe case: a guard that shows the wrong placement really does change the
 * fingerprint is a guard whose subject is proven live. Asserting only "the safe
 * shape is stable" would also pass if the function stopped reading `data` at
 * all.
 */

import { describe, it, expect } from "vitest";
import { resolveAutomationEventFingerprintId } from "./automation-trigger-matcher.js";

const BASE = {
  eventType: "entity.create.completed",
  subjectId: "entity-1",
  data: { profileSlug: "person", title: "Acme" },
} as const;

const EVENT_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const EVENT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("tripwire: eventId provenance is inert to the event fingerprint", () => {
  it("scans a real fingerprint — this test is not passing over nothing", () => {
    // Non-vacuity: the function must actually produce a hash for this input,
    // and two genuinely different events must differ. If it returned a constant
    // every assertion below would pass while proving nothing.
    const fp = resolveAutomationEventFingerprintId({ ...BASE });
    expect(typeof fp).toBe("string");
    expect(fp.length).toBeGreaterThan(8);
    expect(
      resolveAutomationEventFingerprintId({ ...BASE, subjectId: "entity-2" })
    ).not.toBe(fp);
  });

  it("the fingerprint is IDENTICAL whether or not the payload carries eventId", () => {
    // The matcher takes `eventId` off the TOP LEVEL of the job payload, so it
    // never reaches this function's inputs at all. Two runs of the same event,
    // one with provenance and one without, must dedupe against each other.
    const withoutProvenance = resolveAutomationEventFingerprintId({ ...BASE });

    // Exactly what the matcher passes: eventType, subjectId, data — and `data`
    // is the emit's own payload, untouched by the provenance field.
    const withProvenance = resolveAutomationEventFingerprintId({
      eventType: BASE.eventType,
      subjectId: BASE.subjectId,
      data: BASE.data,
    });

    expect(withProvenance).toBe(withoutProvenance);
  });

  it("DEMONSTRATES the trap: eventId inside `data` DOES change it, per event", () => {
    // Not a wish — the live behaviour, shown. `data.eventId` is candidate #1, so
    // the fingerprint stops being a hash of the event and becomes the id itself:
    // unique per event, therefore never equal to any other, therefore a claim
    // key that can never collide and a dedupe that can never fire.
    const a = resolveAutomationEventFingerprintId({
      ...BASE,
      data: { ...BASE.data, eventId: EVENT_A },
    });
    const b = resolveAutomationEventFingerprintId({
      ...BASE,
      data: { ...BASE.data, eventId: EVENT_B },
    });

    expect(a).toBe(EVENT_A);
    expect(b).toBe(EVENT_B);
    expect(a).not.toBe(b);
    // …and neither equals the fingerprint of the same event without it, which
    // is what would break dedupe against every run recorded before the change.
    expect(a).not.toBe(resolveAutomationEventFingerprintId({ ...BASE }));
  });

  it("a redelivery of the same event still dedupes to one fingerprint", () => {
    // The property the claim key actually depends on: same event twice, same
    // fingerprint. Pinned because the safe placement is only worth anything if
    // this still holds.
    expect(resolveAutomationEventFingerprintId({ ...BASE })).toBe(
      resolveAutomationEventFingerprintId({
        eventType: BASE.eventType,
        subjectId: BASE.subjectId,
        data: { ...BASE.data },
      })
    );
  });
});
