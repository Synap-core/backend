/**
 * `dateBinding` on a lifecycle option (status-flow W6), validated like
 * `stuckAfterDays`: it survives the authoring parse AND the stored-option
 * mapper (both doors a declaration crosses), a bad value is reported without
 * dropping the option, and a finished (done/lost) option cannot declare one.
 */
import { describe, it, expect } from "vitest";
import { parseLifecycleOptions } from "./lifecycle-model.js";
import { normalizeEnumOptions } from "./property-enum.js";

describe("dateBinding", () => {
  it("is kept on an open/active/paused option, through both mappers", () => {
    const authored = [
      { key: "draft", category: "open" },
      { key: "sent", category: "active", dateBinding: "dueDate" },
      { key: "disputed", category: "paused", dateBinding: "due_date" },
      { key: "paid", category: "done" },
    ];
    const parsed = parseLifecycleOptions(authored);
    expect(parsed.errors).toEqual([]);
    const bound = (os: Array<{ dateBinding?: string }>) =>
      os.map((o) => o.dateBinding);
    expect(bound(parsed.options)).toEqual([
      undefined,
      "dueDate",
      "due_date",
      undefined,
    ]);
    // Stored → read back (the effective read parses the normalized options).
    const stored = normalizeEnumOptions(parsed.options)!;
    expect(bound(stored)).toEqual([
      undefined,
      "dueDate",
      "due_date",
      undefined,
    ]);
    expect(bound(parseLifecycleOptions(stored).options)).toEqual([
      undefined,
      "dueDate",
      "due_date",
      undefined,
    ]);
  });

  it("refuses a bad value or a finished option — and keeps the option", () => {
    const r = parseLifecycleOptions([
      { key: "a", category: "open", dateBinding: "" },
      { key: "b", category: "open", dateBinding: "due date" },
      { key: "c", category: "open", dateBinding: 7 },
      { key: "paid", category: "done", dateBinding: "dueDate" },
    ]);
    expect(r.errors).toHaveLength(4);
    expect(r.errors[3]).toMatch(/cannot be late/);
    expect(r.options.map((o) => o.key)).toEqual(["a", "b", "c", "paid"]);
    expect(r.options.every((o) => o.dateBinding === undefined)).toBe(true);
  });
});
