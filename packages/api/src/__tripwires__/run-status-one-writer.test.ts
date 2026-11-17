/**
 * TRIPWIRE — `playbook_runs.status` has ONE writer once a run exists
 * (reactions W1): `setRunStatus` in
 * `packages/database/src/services/lifecycle/run-status.ts`. It holds the
 * compare-and-set and owes the run's transition in the same transaction; a
 * raw `.update(playbookRuns).set({ status: … })` anywhere else moves a run
 * with no transition (no reaction, no realtime push, no history) and no CAS.
 *
 * Modelled on `session-status-one-writer.test.ts`. DERIVED: every non-test
 * `.ts` under the backend's source roots is scanned; a new writer joins by
 * existing. The scan reads the `.set(` argument of each
 * `.update(playbookRuns)` (comments stripped) up to its `.where(` /
 * `.returning(` / `;`, and flags a `status:` key there.
 *
 * WHAT IT DOES NOT SEE, stated: a status assigned onto a variable that is
 * then passed to `.set(set)`, and raw SQL (`playbook-run-terminal-settles-
 * parent.test.ts` asserts no raw `UPDATE playbook_runs` exists). A run BORN
 * with a status (`.insert(playbookRuns)`) is not a move and is not scanned.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { stripComments } from "../../../../scripts/strip-comments.mjs";

/** `src/__tripwires__` → src → api → packages → synap-backend. */
const BACKEND_ROOT = join(import.meta.dirname, "../../../..");
const ROOTS = [
  "apps/api/src",
  "packages/api/src",
  "packages/jobs/src",
  "packages/database/src",
];
const THE_WRITER = "packages/database/src/services/lifecycle/run-status.ts";

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

/** The `.set(` argument of each `.update(playbookRuns)` in `src`. */
function runSetArguments(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/\.update\(\s*playbookRuns\s*\)\s*\.set\(/g)) {
    const start = m.index! + m[0].length;
    const rest = src.slice(start);
    const end = rest.search(/\.where\(|\.returning\(|;/);
    out.push(end === -1 ? rest : rest.slice(0, end));
  }
  return out;
}

const writesStatus = (src: string): boolean =>
  runSetArguments(src).some((arg) => /\bstatus\s*:/.test(arg));

const offenders = (): { scanned: number; hits: string[] } => {
  let scanned = 0;
  const hits: string[] = [];
  for (const root of ROOTS) {
    for (const file of walk(join(BACKEND_ROOT, root))) {
      const src = stripComments(readFileSync(file, "utf8"), "ts");
      if (runSetArguments(src).length === 0) continue;
      scanned += 1;
      if (writesStatus(src)) {
        hits.push(relative(BACKEND_ROOT, file).split("\\").join("/"));
      }
    }
  }
  return { scanned, hits };
};

describe("playbook_runs.status has one writer", () => {
  it("SELF-GUARD: the detector sees a raw status write, and only in a .set(", () => {
    expect(
      writesStatus(`await db
        .update(playbookRuns)
        .set({ status: "failed", completedAt: new Date() })
        .where(eq(playbookRuns.id, id));`)
    ).toBe(true);
    // A status read in the WHERE or the RETURNING is not a write.
    expect(
      writesStatus(`await db
        .update(playbookRuns)
        .set({ externalAgent: ref })
        .where(eq(playbookRuns.status, "running"))
        .returning({ id: playbookRuns.id, status: playbookRuns.status });`)
    ).toBe(false);
  });

  it("the scan is not vacuous, and still sees the one writer", () => {
    const { scanned, hits } = offenders();
    // The door plus the non-status writers (the external-agent receipt,
    // guidance, the generate snapshot).
    expect(scanned).toBeGreaterThanOrEqual(4);
    expect(hits).toContain(THE_WRITER);
  });

  it("no other file writes playbook_runs.status", () => {
    const { hits } = offenders();
    expect(
      hits.filter((f) => f !== THE_WRITER),
      "These write playbook_runs.status with a raw UPDATE. Move the run " +
        "through setRunStatus (@synap/database), which holds the " +
        "compare-and-set and owes the transition."
    ).toEqual([]);
  });
});
