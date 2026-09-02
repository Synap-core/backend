import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

/**
 * TRIPWIRE — every owner-private kind in the object-graph `KIND_TABLE` must get
 * an explicit OWNER-AWARE read floor in `hydrationScopeWhere`, never the default.
 *
 * THE BUG THIS EXISTS TO PREVENT (found 2026-07-27, confirmed in source):
 * `hydrateNodes`' default floor is `workspaceLensWhere`, which bottoms out in
 * `userVisibleWhere`, whose `isNull(workspaceId)` branch is OWNER-BLIND — it
 * carries no `user_id` term at all. On a table where NULL workspace means
 * "personal to the owner", that admits EVERY user's private rows to EVERY
 * authenticated pod user. `document`, `session`, `channel`, `project` and `view`
 * were all exposed this way through three doors at once: tRPC
 * `graph.getObjectGraph`, Hub REST, and the MCP `synap_get_graph` tool.
 *
 * It was not a one-off: `entity` and `agent` had already been patched with
 * bespoke floors reactively, each after its own leak. Seven occurrences of one
 * shape is a missing invariant, so this asserts the invariant rather than the
 * instances — the NEXT kind added to KIND_TABLE cannot reintroduce it silently.
 *
 * TWO THINGS THIS DELIBERATELY DOES NOT DO, both learned from a review that
 * caught this file giving a false pass:
 *   1. It does not merely check that a `case` EXISTS. `case "project": return
 *      workspaceLensWhere(...)` is exactly the bug wearing a case label, so the
 *      case BODY must name an approved owner-aware predicate.
 *   2. It does not trust `access/registry.ts` alone to enumerate owner-private
 *      tables. `projects` and `views` have NO registered rule yet are
 *      owner-private in behaviour — unclassified is not the same as safe.
 *      (`focus_sessions` was a third such table until 0241's temporal fold made
 *      sessions graph neighbours and forced it to be declared.)
 *      Candidates are therefore derived from the SCHEMA shape (nullable
 *      `workspace_id` + a NOT NULL owner column), so a new table is caught on
 *      arrival rather than when someone remembers to register it.
 *
 * Source-parsing (not runtime) on purpose: it must fail in CI without a database,
 * and it must catch the omission at the point of EDIT rather than at exploit time.
 */

const API_SRC = join(__dirname, "..");
const DB_SCHEMA = join(API_SRC, "../../database/src/schema");
const GRAPH_SERVICE = join(API_SRC, "services/object-graph/graph-service.ts");
const REGISTRY = join(API_SRC, "access/registry.ts");

/**
 * Predicates that actually gate the NULL-workspace branch by owner. A case body
 * naming one of these is accepted; anything else (notably `workspaceLensWhere`)
 * is treated as unsafe for an owner-private table.
 */
const OWNER_AWARE_PREDICATES = [
  "ownerPrivateVisibleWhere",
  "accessScopeWhere",
  "channelVisibilityWhere",
];

/**
 * Kinds whose table has no `workspaceId` column at all, so the owner-private
 * question does not apply — they carry their own bespoke floors.
 */
const NO_WORKSPACE_COLUMN = new Set(["workspace", "agent"]);

/**
 * Tables the schema-shape heuristic flags as possibly owner-private, but which
 * have NO `VisibilityRule` — so nobody has ever declared what a NULL workspace
 * MEANS for them. That is an open question, not a resolved one.
 *
 * They are parked here rather than force-floored because guessing either way is
 * a real change: `skills` are ~141 pod-wide teaching docs and `capabilities` are
 * shared tool bundles, so applying an owner-gate would HIDE legitimately shared
 * rows (a functional regression), while leaving them bare would expose personal
 * ones if that is what NULL actually means. Resolving it requires a product call
 * + a `registerVisibility` entry — at which point the entry below is deleted and
 * the registry answers automatically.
 *
 * SHRINK-ONLY. Adding a table here to silence a failure re-introduces the exact
 * "enumerate instead of detect" defect this file exists to prevent; the count
 * assertion below enforces that.
 */
const UNCLASSIFIED_PENDING_REGISTRY = new Set(["skills", "capabilities"]);

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** `kind: { table: identifier, ... }` inside the KIND_TABLE object literal. */
function parseKindTable(src: string): Map<string, string> {
  const start = src.indexOf("const KIND_TABLE");
  expect(
    start,
    "KIND_TABLE not found — did graph-service.ts move?"
  ).toBeGreaterThan(-1);
  const body = src.slice(start, src.indexOf("\n};", start));
  const out = new Map<string, string>();
  for (const m of body.matchAll(/^\s*(\w+):\s*\{[^}]*?table:\s*(\w+)/gms)) {
    out.set(m[1], m[2]);
  }
  return out;
}

/**
 * Registry classification of what a NULL workspace MEANS per table.
 *
 * The registry is AUTHORITATIVE where it has spoken: `podGlobalConfig` is a
 * deliberate declaration that NULL rows are genuinely pod-wide (playbooks, tools,
 * skills…), and the owner-blind floor is the INTENDED semantics there. The
 * schema-shape heuristic must not second-guess it — those tables also have a
 * nullable workspace_id and a NOT NULL `createdBy`, so shape alone would flag
 * them and the tripwire would cry wolf on correct code.
 *
 * Shape is therefore the fallback for tables the registry has NOT classified —
 * where "unclassified" must not be silently read as "safe".
 */
function parseRegistryClassification(src: string): {
  ownerPrivate: Set<string>;
  classified: Set<string>;
} {
  const ownerPrivate = new Set<string>();
  const classified = new Set<string>();
  for (const block of src.split("registerVisibility({").slice(1)) {
    const table = block.match(/^\s*table:\s*(\w+)/m)?.[1];
    if (!table) continue;
    const means = block.match(/nullWorkspaceMeans:\s*"(\w+)"/)?.[1];
    if (!means) continue;
    classified.add(table);
    if (means === "ownerPrivate") ownerPrivate.add(table);
  }
  return { ownerPrivate, classified };
}

/**
 * Owner columns that can carry the "personal to this user" semantics. `userId`
 * is the common one; `createdBy` is the shape playbooks/capabilities/tools use.
 * Those are `podGlobalConfig` today so it is not a live hole — but if one is ever
 * reclassified, the heuristic must notice rather than stay silent.
 */
const OWNER_COLUMNS = ["userId", "createdBy", "ownerId"];

/**
 * Every Drizzle table const in the schema package → its declaration body.
 *
 * Globbed, NOT a hand-listed set of files. A review caught the first two versions
 * of this test ENUMERATING what to check (first a Set of tables, then a list of
 * filenames) — each time, a new table simply wasn't in the list, needed no case,
 * took the unsafe default, and every test stayed green. Enumerating is the bug
 * this file exists to catch, so it must not be how the file works.
 */
function loadSchemaBodies(): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of readdirSync(DB_SCHEMA)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    const src = read(join(DB_SCHEMA, file));
    for (const m of src.matchAll(/export const (\w+) = pgTable\(/g)) {
      const end = src.indexOf("\n);", m.index!);
      out.set(m[1], src.slice(m.index!, end === -1 ? undefined : end));
    }
  }
  return out;
}

/**
 * Owner-private SHAPE: a nullable `workspace_id` (personal rows are possible)
 * AND a NOT NULL owner column (there is someone to gate on).
 */
function isOwnerPrivateByShape(body: string | undefined): boolean {
  if (!body) return false;
  const wsLine = body.match(/^\s*workspaceId:.*$/m)?.[0] ?? "";
  if (wsLine === "" || /notNull\(\)/.test(wsLine)) return false;
  return OWNER_COLUMNS.some((col) => {
    const line = body.match(new RegExp(`^\\s*${col}:.*$`, "m"))?.[0] ?? "";
    return /notNull\(\)/.test(line);
  });
}

/**
 * Strip `//` line comments. Without this, a case that RETURNS the unsafe
 * `workspaceLensWhere` but merely mentions `ownerPrivateVisibleWhere` in an
 * explanatory comment would satisfy the content assertions below — the comment
 * would vouch for code that does the opposite.
 */
function stripLineComments(src: string): string {
  return src
    .split("\n")
    .map((l) => {
      const i = l.indexOf("//");
      return i === -1 ? l : l.slice(0, i);
    })
    .join("\n");
}

/** Case label → the source text of that case's body, from hydrationScopeWhere. */
function parseCaseBodies(src: string): Map<string, string> {
  const start = src.indexOf("function hydrationScopeWhere");
  expect(
    start,
    "hydrationScopeWhere not found — the floor helper was renamed or inlined"
  ).toBeGreaterThan(-1);
  const fn = src.slice(
    start,
    src.indexOf("\n}", src.indexOf("default:", start))
  );
  const out = new Map<string, string>();
  const labels = [...fn.matchAll(/case\s+"(\w+)":/g)];
  labels.forEach((m, i) => {
    const from = m.index! + m[0].length;
    const to =
      i + 1 < labels.length ? labels[i + 1].index! : fn.indexOf("default:");
    // Comments stripped: only executable source may satisfy the assertions.
    out.set(m[1], stripLineComments(fn.slice(from, to)));
  });
  return out;
}

describe("TRIPWIRE: object-graph hydration read floor", () => {
  const graphSrc = read(GRAPH_SERVICE);
  const kindTable = parseKindTable(graphSrc);
  const { ownerPrivate, classified } = parseRegistryClassification(
    read(REGISTRY)
  );
  const cases = parseCaseBodies(graphSrc);
  const schemaBodies = loadSchemaBodies();

  const ownerPrivateKinds = [...kindTable.entries()].filter(([kind, table]) => {
    if (NO_WORKSPACE_COLUMN.has(kind)) return false;
    if (UNCLASSIFIED_PENDING_REGISTRY.has(table)) return false;
    // Registry wins where it has spoken; shape only judges the unclassified.
    if (classified.has(table)) return ownerPrivate.has(table);
    return isOwnerPrivateByShape(schemaBodies.get(table));
  });

  it("parses non-trivially (guards against a silently-empty scan)", () => {
    expect(kindTable.size).toBeGreaterThanOrEqual(10);
    expect(cases.size).toBeGreaterThanOrEqual(5);
    expect(ownerPrivateKinds.length).toBeGreaterThanOrEqual(5);
  });

  it("floors every owner-private kind with an OWNER-AWARE predicate", () => {
    const bad = ownerPrivateKinds
      .filter(([kind]) => {
        const body = cases.get(kind);
        if (body === undefined) return true; // falls to the unsafe default
        return !OWNER_AWARE_PREDICATES.some((p) => body.includes(p));
      })
      .map(([kind, table]) => `${kind} (${table})`);

    expect(
      bad,
      `These KIND_TABLE kinds are owner-private but do NOT apply an owner-aware ` +
        `floor in hydrationScopeWhere. The default (and any body using only ` +
        `workspaceLensWhere) bottoms out in userVisibleWhere, whose ` +
        `isNull(workspaceId) branch has no user_id term — every user's private ` +
        `rows become readable by every pod user through graph.getObjectGraph, ` +
        `Hub REST and synap_get_graph.\n` +
        `Use one of: ${OWNER_AWARE_PREDICATES.join(" | ")}.`
    ).toEqual([]);
  });

  it("keeps every owner-private kind honouring the workspace lens", () => {
    // The owner-aware helpers carry NO workspace dimension, so dropping the lens
    // silently widens a workspace-scoped query to every workspace the caller can
    // see. `entity` threads it via accessScopeWhere's own `workspaceLens`.
    const unlensed = ownerPrivateKinds
      .filter(([kind]) => {
        const body = cases.get(kind) ?? "";
        return (
          !body.includes("lensNarrowing") && !body.includes("workspaceLens")
        );
      })
      .map(([kind]) => kind);

    expect(
      unlensed,
      `These kinds apply an owner floor but no workspace-lens narrowing, so a ` +
        `lensed graph query would hydrate rows from OTHER workspaces. AND in ` +
        `lensNarrowing(<table>.workspaceId, workspaceId) — an AND can only ` +
        `narrow, so it cannot reopen the owner hole.`
    ).toEqual([]);
  });

  it("does not grow the unclassified-table backlog", () => {
    // Shrink-only. If a NEW table needs parking here to go green, the honest move
    // is a `registerVisibility` entry declaring what its NULL workspace means —
    // not another exemption. Every entry is an unanswered access-control question.
    expect(
      UNCLASSIFIED_PENDING_REGISTRY.size,
      `Parking a table here silences the owner-private check for it. Register a ` +
        `VisibilityRule with an explicit nullWorkspaceMeans instead.`
    ).toBeLessThanOrEqual(2);

    // And they must still be genuinely unregistered — once a rule lands, delete
    // the entry so the registry (not this list) is the answer.
    for (const table of UNCLASSIFIED_PENDING_REGISTRY) {
      expect(
        classified.has(table),
        `${table} now HAS a VisibilityRule — remove it from ` +
          `UNCLASSIFIED_PENDING_REGISTRY so the registry governs it.`
      ).toBe(false);
    }
  });

  it("does not floor channels with the blanket owner-gate", () => {
    // Channels have legitimate shared-TYPE NULL rows that must stay pod-wide;
    // ownerPrivateVisibleWhere would wrongly hide them.
    const body = cases.get("channel") ?? "";
    expect(body).toContain("channelVisibilityWhere");
    expect(body).not.toContain("ownerPrivateVisibleWhere");
  });
});
