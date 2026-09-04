import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";

/**
 * TRIPWIRE — `LinkEndpointType` is DECLARED in one place and MIRRORED in
 * others (a hand-copied union in `@synap/playbooks`, a `z.enum` array in the
 * hub-REST door). They already drifted once silently: the REST
 * `LINK_ENDPOINT_TYPES` array (rest/links.ts) was missing "automation" /
 * "project" / "secret" / "capability" that the schema union had gained, which
 * meant an agent could never create those edge kinds over the Hub Protocol
 * even though the schema allowed them.
 *
 * DERIVE, DON'T HAND-LIST. The earlier version of this test named the two
 * mirror files explicitly — which meant a THIRD mirror could be added anywhere
 * in the repo and this tripwire would sail past it, the exact fork it exists
 * to prevent. It now DISCOVERS the registration sites by scanning
 * `packages/**\/src` source (same shape as
 * `capability-drift.projection-parity.tripwire.test.ts`, which parses the
 * applier's own `.set({...})` to derive its field set):
 *
 *   site kind A — any `type LinkEndpointType = "..." | "..."` union declaration
 *   site kind B — any `[...] as const` string array whose members are ALL
 *                 members of the schema union and which holds ≥ 5 of them
 *                 (i.e. a list that is unmistakably an endpoint-type list)
 *
 * Rule B deliberately does NOT match a declared SUPERSET such as
 * `GRAPH_KINDS` (it contains "view"/"document", which are not endpoint types),
 * nor a small intentional subset such as `GrantableKind` (< 5 members).
 *
 * Every discovered site must equal the schema union EXACTLY.
 */

/** Strip `// ...` line comments so a comment's prose (e.g. the words in a
 * doc-comment, or a stray `;`) can never be mistaken for source syntax when
 * scanning for block boundaries or string literals below. */
function stripLineComments(src: string): string {
  return src
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

function schemaUnion(): string[] {
  const clean = stripLineComments(readFileSync(SCHEMA_FILE, "utf8"));
  const start = clean.indexOf("export type LinkEndpointType =");
  if (start === -1) throw new Error("LinkEndpointType not found in schema");
  const end = clean.indexOf(";", start);
  return [...clean.slice(start, end).matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
}

const SKIP_DIRS = new Set(["node_modules", "dist", ".turbo", "build"]);

/** This scanner's own source quotes the patterns it looks for, so it would
 * otherwise discover ITSELF as a registration site. */
const SELF = fileURLToPath(import.meta.url);

/** Every `.ts` source file under `packages/`, excluding build output. */
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

interface Site {
  file: string;
  kind: "union" | "array";
  members: string[];
}

function discoverSites(union: ReadonlySet<string>): Site[] {
  const sites: Site[] = [];
  for (const file of sourceFiles()) {
    const src = stripLineComments(readFileSync(file, "utf8"));

    // Site kind A — a `LinkEndpointType` union declaration.
    let idx = src.indexOf("type LinkEndpointType =");
    while (idx !== -1) {
      const end = src.indexOf(";", idx);
      if (end !== -1) {
        sites.push({
          file,
          kind: "union",
          members: [...src.slice(idx, end).matchAll(/"([a-z_]+)"/g)].map(
            (m) => m[1]
          ),
        });
      }
      idx = src.indexOf("type LinkEndpointType =", idx + 1);
    }

    // Site kind B — a hand-copied `as const` array of endpoint-type literals.
    for (const m of src.matchAll(/=\s*\[([^[\]]*?)\]\s*as const/gs)) {
      const body = m[1];
      // Literals only — anything else (spreads, identifiers, objects) means
      // this is not a plain string list.
      if (/[^\s"',\w]/.test(body)) continue;
      const values = [...body.matchAll(/"([a-z_]+)"/g)].map((v) => v[1]);
      if (values.length < 5) continue;
      if (!values.every((v) => union.has(v))) continue;
      sites.push({ file, kind: "array", members: values });
    }
  }
  return sites;
}

describe("tripwire: LinkEndpointType SSOT (derived registration sites)", () => {
  const union = schemaUnion();
  const unionSet = new Set(union);
  const sites = discoverSites(unionSet);

  it("discovers the schema declaration plus at least two mirrors", () => {
    // Guard against a scanner that silently matches NOTHING and so passes
    // vacuously. This is a FLOOR on the discovered population, not the
    // population itself — new mirrors are found automatically.
    expect(sites.map((s) => s.file)).toContain(SCHEMA_FILE);
    expect(sites.length).toBeGreaterThanOrEqual(3);
  });

  it("every discovered site matches the schema union exactly", () => {
    const drift = sites
      .map((s) => {
        const has = new Set(s.members);
        return {
          file: s.file,
          kind: s.kind,
          missing: union.filter((t) => !has.has(t)),
          extra: s.members.filter((t) => !unionSet.has(t)),
        };
      })
      .filter((d) => d.missing.length > 0 || d.extra.length > 0);

    expect(drift).toEqual([]);
  });

  /**
   * `governance_rule` TRACKS ITS PRODUCER — in both directions.
   *
   * It was added to the union so an intent-rule could hold an edge to the
   * governance rule it produced, and then removed again in the same wave
   * because that producer was never written: it had zero producers AND zero
   * readers, while the wave's main effort was deleting exactly that shape
   * elsewhere. It was also allowlisted for Hub REST writes, so an agent could
   * have created edges nothing could interpret.
   *
   * This asserts the RELATIONSHIP rather than either state, so it needs no edit
   * when the producer lands: write a producer and the union MUST carry the
   * member; delete the producer and it must not. Pinning "absent" instead would
   * be a decision frozen into a test, and the next person would have to delete
   * an assertion to do the right thing — which is how tests come to be treated
   * as obstacles.
   */
  it("carries `governance_rule` exactly when something produces such an edge", () => {
    const PRODUCER = /(?:from|to)Type:\s*["'`]governance_rule["'`]/;
    const producers = sourceFiles().filter((file) =>
      PRODUCER.test(readFileSync(file, "utf8"))
    );
    const declared = unionSet.has("governance_rule");

    if (producers.length > 0) {
      expect(
        declared,
        `Something writes a \`governance_rule\` edge (${producers
          .map((f) => f.split("/packages/")[1] ?? f)
          .join(
            ", "
          )}) but the endpoint union does not carry it, so the write ` +
          `cannot be typed or validated. Add it to every registration site — ` +
          `the parity test above lists them.`
      ).toBe(true);
    } else {
      expect(
        declared,
        "`governance_rule` is declared as an endpoint type but NOTHING writes " +
          "such an edge and nothing reads one. A declared-but-unproduced " +
          "endpoint type is the same defect this wave removed from the " +
          "`activates` edge, one level up: it widens what an agent may write " +
          "through the Hub REST allowlist before anything can interpret it. " +
          "Land the producer in the same change, or leave the member out."
      ).toBe(false);
    }
  });
});
