/**
 * `stuckAfterDays` on a lifecycle option (surfaces W1.5): it survives the
 * authoring parse AND the stored-option mapper (both doors a declaration
 * crosses), a bad value is reported without dropping the option, and a
 * finished (done/lost) option cannot declare one.
 */
import { describe, it, expect } from "vitest";
import {
  parseLifecycleOptions,
  isStuckAfterDays,
  STUCK_AFTER_DAYS_MAX,
} from "./lifecycle-model.js";
import { normalizeEnumOptions } from "./property-enum.js";

describe("stuckAfterDays", () => {
  it("is kept on an open/active/paused option, through both mappers", () => {
    const authored = [
      { key: "draft", category: "open", stuckAfterDays: 7 },
      { key: "review", category: "active", stuckAfterDays: 3 },
      { key: "won", category: "done" },
    ];
    const parsed = parseLifecycleOptions(authored);
    expect(parsed.errors).toEqual([]);
    expect(parsed.options.map((o) => o.stuckAfterDays)).toEqual([
      7,
      3,
      undefined,
    ]);
    // Stored → read back (the effective read parses the normalized options).
    const stored = normalizeEnumOptions(parsed.options);
    expect(stored?.map((o) => o.stuckAfterDays)).toEqual([7, 3, undefined]);
    expect(
      parseLifecycleOptions(stored).options.map((o) => o.stuckAfterDays)
    ).toEqual([7, 3, undefined]);
  });

  it("refuses a bad value or a finished option — and keeps the option", () => {
    const r = parseLifecycleOptions([
      { key: "a", category: "open", stuckAfterDays: 0 },
      { key: "b", category: "open", stuckAfterDays: 2.5 },
      { key: "c", category: "open", stuckAfterDays: "7" },
      { key: "won", category: "done", stuckAfterDays: 5 },
    ]);
    expect(r.errors).toHaveLength(4);
    expect(r.errors[3]).toMatch(/cannot be stuck/);
    expect(r.options.map((o) => o.key)).toEqual(["a", "b", "c", "won"]);
    expect(r.options.every((o) => o.stuckAfterDays === undefined)).toBe(true);
  });

  it("bounds", () => {
    expect(isStuckAfterDays(1)).toBe(true);
    expect(isStuckAfterDays(STUCK_AFTER_DAYS_MAX)).toBe(true);
    expect(isStuckAfterDays(STUCK_AFTER_DAYS_MAX + 1)).toBe(false);
  });
});
