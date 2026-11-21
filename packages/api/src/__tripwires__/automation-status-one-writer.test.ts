/**
 * TRIPWIRE — `automations.status` has ONE writer once an automation exists:
 * `setAutomationStatus` in
 * `packages/database/src/services/lifecycle/automation-status.ts`, the
 * compare-and-set over `AUTOMATION_TRANSITIONS`. A raw
 * `.update(automations).set({ status: … })` anywhere else moves an automation
 * with no CAS and no transition table.
 *
 * DERIVED: every non-test `.ts` under the backend's source roots is scanned;
 * a new writer joins by existing. The scan reads the `.set(` argument of each
 * `.update(automations)` (comments stripped) up to its `.where(` /
 * `.returning(` / `;`, and flags a `status:` key there.
 *
 * WHAT IT DOES NOT SEE, stated: a status assigned onto a variable that is
 * then passed to `.set(set)`, and the replica upsert (`sync.ts`), which
 * copies a peer's row as it is. An automation BORN with a status
 * (`insertAutomation`) is not a move and is not scanned.
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
const THE_WRITER =
  "packages/database/src/services/lifecycle/automation-status.ts";

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

/** The `.set(` argument of each `.update(automations)` in `src`. */
function automationSetArguments(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(
    /\.update\(\s*(?:schema\.)?automations\s*\)\s*\.set\(/g
  )) {
    const start = m.index! + m[0].length;
    const rest = src.slice(start);
    const end = rest.search(/\.where\(|\.returning\(|;/);
    out.push(end === -1 ? rest : rest.slice(0, end));
  }
  return out;
}

const writesStatus = (src: string): boolean =>
  automationSetArguments(src).some((arg) => /\bstatus\s*:/.test(arg));

const offenders = (): { scanned: number; hits: string[] } => {
  let scanned = 0;
  const hits: string[] = [];
  for (const root of ROOTS) {
    for (const file of walk(join(BACKEND_ROOT, root))) {
      const src = stripComments(readFileSync(file, "utf8"), "ts");
      if (automationSetArguments(src).length === 0) continue;
      scanned += 1;
      if (writesStatus(src)) {
        hits.push(relative(BACKEND_ROOT, file).split("\\").join("/"));
      }
    }
  }
  return { scanned, hits };
};

describe("automations.status has one writer", () => {
  it("SELF-GUARD: the detector sees a raw status write, and only in a .set(", () => {
    expect(
      writesStatus(`await db
        .update(automations)
        .set({ status: "paused", updatedAt: new Date() })
        .where(eq(automations.id, id));`)
    ).toBe(true);
    // A status read in the WHERE or the RETURNING is not a write.
    expect(
      writesStatus(`await db
        .update(automations)
        .set({ metadata })
        .where(eq(automations.status, "paused"))
        .returning({ id: automations.id, status: automations.status });`)
    ).toBe(false);
  });

  it("the scan is not vacuous, and still sees the one writer", () => {
    const { scanned, hits } = offenders();
    expect(scanned).toBeGreaterThan(8);
    expect(hits).toContain(THE_WRITER);
  });

  it("no other file writes automations.status", () => {
    const { hits } = offenders();
    expect(
      hits.filter((f) => f !== THE_WRITER),
      "These write automations.status with a raw UPDATE. Move the " +
        "automation through setAutomationStatus (@synap/database), which " +
        "holds the compare-and-set over AUTOMATION_TRANSITIONS."
    ).toEqual([]);
  });
});
