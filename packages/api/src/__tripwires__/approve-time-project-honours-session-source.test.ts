/**
 * APPROVE-TIME PROJECT LADDER HONOURS THE PERSISTED `sessionSource` (A1).
 *
 * A pending proposal filed under a DERIVED session (the MCP adapter's
 * newest-open-session guess) stores `session_id` for grouping and
 * `data.sessionSource = "derived"` (stamped by `insertPendingProposal`). Every
 * door that RE-RUNS the project ladder from a stored proposal's `sessionId` at
 * approval must forward that marker, or approving the row files it into the
 * guessed session's project — the widening A1 forbids.
 *
 * DERIVED SET: every `.ts` source file under api/src and jobs/src containing a
 * `resolveProjectPlacement(` call whose argument object passes
 * `sessionId: proposal.sessionId`. A new approve-time door joins by existing.
 *
 * CANNOT SEE: a door that aliases the row (`sessionId: row.sessionId`) or reads
 * the session through a helper; the call-argument window is the text up to the
 * first `});` after the call.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

const ROOTS = [
  join(process.cwd(), "src"),
  join(process.cwd(), "..", "jobs", "src"),
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (
      p.endsWith(".ts") &&
      !p.endsWith(".test.ts") &&
      !p.endsWith(".d.ts")
    )
      out.push(p);
  }
  return out;
}

const CALL = /resolveProjectPlacement\(/g;

function approveTimeCalls(): Array<{ file: string; args: string }> {
  const found: Array<{ file: string; args: string }> = [];
  for (const root of ROOTS) {
    for (const file of walk(root)) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(CALL)) {
        const end = src.indexOf("});", m.index);
        if (end === -1) continue;
        const args = src.slice(m.index, end);
        if (/sessionId:\s*proposal\.sessionId/.test(args)) {
          found.push({ file, args });
        }
      }
    }
  }
  return found;
}

describe("approve-time project ladder honours the persisted sessionSource", () => {
  const calls = approveTimeCalls();

  it("finds the approve-time ladder doors (non-vacuity: apply-approval + materializer)", () => {
    const files = calls.map((c) => c.file);
    expect(
      files.some((f) => f.endsWith("routers/proposals/apply-approval.ts"))
    ).toBe(true);
    expect(files.some((f) => f.endsWith("workers/materializer.ts"))).toBe(true);
  });

  it("the scan can still see a literal door of the shape it hunts (self-check)", () => {
    const sample =
      "await resolveProjectPlacement(db, {\n  sessionId: proposal.sessionId,\n});";
    expect(/sessionId:\s*proposal\.sessionId/.test(sample)).toBe(true);
  });

  it("every such door forwards `sessionSource` read from the stored proposal data", () => {
    const missing = calls
      .filter(
        (c) => !/sessionSource/.test(c.args) || !/proposal\.data/.test(c.args)
      )
      .map((c) => c.file);
    expect(
      missing,
      "these doors re-derive a project from a stored proposal's session without honouring " +
        "`data.sessionSource` — approving a row filed under a DERIVED session would place it " +
        "into that guessed session's project"
    ).toEqual([]);
  });
});
