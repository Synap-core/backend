import { describe, it, expect, beforeEach, vi } from "vitest";

// The @synap/database barrel validates config at import. The engine is driven
// through a fake `sql` below, so this URL is never connected to.
vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgres://unused:unused@127.0.0.1:1/unused";
});
import { runConversions, type ConversionManifest } from "@synap/database";
import type { Sql } from "postgres";
import {
  BOOT_CONVERSION_OPTIONS,
  UNCHECKED_CONVERSIONS_STATE,
  conversionsBootStateFromSummary,
  conversionsStatusSection,
  recordSystemProfilesBootResult,
  systemProfilesStatusSection,
  __resetSystemProfilesBootResultForTest,
} from "./boot-status.js";

/** Fake postgres.js: empty ledger, every op body touches nothing. */
function fakeSql(): Sql {
  const fn: any = (strings: TemplateStringsArray) => {
    const text = strings.join("?");
    if (text.includes("CREATE TABLE")) return Promise.resolve(undefined);
    if (text.includes('INSERT INTO "_conversions"'))
      return Promise.resolve({ count: 1 });
    return Promise.resolve([]);
  };
  fn.json = (v: unknown) => v;
  fn.begin = async (cb: (tx: Sql) => unknown) => cb(fn as Sql);
  return fn as Sql;
}

const manifest: ConversionManifest = {
  version: 1,
  ops: [
    { op: "keep", opKey: "t.keep", slug: "note" },
    {
      op: "mergeInto",
      opKey: "w7.merge.x",
      fromSlugs: ["crm-lead"],
      intoSlug: "lead",
    },
    {
      op: "dedupeProfileRows",
      opKey: "w4.dedupe.knowledge",
      slug: "knowledge",
    },
    {
      op: "remapPropertyValues",
      opKey: "crm.deal-stage.commercial-fold",
      deferAtBoot: true,
      slug: "deal",
      sourceKey: "dealStage",
      targetKey: "commercialStage",
      valueMap: { lead: "draft" },
    } as any,
  ],
};

describe("/status/release conversions section — from a REAL boot run", () => {
  it("deferred ops from the boot pass reach conversions.pending with their reason", async () => {
    const summary = await runConversions(
      fakeSql(),
      manifest,
      BOOT_CONVERSION_OPTIONS
    );
    const section = conversionsStatusSection(
      conversionsBootStateFromSummary(
        summary,
        Date.parse("2026-09-13T00:00:00Z")
      )
    );
    expect(section.pending).toEqual([
      {
        opKey: "w7.merge.x",
        op: "mergeInto",
        slug: null,
        reason: "destructive-tail",
      },
      {
        opKey: "w4.dedupe.knowledge",
        op: "dedupeProfileRows",
        slug: "knowledge",
        reason: "destructive-tail",
      },
      {
        opKey: "crm.deal-stage.commercial-fold",
        op: "remapPropertyValues",
        slug: "deal",
        reason: "defer-at-boot",
      },
    ]);
    // A CLEAN boot stamps checkedAt (it read null on the live pod).
    expect(section.checkedAt).toBe("2026-09-13T00:00:00.000Z");
    expect(section.degraded).toBe(false);
  });

  it("before the pass runs, pending and checkedAt are null — unmeasured, not empty", () => {
    const section = conversionsStatusSection(UNCHECKED_CONVERSIONS_STATE);
    expect(section.pending).toBeNull();
    expect(section.checkedAt).toBeNull();
  });
});

describe("/status/release systemProfiles section", () => {
  beforeEach(() => __resetSystemProfilesBootResultForTest());

  it("exposes a seeder status:error with its error", () => {
    recordSystemProfilesBootResult({
      status: "error",
      message: "reconcile failed",
      error: 'relation "profiles" does not exist',
      profilesCreated: 0,
      propertiesCreated: 0,
      linksCreated: 0,
    });
    expect(systemProfilesStatusSection()).toMatchObject({
      status: "error",
      error: 'relation "profiles" does not exist',
    });
  });

  it("is null before the hook ran, and error:null on success", () => {
    expect(systemProfilesStatusSection()).toEqual({
      status: null,
      error: null,
      checkedAt: null,
    });
    recordSystemProfilesBootResult({
      status: "exists",
      message: "ok",
      profilesCreated: 0,
      propertiesCreated: 0,
      linksCreated: 0,
    });
    expect(systemProfilesStatusSection()).toMatchObject({
      status: "exists",
      error: null,
    });
  });
});
