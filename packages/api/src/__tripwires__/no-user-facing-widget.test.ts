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
 * `widgetType` block field and the `"widget"` block kind (P5 renames the
 * block shape), `SynapWidget` (the deprecated frame global), the
 * `iframe-widget` and `native-widget` keys, the `generate_widget` IS tool,
 * the `widget-catalog` topic stem, and the glossary's own prohibition
 * ("never Widget").
 *
 * WHAT IT DOES NOT SEE, stated rather than implied: error strings and other
 * literals in `packages/api/src` (they are not a derived text set; the ones an
 * agent reads were renamed by hand in the same change), pod admin JSX outside
 * `copy.ts`, and every sibling repo (synap-app, browser, relay, CLI, IS:
 * their own pass).
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
  /\bsynap_list_widgets\b/g,
  /\blist_widgets\b/g,
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

  it("non-vacuity: the derived set holds what it claims", () => {
    expect(skillFiles.length).toBeGreaterThan(80);
    expect(skillFiles.map((f) => relative(REPO, f))).toContain(
      "skills/synap-ui/widget-catalog.md"
    );
    expect(copyFiles.map((f) => relative(REPO, f))).toContain(
      "apps/pod-admin/app/open/copy.ts"
    );
    expect(catalogFiles.length).toBeGreaterThanOrEqual(2);
    const texts = manifestTexts();
    expect(texts.length).toBeGreaterThan(500);
    expect(texts.map((t) => t.where)).toContain("synap_list_cells.title");
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
});
