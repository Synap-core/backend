/**
 * TRIPWIRE — no person or agent reads the word "widget" (founder, 23 Nov
 * 2026: the word is Cell, for users and agents alike; "card" is only a
 * renderer slot).
 *
 * The scanned set is DERIVED, so a new file joins it by existing:
 *   - every skill SOURCE under `skills/` (`*.md` but the assembled `SKILL.md`,
 *     which is built from them, plus `_skill.yaml` and `_teaching.json`):
 *     what agents load;
 *   - every title and description of the committed MCP manifest
 *     (`mcp-tools.manifest.json`, the projection of `tools/index.ts` the
 *     freshness tripwire keeps current): what every agent is told;
 *   - every pod admin `copy.ts`: the words a person reads in pod admin;
 *   - the vocabulary catalogs (`packages/types/src/vocabulary/catalog.*.ts`):
 *     the one door every surface names a kind through.
 *
 * ALLOWED (stripped before the scan): the names that must keep working while
 * the old word retires, each a wire value or an alias, never prose:
 * `synap_list_widgets` / `list_widgets` (the MCP alias of synap_list_cells),
 * the `/widget-definitions` route and `widget_definitions` table, the
 * `widgetType` block field and the `"widget"` block kind (a later change renames the
 * block shape), `SynapWidget` (the deprecated frame global), the
 * `iframe-widget` and `native-widget` keys, the `generate_widget` IS tool,
 * the `widget-catalog` topic stem, and the glossary's own prohibition
 * ("never Widget").
 *
 * THE OLD TOOL NAME. `\bwidgets?\b` never sees `synap_list_widgets` (the
 * underscore is a word character), so an agent told to "call
 * synap_list_widgets" passed. A second detector finds the old tool name
 * (`synap_list_widgets`, `list_widgets`) in PROSE: a manifest description,
 * a skill, a copy or catalog line, or a string literal of `packages/api/src`
 * or `packages/types/src` that holds other words beside it. A literal that IS
 * the name (an alias table key, a door-name row, a profile list) is a wire
 * value and passes; the alias tables (`tool-aliases.ts`,
 * `tool-verb-aliases.ts`) are not scanned at all.
 *
 * WHAT IT DOES NOT SEE, stated rather than implied: "widget" in error strings
 * and other literals of `packages/api/src` (only the old TOOL NAME is
 * scanned there), a literal split over a `+` concatenation, a comment line
 * (skipped: `//`, `*`, `/*`), pod admin JSX outside `copy.ts`, and every
 * sibling repo (synap-app, browser, relay, CLI, IS: their own pass).
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");
const SKILLS = join(REPO, "skills");
const POD_ADMIN = join(REPO, "apps/pod-admin");
const VOCABULARY = join(REPO, "packages/types/src/vocabulary");
const MANIFEST = join(
  REPO,
  "packages/api/src/routers/mcp/tools/mcp-tools.manifest.json"
);

/** The retired word, singular or plural, any case. */
const WIDGET = /\bwidgets?\b/i;

/** Wire values and aliases that keep the old spelling on purpose. */
const ALLOWED: readonly RegExp[] = [
  /\bwidget-definitions\b/g,
  /\bwidget_definitions\b/g,
  /\bwidgetType\b/g,
  /SynapWidget/g,
  /["'`]widgets?["'`]/g,
  /\biframe-widget\b/g,
  /\bnative-widget\b/g,
  /\bgenerate_widget\b/g,
  /\bwidget-catalog\b/g,
  /\bnever Widget\b/g,
];

/** The old tool name (and its teaching key), wherever it stands. */
const OLD_TOOL = /\b(?:synap_)?list_widgets\b/;

/** The lines of `text` that tell a reader to use the old tool name. */
function oldToolLines(text: string): string[] {
  return text.split("\n").filter((line) => OLD_TOOL.test(line));
}

/**
 * The string literals of a TS source that say the old tool name in prose
 * (with other words beside it). Comment lines are skipped; a literal that is
 * exactly the name is a wire value.
 */
function oldToolLiterals(source: string): string[] {
  const code = source
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join("\n");
  const literals =
    code.match(
      /`(?:[^`\\]|\\[\s\S])*`|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g
    ) ?? [];
  return literals.filter(
    (literal) => OLD_TOOL.test(literal) && /\s/.test(literal.slice(1, -1))
  );
}

/** The lines of `text` that still say "widget" once the allowed names are stripped. */
function widgetLines(text: string): string[] {
  return text.split("\n").filter((line) => {
    let rest = line;
    for (const allowed of ALLOWED) rest = rest.replace(allowed, "");
    return WIDGET.test(rest);
  });
}

function filesUnder(dir: string, keep: (name: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(path, keep));
    else if (keep(entry.name)) out.push(path);
  }
  return out;
}

const skillFiles = filesUnder(
  SKILLS,
  (name) =>
    name !== "SKILL.md" &&
    (name.endsWith(".md") ||
      name === "_skill.yaml" ||
      name === "_teaching.json")
);
const copyFiles = filesUnder(POD_ADMIN, (name) => name === "copy.ts");
/** The TS sources whose literals reach agents and people (tests excluded). */
const ALIAS_TABLES = new Set(["tool-aliases.ts", "tool-verb-aliases.ts"]);
const sourceFiles = ["packages/api/src", "packages/types/src"].flatMap((dir) =>
  filesUnder(
    join(REPO, dir),
    (name) =>
      /\.tsx?$/.test(name) &&
      !/\.test\.tsx?$/.test(name) &&
      !name.endsWith(".d.ts") &&
      !ALIAS_TABLES.has(name)
  )
);

/**
 * KNOWN, a ledger that only shrinks: texts that still name the old tool and
 * belong to an open change. Both MCP descriptions and the bento view type's
 * blurb are lines of backend#1286 (the bento catalog), which owns them; its
 * lane renames them and lowers this ledger. Exact, so a stale entry fails.
 */
const KNOWN_MANIFEST = [
  "synap_create_view.description",
  "synap_update_view.description",
];
const KNOWN_SOURCE: Record<string, number> = {
  "packages/api/src/routers/mcp/tools/index.ts": 2,
  "packages/types/src/renderables/views.ts": 1,
};
const catalogFiles = readdirSync(VOCABULARY)
  .filter((name) => /^catalog\.[a-z]+\.ts$/.test(name))
  .map((name) => join(VOCABULARY, name));

/** Every title and description in the manifest, wherever it is nested. */
function manifestTexts(): Array<{ where: string; text: string }> {
  const out: Array<{ where: string; text: string }> = [];
  const walk = (node: unknown, where: string) => {
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, `${where}[${i}]`));
    } else if (node && typeof node === "object") {
      const record = node as Record<string, unknown>;
      const name = typeof record.name === "string" ? record.name : where;
      for (const [key, value] of Object.entries(record)) {
        if (
          (key === "description" || key === "title") &&
          typeof value === "string"
        )
          out.push({ where: `${name}.${key}`, text: value });
        else walk(value, `${name}.${key}`);
      }
    }
  };
  walk(JSON.parse(readFileSync(MANIFEST, "utf8")).tools, "tools");
  return out;
}

describe("tripwire: no user- or agent-facing 'widget'", () => {
  it("SELF-CHECK: the detector fires on the prose it retired, and lets the wire names through", () => {
    expect(widgetLines("Arrange widgets on a bento.")).toHaveLength(1);
    expect(widgetLines("List compose widgets")).toHaveLength(1);
    expect(
      widgetLines("A dashboard of {n, plural, one {# widget}}")
    ).toHaveLength(1);
    expect(
      widgetLines(
        'Call synap_list_widgets (GET /widget-definitions); a block is {kind: "widget", widgetType}.'
      )
    ).toEqual([]);
  });

  it("SELF-CHECK: the old tool name is found in prose, and passes as a wire value", () => {
    expect(oldToolLines("Call synap_list_widgets for the keys.")).toHaveLength(
      1
    );
    expect(
      oldToolLiterals(
        'const a = "a cell type key: synap_list_widgets";\nconst b = `see list_widgets`;'
      )
    ).toHaveLength(2);
    expect(
      oldToolLiterals(
        'synap_list_widgets: "synap_list_cells",\n  "pod-mcp": "synap_list_widgets",\n// call synap_list_widgets'
      )
    ).toEqual([]);
  });

  it("non-vacuity: the derived set holds what it claims", () => {
    expect(skillFiles.length).toBeGreaterThan(80);
    expect(skillFiles.map((f) => relative(REPO, f))).toContain(
      "skills/synap-ui/widget-catalog.md"
    );
    expect(copyFiles.map((f) => relative(REPO, f))).toContain(
      "apps/pod-admin/app/open/copy.ts"
    );
    expect(catalogFiles.length).toBeGreaterThanOrEqual(2);
    const sources = sourceFiles.map((f) => relative(REPO, f));
    expect(sources.length).toBeGreaterThan(1000);
    expect(sources).toContain("packages/api/src/services/surfaces/create.ts");
    expect(sources).not.toContain("packages/api/src/routers/mcp/tool-aliases.ts");
    const texts = manifestTexts();
    expect(texts.length).toBeGreaterThan(500);
    expect(texts.map((t) => t.where)).toContain("synap_list_cells.description");
  });

  it("no skill source, pod admin copy or vocabulary catalog says widget", () => {
    const offenders = [...skillFiles, ...copyFiles, ...catalogFiles].flatMap(
      (file) =>
        widgetLines(readFileSync(file, "utf8")).map(
          (line) => `${relative(REPO, file)}: ${line.trim().slice(0, 160)}`
        )
    );
    expect(
      offenders,
      'Say "cell" (founder, 23 Nov 2026). A wire value or alias that must keep the old spelling goes in ALLOWED, with its reason.'
    ).toEqual([]);
  });

  it("no MCP tool title or description says widget", () => {
    const offenders = manifestTexts()
      .filter((t) => widgetLines(t.text).length > 0)
      .map((t) => `${t.where}: ${t.text.slice(0, 160)}`);
    expect(offenders).toEqual([]);
  });

  it("no MCP description, skill, copy or catalog tells a reader to call the old tool name", () => {
    const manifest = manifestTexts()
      .filter((t) => oldToolLines(t.text).length > 0)
      .map((t) => t.where);
    expect(
      manifest.filter((where) => !KNOWN_MANIFEST.includes(where)),
      "Name synap_list_cells: synap_list_widgets is only its alias."
    ).toEqual([]);
    expect(manifest.sort(), "KNOWN_MANIFEST only shrinks").toEqual(
      [...KNOWN_MANIFEST].sort()
    );
    const texts = [...skillFiles, ...copyFiles, ...catalogFiles].flatMap(
      (file) =>
        oldToolLines(readFileSync(file, "utf8")).map(
          (line) => `${relative(REPO, file)}: ${line.trim().slice(0, 160)}`
        )
    );
    expect(texts).toEqual([]);
  });

  it("no string literal of the api or types source names the old tool in prose", () => {
    const counts: Record<string, number> = {};
    for (const file of sourceFiles) {
      const n = oldToolLiterals(readFileSync(file, "utf8")).length;
      if (n > 0) counts[relative(REPO, file)] = n;
    }
    expect(
      counts,
      "Name synap_list_cells: synap_list_widgets is only its alias. A ledger entry only shrinks."
    ).toEqual(KNOWN_SOURCE);
  });
});
