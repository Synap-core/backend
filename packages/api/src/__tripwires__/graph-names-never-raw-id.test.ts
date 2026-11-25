import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { stripComments } from "../../../../scripts/strip-comments.mjs";

/**
 * TRIPWIRE: the object graph never names a node by its raw id.
 *
 * Every reader (browser, relay, an agent's `get_graph`) shows a neighbour's
 * `name`. A `name: x ?? id` fallback put `51dd9623-d895-…` on a node page as a
 * session's name (finding 80cc8e12; round 1 of the UI consolidation wave, PR
 * #1236), and four more such fallbacks were left in `graph-service.ts`, each
 * caught only downstream by the shared connections model. The doors to use
 * instead: `resolvePrivateObjectLabel(kind)` for a far end the reader may not
 * see, `resolveObjectNoun(kind)` for one with nothing to read a name from,
 * `isMachineToken` to tell a machine id from a readable handle.
 *
 * THE SCAN SET IS DERIVED: every non-test `.ts` file of
 * `services/object-graph/`, plus every non-test `.ts` file under
 * `packages/api/src` that names the `GraphNeighbor` or `GraphNode` type (the
 * read models that build graph nodes). A new file joins by existing.
 *
 * WHAT IT FLAGS: in a display-name expression (an object key or a `const`/`let`
 * named `name`, `title`, `label` or `displayName`, read up to its `,` / `;` /
 * closing bracket at depth 0, over several lines), an id-shaped operand: `id`,
 * `<x>.id` or `<x>Id` as the whole expression, or after `??`, `||`, a ternary
 * `?` / `:`, or `${`, and not called or indexed (`.slice()` / `.substring()` on
 * it still counts).
 *
 * WHAT IT DOES NOT SEE (stated, so nobody reads coverage into it):
 *   - an id passed through a helper (`name: f(kind, id)`): the helper's own
 *     body is not a name expression. `stubNodeName` is such a helper; it reaches
 *     the id only behind `isMachineToken`.
 *   - an id under another variable name (`const handle = r.id; name: handle`).
 *   - a name expression whose key is none of the four above.
 * Granularity is the expression: run against `graph-service.ts` as it was
 * before this guard (negative control), it lists each of the four fallbacks it
 * replaced on its own line.
 */

const API_SRC = join(__dirname, "..");
const OBJECT_GRAPH = join(API_SRC, "services/object-graph");

const isSource = (f: string) =>
  f.endsWith(".ts") && !/\.test\.ts$|\.d\.ts$/.test(f);

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === "__tests__" || e.name === "__tripwires__") return [];
    const p = join(dir, e.name);
    return e.isDirectory() ? walk(p) : isSource(e.name) ? [p] : [];
  });
}

const NAME_KEY =
  /(?:(?<=^|[\s{,(])(?:name|title|label|displayName)\s*:(?!:)|\b(?:const|let)\s+(?:name|title|label|displayName)\s*(?::[^=\n]+)?=(?!=))/g;

/** The expression after a name key: up to `,` / `;` / an unbalanced close. */
function expressionAt(src: string, start: number): string {
  let depth = 0;
  let i = start;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'") {
      for (i++; i < src.length && src[i] !== ch && src[i] !== "\n"; i++) {
        if (src[i] === "\\") i++;
      }
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) break;
      depth--;
    } else if ((ch === "," || ch === ";") && depth === 0) break;
  }
  return src.slice(start, i);
}

const ID_OPERAND =
  /(?:^|\?\?|\|\||(?<!\?)\?(?![?.])|:|\$\{)\s*\(?\s*((?:[A-Za-z_$][\w$]*\??\.)*(?:id|[a-z][\w$]*Id))(?![\w$])(?!\s*[([])(?!\s*\??\.(?!(?:slice|substring|substr)\b))/;

/** Every display-name expression of `source`, and the ones naming by id. */
function scan(source: string) {
  const src = stripComments(source, "ts");
  const hits: { line: number; expr: string }[] = [];
  let scanned = 0;
  for (const m of src.matchAll(NAME_KEY)) {
    const expr = expressionAt(src, m.index! + m[0].length).trim();
    scanned++;
    if (ID_OPERAND.test(expr)) {
      hits.push({
        line: src.slice(0, m.index).split("\n").length,
        expr: expr.replace(/\s+/g, " ").slice(0, 140),
      });
    }
  }
  return { scanned, hits };
}

const FILES = [
  ...new Set([
    ...walk(OBJECT_GRAPH),
    ...walk(API_SRC).filter((f) =>
      /\bGraph(?:Neighbor|Node)\b/.test(readFileSync(f, "utf8"))
    ),
  ]),
].sort();

describe("graph read models never name a node by its raw id", () => {
  it("the scanner sees what it hunts (self-check)", () => {
    const flagged = [
      "const n = { name: node?.name ?? r.id, x: 1 };",
      "const n = {\n  name: isEntity\n    ? (c.entity?.title ?? c.label ?? id)\n    : x,\n};",
      'const o = { name: found ? id : "(not found)" };',
      "const o = { title: `${row.entityId.slice(0, 8)}…` };",
      "const name = x ?? c.focusSessionId;",
      "const o = { label: a || b.toId };",
      "const o = { name: id };",
    ];
    const clean = [
      'const o = { name: names?.get(id) ?? "(untitled)" };',
      "const o = { name: resolvePrivateObjectLabel(r.kind) };",
      "const o = { name: nameById.get(x) ?? fallback };",
      "const o = { name: node?.name ?? (hidden ? resolvePrivateObjectLabel(r.kind) : resolveObjectNoun(r.kind)) };",
      "const o = { name: stubNodeName(kind, id), id: r.id };",
      "// name: node?.name ?? r.id\nconst o = { id };",
    ];
    for (const s of flagged) expect(scan(s).hits, s).toHaveLength(1);
    for (const s of clean) expect(scan(s).hits, s).toEqual([]);
  });

  it("the scan set is derived and non-vacuous", () => {
    const rel = FILES.map((f) => f.slice(API_SRC.length + 1));
    expect(rel).toContain("services/object-graph/graph-service.ts");
    expect(rel).toContain("routers/graph.ts");
    expect(FILES.length).toBeGreaterThanOrEqual(6);
    // graph-service alone holds ~37 name expressions; a scan that stopped
    // reading them would fall far below this.
    const gs = scan(
      readFileSync(join(OBJECT_GRAPH, "graph-service.ts"), "utf8")
    );
    expect(gs.scanned).toBeGreaterThanOrEqual(25);
  });

  it("no display name falls back to an id", () => {
    const offenders = FILES.flatMap((f) =>
      scan(readFileSync(f, "utf8")).hits.map(
        (h) => `${f.slice(API_SRC.length + 1)}:${h.line}  ${h.expr}`
      )
    );
    expect(offenders).toEqual([]);
  });
});
