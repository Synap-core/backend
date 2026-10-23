/**
 * TRIPWIRE — every door that FILES a proposal records the calling key (FB1020
 * B7, column `proposals.api_key_id`, migration 0346).
 *
 * The key is what tells two computers running the same agent apart on a
 * review card, and what "the agent's OWN records" means for the B3 class
 * (`own-organise.ts`). A door that inserts a proposal row without
 * `...callingKeyAttribution()` files rows that read as "no key": the card
 * loses its computer and the agent's own fresh work stops counting as its own.
 *
 * DERIVED, never a hand list: every non-test source file under the backend
 * packages that contains `.insert(proposals)` is scanned, so a new insert door
 * joins the scan by existing. Each such file must spread
 * `callingKeyAttribution()` at least as many times as it inserts.
 *
 * Comment lines are dropped before matching (two files name the call in prose).
 *
 * What it can NOT see (measured, see the negative control in the lane report):
 * granularity is the COUNT per file, not the statement — a file with two
 * inserts and two spreads both in ONE of them passes. And an insert written
 * with another table alias (`.insert(p)`) is not matched.
 *
 * Exempt, with the reason: `routers/sync.ts` REPLICATES proposal rows a peer
 * pod already filed; the row it copies carries no key of this pod.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const PACKAGES = join(process.cwd(), "..");
const ROOTS = ["api/src", "database/src", "jobs/src"].map((r) =>
  join(PACKAGES, r)
);
const EXEMPT = new Map<string, string>([
  ["api/src/routers/sync.ts", "replicates a peer pod's rows"],
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.ts$/.test(name) && !/\.test\.ts$|\.d\.ts$/.test(name))
      out.push(full);
  }
  return out;
}

const INSERT = /\.insert\(\s*proposals\s*\)/g;
const STAMP = /\.\.\.callingKeyAttribution\(\)/g;

const doors = ROOTS.flatMap((root) => walk(root))
  .map((file) => {
    // Code only: a comment that NAMES `db.insert(proposals)` is not a door.
    const src = readFileSync(file, "utf8")
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join("\n");
    return {
      file: relative(PACKAGES, file),
      inserts: src.match(INSERT)?.length ?? 0,
      stamps: src.match(STAMP)?.length ?? 0,
    };
  })
  .filter((d) => d.inserts > 0);

describe("tripwire: every proposal insert door records the calling key", () => {
  it("the scan still sees the insert doors (non-vacuity + a literal sample)", () => {
    expect(doors.length).toBeGreaterThanOrEqual(5);
    expect(doors.map((d) => d.file)).toContain(
      "database/src/utils/insert-pending-proposal.ts"
    );
    expect("x.insert(proposals)".match(INSERT)?.length).toBe(1);
    expect("...callingKeyAttribution(),".match(STAMP)?.length).toBe(1);
  });

  it("each door spreads callingKeyAttribution() once per insert", () => {
    const missing = doors
      .filter((d) => !EXEMPT.has(d.file) && d.stamps < d.inserts)
      .map((d) => `${d.file}: ${d.inserts} insert(s), ${d.stamps} stamp(s)`);
    expect(missing).toEqual([]);
  });

  it("every exemption still names a real insert door", () => {
    for (const file of EXEMPT.keys()) {
      expect(doors.map((d) => d.file)).toContain(file);
    }
  });
});
