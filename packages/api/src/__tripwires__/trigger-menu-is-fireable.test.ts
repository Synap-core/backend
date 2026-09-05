import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { isFireableTriggerPattern } from "../routers/automations.js";

/**
 * The trigger menu may only offer patterns that can ACTUALLY reach the matcher.
 *
 * The observed tier of `availableTriggerEvents` reads `events.type` — the audit
 * spine — and used to offer every row in it. For a first-party subject that is
 * not just noise: the pattern can never fire, because the reactor that feeds the
 * matcher hardcodes the phase. A rule stored on `entity.update.requested`
 * reported itself live and silently never ran, which is the same
 * authorable-but-inert class as a WHERE filter the runtime cannot evaluate.
 *
 * It also produced the duplicate rows the founder reported: four phases × one
 * label (`eventLabelFor` reads subject and action, never phase) = "An entity was
 * updated" four times, all four saving the same single pattern.
 *
 * These assertions are pinned to the PRODUCERS' OWN SOURCE, not to remembered
 * facts. If someone teaches the reactor to send a non-`.completed` phase, the
 * source scan below goes red and this policy must be revisited — rather than the
 * menu silently staying narrower than the runtime.
 */
describe("the trigger menu only offers fireable patterns", () => {
  const REPO = path.resolve(__dirname, "../../../..");
  const read = (rel: string) => fs.readFileSync(path.join(REPO, rel), "utf8");

  it("the first-party reactor still hardcodes `.completed`", () => {
    // packages/events/src/side-effects.ts — the ONLY first-party producer of the
    // `automation-trigger-match` queue.
    const src = read("packages/events/src/side-effects.ts");
    const send =
      /automation-trigger-match[\s\S]{0,400}?eventType:\s*`([^`]+)`/.exec(src);
    expect(
      send,
      "the reactor's queue send moved — re-derive this policy"
    ).toBeTruthy();
    expect(
      send![1],
      "The reactor no longer hardcodes `.completed`. If it now forwards the " +
        "real phase, first-party non-completed patterns became fireable and " +
        "`isFireableTriggerPattern` must be widened to match."
    ).toBe("${payload.subjectType}.${payload.action}.completed");
  });

  it("observations still forward their phase RAW", () => {
    // The asymmetry only holds while observations pass `obs.type` through.
    const src = read("packages/api/src/routers/hub-protocol/observations.ts");
    expect(
      /automation-trigger-match[\s\S]{0,300}?eventType:\s*obs\.type/.test(src),
      "Observations no longer forward `obs.type` raw — the reserved phases may " +
        "no longer fire, and the menu should stop offering them."
    ).toBe(true);
  });

  it("drops first-party phases that can never fire", () => {
    for (const phase of ["requested", "validated", "denied", "failed"]) {
      expect(
        isFireableTriggerPattern(`entity.update.${phase}`),
        `entity.update.${phase} cannot reach the matcher and must not be offered`
      ).toBe(false);
    }
  });

  it("keeps the first-party phase that does fire", () => {
    expect(isFireableTriggerPattern("entity.update.completed")).toBe(true);
    expect(
      isFireableTriggerPattern("external_message.received.completed")
    ).toBe(true);
  });

  it("keeps EVERY reserved phase for an observation namespace", () => {
    // These are real and distinct at runtime — collapsing them to `.completed`
    // would destroy a distinction the observation door honours.
    for (const phase of ["validated", "completed", "failed"]) {
      expect(isFireableTriggerPattern(`dev.build.${phase}`)).toBe(true);
      expect(isFireableTriggerPattern(`ci.run.${phase}`)).toBe(true);
    }
  });
});
