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

  it("there are still exactly TWO producers of the match queue", () => {
    // The whole policy rests on knowing every producer. The test below asserted
    // one file's behaviour while its comment claimed that file was "the ONLY
    // first-party producer" — nothing pinned the uniqueness, so a third
    // producer could appear and the menu would silently be wrong about it.
    const sends: string[] = [];
    const walk = (dir: string): void => {
      const full = path.join(REPO, dir);
      if (!fs.existsSync(full)) return;
      for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(rel);
        else if (/\.ts$/.test(entry.name) && !entry.name.includes(".test.")) {
          const body = read(rel);
          // A SEND, not a mention.
          if (/\.send\(\s*["'`]automation-trigger-match["'`]/.test(body)) {
            sends.push(rel);
          }
        }
      }
    };
    for (const root of [
      "packages/events/src",
      "packages/api/src",
      "packages/jobs/src",
    ]) {
      walk(root);
    }
    expect(
      sends.sort(),
      "A producer of `automation-trigger-match` was added or removed. The " +
        "menu's phase policy is derived from what these producers can send — " +
        "re-derive `isFireableTriggerPattern` before changing this."
    ).toEqual([
      "packages/api/src/routers/hub-protocol/observations.ts",
      "packages/events/src/side-effects.ts",
    ]);
  });

  it("the first-party reactor still hardcodes `.completed`", () => {
    const src = read("packages/events/src/side-effects.ts");
    // ⚠️ Anchored on the SEND, not the first mention of the queue name — which
    // is the reactor's own `id:` field several lines earlier. The previous
    // regex reached the right `eventType` only by adjacency; a reordered
    // object would have made it read the wrong thing.
    const send =
      /\.send\(\s*["'`]automation-trigger-match["'`][\s\S]{0,400}?eventType:\s*`([^`]+)`/.exec(
        src
      );
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

  it("offers a PHASE-LESS observation type, which is the shape they have", () => {
    // ⚠️ This used to assert that `dev.build.validated` is offered, "keeping
    // every reserved phase" — pinning a shape that CANNOT EXIST as an
    // assertion. `observations.ts:169` refines with
    // `!RESERVED_PHASES.some((p) => t.endsWith(p))`: an observation type may
    // not end in a lifecycle phase, because "an observation reports a fact, it
    // never asserts an outcome". So the real shape is `dev.commit`, and the
    // reason the namespace allowlist (not a `.completed` check) is correct is
    // that these types carry no phase at all.
    expect(isFireableTriggerPattern("dev.commit")).toBe(true);
    expect(isFireableTriggerPattern("ci.run")).toBe(true);
    expect(isFireableTriggerPattern("dev.build.something")).toBe(true);
  });

  it("the observation door still REFUSES a reserved phase", () => {
    // If this ever stops holding, the menu policy above must be revisited —
    // a phase-bearing observation type would become recordable and the
    // namespace allowlist would start offering shapes nobody has thought about.
    const src = fs.readFileSync(
      path.join(REPO, "packages/api/src/routers/hub-protocol/observations.ts"),
      "utf8"
    );
    expect(
      /RESERVED_PHASES\.some\(\(p\) => t\.endsWith\(p\)\)/.test(src),
      "observations no longer refuse reserved phases — re-derive the menu policy"
    ).toBe(true);
  });
});
