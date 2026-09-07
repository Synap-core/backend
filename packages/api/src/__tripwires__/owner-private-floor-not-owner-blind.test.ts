import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

/**
 * TRIPWIRE — a table the access registry declares `nullWorkspaceMeans:
 * "ownerPrivate"` may never be floored with a bare `userVisibleWhere(<table>
 * .workspaceId, …)`.
 *
 * THE BUG THIS EXISTS TO PREVENT: `userVisibleWhere`'s FIRST branch is
 * `isNull(workspaceIdColumn)` — it carries no owner term at all. On a table
 * where a NULL workspace means "personal to the owner", that admits EVERY
 * user's private rows to EVERY authenticated pod user. `ownerPrivateVisibleWhere`
 * is the fix and has existed for a while; what was missing was ADOPTION. When
 * this file was written, ~20 hand-built queries over `entities`, `views` and
 * `focus_sessions` still called the owner-blind helper — including two that
 * wrote `eq(userId) OR userVisibleWhere(...)` and read as owner-gated while the
 * OR only WIDENED an already-owner-blind predicate.
 *
 * THE TABLE LIST IS DERIVED, NEVER HAND-MAINTAINED. It is parsed out of
 * `access/registry.ts`'s own `nullWorkspaceMeans` declarations, so classifying a
 * new table as ownerPrivate arms this scan for it in the same commit, and
 * reclassifying one disarms it — there is no second list to drift. A
 * hand-written table list is the exact defect class this repo keeps paying for.
 *
 * NON-VACUITY IS ASSERTED. A source scan that silently matches nothing reads
 * green forever. This one fails loudly if the registry yields no ownerPrivate
 * tables, if no source file mentions the helper at all, or if the corpus of
 * files it walked is implausibly small.
 *
 * SCOPE: `api/src` AND `database/src`, tests excluded, with NO per-package
 * exemption. The helper used to live in `@synap/api` and this scan used to skip
 * `@synap/database` for that reason — but the two owner-gated reads inside
 * `@synap/database` (`services/team-person-bridge.ts`,
 * `utils/entity-project-membership.ts`) had hand-inlined the same predicate, so
 * the "necessity" exemption was covering exactly the drift the scan exists to
 * catch: a guard whose escape hatch is shaped like its own defect. The helper
 * now lives in `@synap/database/utils/user-visible-where.ts` and both packages
 * are judged by the same rule.
 */

const API_SRC = join(__dirname, "..");
const DATABASE_SRC = join(API_SRC, "../../database/src");
const SCAN_ROOTS = [API_SRC, DATABASE_SRC];
const REGISTRY = join(API_SRC, "access/registry.ts");

/**
 * Tables that are `ownerPrivate` yet legitimately keep a NON-owner-gated
 * predicate, each with the reason the registry itself states. This is a
 * SUBSET-of-derived exemption, not a parallel list: the test below asserts every
 * entry is actually declared ownerPrivate AND that the registry still documents
 * the alternative predicate, so a silent reclassification cannot leave a stale
 * hole behind.
 */
const EXEMPT: Record<string, { predicate: string; why: string }> = {
  channels: {
    predicate: "channelVisibilityWhere",
    why: "A NULL-workspace PERSONAL channel is owner-private, but a shared-TYPE NULL channel is legitimately pod-wide. `ownerPrivateVisibleWhere` would over-restrict and hide shared channels.",
  },
};

/** Parse `nullWorkspaceMeans: "ownerPrivate"` blocks out of the registry. */
function deriveOwnerPrivateTables(): string[] {
  const src = readFileSync(REGISTRY, "utf8");
  const out: string[] = [];
  // Each declaration is `registerVisibility({ table: X, … })`; take the nearest
  // preceding `table:` for every ownerPrivate marker.
  const blocks = src.split("registerVisibility({").slice(1);
  for (const block of blocks) {
    if (!/nullWorkspaceMeans:\s*"ownerPrivate"/.test(block)) continue;
    const m = /^\s*table:\s*(\w+)\s*,/m.exec(block);
    if (m) out.push(m[1]);
  }
  return [...new Set(out)];
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "node_modules" || name === "dist") continue;
      walk(p, acc);
    } else if (
      name.endsWith(".ts") &&
      !name.endsWith(".test.ts") &&
      !name.endsWith(".d.ts")
    ) {
      acc.push(p);
    }
  }
  return acc;
}

/**
 * Local aliases for a schema table (`import { entities as entitiesTable }`), so
 * `userVisibleWhere(entitiesTable.workspaceId, …)` is not invisible to the scan.
 * `capture.ts` uses exactly that alias, and it held five of the swapped sites.
 */
function aliasesFor(source: string, table: string): string[] {
  const names = [table];
  const re = new RegExp(`\\b${table}\\s+as\\s+(\\w+)`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) names.push(m[1]);
  return names;
}

describe("TRIPWIRE: ownerPrivate tables are never floored owner-blind", () => {
  const ownerPrivate = deriveOwnerPrivateTables();
  const files = SCAN_ROOTS.flatMap((root) => walk(root));

  it("derives a non-empty ownerPrivate table set from the registry", () => {
    // NON-VACUITY: if the parse breaks (registry reformatted, marker renamed),
    // the scan below would judge nothing and pass. Fail here instead.
    expect(ownerPrivate.length).toBeGreaterThanOrEqual(5);
    // Anchors: the three tables whose leaks motivated this file. `projects` and
    // `views` were UNDECLARED until the same wave that wrote this test.
    expect(ownerPrivate).toContain("entities");
    expect(ownerPrivate).toContain("focusSessions");
    expect(ownerPrivate).toContain("projects");
    expect(ownerPrivate).toContain("views");
  });

  it("exempts only tables the registry itself declares and justifies", () => {
    const registrySrc = readFileSync(REGISTRY, "utf8");
    for (const [table, { predicate }] of Object.entries(EXEMPT)) {
      // A stale exemption for a table nobody calls ownerPrivate any more is a
      // hole with no owner — force it to be deleted.
      expect(ownerPrivate).toContain(table);
      // …and the registry must still say the alternative predicate is the one.
      expect(registrySrc).toContain(predicate);
    }
  });

  it("walks a plausible api/src + database/src corpus", () => {
    // NON-VACUITY: a broken walk (wrong root, over-eager filter) yields zero
    // files and zero violations.
    expect(files.length).toBeGreaterThan(200);
    // NON-VACUITY per ROOT: a mis-resolved DATABASE_SRC would silently walk
    // nothing and re-create the very exemption this widening removed.
    for (const root of SCAN_ROOTS) {
      expect(
        files.filter((f) => f.startsWith(root + "/")).length,
        `scan root contributed zero files: ${root}`
      ).toBeGreaterThan(20);
    }
    const mentioning = files.filter((f) =>
      readFileSync(f, "utf8").includes("userVisibleWhere(")
    );
    expect(mentioning.length).toBeGreaterThan(10);
  });

  it("finds no bare userVisibleWhere(<ownerPrivate>.workspaceId, …)", () => {
    const scanned = ownerPrivate.filter((t) => !(t in EXEMPT));
    // NON-VACUITY: every exemption must leave real tables to judge.
    expect(scanned.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      if (!src.includes("userVisibleWhere(")) continue;
      const lines = src.split("\n");
      for (const table of scanned) {
        for (const name of aliasesFor(src, table)) {
          // `(?<!ownerPrivate)` so the FIX does not trip its own tripwire.
          const re = new RegExp(
            `(?<!ownerPrivate)\\buserVisibleWhere\\(\\s*\\n?\\s*${name}\\.workspaceId`
          );
          lines.forEach((line, i) => {
            // Match on the joined 2-line window so a wrapped call is seen too.
            const window = line + "\n" + (lines[i + 1] ?? "");
            if (!re.test(window)) return;
            // Only report the line that actually opens the call.
            if (!/userVisibleWhere\(/.test(line)) return;
            violations.push(
              `${relative(join(API_SRC, "../.."), file)}:${i + 1} — userVisibleWhere(${name}.workspaceId, …) on ownerPrivate table \`${table}\``
            );
          });
        }
      }
    }

    expect(
      violations,
      [
        "An ownerPrivate table is floored with the OWNER-BLIND `userVisibleWhere`.",
        "Its `isNull(workspaceId)` branch has no owner term, so every user's",
        "pod-personal rows are visible to every pod user. Use",
        "`ownerPrivateVisibleWhere(<t>.workspaceId, <t>.userId, userId)` from",
        "`utils/user-visible-where.js` (or `accessScopeWhere` for the entity",
        "graph). Adding `eq(userId) OR …` around the bare helper does NOT fix it —",
        "the OR widens, it does not gate.",
        "",
        ...violations,
      ].join("\n")
    ).toEqual([]);
  });
});
