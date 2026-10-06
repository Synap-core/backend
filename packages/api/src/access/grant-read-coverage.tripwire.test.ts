/**
 * TRIPWIRE — every table readable through scopedDb names its GRANT subject.
 *
 * The set is DERIVED from the visibility registry (`registeredTables()`), never
 * hand-listed: a table that becomes scoped joins the scan by existing. A table
 * with no `GRANT_READ_SPECS` entry fails CLOSED for granted keys (zero rows
 * unless the grant is `*`) — safe, but silently useless — so this guard makes
 * the omission a red test instead of a quiet empty list. Stale entries (a spec
 * for a table no longer registered) fail too.
 */
import { describe, expect, it } from "vitest";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import "./index.js"; // populates the registry
import { registeredTables } from "./visibility.js";
import { GRANT_READ_SPECS } from "./grant-read.js";

const name = (t: object) => getTableConfig(t as PgTable).name;

describe("grant read coverage", () => {
  it("scans the real registry (non-vacuity)", () => {
    expect(registeredTables().length).toBeGreaterThanOrEqual(30);
  });

  it("every registered table has a grant subject", () => {
    const missing = registeredTables()
      .filter((t) => !GRANT_READ_SPECS.has(t))
      .map(name)
      .sort();
    expect(
      missing,
      "Add the table to GRANT_READ_SPECS (access/grant-read.ts) with its subject."
    ).toEqual([]);
  });

  it("no spec names a table the registry no longer scopes", () => {
    const registered = new Set(registeredTables());
    const stale = [...GRANT_READ_SPECS.keys()]
      .filter((t) => !registered.has(t))
      .map(name)
      .sort();
    expect(stale).toEqual([]);
  });
});
