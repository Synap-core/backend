import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";

/**
 * TRIPWIRE — `LinkType` SSOT, and the Hub REST WRITE ALLOWLIST derived from it.
 *
 * The sibling `links-endpoint-type-ssot.test.ts` guards `LinkEndpointType` and
 * ONLY that — it contains zero `LinkType` references. While a comment in
 * `schema/links.ts` implied otherwise, the REST allowlist in
 * `hub-protocol/rest/links.ts` sat FOUR members behind the schema union
 * (`blocked_by`, `spawned_from`, `activates`, `provides_credential`), so an IS
 * agent — whose only door to the pod is Hub Protocol — could not declare that
 * one unit of work blocks another. This file closes that half.
 *
 * TWO invariants, both DERIVED, neither hand-maintained:
 *
 *   1. PARITY — every `type LinkType = "…" | "…"` declaration in the repo (the
 *      schema, plus the dependency-free mirror in `@synap/playbooks`) must
 *      equal the schema union EXACTLY. Sites are discovered by scanning
 *      `packages/**\/src`, so a THIRD mirror added anywhere joins the scan by
 *      existing rather than by someone remembering to list it.
 *
 *   2. THE WRITE ALLOWLIST COVERS EVERY TYPED PRODUCER — a member with a
 *      producer (`linkType: "x"`) or a TYPED reader (`links.linkType, "x"`)
 *      MUST be writable over Hub Protocol. "Typed" is itself derived by
 *      scanning source, so landing a producer DEMANDS the allowlist entry
 *      rather than waiting for someone to notice. This is the exact drift that
 *      bit: `blocked_by` and `spawned_from` each had a dedicated producer AND a
 *      dedicated reader, and an IS agent still could not write one.
 *
 * THE REVERSE DIRECTION IS DELIBERATELY NOT AN AUTOMATIC GATE, and the reason
 * matters more than the rule. "No typed reader" does NOT mean "no reader":
 * `getLinksFor` (services/links/links-service.ts) returns EVERY edge on a node
 * regardless of `linkType`, so a bridge edge can be produced by an agent through
 * this door and consumed by a graph traversal that never names its type. A scan
 * that concluded "dead" from the absence of an `eq(links.linkType, …)` would be
 * a guard reasoning past what it can actually see — the failure this file exists
 * to prevent, committed by this file. So the members with no typed producer are
 * PINNED below with their reasoning instead, and the pin trips in BOTH
 * directions: a new one appearing is a new silent widening to justify, and one
 * disappearing means a producer landed and the pin is now a lie.
 *
 * `provides_credential` is the clear-cut case and is NOT allowlisted: migration
 * 0161 retired it (`DELETE FROM links WHERE link_type = 'provides_credential'`)
 * and dynamic tool auth moved to the secrets connection registry — so it is dead
 * by MIGRATION, evidence a source scan alone could not supply.
 *
 * WHAT THIS DOES NOT COVER, measured:
 *   - Granularity is the FILE and the LITERAL, not the call site. A file that
 *     both produces and reads a type is indistinguishable from one that only
 *     produces it.
 *   - It cannot see a producer that builds the literal dynamically
 *     (`linkType: someVariable`), nor a type-agnostic reader (see above). The
 *     non-vacuity floor below catches the scan going blind wholesale, but not
 *     one member going dark this way.
 *   - It says nothing about whether a link type is CORRECT, only about whether
 *     the copies of the list agree and whether every typed producer can reach
 *     the write door.
 */

/**
 * Union members allowlisted for Hub REST writes that have NO typed producer and
 * NO typed reader in source, as measured 2026-09-08.
 *
 * All three are the knowledge↔config bridge edges (`entity DATA --about/
 * documents/concerns--> config object`) minus `documents`, which does have a
 * typed producer. They were allowlisted before this tripwire existed. They are
 * NOT removed here because `getLinksFor` reads edges type-agnostically, so an
 * agent may well be writing them today for a traversal to consume — and
 * narrowing a live write door on the strength of a regex is the kind of
 * confident overclaim this repo pays for. They need a human decision: wire a
 * typed reader, or drop them.
 */
const ALLOWLISTED_WITHOUT_TYPED_PRODUCER = ["about", "concerns", "provided_by"];

/**
 * Strip BOTH `/* … *\/` block comments and `// …` line comments, so a comment's
 * prose can never be mistaken for source syntax.
 *
 * BLOCK comments matter here and the sibling endpoint tripwire does not strip
 * them — which is not an oversight there (its union carries only `//` notes) but
 * IS load-bearing here, and this file was written with the line-only stripper
 * first and went red for exactly that reason. The `spawned_from` member of the
 * schema union carries a JSDoc containing the sentence `The UI says "forked
 * from"; it never draws a graph.` — a SEMICOLON in prose. A union parse bounded
 * by `indexOf(";")` therefore stopped THREE members early, silently, and the
 * word `"branched_from"` quoted in that same prose was read as a member. That is
 * the signature defect of this codebase (a scan truncated at a brace or a
 * semicolon in a doc comment) reproducing itself inside the guard written to
 * prevent it.
 *
 * Boundary, stated: this also blanks a `//` sequence inside a string literal (a
 * URL). Nothing scanned below depends on one, and the two union parses read only
 * lowercase-and-underscore literals.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

const SCHEMA_FILE = join(
  process.cwd(),
  "..",
  "database",
  "src",
  "schema",
  "links.ts"
);

const REST_DOOR = join(
  process.cwd(),
  "src",
  "routers",
  "hub-protocol",
  "rest",
  "links.ts"
);

function schemaUnion(): string[] {
  const clean = stripComments(readFileSync(SCHEMA_FILE, "utf8"));
  const start = clean.indexOf("export type LinkType =");
  if (start === -1) throw new Error("LinkType not found in schema");
  const end = clean.indexOf(";", start);
  return [...clean.slice(start, end).matchAll(/"([a-z_]+)"/g)].map(
    (m) => m[1]!
  );
}

const SKIP_DIRS = new Set(["node_modules", "dist", ".turbo", "build"]);

/** This scanner quotes the patterns it hunts, so it would otherwise discover
 *  ITSELF as both a mirror and a producer. */
const SELF = fileURLToPath(import.meta.url);

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".ts") && !name.endsWith(".d.ts") && full !== SELF)
        out.push(full);
    }
  };
  walk(join(process.cwd(), ".."));
  return out;
}

/** A file that only asserts ABOUT link types is not a producer of one. */
function isTestFile(file: string): boolean {
  return (
    file.includes("/__tests__/") ||
    file.includes("/__tripwires__/") ||
    file.endsWith(".test.ts")
  );
}

interface Site {
  file: string;
  kind: "union" | "array";
  members: string[];
}

/**
 * Discover every place the LinkType list is written out:
 *   kind A — a `type LinkType = "…" | "…"` declaration.
 *   kind B — an `[…] as const` string array whose members are ALL union members
 *            and which holds ≥ 5 of them (unmistakably a link-type list, and
 *            deliberately not matching a small intentional subset).
 */
function discoverSites(union: ReadonlySet<string>): Site[] {
  const sites: Site[] = [];
  for (const file of sourceFiles()) {
    const src = stripComments(readFileSync(file, "utf8"));

    let idx = src.indexOf("type LinkType =");
    while (idx !== -1) {
      const end = src.indexOf(";", idx);
      if (end !== -1) {
        sites.push({
          file,
          kind: "union",
          members: [...src.slice(idx, end).matchAll(/"([a-z_]+)"/g)].map(
            (m) => m[1]!
          ),
        });
      }
      idx = src.indexOf("type LinkType =", idx + 1);
    }

    for (const m of src.matchAll(/=\s*\[([^[\]]*?)\]\s*as const/gs)) {
      const body = m[1]!;
      // Literals only — a spread, identifier or object means this is not a
      // plain string list.
      if (/[^\s"',\w]/.test(body)) continue;
      const values = [...body.matchAll(/"([a-z_]+)"/g)].map((v) => v[1]!);
      if (values.length < 5) continue;
      if (!values.every((v) => union.has(v))) continue;
      sites.push({ file, kind: "array", members: values });
    }
  }
  return sites;
}

/**
 * The link types something actually WRITES or READS by name, in non-test
 * source. Both shapes the codebase uses:
 *   producer — `linkType: "blocked_by"` (an insert / link input)
 *   reader   — `eq(links.linkType, "blocked_by")` (a where clause)
 * A `.js`-suffixed import or a comment can never match: the scan runs on
 * comment-stripped source and requires the `linkType` token adjacent to the
 * quoted literal.
 */
function liveLinkTypes(union: readonly string[]): Set<string> {
  const live = new Set<string>();
  for (const file of sourceFiles()) {
    if (isTestFile(file)) continue;
    const src = stripComments(readFileSync(file, "utf8"));
    for (const type of union) {
      const producer = new RegExp(`linkType:\\s*"${type}"`);
      const reader = new RegExp(`linkType\\s*,\\s*"${type}"`);
      if (producer.test(src) || reader.test(src)) live.add(type);
    }
  }
  return live;
}

describe("tripwire: LinkType SSOT (derived mirrors)", () => {
  const union = schemaUnion();
  const unionSet = new Set(union);
  const sites = discoverSites(unionSet);

  it("the schema union is non-empty and holds the members this file reasons about", () => {
    // Non-vacuity for EVERY assertion below: a `schemaUnion()` that silently
    // returned `[]` would make the parity check trivially true and the live-set
    // scan trivially empty.
    expect(union.length).toBeGreaterThanOrEqual(15);
    expect(unionSet.has("blocked_by")).toBe(true);
    expect(unionSet.has("provides_credential")).toBe(true);
  });

  it("discovers the schema declaration plus at least two mirrors", () => {
    // A FLOOR on the discovered population, not the population itself — a new
    // mirror joins the scan by existing. Guards a scanner that matches nothing
    // and so passes vacuously.
    expect(sites.map((s) => s.file)).toContain(SCHEMA_FILE);
    expect(sites.map((s) => s.file)).toContain(REST_DOOR);
    expect(sites.length).toBeGreaterThanOrEqual(3);
  });

  it("every `type LinkType` declaration matches the schema union exactly", () => {
    const drift = sites
      .filter((s) => s.kind === "union")
      .map((s) => {
        const has = new Set(s.members);
        return {
          file: s.file,
          missing: union.filter((t) => !has.has(t)),
          extra: s.members.filter((t) => !unionSet.has(t)),
        };
      })
      .filter((d) => d.missing.length > 0 || d.extra.length > 0);

    expect(drift).toEqual([]);
  });
});

describe("tripwire: the Hub REST write allowlist tracks producers, not symmetry", () => {
  const union = schemaUnion();
  const live = liveLinkTypes(union);

  it("the producer/reader scan can still see a literal sample of what it hunts", () => {
    // Self-check: if the regexes ever stop matching the shape producers are
    // written in, this goes red instead of quietly declaring everything dead.
    expect(live.has("blocked_by")).toBe(true);
    expect(live.has("spawned_from")).toBe(true);
    expect(live.size).toBeGreaterThanOrEqual(8);
    // And it must NOT be indiscriminate — `provides_credential` was retired by
    // migration 0161 and has neither producer nor reader in TypeScript. A scan
    // that reported it live would be matching comments or prose.
    expect(live.has("provides_credential")).toBe(false);
  });

  it("allowlists exactly the union members something produces or reads", () => {
    const src = stripComments(readFileSync(REST_DOOR, "utf8"));
    const match = src.match(/LINK_TYPES\s*=\s*\[([^\]]*)\]\s*as const/s);
    expect(
      match,
      "LINK_TYPES array not found in the Hub REST links door"
    ).toBeTruthy();
    const allowed = new Set(
      [...match![1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!)
    );

    const shouldAllow = union.filter((t) => live.has(t)).sort();
    const missing = shouldAllow.filter((t) => !allowed.has(t));

    expect(
      missing,
      "These link types have a producer or a typed reader but an agent cannot " +
        "write them over Hub Protocol — the only door an IS agent has. Add " +
        "them to LINK_TYPES in hub-protocol/rest/links.ts."
    ).toEqual([]);

    // Non-vacuity for the assertion above: it is only meaningful if the
    // allowlist is genuinely a subset of the union and actually holds the
    // members this change added.
    expect([...allowed].filter((t) => !union.includes(t))).toEqual([]);
    expect(allowed.has("blocked_by")).toBe(true);
    expect(allowed.has("spawned_from")).toBe(true);
    expect(allowed.has("activates")).toBe(true);
    expect(allowed.has("provides_credential")).toBe(false);
  });

  it("the set of allowlisted-but-unproduced types is exactly the pinned one", () => {
    const src = stripComments(readFileSync(REST_DOOR, "utf8"));
    const match = src.match(/LINK_TYPES\s*=\s*\[([^\]]*)\]\s*as const/s);
    const allowed = [...match![1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
    const unproduced = allowed.filter((t) => !live.has(t)).sort();

    // BOTH directions. A NEW entry is a widening of what agents may write with
    // nothing typed to interpret it — justify it or drop it. A MISSING entry
    // means a producer landed, so the pin above now describes the past; delete
    // the member from the list and say so.
    expect(
      unproduced,
      "The allowlisted-but-unproduced set changed. See " +
        "ALLOWLISTED_WITHOUT_TYPED_PRODUCER at the top of this file."
    ).toEqual([...ALLOWLISTED_WITHOUT_TYPED_PRODUCER].sort());
  });
});
