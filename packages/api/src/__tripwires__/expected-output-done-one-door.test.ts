import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join, relative } from "path";

/**
 * TRIPWIRE — `expectedOutputs[].status = "done"` has ONE write door.
 *
 * A focus session declares deliverables in the untyped JSONB `expectedOutputs`.
 * Until P5 the AGENT marked them done itself (by label match), and
 * `completeFocusSession` then counted `status !== "done"` as a warn-only
 * warning — i.e. the agent graded its own homework and the session closed clean.
 *
 * The honest signal is APPROVAL: proposals carry `sessionId`, so an approved,
 * successfully applied session-scoped proposal is a human accepting the
 * artefact. `satisfyExpectedOutputs` stamps `status: "done"` +
 * `satisfiedByProposalId` from the approval path and NOTHING else may. An
 * agent's own mark belongs on `claimedDone` — a claim to show the human, never
 * proof.
 *
 * If this fails: call `satisfyExpectedOutputs` (or write `claimedDone` if what
 * you have is a claim). Do NOT widen the list below — the only legal edit to it
 * is REMOVING a line.
 *
 * SCOPE: files that mention `expectedOutputs` at all, across api/src, jobs/src
 * and database/src. Narrowed that way on purpose: `status: "done"` is a common
 * literal (the import orchestrator's per-file progress uses it) and a bare token
 * scan would drown in false positives.
 */

// The ONE door.
const DOOR_SUFFIX = "satisfy-expected-output.ts";

/**
 * KNOWN RESIDUAL — not an endorsement.
 *
 * `update-session.ts` is the agent's own `completeOutput` mark. It still writes
 * `status: "done"`; converting it to `claimedDone` is the open half of P5, left
 * undone because the file was being edited by a concurrent session and could not
 * be touched without committing someone else's work-in-progress.
 *
 * This list is pinned EXACTLY (not as a subset) so the residual can never grow
 * silently and so removing the last entry is a required, visible edit.
 */
const KNOWN_RESIDUAL = ["src/services/focus-sessions/update-session.ts"];

const DONE_LITERAL = /status:\s*"done"/g;

/**
 * Proximity window (chars) around a `status: "done"` in which the surrounding
 * code must mention the outputs array for the hit to count. File-level matching
 * is too coarse: `import-orchestrator.ts` documents `expectedOutputs[0].kind` in
 * a comment 700 lines away from an unrelated per-file progress `status: "done"`.
 */
const WINDOW = 400;
const OUTPUT_CONTEXT = /expectedOutputs|completeOutput/;

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

function offenders(): string[] {
  const roots = [
    join(process.cwd(), "src"),
    join(process.cwd(), "..", "jobs", "src"),
    join(process.cwd(), "..", "database", "src"),
  ];
  const found: string[] = [];
  for (const root of roots) {
    for (const f of tsFiles(root)) {
      if (f.endsWith(DOOR_SUFFIX)) continue;
      const src = readFileSync(f, "utf8");
      if (!src.includes("expectedOutputs")) continue;
      DONE_LITERAL.lastIndex = 0;
      for (const m of src.matchAll(DONE_LITERAL)) {
        const from = Math.max(0, m.index - WINDOW);
        if (OUTPUT_CONTEXT.test(src.slice(from, m.index + WINDOW))) {
          found.push(relative(process.cwd(), f));
          break;
        }
      }
    }
  }
  return found.sort();
}

describe("tripwire: expected-output `done` has one write door", () => {
  it("only the one door — plus the pinned, documented residual — stamps done", () => {
    expect(offenders()).toEqual([...KNOWN_RESIDUAL].sort());
  });

  it("the door actually stamps lineage, so a `done` is falsifiable", () => {
    const door = readFileSync(
      join(
        process.cwd(),
        "src",
        "services",
        "focus-sessions",
        "satisfy-expected-output.ts"
      ),
      "utf8"
    );
    // A status stamp with no proposal id is exactly the unverifiable claim this
    // whole door exists to replace.
    expect(door).toMatch(/satisfiedByProposalId/);
    expect(door).toMatch(
      /status:\s*"done"\s*as const,\s*satisfiedByProposalId/
    );
  });

  it("the approval path calls the door with the proposal's own session + target", () => {
    const applier = readFileSync(
      join(process.cwd(), "src", "routers", "proposals", "apply-approval.ts"),
      "utf8"
    );
    expect(applier).toMatch(/satisfyExpectedOutputs\(\{/);
    // Reading these off the PROPOSAL (not off caller input) is what makes the
    // stamp attributable rather than assertable.
    expect(applier).toMatch(/sessionId: args\.proposal\.sessionId/);
    expect(applier).toMatch(/targetType: args\.proposal\.targetType/);
  });
});
