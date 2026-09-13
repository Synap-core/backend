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
  conversionBootSeverity,
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
  const fn: any = (
    strings: TemplateStringsArray | string[],
    ...values: unknown[]
  ) => {
    const text = Array.isArray(strings) ? strings.join("?") : String(strings);
    return Promise.resolve(handler(text, values));
  };
  fn.json = (v: unknown) => ({ __json: v });
  fn.begin = async (cb: (tx: Sql) => unknown) => cb(fn as Sql);
  return fn as Sql;
}

/**
 * Like makeFakeSql but THROWS on the first op-body query (any query that isn't
 * the ledger CREATE/SELECT/INSERT infra) — simulates an op failing to apply so
 * we can assert the severity the engine stamps on the error result.
 */
function makeThrowingSql(): Sql {
  const handler = (text: string) => {
    if (text.includes("CREATE TABLE")) return undefined;
    if (text.includes("SELECT op_key FROM")) return [];
    if (text.includes('INSERT INTO "_conversions"')) return { count: 1 };
    throw new Error("simulated op-body failure");
  };
  const fn: any = (strings: TemplateStringsArray | string[]) => {
    const text = Array.isArray(strings) ? strings.join("?") : String(strings);
    return Promise.resolve(handler(text));
  };
  fn.json = (v: unknown) => ({ __json: v });
  fn.begin = async (cb: (tx: Sql) => unknown) => cb(fn as Sql);
  return fn as Sql;
}

const manifest: ConversionManifest = {
  version: 1,
  ops: [
    { op: "keep", opKey: "t.keep", slug: "note", note: "audit" },
    {
      op: "mergeInto",
      opKey: "t.merge",
      fromSlugs: ["note"],
      intoSlug: "item",
    },
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

// deferAtBoot — the manifest-flagged, typed boot-defer property.
const deferAtBootManifest: ConversionManifest = {
  version: 1,
  ops: [
    {
      op: "remapPropertyValues",
      opKey: "t.remap.deferred",
      deferAtBoot: true,
      slug: "deal",
      sourceKey: "dealStage",
      targetKey: "commercialStage",
      valueMap: { lead: "draft" },
    },
  ],
};

describe("runConversions — skipDeferred (deferAtBoot)", () => {
  it("SKIPS a deferAtBoot op (status deferred, not ledgered) when skipDeferred:true", async () => {
    const ledgered: string[] = [];
    const summary = await runConversions(
      makeFakeSql(ledgered),
      deferAtBootManifest,
      {
        dryRun: false,
        destructiveTail: false,
        deferDestructive: true,
        skipDeferred: true,
      }
    );
    expect(summary.results[0].status).toBe("deferred");
    expect(summary.hadError).toBe(false);
    expect(ledgered).toEqual([]); // untouched → a later --apply still runs it
  });

  it("RUNS a deferAtBoot op when skipDeferred is unset (the CLI --apply path)", async () => {
    const ledgered: string[] = [];
    const summary = await runConversions(
      makeFakeSql(ledgered),
      deferAtBootManifest,
      {
        dryRun: false,
        destructiveTail: false,
      }
    );
    // fake sql touches nothing → noop, but it WAS applied and ledgered.
    expect(summary.results[0].status).toBe("noop");
    expect(ledgered).toEqual(["t.remap.deferred"]);
  });
});

describe("conversion boot severity", () => {
  it("classifies integrity ops fatal and value/scope ops advisory", () => {
    expect(
      conversionBootSeverity({
        op: "convertToFacet",
        opKey: "x",
        slug: "client",
        targetKindSlug: "company",
        applicableKinds: ["company"],
      })
    ).toBe("fatal");
    expect(
      conversionBootSeverity({
        op: "seedKindProfile",
        opKey: "x",
        slug: "item",
        displayName: "Item",
        entityScope: "pod",
      })
    ).toBe("fatal");
    expect(
      conversionBootSeverity({
        op: "remapPropertyValues",
        opKey: "x",
        slug: "deal",
        sourceKey: "a",
        targetKey: "b",
        valueMap: { a: "b" },
      })
    ).toBe("advisory");
    expect(
      conversionBootSeverity({ op: "reconcileEntityScope", opKey: "x" })
    ).toBe("advisory");
  });

  it("stamps FATAL severity on a failing integrity op (boot would exit)", async () => {
    const summary: RunSummary = await runConversions(
      makeThrowingSql(),
      {
        version: 1,
        ops: [
          {
            op: "seedKindProfile",
            opKey: "t.seed.fatal",
            slug: "item",
            displayName: "Item",
            entityScope: "pod",
          },
        ],
      },
      { dryRun: false, destructiveTail: false }
    );
    const err = summary.results.find((r) => r.status === "error");
    expect(err?.severity).toBe("fatal");
    expect(summary.hadError).toBe(true);
  });

  it("stamps ADVISORY severity on a failing value-remap op (boot would degrade, not exit)", async () => {
    const summary: RunSummary = await runConversions(
      makeThrowingSql(),
      {
        version: 1,
        ops: [
          {
            op: "remapPropertyValues",
            opKey: "t.remap.advisory",
            slug: "deal",
            sourceKey: "dealStage",
            targetKey: "commercialStage",
            valueMap: { lead: "draft" },
          },
        ],
      },
      { dryRun: false, destructiveTail: false }
    );
    const err = summary.results.find((r) => r.status === "error");
    expect(err?.severity).toBe("advisory");
    expect(summary.hadError).toBe(true);
  });
});

// ─── The ledger trap (W1a) ────────────────────────────────────────────────────
// A real run without destructiveTail must never apply-and-ledger a
// destructive-tail op: once ledgered, the ledger skip makes its deactivation
// unreachable forever.
describe("runConversions — destructive-tail op without destructiveTail", () => {
  for (const [label, op] of [
    [
      "dedupeProfileRows",
      { op: "dedupeProfileRows", opKey: "t.dedupe", slug: "knowledge" },
    ],
    [
      "mergeInto",
      {
        op: "mergeInto",
        opKey: "t.merge",
        fromSlugs: ["note"],
        intoSlug: "item",
      },
    ],
  ] as const) {
    it(`REFUSES a ${label} op on a real run — neither applied nor ledgered, run halts`, async () => {
      const ledgered: string[] = [];
      const bodyQueries: string[] = [];
      const base = makeFakeSql(ledgered);
      const spy: any = (
        strings: TemplateStringsArray,
        ...values: unknown[]
      ) => {
        const text = strings.join("?");
        if (
          !text.includes("CREATE TABLE") &&
          !text.includes("SELECT op_key FROM") &&
          !text.includes('INSERT INTO "_conversions"')
        ) {
          bodyQueries.push(text);
        }
        return (base as any)(strings, ...values);
      };
      spy.json = (base as any).json;
      spy.begin = async (cb: (tx: Sql) => unknown) => cb(spy as Sql);

      const summary = await runConversions(
        spy as Sql,
        {
          version: 1,
          ops: [op as any, { op: "keep", opKey: "t.after", slug: "note" }],
        },
        { dryRun: false, destructiveTail: false }
      );

      expect(summary.results[0].status).toBe("error");
      expect(summary.results[0].error).toMatch(
        new RegExp(
          `--apply --only ${op.opKey.replace(".", "\\.")} --destructive-tail`
        )
      );
      expect(summary.hadError).toBe(true);
      expect(bodyQueries).toEqual([]); // the repoint never ran
      expect(ledgered).toEqual([]); // not even an error row — a later tail run is clean
      expect(summary.results.map((r) => r.opKey)).toEqual([op.opKey]); // halted
    });
  }

  it("still APPLIES + ledgers it when destructiveTail:true (the operator path)", async () => {
    const ledgered: string[] = [];
    const summary = await runConversions(
      makeFakeSql(ledgered),
      { version: 1, ops: [manifest.ops[2]] },
      { dryRun: false, destructiveTail: true }
    );
    expect(summary.hadError).toBe(false);
    expect(ledgered).toEqual(["t.dedupe"]);
  });

  it("does NOT refuse a dry run (writes nothing, so nothing can be orphaned)", async () => {
    const summary = await runConversions(makeFakeSql([]), manifest, {
      dryRun: true,
      destructiveTail: false,
    });
    expect(summary.hadError).toBe(false);
    expect(summary.results.map((r) => r.status)).toEqual([
      "dry-run",
      "dry-run",
      "dry-run",
    ]);
  });

  it("BOOT options still DEFER these ops (no throw, no error, stamped reason) — the pod keeps booting", async () => {
    const ledgered: string[] = [];
    const bootManifest: ConversionManifest = {
      version: 1,
      ops: [...manifest.ops, ...deferAtBootManifest.ops],
    };
    // Exactly index.ts's boot options.
    const summary = await runConversions(makeFakeSql(ledgered), bootManifest, {
      dryRun: false,
      destructiveTail: false,
      deferDestructive: true,
      skipDeferred: true,
    });
    expect(summary.hadError).toBe(false);
    expect(summary.results.filter((r) => r.status === "error")).toEqual([]);
    const deferred = summary.results
      .filter((r) => r.status === "deferred")
      .map((r) => [r.opKey, r.deferReason]);
    expect(deferred).toEqual([
      ["t.merge", "destructive-tail"],
      ["t.dedupe", "destructive-tail"],
      ["t.remap.deferred", "defer-at-boot"],
    ]);
    expect(ledgered).toEqual(["t.keep"]);
  });
});
