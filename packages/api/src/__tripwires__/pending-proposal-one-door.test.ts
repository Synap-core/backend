import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join, relative } from "path";

/**
 * TRIPWIRE — every PENDING proposal row goes through the ONE door.
 *
 * A pending `proposals` row (an AI/automation write awaiting human review) may be
 * INSERTed in exactly one place: `insertPendingProposal()`
 * (@synap/database — database/src/utils/insert-pending-proposal.ts). Both writers
 * call it: `createPendingProposal` (api's permission-check → checkPermissionOr
 * Propose chat-AI path) and `proposeAutomationWrite` (jobs' automation-governance
 * → automation write path). It owns the pending row shape: status, TTL/expiry
 * default, and the conditional provenance spreads. A hand-mirrored pending INSERT
 * anywhere else forks that shape — it is how the expiry default, provenance
 * columns, and status drift out of sync (the exact drift the SSOT helper deleted
 * from automation-governance.ts).
 *
 * This test forbids any file OTHER than the SSOT helper from writing
 * `.insert(proposals)` with a PENDING status. It does NOT touch the legitimately
 * different proposal inserts, which write a NON-pending status and so never match:
 *   - permission-check.ts (`status: ProposalStatus.AUTO_APPROVED` audit row on the
 *     execute/auto-approve verdict),
 *   - event-backed-proposal.ts (`status: ProposalStatus.AUTO_APPROVED`),
 *   - sync.ts (device-sync replication upsert — carries the synced row's own
 *     status via `onConflictDoUpdate`, not a fresh pending creation).
 * Object literals that merely carry `status: ProposalStatus.PENDING` for a socket
 * broadcast / return payload (no `.insert(proposals)` nearby) are likewise not a
 * DB write and do not match.
 *
 * If this fails: build your pending row through
 * `insertPendingProposal({ workspaceId, targetType, targetId, proposalType, data,
 * createdBy, … })` (optionally passing a tx as the 2nd arg) instead of inlining a
 * `db.insert(proposals).values({ status: ProposalStatus.PENDING, … })`. Do NOT add
 * your file to the allowlist.
 */

// The ONE door — the only file permitted to INSERT a pending proposal row.
// Path is relative to the `packages/` root (see `PACKAGES_ROOT`). Shrink-only.
const ALLOWLIST = new Set<string>([
  "database/src/utils/insert-pending-proposal.ts",
]);

// A `.insert(proposals)` whose values object writes a pending status — the fork
// pattern. The bounded gap binds the insert to its own `.values({ … status … })`
// so a later, unrelated pending object literal in the same file does not match.
const PENDING_INSERT =
  /\.insert\(\s*proposals\s*\)[\s\S]{0,600}?status:\s*(?:ProposalStatus\.PENDING|["']pending["'])/;

function tsFiles(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      tsFiles(p, acc);
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      acc.push(p);
    }
  }
  return acc;
}

// cwd is the api package root when its vitest runs; the proposal inserts span the
// api, database, and jobs packages, so scan all three `src` trees.
const PACKAGES_ROOT = join(process.cwd(), "..");
const ROOTS = [
  join(process.cwd(), "src"),
  join(PACKAGES_ROOT, "database/src"),
  join(PACKAGES_ROOT, "jobs/src"),
];

describe("tripwire: pending proposals have one door (insertPendingProposal)", () => {
  const matches = ROOTS.flatMap((root) => tsFiles(root))
    .filter((f) => PENDING_INSERT.test(readFileSync(f, "utf8")))
    .map((f) => relative(PACKAGES_ROOT, f));

  it("detects the canonical pending INSERT (guards against a dead regex)", () => {
    // The SSOT helper MUST match — otherwise the detector silently passes forever.
    expect(matches).toContain("database/src/utils/insert-pending-proposal.ts");
  });

  it("no file outside the SSOT helper inserts a pending proposal row", () => {
    const offenders = matches.filter((rel) => !ALLOWLIST.has(rel));
    expect(offenders).toEqual([]);
  });
});
