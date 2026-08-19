/**
 * Rules-ecosystem "WHEN" menu — the DECLARED tier (SLICE 2).
 *
 * A capability declares the event patterns it can emit in `metadata.emits`;
 * `availableTriggerEvents` folds them into the menu as `source:"declared"`,
 * outranking `observed`/`catalog` while preserving any discovered `observedCount`.
 * These are PURE-LOGIC tests over the two shared helpers — no Postgres (which is
 * intentionally not required here): the DB read that feeds `foldDeclaredEmits` is
 * a thin `userVisibleWhere`-floored scan whose per-row payload IS the `emits`
 * array these tests supply directly.
 */
import { describe, expect, it } from "vitest";
import { foldDeclaredEmits, type EventOption } from "./automations.js";
import { sanitizeEmitPatterns } from "../services/capabilities/create-from-definition.js";

const MESSAGING = "external_message.received.completed";
const CHANNEL_MSG = "channel_message.created.completed";

describe("foldDeclaredEmits (declared WHEN-menu tier)", () => {
  it("declares a capability's emitted pattern with source:'declared'", () => {
    const byPattern = new Map<string, EventOption>();
    foldDeclaredEmits(byPattern, [MESSAGING]);

    const opt = byPattern.get(MESSAGING);
    expect(opt).toBeDefined();
    expect(opt).toMatchObject({ pattern: MESSAGING, source: "declared" });
    // A real, human label was resolved (not the raw token).
    expect(opt!.label.length).toBeGreaterThan(0);
    expect(opt!.label).not.toBe(MESSAGING);
  });

  it("folds BOTH physical channel message patterns a bridge emits", () => {
    const byPattern = new Map<string, EventOption>();
    foldDeclaredEmits(byPattern, [MESSAGING, CHANNEL_MSG]);
    expect(byPattern.get(MESSAGING)?.source).toBe("declared");
    expect(byPattern.get(CHANNEL_MSG)?.source).toBe("declared");
  });

  it("drops a validator-illegal pattern (never a phantom option)", () => {
    const byPattern = new Map<string, EventOption>();
    foldDeclaredEmits(byPattern, ["bogus.nonsense.zzz", MESSAGING]);
    expect(byPattern.has("bogus.nonsense.zzz")).toBe(false);
    expect(byPattern.has(MESSAGING)).toBe(true);
  });

  it("drops non-string entries", () => {
    const byPattern = new Map<string, EventOption>();
    foldDeclaredEmits(byPattern, [42, null, undefined, {}, MESSAGING]);
    expect(byPattern.size).toBe(1);
    expect(byPattern.has(MESSAGING)).toBe(true);
  });

  it("upgrades an observed pattern to declared, preserving observedCount", () => {
    const byPattern = new Map<string, EventOption>();
    byPattern.set(MESSAGING, {
      pattern: MESSAGING,
      label: "already-labeled",
      source: "observed",
      observedCount: 7,
    });
    foldDeclaredEmits(byPattern, [MESSAGING]);

    const opt = byPattern.get(MESSAGING)!;
    expect(opt.source).toBe("declared");
    expect(opt.observedCount).toBe(7); // observed count survives the upgrade
    expect(opt.label).toBe("already-labeled"); // existing label preserved
  });
});

describe("sanitizeEmitPatterns (applier persistence)", () => {
  it("returns undefined when no emits are declared (leaves existing untouched)", () => {
    expect(sanitizeEmitPatterns(undefined)).toBeUndefined();
  });

  it("preserves an explicit empty declaration as []", () => {
    expect(sanitizeEmitPatterns([])).toEqual([]);
  });

  it("keeps valid patterns, drops invalid, and dedups", () => {
    expect(
      sanitizeEmitPatterns([MESSAGING, "not.a.real.thing.x", MESSAGING])
    ).toEqual([MESSAGING]);
  });
});
