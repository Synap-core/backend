/**
 * `tools` REACHES THE ROW — the anti-"declared on the wire, populated by
 * nobody" tripwire, for the ONE list of what a run of a playbook may use
 * (0419; plan 08e4fba7 decisions 3 and 4). It replaced `requiredIntents`, and
 * this file is that field's tripwire carried over.
 *
 * The field is declared in places that can silently disagree: the ONE wire
 * schema, the update PATCH schema, the proposal payloads, and the actual
 * drizzle write. zod STRIPS undeclared keys and every write site builds its own
 * object literal, so the failure mode is precise and quiet: an author declares
 * a list, the door accepts it, the row stores `[]`, and the run gets only its
 * floor. Every type checks.
 *
 * WHAT IT PROVES, per site, by SOURCE SCAN of the writer's own literal:
 *   - the definition schema declares the field;
 *   - the update PATCH declares it;
 *   - the insert literal writes it;
 *   - the update `set` literal writes it;
 *   - BOTH proposal payloads carry it;
 *   - it is a version-bumping definition field;
 *   - the run snapshot records it.
 *
 * WHAT IT DOES NOT PROVE: that the value stored is the value submitted — this
 * is a source scan, not an execution (`playbook-tools.pglite.test.ts` drives
 * the real door). A refactor that builds the insert from a spread would make
 * this vacuous, which is why every site asserts BOTH that the literal names
 * the key AND a non-vacuity check that the scan can still see that shape.
 */

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { stripComments } from "../../../../scripts/strip-comments.mjs";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const ROUTER = join(SRC, "routers/playbooks.ts");
const SCHEMA = join(SRC, "schemas/playbook-definition.ts");
const RUN = join(SRC, "services/playbooks/run-playbook.ts");
const VERSION = join(SRC, "services/playbooks/definition-version.ts");

const read = (path: string): string => readFileSync(path, "utf8");

/**
 * The slice of a file between two anchors, so each assertion is aimed at ONE
 * write site.
 *
 * ⚠️ BOTH ANCHORS MUST EXIST, AND THE SLICE MUST NOT RUN TO END-OF-FILE.
 *
 * This helper originally fell back to `src.length` when the end anchor was
 * missing — and the insert block's end anchor (`.onConflictDoUpdate`) does NOT
 * exist there, because the insert has no upsert. So the slice silently ran to
 * EOF, swallowed the update path and both proposal payloads along with it, and
 * the reachability tripwire stayed GREEN after the insert write was deleted
 * from it. A guard that spans more than it means to check is a guard that
 * passes on a defect it was written to catch — so a missing end anchor is now a
 * hard failure, and `assertSlice` below additionally proves each slice is
 * BOUNDED (it does not contain the next anchor).
 */
function slice(src: string, from: string, to: string): string {
  const start = src.indexOf(from);
  expect(start, `start anchor not found: ${from}`).toBeGreaterThan(-1);
  const end = src.indexOf(to, start + from.length);
  expect(end, `end anchor not found after ${from}: ${to}`).toBeGreaterThan(-1);
  return src.slice(start, end);
}

/**
 * Non-vacuity for a slice: it must be non-trivial AND must NOT contain the
 * other anchors — a slice that swallowed a neighbouring site would satisfy an
 * assertion aimed at it without the site ever being checked.
 */
function assertSlice(
  name: string,
  body: string,
  mustNotContain: string[]
): void {
  expect(
    body.length,
    `slice "${name}" is empty — anchors moved`
  ).toBeGreaterThan(50);
  for (const other of mustNotContain) {
    expect(
      body.includes(other),
      `slice "${name}" swallowed "${other}" — it spans a site it is not checking`
    ).toBe(false);
  }
}

const router = read(ROUTER);

/** The insert block's real end anchor: it has NO upsert, so `.returning()` is
 * what closes it. (An earlier `.onConflictDoUpdate` anchor named a DIFFERENT
 * insert elsewhere in the file and made this slice run to EOF.) */
const INSERT_END = ".returning();";

describe("tools — reaches the row, not just the schema", () => {
  it("non-vacuity: every scanned site is a real, BOUNDED slice", () => {
    // A slice that came back empty, or that swallowed its neighbour, would
    // make every "does this site name the field" assertion below pass on a
    // defect. That is precisely how the first version of this file passed
    // green after the insert write was deleted from it.
    assertSlice("insert", slice(router, ".insert(playbooks)", INSERT_END), [
      "const set: Partial<typeof playbooks.$inferInsert>",
      "// The WHOLE patch, not `{ id, name }`",
    ]);
    assertSlice(
      "update",
      slice(
        router,
        "const set: Partial<typeof playbooks.$inferInsert>",
        "// D3c: bump"
      ),
      [".insert(playbooks)"]
    );
    assertSlice(
      "createProposal",
      slice(router, "data: {", "// IDEMPOTENCY ABOVE THE PROPOSE PATH"),
      ["const set: Partial<typeof playbooks.$inferInsert>"]
    );
    assertSlice(
      "updateProposal",
      slice(
        router,
        "// The WHOLE patch, not `{ id, name }`",
        'if ("denied" in perm'
      ),
      [".insert(playbooks)"]
    );
    assertSlice(
      "schema",
      slice(
        read(SCHEMA),
        "export const playbookDefinitionSchema = z.object({",
        "/** A parsed playbook definition"
      ),
      ["playbookToolsSchema = z\n"]
    );

    // And the scan can still see the shape it hunts: a literal `tools:`
    // in one of them, matched by the SAME regex the assertions use.
    expect(slice(router, ".insert(playbooks)", INSERT_END)).toMatch(
      /\btools\s*:/
    );
    // Negative control on the regex: a key that is NOT declared must not match,
    // so "it matches" above is not a tautology over any camelCase token.
    expect("notAField: 1").not.toMatch(/\btools\s*:/);
  });

  it("the ONE wire schema declares it", () => {
    // `playbookDefinitionSchema` is what every package / capability / loop door
    // `.extend`s, so a field present HERE reaches every door. Absent it, an
    // author gets a silent strip.
    const def = slice(
      read(SCHEMA),
      "export const playbookDefinitionSchema = z.object({",
      "/** A parsed playbook definition"
    );
    expect(def).toMatch(/\btools\s*:/);
  });

  it("the update PATCH declares it (an all-optional patch that omits it drops it)", () => {
    const patch = slice(
      router,
      "export const updateInputSchema = z.object({",
      "// ── Links sub-router"
    );
    expect(patch).toMatch(/\btools\s*:/);
  });

  it("the insert literal writes it", () => {
    // Without it, a create stores the column default `[]` and the declaration
    // is gone the moment the author saves.
    expect(slice(router, ".insert(playbooks)", INSERT_END)).toMatch(
      /\btools\s*:\s*input\.tools\b/
    );
  });

  it("the update set literal writes it", () => {
    // The `if (x !== undefined) set.x = ...` form every field beside it uses.
    const update = slice(
      router,
      "const set: Partial<typeof playbooks.$inferInsert>",
      "// D3c: bump"
    );
    expect(update).toMatch(
      /if \(input\.tools !== undefined\)\s*\n?\s*set\.tools = input\.tools;/
    );
  });

  it("BOTH proposal payloads carry it", () => {
    // The create proposal materializes a real playbook on approval; the update
    // proposal carries a field diff. Each builds its own literal, and each is a
    // place an approved write silently loses the field.
    const createProposal = slice(
      router,
      "data: {",
      "// IDEMPOTENCY ABOVE THE PROPOSE PATH"
    );
    expect(createProposal).toMatch(/\btools\s*:\s*input\.tools\b/);

    const updateProposal = slice(
      router,
      "// The WHOLE patch, not `{ id, name }`",
      'if ("denied" in perm'
    );
    // The spread-conditional form, so a PATCH that omits the field still keeps
    // the stored one rather than clearing it.
    expect(updateProposal).toMatch(
      /input\.tools !== undefined\s*\n?\s*\?\s*\{\s*tools: input\.tools\s*\}/
    );
  });

  it("it is a version-bumping definition field", () => {
    // Otherwise editing the requirements leaves `version` untouched and the run
    // snapshot cannot tell the two definitions apart — "what ran" stops being
    // diffable against "today" for exactly this field.
    expect(read(VERSION)).toMatch(/["']tools["']/);
  });

  it("the run snapshot records it", () => {
    const snapshot = slice(
      read(RUN),
      "export function buildDefinitionSnapshot",
      "/**\n * Idempotency-by-subject"
    );
    expect(snapshot).toMatch(/\btools\s*:\s*playbook\.tools\b/);
  });
});

// ── Every OTHER writer of a playbook ────────────────────────────────────────
//
// The door above folds and stores `tools`, but a playbook is also created by
// code that builds its own object for `playbooks.create` (a loop install, a
// capability install) or inserts a row itself (promote). Each such literal that
// leaves `tools` out gives the playbook its class floor only — the defect the
// 2026-11-11 review found in promote and the loop install.
//
// THE SET IS DERIVED: every object literal in a non-test `.ts` under
// `packages/api/src` that is the argument of a `.create(` or a `.values(` and
// whose DEPTH-1 keys (shorthand included) hold both `name` and `goalTemplate`
// (a playbook create always carries both; `goalTemplate` is required). It must
// name `tools` or spread another object (a spread passes the whole definition
// through: the package applier's `...projected`; a conditional
// `...(x ? {…} : {})` does not count), or be classified below with its reason.
//
// WHAT IT CANNOT SEE (stated, not implied): a playbook built from a literal
// without `goalTemplate` at depth 1 (e.g. assembled field by field), a create
// whose argument is a variable (the approval replay: covered by the replay
// assertions above), and whether a spread's source actually holds `tools`.

/** Strip comments and string contents (keeps the quotes), so braces inside never count. */
function codeOf(src: string): string {
  return stripComments(src, "ts").replace(
    /(["'`])(?:\\.|(?!\1)[^\\])*\1/g,
    (m) => m[0] + m[0]
  );
}

/** Every `{…}` literal of `code` with its depth-1 keys, its spreads, its line. */
function objectLiterals(
  code: string
): Array<{ line: number; keys: string[]; spreads: boolean; written: boolean }> {
  const out: Array<{
    line: number;
    keys: string[];
    spreads: boolean;
    written: boolean;
  }> = [];
  const stack: Array<{
    at: number;
    keys: string[];
    spreads: boolean;
    seg: number;
    depth: number;
  }> = [];
  /** A shorthand key (`name,`) ends the segment it is alone in. */
  const shorthand = (top: { keys: string[]; seg: number }, end: number) => {
    const m = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(code.slice(top.seg, end));
    if (m && !top.keys.includes(m[1]!)) top.keys.push(m[1]!);
  };
  let depth = 0;
  for (let i = 0; i < code.length; i++) {
    const c = code[i]!;
    if (c === "{") {
      depth++;
      stack.push({ at: i, keys: [], spreads: false, seg: i + 1, depth });
      continue;
    }
    if (c === "}") {
      const top = stack.pop();
      depth--;
      if (top) {
        shorthand(top, i);
        out.push({
          line: code.slice(0, top.at).split("\n").length,
          keys: top.keys,
          spreads: top.spreads,
          // WRITTEN = the literal is the argument of a create or an insert.
          written: /(?:\.create|\.values)\(\s*$/.test(
            code.slice(Math.max(0, top.at - 40), top.at)
          ),
        });
      }
      continue;
    }
    const top = stack[stack.length - 1];
    if (!top) continue;
    // Depth-1 of `top`: no other bracket opened since it.
    if (c === "(" || c === "[") {
      // Skip to the matching bracket: its contents are not this literal's keys.
      const close = c === "(" ? ")" : "]";
      let d = 1;
      let j = i + 1;
      for (; j < code.length && d > 0; j++) {
        if (code[j] === c) d++;
        else if (code[j] === close) d--;
        else if (code[j] === "{" || code[j] === "}") break;
      }
      if (d === 0) {
        i = j - 1;
        continue;
      }
    }
    if (c === "," || c === "\n") {
      if (c === ",") shorthand(top, i);
      top.seg = i + 1;
    }
    if (c === ":") {
      const m = /^\s*([A-Za-z_$][\w$]*)\??\s*$/.exec(code.slice(top.seg, i));
      if (m && !top.keys.includes(m[1]!)) top.keys.push(m[1]!);
    }
    // A spread of a whole object (`...projected`) passes a definition through;
    // a conditional spread (`...(x ? { a } : {})`) adds one optional key and
    // does not count.
    if (
      c === "." &&
      code.startsWith("...", i) &&
      /^\s*$/.test(code.slice(top.seg, i)) &&
      /^\.\.\.\s*[A-Za-z_$]/.test(code.slice(i, i + 40))
    ) {
      top.spreads = true;
    }
    // A conditional spread that adds `tools` (`...(x.tools !== undefined ?
    // { tools: x.tools } : {})`) carries it.
    if (c === "." && code.startsWith("...(", i)) {
      let d = 0;
      let j = i + 3;
      for (; j < code.length; j++) {
        if (code[j] === "(") d++;
        else if (code[j] === ")" && --d === 0) break;
      }
      if (
        /\?\s*\{\s*tools\s*[:,}]/.test(code.slice(i, j)) &&
        !top.keys.includes("tools")
      )
        top.keys.push("tools");
      i = j;
      continue;
    }
  }
  return out;
}

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory())
      return name === "node_modules" ||
        name === "__tests__" ||
        name === "__tripwires__"
        ? []
        : tsFiles(p);
    return p.endsWith(".ts") &&
      !/\.(test|spec)\.ts$/.test(p) &&
      !p.endsWith(".d.ts")
      ? [p]
      : [];
  });
}

/**
 * Playbook literals that deliberately carry no `tools`, each with why. A new
 * one fails the scan; a classified one that starts carrying `tools` fails too
 * (the classification is then stale).
 */
const NO_TOOLS_BY_DESIGN: Record<string, string> = {
  // A graph op (`create_playbook` in a capture graph / rule loop) has no tools
  // in its op shape: it files a DRAFT the person shapes before running it.
  "utils/materialize-composite.ts":
    "create_playbook graph op: the op shape has no tools; it creates a draft",
  "utils/rule-loop-callers.ts":
    "create_playbook rule-loop op: the op shape has no tools; it creates a draft",
};

describe("every playbook writer carries tools (derived)", () => {
  const found = tsFiles(SRC).flatMap((file) =>
    objectLiterals(codeOf(read(file)))
      .filter(
        (o) =>
          o.written &&
          o.keys.includes("name") &&
          o.keys.includes("goalTemplate")
      )
      .map((o) => ({
        file: relative(SRC, file),
        line: o.line,
        carries: o.keys.includes("tools") || o.spreads,
      }))
  );

  it("non-vacuity: the scan finds the door, promote, the loop and capability installs", () => {
    const files = new Set(found.map((f) => f.file));
    for (const f of [
      "routers/playbooks.ts",
      "services/playbooks/playbook-lifecycle.ts",
      "services/loops/create-from-definition.ts",
      "services/capabilities/create-from-definition.ts",
    ])
      expect(files.has(f), `scan no longer sees ${f}`).toBe(true);
    // Self-check of the extractor on a literal sample.
    const sample = codeOf(
      `a.create({ name: "x", goalTemplate: "y", nested: { tools: [] } }); b.create({ name, goalTemplate: "b", tools }); t.insert(p).values({ ...def, name: "c", goalTemplate: "d" }); read({ name: true, goalTemplate: true }); c.create({ name: "e", goalTemplate: "f", ...(x ? { y: 1 } : {}) }); d.create({ name: "g", goalTemplate: "h", ...(p.tools !== undefined ? { tools: p.tools } : {}) });`
    );
    const lits = objectLiterals(sample).filter((o) =>
      o.keys.includes("goalTemplate")
    );
    expect(
      lits.map((o) => [o.written, o.keys.includes("tools") || o.spreads])
    ).toEqual([
      [true, false],
      [true, true],
      [true, true],
      [false, false],
      [true, false],
      [true, true],
    ]);
  });

  it("each one names tools, spreads a definition through, or is classified", () => {
    const missing = found
      .filter((f) => !f.carries && !(f.file in NO_TOOLS_BY_DESIGN))
      .map((f) => `${f.file}:${f.line}`);
    expect(missing, "a playbook literal drops tools").toEqual([]);
  });

  it("every classification is still a real tools-less site", () => {
    for (const file of Object.keys(NO_TOOLS_BY_DESIGN)) {
      const here = found.filter((f) => f.file === file);
      expect(
        here.length,
        `${file} no longer creates a playbook`
      ).toBeGreaterThan(0);
      expect(
        here.every((f) => !f.carries),
        `${file} now carries tools: drop its classification`
      ).toBe(true);
    }
  });
});
