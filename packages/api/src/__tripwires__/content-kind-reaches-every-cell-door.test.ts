import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { CONTENT_KINDS } from "@synap/database/schema";

/**
 * TRIPWIRE — `contentKind` must reach every cell write door.
 *
 * THE DEFECT THIS GUARDS
 * ======================
 * `widget_definitions.content_kind` is the renderer SLOT: `renderersForType()`
 * (the browser cell registry, and therefore the renderer picker) filters on it,
 * so a row written without one takes the column default `widget` — placeable on
 * a bento, and invisible to every entity-detail / entity-card / entity-profile /
 * collection renderer assignment. Installed, and unpickable.
 *
 * `defineCell()` — the ONE write door — has always accepted `contentKind`. What
 * was missing were PRODUCERS: `POST /api/hub/cells/define`, MCP
 * `synap_create_cell`, the `cell/define` approve-executor, `POST
 * /api/hub/cells/install`, and the `cells[]` slot of `POST
 * /api/hub/packages/apply` all declared `viewTypes` (the sibling column, one
 * over) and none declared `contentKind`. A plain `z.object` STRIPS an undeclared
 * key, so a caller sending it got a 201/success and a cell in the wrong slot —
 * no error, no log. The Control Plane's own `cells[]` publish slot HAD declared
 * `contentKind`; the pod stripped it one hop later, which the
 * `cp-pod-package-schema-parity` tripwire cannot see because it compares only
 * TOP-LEVEL keys.
 *
 * This is the "a DECLARED zod schema IS the contract; passthrough ≠ coverage"
 * class, and it is invisible to `tsc` (every field is optional) and to a plain
 * `rg` count (the token appears in prose and on the read side).
 *
 * WHAT IS ASSERTED
 * ================
 * Three checks, each DERIVED from source rather than a hand-kept list:
 *   A. every `defineCell({…})` call site passes `contentKind`;
 *   B. every zod schema declaring `viewTypes: z.array(` also DECLARES a
 *      `contentKind` slot (a zod declaration, not merely a forward of the
 *      field) — the two columns travel together at every wire boundary, which
 *      is exactly what stopped being true;
 *   C. the ADVERTISED MCP tool schema for `synap_create_cell` declares it —
 *      accepting a parameter no agent can discover is not a producer.
 * Plus D: the enum is built from the `CONTENT_KINDS` runtime SSOT, never
 * retyped, because a hand-copied projection of that union has already drifted
 * once (`entity-card` existed on the pod but not in CP's schema, so an
 * entity-card cell could not be shipped as a package at all).
 *
 * If this fails: add `contentKind` to the door, forward it to `defineCell`, and
 * (for a governed door) carry it in the `checkPermissionOrPropose` `data` too —
 * otherwise an APPROVED agent-authored cell materializes into the wrong slot.
 */

const SRC = join(process.cwd(), "src");

function tsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) tsFiles(p, acc);
    else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".d.ts")
    )
      acc.push(p);
  }
  return acc;
}

/** Comments and string/template literals removed — what survives is executable. */
function stripCommentsAndStrings(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ")
    .replace(/`(?:\\[\s\S]|[^\\`])*`/g, '""')
    .replace(/'(?:\\.|[^\\'])*'/g, '""')
    .replace(/"(?:\\.|[^\\"])*"/g, '""');
}

/** Brace-matched argument bodies of every `fn(` call in `src`. */
function callArgBodies(src: string, fn: string): string[] {
  const bodies: string[] = [];
  const needle = `${fn}(`;
  let from = 0;
  for (;;) {
    const at = src.indexOf(needle, from);
    if (at === -1) break;
    let depth = 0;
    let i = at + needle.length - 1;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (ch === "(" || ch === "{" || ch === "[") depth++;
      else if (ch === ")" || ch === "}" || ch === "]") {
        depth--;
        if (depth === 0) break;
      }
    }
    bodies.push(src.slice(at, i));
    from = at + needle.length;
  }
  return bodies;
}

const FILES = tsFiles(SRC).map((f) => ({
  rel: relative(SRC, f),
  stripped: stripCommentsAndStrings(readFileSync(f, "utf8")),
}));

describe("tripwire: contentKind reaches every cell write door", () => {
  it("A. every defineCell() call site passes contentKind", () => {
    const offenders: string[] = [];
    let sites = 0;
    for (const { rel, stripped } of FILES) {
      // The door's own definition is not a call site.
      if (rel === "services/cells/define-cell.ts") continue;
      for (const body of callArgBodies(stripped, "defineCell")) {
        // `const { defineCell } = await import(...)` is a destructure, not a call.
        if (!body.includes("{")) continue;
        sites++;
        if (!body.includes("contentKind")) offenders.push(rel);
      }
    }
    // Guard against a vacuous pass if the door is ever renamed.
    expect(
      sites,
      "no defineCell() call sites found — is this test stale?"
    ).toBeGreaterThanOrEqual(4);
    expect(
      offenders,
      "these defineCell() call sites write a cell without a renderer slot, so it " +
        "lands as the column default `widget` and is invisible to renderersForType()"
    ).toEqual([]);
  });

  it("B. every zod door declaring viewTypes also declares contentKind", () => {
    // The ONE exemption: the search-index surface configures which view types a
    // Typesense collection covers. It writes no cell and has no renderer slot —
    // the field is a homonym, not the sibling column.
    const EXEMPT = new Set<string>(["routers/typesense.ts"]);
    const offenders = FILES.filter(
      ({ rel, stripped }) =>
        !EXEMPT.has(rel) &&
        /viewTypes:\s*z\.array\(/.test(stripped) &&
        // Must be a zod DECLARATION, not merely a mention: a bare
        // /contentKind:/ is also satisfied by `contentKind: parsed.data.
        // contentKind` — a FORWARD of a field the schema still strips, which
        // is precisely the broken state (verified: with the schema slot deleted
        // and the forwards left in place, a bare-key check stayed green). The
        // `[\s\S]{0,40}?` tolerates prettier's multi-line `z\n.enum(` form.
        !/contentKind:\s*z[\s\S]{0,40}?\.enum\(/.test(stripped)
    ).map(({ rel }) => rel);
    expect(
      offenders,
      "a zod door that declares viewTypes but not contentKind STRIPS the slot: " +
        "the caller gets a success and a cell in the wrong renderer slot"
    ).toEqual([]);
  });

  it("C. the advertised synap_create_cell tool schema declares contentKind", () => {
    const manifest = JSON.parse(
      readFileSync(
        join(SRC, "routers/mcp/tools/mcp-tools.manifest.json"),
        "utf8"
      )
    ) as {
      tools: Array<{
        name: string;
        inputSchema?: { properties?: Record<string, { enum?: string[] }> };
      }>;
    };
    const tool = manifest.tools.find((t) => t.name === "synap_create_cell");
    expect(
      tool,
      "synap_create_cell missing from the MCP manifest"
    ).toBeDefined();
    const prop = tool!.inputSchema?.properties?.contentKind;
    expect(
      prop,
      "synap_create_cell ACCEPTS contentKind but does not ADVERTISE it — no agent " +
        "can discover a parameter that is not in the tool schema, so the door has " +
        "no producer. Add it to tools/index.ts and re-run `pnpm gen:mcp-manifest`."
    ).toBeDefined();
    // The advertised enum is a projection of the SSOT and must not drift from it.
    expect([...(prop!.enum ?? [])].sort()).toEqual([...CONTENT_KINDS].sort());
  });

  it("D. no cell door retypes the ContentKind union instead of using CONTENT_KINDS", () => {
    const offenders = FILES.filter(({ stripped }) =>
      /contentKind:\s*z\s*\.?\s*\n?\s*\.enum\(\s*\[/.test(stripped)
    ).map(({ rel }) => rel);
    expect(
      offenders,
      "build the enum from the CONTENT_KINDS runtime SSOT (`z.enum(CONTENT_KINDS)`), " +
        "never a hand-copied literal list — that projection has already drifted once"
    ).toEqual([]);
  });
});
