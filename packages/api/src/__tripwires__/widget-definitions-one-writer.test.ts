/**
 * TRIPWIRE — `widget_definitions` has ONE authoring writer: `defineCell`.
 *
 * Two writers used to insert into this table. `defineCell` (MCP
 * `synap_create_cell`, Hub `POST /cells/define`, Cell Studio, the `cell/define`
 * approve executor) derives the rendererType, validates deps and emits
 * `widget_definition.*.completed`. The Hub `upsertWidgetDef` door and the
 * `widget/register` executor had their own `.insert(widgetDefinitions)`, which
 * skipped all three (effects map fbadd1c7 §3). Both now delegate.
 *
 * Derived, not hand-listed: every non-test `.ts` under packages/ and apps/ is
 * scanned, so a new writer anywhere is caught.
 *
 * The one allowed exception is `routers/sync.ts`: it REPLICATES rows keyed by
 * their existing id from a peer pod (not authoring; it already floors
 * trustLevel and rejects `native`, see widget-definitions.native-rejected.test).
 * That entry is pinned: if sync.ts stops inserting, the test fails so the
 * allowance cannot go stale.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import { stripComments } from "../../../../scripts/strip-comments.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "..", "..", "..", "..");
const THE_WRITER = "packages/api/src/services/cells/define-cell.ts";
const REPLICATION_EXCEPTION = "packages/api/src/routers/sync.ts";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "dist" || name === "node_modules" || name.startsWith("."))
      continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (
      name.endsWith(".ts") &&
      !name.endsWith(".d.ts") &&
      !/\.(test|spec)\./.test(name) &&
      !full.includes(`${sep}__tests__${sep}`)
    )
      out.push(full);
  }
  return out;
}

/** An INSERT into widget_definitions: drizzle call or raw SQL. */
export function insertsWidgetDefinitions(source: string): boolean {
  const code = stripComments(source, "ts");
  return (
    /\.insert\(\s*(?:\w+\.)*widgetDefinitions\s*\)/.test(code) ||
    /insert\s+into\s+"?widget_definitions"?/i.test(code)
  );
}

const scanned = [
  ...walk(join(REPO, "packages")),
  ...(statSync(join(REPO, "apps"), { throwIfNoEntry: false })
    ? walk(join(REPO, "apps"))
    : []),
];
const rel = (f: string) => relative(REPO, f).split(sep).join("/");

describe("tripwire: widget_definitions has one authoring writer", () => {
  it("only define-cell.ts (and the sync replicator) insert into it", () => {
    const writers = scanned
      .filter((f) => insertsWidgetDefinitions(readFileSync(f, "utf8")))
      .map(rel)
      .sort();
    expect(
      writers,
      "A second door inserts into widget_definitions. Route it through " +
        "defineCell (services/cells/define-cell.ts) so rendererType is derived, " +
        "deps are validated and widget_definition.*.completed is emitted."
    ).toEqual([REPLICATION_EXCEPTION, THE_WRITER].sort());
  });

  it("is not vacuous: the scan is wide and sees the real writer", () => {
    expect(scanned.length).toBeGreaterThan(500);
    expect(scanned.map(rel)).toContain(THE_WRITER);
    expect(
      insertsWidgetDefinitions(readFileSync(join(REPO, THE_WRITER), "utf8"))
    ).toBe(true);
  });

  it("the detector fires on each insert shape and ignores comments/reads", () => {
    expect(
      insertsWidgetDefinitions("await db.insert(widgetDefinitions).values(v)")
    ).toBe(true);
    expect(
      insertsWidgetDefinitions(
        "db.insert(schema.widgetDefinitions)\n.values(v)"
      )
    ).toBe(true);
    expect(
      insertsWidgetDefinitions("sql`INSERT INTO widget_definitions (x)`")
    ).toBe(true);
    expect(
      insertsWidgetDefinitions(
        "// db.insert(widgetDefinitions)\n/* insert into widget_definitions */"
      )
    ).toBe(false);
    expect(
      insertsWidgetDefinitions("db.select().from(widgetDefinitions)")
    ).toBe(false);
  });

  it("the replication exception is still real (no stale allowance)", () => {
    expect(
      insertsWidgetDefinitions(
        readFileSync(join(REPO, REPLICATION_EXCEPTION), "utf8")
      )
    ).toBe(true);
  });

  it("the Hub door and the legacy executor carry no insert of their own", () => {
    for (const f of [
      "packages/api/src/routers/hub-protocol/widget-definitions.ts",
      "packages/api/src/routers/proposals/executors/widget.ts",
    ]) {
      const code = stripComments(readFileSync(join(REPO, f), "utf8"), "ts");
      expect(code, f).not.toMatch(/onConflictDoUpdate/);
      expect(insertsWidgetDefinitions(code), f).toBe(false);
    }
  });
});
