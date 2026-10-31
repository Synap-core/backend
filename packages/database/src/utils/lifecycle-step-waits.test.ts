/**
 * `waits` on a lifecycle option (status foundation decision 1, PR-B): a step
 * declares what it waits on. Validated like `dateBinding`: it survives the
 * authoring parse AND the stored-option mapper (both doors a declaration
 * crosses), a bad value is reported without dropping the option, and a
 * finished (done/lost) option cannot declare one.
 *
 * PARITY: every field of `LifecycleOption` (`@synap-core/types/lifecycle`)
 * survives the stored-option mapper. A field the mapper does not know is
 * silently stripped from every stored option: that gap is why `dateBinding`
 * never reached a template.
 */
import { describe, it, expect } from "vitest";
import type {
  LifecycleOption,
  LifecycleOptionWaits,
} from "@synap-core/types/lifecycle";
import { parseLifecycleOptions } from "./lifecycle-model.js";
import { normalizeEnumOptions } from "./property-enum.js";

describe("waits", () => {
  it("is kept on an open/active/paused option, through both mappers", () => {
    const authored = [
      { key: "draft", category: "open" },
      {
        key: "sent",
        category: "active",
        waits: { on: "person", waitKind: "their_reply", refFrom: "contactId" },
      },
      {
        key: "nurturing",
        category: "paused",
        waits: { on: "date", dateBinding: "nextActionAt" },
      },
      { key: "won", category: "done" },
    ];
    const parsed = parseLifecycleOptions(authored);
    expect(parsed.errors).toEqual([]);
    const waits = (os: Array<{ waits?: unknown }>) => os.map((o) => o.waits);
    const expected = [
      undefined,
      { on: "person", waitKind: "their_reply", refFrom: "contactId" },
      { on: "date", dateBinding: "nextActionAt" },
      undefined,
    ];
    expect(waits(parsed.options)).toEqual(expected);
    // Stored → read back (the effective read parses the normalized options).
    const stored = normalizeEnumOptions(parsed.options)!;
    expect(waits(stored)).toEqual(expected);
    expect(waits(parseLifecycleOptions(stored).options)).toEqual(expected);
  });

  it("a bad wait is reported, and the option stays", () => {
    const cases: Array<[unknown, RegExp]> = [
      ["person", /waits must be an object/],
      [{ on: "client" }, /waits\.on must be one of/],
      [{ on: "unspecified" }, /waits\.on must be one of/],
      [
        { on: "person", waitKind: "kind" },
        /waits\.waitKind is not a wait kind/,
      ],
      [{ on: "person", refFrom: "not a slug" }, /waits\.refFrom must name/],
      [{ on: "date", dateBinding: 7 }, /waits\.dateBinding must name/],
      [{ on: "person", kind: "their_reply" }, /unknown field\(s\): kind/],
    ];
    for (const [waits, message] of cases) {
      const parsed = parseLifecycleOptions([
        { key: "sent", category: "active", waits },
      ]);
      expect(parsed.errors.join(" ")).toMatch(message);
      expect(parsed.options.map((o) => o.key)).toEqual(["sent"]);
      expect(parsed.options[0]!.waits).toBeUndefined();
    }
  });

  it("a finished option waits on nothing", () => {
    for (const category of ["done", "lost"]) {
      const parsed = parseLifecycleOptions([
        { key: "x", category, waits: { on: "person" } },
      ]);
      expect(parsed.errors.join(" ")).toMatch(/waits on nothing/);
      expect(parsed.options[0]!.waits).toBeUndefined();
    }
  });
});

describe("parity: every LifecycleOption field survives the stored mapper", () => {
  it("a fully authored option comes back whole", () => {
    const waits: LifecycleOptionWaits = {
      on: "external",
      waitKind: "signature",
      refFrom: "signerId",
      dateBinding: "sentAt",
    };
    // Typed by EVERY field: a field added to `LifecycleOption` without a
    // value here stops the build, and then this test reads whether the
    // mapper keeps it.
    const full: Required<LifecycleOption> = {
      key: "sent",
      label: "Contract sent",
      category: "active",
      tone: "info",
      humanOnly: true,
      stuckAfterDays: 14,
      dateBinding: "dueDate",
      waits,
    };
    const [stored] = normalizeEnumOptions([full])!;
    expect(stored).toEqual(full);
    const reparsed = parseLifecycleOptions([stored]);
    expect(reparsed.errors).toEqual([]);
    expect(reparsed.options[0]).toEqual(full);
  });
});
