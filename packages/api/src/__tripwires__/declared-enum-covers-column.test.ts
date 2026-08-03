import { describe, it, expect } from "vitest";
import { ProposalStatus } from "@synap/database";
import {
  ProposalBasicSchema,
  WireProposalSchema,
} from "../routers/hub-protocol/rest/_codecs/proposal.js";

/**
 * TRIPWIRE (T2) — a declared wire enum must COVER the column it serializes.
 *
 * The failure this catches, observed live: `WireProposalSchema.status` was
 * hand-typed as `z.enum(["pending","approved","rejected"])` while the
 * `proposals.status` column had grown to SEVEN states. The published OpenAPI
 * therefore told every generated client that `auto_approved` — the audit
 * receipt an auto-approved agent write files — could never appear on a row.
 * Nothing failed at runtime (the DB happily returns the value); the CONTRACT
 * lied, which is why downstream clients hand-type their own unions instead of
 * generating them.
 *
 * The assertion is SUPERSET, not equality: a zod enum may legitimately carry
 * extra members the column cannot hold (a filter sentinel like `"all"`). What
 * it may never do is omit a value the column CAN hold.
 *
 * Adding a pair is ONE ROW in the table below.
 *
 * Pure: no DB connection, no source scanning — it compares the live zod
 * `.options` against the live Drizzle enum object, so it cannot go stale by a
 * file moving (the documented failure mode of source-scanning tripwires here).
 */

type Pair = {
  /** Human label used in the failure message. */
  name: string;
  /** The zod enum actually published on the wire. */
  zodSchema: unknown;
  /** The values the backing column can hold. */
  dbEnum: Record<string, string> | readonly string[];
};

const PAIRS: Pair[] = [
  {
    name: "WireProposalSchema.status vs proposals.status",
    zodSchema: WireProposalSchema.shape.status,
    dbEnum: ProposalStatus,
  },
  {
    name: "ProposalBasicSchema.status vs proposals.status",
    zodSchema: ProposalBasicSchema.shape.status,
    dbEnum: ProposalStatus,
  },
];

function zodOptions(schema: unknown, name: string): string[] {
  const options = (schema as { options?: unknown })?.options;
  // SELF-GUARD: a zod version bump, an `.optional()` wrapper, or a plain
  // `z.string()` would all make `.options` undefined — and a naive `?? []`
  // would then make this pair pass VACUOUSLY (superset-of-nothing is trivially
  // true). Fail loudly instead.
  if (!Array.isArray(options) || options.length === 0) {
    throw new Error(
      `[${name}] zodSchema exposes no non-empty \`.options\` array — cannot ` +
        `verify coverage. Unwrap the schema (it must be a bare z.enum) or fix ` +
        `the table row; do NOT let this pair pass silently.`
    );
  }
  return options.map(String);
}

function dbValues(dbEnum: Pair["dbEnum"], name: string): string[] {
  const values = Array.isArray(dbEnum)
    ? [...(dbEnum as readonly string[])]
    : Object.values(dbEnum as Record<string, string>);
  if (values.length === 0) {
    throw new Error(`[${name}] dbEnum is empty — nothing to verify.`);
  }
  return values;
}

describe("tripwire: declared wire enums cover their stored column", () => {
  it("the pair table is non-empty (a vacuous tripwire is not a tripwire)", () => {
    expect(PAIRS.length).toBeGreaterThan(0);
  });

  for (const pair of PAIRS) {
    it(`${pair.name} — zod options are a superset of the column's values`, () => {
      const declared = new Set(zodOptions(pair.zodSchema, pair.name));
      const stored = dbValues(pair.dbEnum, pair.name);
      const uncovered = stored.filter((v) => !declared.has(v));
      expect({ pair: pair.name, uncovered }).toEqual({
        pair: pair.name,
        uncovered: [],
      });
    });
  }
});
