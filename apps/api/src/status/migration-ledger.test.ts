import { describe, expect, it } from "vitest";
import { summarizeMigrationLedger } from "./migration-ledger.js";

describe("summarizeMigrationLedger", () => {
  it("names the newest migration by NAME when an older number was applied last", () => {
    // pod.antoinesrvt, 2026-10-20: 0331 merged after 0336 was already applied.
    const ledger = summarizeMigrationLedger([
      { filename: "0334_invite_acceptances.sql", applied_at: "2026-10-20T11:21:48.580Z" },
      { filename: "0336_site_collections.sql", applied_at: "2026-10-20T11:21:48.653Z" },
      { filename: "0331_official_catalog_digests.sql", applied_at: "2026-10-20T14:44:02.000Z" },
    ]);
    expect(ledger.lastApplied).toBe("0336_site_collections.sql");
    expect(ledger.lastAppliedAt).toBe("2026-10-20T14:44:02.000Z");
    expect(ledger.count).toBe(3);
  });

  it("an empty ledger reports nothing applied", () => {
    expect(summarizeMigrationLedger([])).toEqual({ lastApplied: null, lastAppliedAt: null, count: 0 });
  });
});
