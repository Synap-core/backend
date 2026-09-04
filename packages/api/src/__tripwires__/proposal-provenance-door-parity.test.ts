/**
 * TRIPWIRE — the two `proposals` INSERT doors must name the SAME provenance set.
 *
 * There are exactly two places a `proposals` row is born for a governed agent
 * write, and they are in different packages:
 *   1. PENDING     — `insertPendingProposal` (@synap/database)
 *   2. AUTO_APPROVED receipt — the `_autoApprove` branch of `checkPermission
 *      OrPropose` (@synap/api's permission-check)
 *
 * They have already drifted, and the drift was invisible: the PENDING door
 * carried `stepRunId` / `nodeId` / `governanceReason` while the receipt door did
 * not, and the receipt door took `sessionId` raw from an input nothing produced.
 * Measured on 2026-09-03 across 2961 rows, that read out as `sessionId` 2.6% and
 * `stepRunId` 0% — not because the columns were missing, but because the door
 * that writes the MAJORITY of agent rows never named them.
 *
 * A type cannot catch this: both doors build a Drizzle `.values({...})` object
 * where every provenance field is optional, so omitting one compiles cleanly.
 * So this is a SOURCE SCAN — it reads the two `.values({...})` blocks out of the
 * files themselves and asserts each key in `PROPOSAL_PROVENANCE_KEYS` appears in
 * both. Adding a provenance column now forces BOTH doors to carry it.
 *
 * Deliberately NOT asserted against the jobs-side automation receipt: that row
 * is a per-RUN receipt, not a per-write one, and it has no propose rung so it
 * has no `governanceReason` to write. It is a different row shape with a
 * different cardinality — folding it in here would make the tripwire lie about
 * what parity means.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PENDING_DOOR = resolve(
  HERE,
  "../../../database/src/utils/insert-pending-proposal.ts"
);
const RECEIPT_DOOR = resolve(HERE, "../utils/permission-check.ts");

/**
 * Strip `//` and block comments. A key named only in a COMMENT would otherwise
 * satisfy the scan while the door never writes it — the exact false-green this
 * tripwire exists to prevent.
 */
function stripComments(block: string): string {
  return block.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/\/\/[^\n]*/g, " ");
}

/**
 * Slice the object literal that follows `.values(` at `from`, by brace-matching.
 * Regex cannot do this: the blocks contain nested objects, ternaries and
 * conditional spreads.
 */
function valuesBlockAfter(source: string, from: number): string {
  const call = source.indexOf(".values(", from);
  if (call === -1) throw new Error("no `.values(` found after the anchor");
  const open = source.indexOf("{", call);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error("unbalanced `.values({` block");
}

/** Parse the SSOT key list out of the pending door rather than importing it —
 *  importing `@synap/database` boots the pg client, which a source scan must not. */
function provenanceKeys(pendingSource: string): string[] {
  const start = pendingSource.indexOf("PROPOSAL_PROVENANCE_KEYS = [");
  expect(start).toBeGreaterThan(-1);
  const end = pendingSource.indexOf("]", start);
  return [...pendingSource.slice(start, end).matchAll(/"([A-Za-z]+)"/g)].map(
    (m) => m[1]
  );
}

describe("proposals INSERT doors — provenance parity", () => {
  const pendingSource = readFileSync(PENDING_DOOR, "utf8");
  const receiptSource = readFileSync(RECEIPT_DOOR, "utf8");

  const KEYS = provenanceKeys(pendingSource);

  const pendingValues = stripComments(
    valuesBlockAfter(
      pendingSource,
      pendingSource.indexOf("export async function insertPendingProposal")
    )
  );
  const receiptValues = stripComments(
    valuesBlockAfter(
      receiptSource,
      receiptSource.indexOf("const eventKey = `${subjectType}.${action}`")
    )
  );

  /**
   * A door may write a key as `key: value`, as bare shorthand (`correlationId,`)
   * or inside a conditional spread (`...(x ? { key } : {})`) — all three are the
   * column being written, so all three count.
   */
  const writes = (block: string, key: string) =>
    new RegExp(`\\b${key}\\s*[:,}]`).test(block);

  it("names a non-trivial provenance set (the list itself has not been gutted)", () => {
    expect(KEYS).toEqual(
      expect.arrayContaining([
        "agentUserId",
        "correlationId",
        "sessionId",
        "projectId",
        "stepRunId",
        "nodeId",
        "governanceReason",
      ])
    );
  });

  it("both doors are the real INSERT blocks (anchors did not rot)", () => {
    expect(pendingValues).toContain("status: ProposalStatus.PENDING");
    expect(receiptValues).toContain("status: ProposalStatus.AUTO_APPROVED");
  });

  it.each(
    // Sanity: the scan must be looking at a block, not an empty string.
    (() => {
      expect(KEYS.length).toBeGreaterThan(5);
      return KEYS;
    })()
  )("PENDING door writes `%s`", (key) => {
    expect(writes(pendingValues, key)).toBe(true);
  });

  it.each(KEYS)("AUTO_APPROVED receipt door writes `%s`", (key) => {
    expect(writes(receiptValues, key)).toBe(true);
  });
});
