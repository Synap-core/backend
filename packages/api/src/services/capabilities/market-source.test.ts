import { describe, it, expect } from "vitest";
import {
  buildMarketSource,
  stampMarketSource,
  readMarketSource,
  detachMarketSource,
  deepEqual,
  threeWayMergeFields,
} from "./market-source.js";

const AT = "2026-08-04T00:00:00.000Z";

describe("market-source — stamp / read / detach roundtrip", () => {
  it("builds, stamps into a metadata bag, reads back, and clones the baseline", () => {
    const fields = { name: "Weekly report", config: { cron: "0 9 * * 1" } };
    const source = buildMarketSource(fields, {
      packageSlug: "weekly-report",
      packageVersion: "1.2.0",
      installedAt: AT,
    });
    // baseline is a clone — mutating the caller's object must not change it.
    (fields.config as { cron: string }).cron = "MUTATED";
    expect((source.baseline.config as { cron: string }).cron).toBe("0 9 * * 1");

    const metadata = stampMarketSource({ existing: "keep-me" }, source);
    expect(metadata.existing).toBe("keep-me");

    const read = readMarketSource(metadata);
    expect(read?.packageSlug).toBe("weekly-report");
    expect(read?.packageVersion).toBe("1.2.0");
    expect(read?.baseline).toEqual({
      name: "Weekly report",
      config: { cron: "0 9 * * 1" },
    });
  });

  it("readMarketSource returns null for absent/malformed stamps", () => {
    expect(readMarketSource(undefined)).toBeNull();
    expect(readMarketSource({})).toBeNull();
    expect(readMarketSource({ marketSource: 42 })).toBeNull();
    expect(readMarketSource({ marketSource: { packageSlug: "x" } })).toBeNull(); // no baseline
  });

  it("detach clears only the source-link, preserving every other key", () => {
    const source = buildMarketSource(
      { name: "x" },
      { packageSlug: "s", installedAt: AT }
    );
    const metadata = stampMarketSource({ keep: 1 }, source);
    const detached = detachMarketSource(metadata);
    expect(detached).toEqual({ keep: 1 });
    expect(readMarketSource(detached)).toBeNull();
  });
});

describe("deepEqual", () => {
  it("compares nested objects/arrays order-insensitively at the key level", () => {
    expect(
      deepEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })
    ).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 2 })).toBe(false);
    expect(deepEqual([1, 2], [2, 1])).toBe(false); // array order IS significant
  });
  it("treats undefined and absent keys as equal, distinguishes null", () => {
    expect(deepEqual({ a: undefined }, {})).toBe(true);
    expect(deepEqual(null, null)).toBe(true);
    expect(deepEqual(null, undefined)).toBe(true);
    expect(deepEqual(0, null)).toBe(false);
  });
});

describe("threeWayMergeFields — field-level owner-ownership (the safety property)", () => {
  it("advances an UNTOUCHED field to the template's new value", () => {
    const r = threeWayMergeFields(
      { name: "Old" }, // live == base (untouched since install)
      { name: "Old" }, // base
      { name: "New" } // desired
    );
    expect(r.merged.name).toBe("New");
    expect(r.applied).toEqual(["name"]);
    expect(r.ownerOwned).toEqual([]);
    expect(r.nextBaseline.name).toBe("New");
    expect(r.changed).toBe(true);
  });

  it("NEVER overwrites a field the user edited since install (owner-owned)", () => {
    const r = threeWayMergeFields(
      { name: "User's own title" }, // live diverged from base
      { name: "Installed title" }, // base
      { name: "Template's new title" } // desired
    );
    expect(r.merged.name).toBe("User's own title"); // left alone
    expect(r.ownerOwned).toEqual(["name"]);
    expect(r.applied).toEqual([]);
    expect(r.nextBaseline.name).toBe("Installed title"); // old base kept → divergence stays detected
    expect(r.changed).toBe(false);
  });

  it("leaves a field the template DROPPED (prune is OFF)", () => {
    const r = threeWayMergeFields(
      { name: "N", legacy: "keep" },
      { name: "N", legacy: "keep" },
      { name: "N" } // template no longer manages `legacy`
    );
    expect(r.merged.legacy).toBe("keep");
    expect(r.applied).toEqual([]);
    expect(r.ownerOwned).toEqual([]);
  });

  it("adopts a NEWLY-managed field only when there's no diverging user value", () => {
    // live absent → adopt
    const adopt = threeWayMergeFields(
      { name: "N" },
      { name: "N" },
      { name: "N", added: "v" }
    );
    expect(adopt.merged.added).toBe("v");
    expect(adopt.applied).toContain("added");

    // live holds a different, pre-existing user value → owner-owned, don't stomp
    const guard = threeWayMergeFields(
      { name: "N", added: "user-set" },
      { name: "N" },
      { name: "N", added: "template-v" }
    );
    expect(guard.merged.added).toBe("user-set");
    expect(guard.ownerOwned).toContain("added");
  });

  it("deep-compares jsonb field values (edit inside a nested config is owner-owned)", () => {
    const base = { config: { cron: "0 9 * * 1", tz: "UTC" } };
    const r = threeWayMergeFields(
      { config: { cron: "0 6 * * 1", tz: "UTC" } }, // user changed the hour
      base,
      { config: { cron: "0 9 * * 5", tz: "UTC" } } // template changed the day
    );
    expect(r.ownerOwned).toEqual(["config"]);
    expect((r.merged.config as { cron: string }).cron).toBe("0 6 * * 1"); // user's value preserved
  });

  it("reports changed=false when desired equals base (nothing to do)", () => {
    const r = threeWayMergeFields({ name: "N" }, { name: "N" }, { name: "N" });
    expect(r.changed).toBe(false);
    expect(r.applied).toEqual([]);
  });

  it("a field edited TO the template's value is SAME: no write, baseline catches up", () => {
    // Founder pod 2026-10-30: facecam-edit's body equalled the catalog byte for
    // byte and `market update` still said "owner-owned [body]".
    const r = threeWayMergeFields(
      { body: "catalog v2" }, // live: the owner pasted the new catalog body
      { body: "catalog v1" }, // base: what we installed
      { body: "catalog v2" } // desired
    );
    expect(r.applied).toEqual([]);
    expect(r.ownerOwned).toEqual([]);
    expect(r.conflicted).toEqual([]);
    expect(r.changed).toBe(false);
    expect(r.merged.body).toBe("catalog v2");
    expect(r.nextBaseline.body).toBe("catalog v2");
  });

  it("splits owner-owned into conflicted (catalog moved too) and yours only", () => {
    const r = threeWayMergeFields(
      { body: "mine", description: "my words" },
      { body: "v1", description: "same upstream" },
      { body: "v2", description: "same upstream" }
    );
    expect(r.ownerOwned).toEqual(["body", "description"]);
    expect(r.conflicted).toEqual(["body"]); // description: only the owner moved
    expect(r.nextBaseline).toEqual({
      body: "v1",
      description: "same upstream",
    });
  });

  it("a pre-existing value under a newly-managed key is conflicted", () => {
    const r = threeWayMergeFields(
      { name: "N", added: "user-set" },
      { name: "N" },
      { name: "N", added: "template-v" }
    );
    expect(r.ownerOwned).toEqual(["added"]);
    expect(r.conflicted).toEqual(["added"]);
  });
});

describe("readMarketSource — comparatorVersion", () => {
  it("keeps the comparator a reconcile stamped beside the version", () => {
    const read = readMarketSource({
      marketSource: {
        packageSlug: "s",
        packageVersion: "h-2",
        comparatorVersion: 1,
        installedAt: AT,
        baseline: {},
      },
    });
    expect(read?.comparatorVersion).toBe(1);
    expect(
      readMarketSource({
        marketSource: { packageSlug: "s", installedAt: AT, baseline: {} },
      })
    ).not.toHaveProperty("comparatorVersion");
  });
});
