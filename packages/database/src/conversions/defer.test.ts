/**
 * DB-less unit tests for the destructive-tail DEFER path (the startup caller's
 * contract). A fake tagged-template `sql` returns canned results so we can prove
 * the JS orchestration in runConversions — defer ops with a destructive tail,
 * apply the rest, ledger only what applied — without a database.
 */

import { describe, it, expect } from "vitest";
import type { Sql } from "postgres";
import {
  runConversions,
  opHasDestructiveTail,
  type RunSummary,
} from "./engine.js";
import type { ConversionManifest } from "./manifest.js";

/** Records the op keys the engine tried to LEDGER (INSERT into _conversions). */
function makeFakeSql(ledgered: string[]): Sql {
  const handler = (text: string, values: unknown[]) => {
    if (text.includes("CREATE TABLE")) return undefined;
    if (text.includes("SELECT op_key FROM")) return []; // nothing applied yet
    if (text.includes('INSERT INTO "_conversions"')) {
      ledgered.push(String(values[0]));
      return { count: 1 };
    }
    return []; // any op-body query (e.g. the seed INSERT) → touched nothing
  };
  const fn: any = (strings: TemplateStringsArray | string[], ...values: unknown[]) => {
    const text = Array.isArray(strings) ? strings.join("?") : String(strings);
    return Promise.resolve(handler(text, values));
  };
  fn.json = (v: unknown) => ({ __json: v });
  fn.begin = async (cb: (tx: Sql) => unknown) => cb(fn as Sql);
  return fn as Sql;
}

const manifest: ConversionManifest = {
  version: 1,
  ops: [
    { op: "keep", opKey: "t.keep", slug: "note", note: "audit" },
    { op: "mergeInto", opKey: "t.merge", fromSlugs: ["note"], intoSlug: "item" },
    { op: "dedupeProfileRows", opKey: "t.dedupe", slug: "knowledge" },
  ],
};

describe("opHasDestructiveTail", () => {
  it("is true for exactly mergeInto + dedupeProfileRows", () => {
    expect(opHasDestructiveTail(manifest.ops[0])).toBe(false); // keep
    expect(opHasDestructiveTail(manifest.ops[1])).toBe(true); // mergeInto
    expect(opHasDestructiveTail(manifest.ops[2])).toBe(true); // dedupeProfileRows
  });
});

describe("runConversions — deferDestructive", () => {
  it("defers destructive-tail ops (no apply, no ledger) and processes the rest", async () => {
    const ledgered: string[] = [];
    const summary: RunSummary = await runConversions(
      makeFakeSql(ledgered),
      manifest,
      { dryRun: false, destructiveTail: false, deferDestructive: true }
    );

    const byKey = Object.fromEntries(
      summary.results.map((r) => [r.opKey, r.status])
    );
    expect(byKey["t.keep"]).toBe("noop"); // applied, zero-count
    expect(byKey["t.merge"]).toBe("deferred");
    expect(byKey["t.dedupe"]).toBe("deferred");
    expect(summary.hadError).toBe(false);

    // Only the non-destructive op was ledgered; deferred ops are untouched so a
    // later operator run can still complete them with --destructive-tail.
    expect(ledgered).toEqual(["t.keep"]);
  });

  it("rejects deferDestructive combined with destructiveTail", async () => {
    await expect(
      runConversions(makeFakeSql([]), manifest, {
        dryRun: false,
        destructiveTail: true,
        deferDestructive: true,
      })
    ).rejects.toThrow(/mutually exclusive/);
  });
});
