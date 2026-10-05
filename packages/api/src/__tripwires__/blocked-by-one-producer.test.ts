import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * TRIPWIRE — `blocked_by` (and its sibling `replaces`) has ONE producer.
 *
 * Since B4 the edge joins any two units of work (session · entity · track).
 * The store write lives in `services/links/dependency-links.ts`; the session
 * door (`session-blocked-by.ts`) floors ownership and then calls it.
 *
 * The readers in `session-blocked-by.ts` carry no owner floor of their own:
 * they are safe because the single producer floors BOTH endpoints, so an edge
 * can only ever join two sessions of the same owner. A second producer that
 * floors differently would silently turn every read into a cross-user
 * disclosure. This scan makes that a red gate instead of a comment.
 */
const ROOTS = [
  join(__dirname, ".."),
  join(__dirname, "..", "..", "..", "database", "src"),
  join(__dirname, "..", "..", "..", "jobs", "src"),
];
/** THE store write for `blocked_by` / `replaces` (any endpoint kinds). */
const PRODUCER = "services/links/dependency-links.ts";
/** The session door: floors both sessions on one owner, then calls PRODUCER. */
const SESSION_DOOR = "services/focus-sessions/session-blocked-by.ts";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === "node_modules" || name === "dist" || name === "__tripwires__")
      continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
  }
  return out;
}

/** A values object stamping a dependency type, or the type constants. */
const STAMPS_DEPENDENCY =
  /linkType:\s*["'](?:blocked_by|replaces)["']|linkType:\s*(?:DEPENDENCY_LINK_TYPE|REPLACES_LINK_TYPE)\b/;
/** A raw insert into the `links` table. */
const INSERTS_LINKS = /\.insert\(\s*links\s*\)/;

function scan(): { offenders: string[]; scanned: number } {
  const offenders: string[] = [];
  let scanned = 0;
  for (const root of ROOTS) {
    let files: string[] = [];
    try {
      files = walk(root);
    } catch {
      continue;
    }
    for (const file of files) {
      scanned++;
      const rel = relative(root, file).replace(/\\/g, "/");
      if (rel.endsWith(PRODUCER)) continue;
      const src = readFileSync(file, "utf8");
      // A literal stamp anywhere is a second producer. A constant stamp is
      // one only where the file also inserts into `links` itself — the
      // session door names `DEPENDENCY_LINK_TYPE` but hands it to PRODUCER.
      if (/linkType:\s*["'](?:blocked_by|replaces)["']/.test(src)) {
        offenders.push(rel);
      } else if (STAMPS_DEPENDENCY.test(src) && INSERTS_LINKS.test(src)) {
        offenders.push(rel);
      }
    }
  }
  return { offenders, scanned };
}

describe("tripwire: blocked_by / replaces edges are written by exactly one producer", () => {
  it("no insert-shaped dependency literal exists outside dependency-links.ts", () => {
    const { offenders, scanned } = scan();
    // Non-vacuity: the walk saw the codebase, not an empty directory.
    expect(scanned).toBeGreaterThan(500);
    expect(offenders, "second blocked_by/replaces producer(s)").toEqual([]);
  });

  it("the scan still SEES a literal producer (self-check on a sample)", () => {
    expect(STAMPS_DEPENDENCY.test('values({ linkType: "blocked_by" })')).toBe(
      true
    );
    expect(STAMPS_DEPENDENCY.test("{ linkType: REPLACES_LINK_TYPE }")).toBe(
      true
    );
    expect(INSERTS_LINKS.test("db.insert(links).values(")).toBe(true);
  });

  it("the producer writes links and floors both endpoints before any write", () => {
    const src = readFileSync(join(ROOTS[0]!, PRODUCER), "utf8");
    expect(src).toMatch(INSERTS_LINKS);
    // The generic floor: every endpoint through its canonical read rule.
    expect(src).toMatch(/checkLinkEndpointsVisible\(/);
  });

  it("the session door floors both sessions on the caller", () => {
    const src = readFileSync(join(ROOTS[0]!, SESSION_DOOR), "utf8");
    // Both handles are caller-supplied, so both must be loaded under userId.
    const floors = src.match(/eq\(focusSessions\.userId,\s*\w+\)/g) ?? [];
    expect(
      floors.length,
      "owner-floor predicates on focusSessions"
    ).toBeGreaterThanOrEqual(1);
    expect(src).toMatch(/inArray\(focusSessions\.id,|eq\(focusSessions\.id,/);
    expect(src).toMatch(/insertDependencyEdge\(/);
    // ...and never writes `links` itself: the store write is PRODUCER's.
    expect(src).not.toMatch(INSERTS_LINKS);
  });
});
