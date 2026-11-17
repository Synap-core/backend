/**
 * TRIPWIRE — every door that inserts a proposal ALREADY DECIDED
 * (`auto_approved`, a receipt) queues the reactions job for it (reactions
 * W2, review M1).
 *
 * A receipt is born decided: its insert owes no transition, by design ("a
 * birth is not a move", `proposal-transition.ts`). So the rules that listen
 * to an approval — pod default 3, "an outcome is met wherever it was filed" —
 * never saw the most common approval of all: an agent's write a rule let
 * through (`permission-check.ts`, "the MAJORITY of agent write traffic").
 * Each receipt door therefore calls `queueReceiptReactions` after its insert.
 * A new receipt door that forgets it makes default 3 silently skip its writes.
 *
 * DERIVED: every `status: ProposalStatus.AUTO_APPROVED` (or the literal) set
 * in an `.insert(proposals)` in packages/api, jobs and database (non-test),
 * comments stripped; each must be followed by a `queueReceiptReactions(` call
 * within the same statement's neighbourhood. An empty scan fails.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { stripComments } from "../../../../scripts/strip-comments.mjs";

const BACKEND_ROOT = join(import.meta.dirname, "../../../..");
const ROOTS = [
  "packages/api/src",
  "packages/jobs/src",
  "packages/database/src",
];
/** How far after the receipt's status the queue call may sit (one statement + its catch). */
const WINDOW = 4000;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === "__tests__" || name === "__tripwires__") continue;
      walk(full, out);
    } else if (name.endsWith(".ts") && !name.includes(".test.")) out.push(full);
  }
  return out;
}

const sites = (() => {
  const out: Array<{ file: string; line: number; queued: boolean }> = [];
  for (const root of ROOTS.map((r) => join(BACKEND_ROOT, r))) {
    if (!existsSync(root)) {
      throw new Error(`Tripwire cannot read its subject: ${root}`);
    }
    for (const file of walk(root)) {
      const raw = readFileSync(file, "utf8");
      if (!raw.includes(".insert(proposals)")) continue;
      const src = stripComments(raw, "ts");
      const re =
        /status:\s*(?:ProposalStatus\.AUTO_APPROVED|["']auto_approved["'])/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        // Only a status set inside an insert of a proposals row.
        const before = src.lastIndexOf(".insert(proposals)", m.index);
        if (before === -1 || m.index - before > WINDOW) continue;
        out.push({
          file,
          line: src.slice(0, m.index).split("\n").length,
          queued: src
            .slice(m.index, m.index + WINDOW)
            .includes("queueReceiptReactions("),
        });
      }
    }
  }
  return out;
})();

describe("every receipt door queues the reactions for what it records", () => {
  it("finds the receipt doors (an empty scan is a blind guard)", () => {
    expect(sites.length).toBeGreaterThanOrEqual(4);
  });

  it("each receipt insert is followed by queueReceiptReactions", () => {
    const missing = sites
      .filter((s) => !s.queued)
      .map((s) => `${relative(BACKEND_ROOT, s.file)}:${s.line}`);
    expect(missing).toEqual([]);
  });
});
