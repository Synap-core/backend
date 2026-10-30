/**
 * REAL-POSTGRES (PGlite) test for migration 0379 — `governance_rules.revoked_reason`
 * (structural plan S3, founder Q3): why a rule stopped acting. The trust
 * ladder's pause writes `paused_after_reverts`; the person's own revoke leaves
 * it NULL. The migration is idempotent, and the baseline carries the column,
 * so both match the drizzle schema.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { getTableConfig } from "drizzle-orm/pg-core";
import { governanceRules } from "./schema/governance-rules.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (f: string) =>
  readFileSync(resolve(HERE, "../migrations", f), "utf8");
const M0379 = read("0379_governance_rules_revoked_reason.sql");
const BASELINE = read("0000_baseline_schema.sql");

/** The baseline's governance_rules block: its enums, table and indexes. */
const RULES_BLOCK = BASELINE.slice(
  BASELINE.indexOf("-- governance_rules — the ONE store"),
  BASELINE.indexOf("-- proposal_cluster_mutes")
);

const columns = async (client: PGlite) =>
  (
    await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'governance_rules'`
    )
  ).rows.map((r) => r.column_name);

describe("migration 0379 — governance_rules.revoked_reason", () => {
  it("adds the nullable column, twice without error, keeping existing rows", async () => {
    const pg = new PGlite();
    // A pod before 0379: the baseline table WITHOUT the new column.
    await pg.exec(
      RULES_BLOCK.split("\n")
        .filter((l) => !l.includes("revoked_reason"))
        .join("\n")
        // The column was the table's last: drop the comma it leaves behind.
        .replace(/,(\s*\n\);)/, "$1")
    );
    expect(await columns(pg)).not.toContain("revoked_reason");
    await pg.exec(
      `INSERT INTO governance_rules (principal_kind, scope_kind, target_kind, target_pattern, verdict, created_by)
       VALUES ('any', 'pod', 'action', 'entity.create', 'auto', 'system:test')`
    );

    await pg.exec(M0379);
    await pg.exec(M0379);

    const { rows } = await pg.query<{ revoked_reason: string | null }>(
      `SELECT revoked_reason FROM governance_rules`
    );
    expect(rows).toEqual([{ revoked_reason: null }]);
    await pg.close();
  });

  it("the baseline and the migration both match every column the schema declares", async () => {
    const declared = getTableConfig(governanceRules)
      .columns.map((c) => c.name)
      .sort();
    expect(declared).toContain("revoked_reason");

    const base = new PGlite();
    await base.exec(RULES_BLOCK);
    expect((await columns(base)).sort()).toEqual(declared);
    await base.exec(M0379);
    expect((await columns(base)).sort()).toEqual(declared);
    await base.close();
  });
});
