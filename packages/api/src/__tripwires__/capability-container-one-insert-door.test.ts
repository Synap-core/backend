/**
 * TRIPWIRE — `capabilities` (the container table) has exactly ONE insert door.
 *
 * Migration 0242 added a PARTIAL unique index on the container ADDRESS
 * (`capabilities_template_key_scope_uq` over `(COALESCE(workspace_id, sentinel),
 * template_key) WHERE template_key IS NOT NULL`). That turned a previously
 * silent duplicate into a 23505. Two doors were inserting blind:
 * `proposals/executors/capability.ts` and `capability-containers.ts` — and in
 * the executor the throw lands BEFORE `proposals.status` is written, so
 * approving two `capability/create` proposals at the same address left an opaque
 * 500 and a proposal that could never be approved. Strictly worse than the
 * duplicate the index replaced.
 *
 * `resolveOrCreateContainer` (`services/capabilities/container-address.ts`)
 * resolves the address first and treats a lost race as a reuse. It is the only
 * place allowed to call `.insert(capabilities)`.
 *
 * Derived, not hand-listed: the writer set is DISCOVERED by scanning source, so
 * a fourth door added tomorrow is caught here rather than shipping crash-prone.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const API_SRC = join(here, "..");
const DATABASE_SRC = join(here, "..", "..", "..", "database", "src");
const THE_DOOR = "services/capabilities/container-address.ts";

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "dist" || name === "node_modules") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".ts") && !name.includes(".test.")) out.push(full);
  }
  return out;
}

/** Real insert CALLS only — `.insert(capabilities)` not inside a comment line. */
function containerInserters(): string[] {
  return [...walk(API_SRC), ...walk(DATABASE_SRC)].filter((f) =>
    readFileSync(f, "utf8")
      .split("\n")
      .some(
        (line) =>
          /\.insert\(capabilities(Table)?\)/.test(line) &&
          !line.trimStart().startsWith("*") &&
          !line.trimStart().startsWith("//")
      )
  );
}

describe("tripwire: capability containers have one insert door", () => {
  it("only container-address.ts inserts into `capabilities`", () => {
    const rel = containerInserters().map((f) =>
      relative(join(here, "..", "..", ".."), f).replace(/^api\/src\//, "")
    );
    expect(
      rel,
      "Every container-creating door must call resolveOrCreateContainer() " +
        "instead. A bare insert now raises 23505 on the 0242 address index — " +
        "and in the proposal executor that throws before proposals.status is " +
        "updated, making the proposal permanently unapprovable."
    ).toEqual([THE_DOOR]);
  });

  it("the door resolves the address before inserting, and survives a lost race", () => {
    const src = readFileSync(
      join(API_SRC, "services/capabilities/container-address.ts"),
      "utf8"
    );
    // A resolve-then-insert is TOCTOU; the conflict clause + re-read is what
    // makes it safe, so assert BOTH halves are present.
    expect(src).toMatch(/onConflictDoNothing\(\)/);
    const after = src.slice(src.indexOf("onConflictDoNothing"));
    expect(
      after,
      "a swallowed conflict must re-read the address — otherwise the door " +
        "silently returns nothing on a lost race"
    ).toMatch(/findContainerByAddress\(/);
  });
});
