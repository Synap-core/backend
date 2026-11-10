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
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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
