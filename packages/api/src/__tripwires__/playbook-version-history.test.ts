import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, relative } from "path";
import { fileURLToPath } from "url";
import { stripComments } from "../../../../scripts/strip-comments.mjs";

/**
 * TRIPWIRE — every writer of `playbooks.version` keeps that version
 * (`playbook_versions`, 0416; spec 7111934d §2.3, lead's hard requirement (c)).
 *
 * ── The defect it prevents ─────────────────────────────────────────────────
 * A step that IS a playbook is pinned at a version (`PlaybookStage.uses`). The
 * pin is honoured by reading `playbook_versions`. A door that creates a
 * playbook, or bumps its version, WITHOUT keeping the version leaves every pin
 * on it dangling the moment the live row moves on: the step can no longer run
 * what it was written against, and nothing says so until a run fails.
 *
 * ── How ────────────────────────────────────────────────────────────────────
 * Derives the set of writers by GLOB over `packages/api/src` and
 * `packages/jobs/src` (never a hand list of doors): every file with a write
 * statement on the `playbooks` table (`.insert(playbooks…)` /
 * `.update(playbooks…)`, including the `playbooksTable` alias). Each must be
 * classified:
 *   KEEPS_VERSIONS  it creates a row or sets `version`, and calls
 *                   `recordPlaybookVersion` (asserted: reachability, not a name
 *                   on a list);
 *   NO_VERSION      every write statement in it sets no `version` and inserts
 *                   no row (asserted on the statement's text), with the reason.
 *
 * ── What it cannot see (measured) ──────────────────────────────────────────
 * - Granularity is the FILE for KEEPS_VERSIONS: a second, unrecorded bump
 *   beside a recorded one stays green (verified by reading; the behavioural
 *   tests in `stage-uses.pglite.test.ts` cover the call sites).
 * - A write that never spells `playbooks` in its `.insert(` / `.update(` call
 *   (raw SQL, a re-aliased import other than `playbooksTable`). None today:
 *   `grep -rn "UPDATE playbooks\|INSERT INTO playbooks"` finds none.
 * - The statement window ends at the first `.returning(` / `.where(` / `;`
 *   after the call; a `version` written after that inside the same statement
 *   is not seen.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const API_SRC = join(HERE, "..");
const JOBS_SRC = join(HERE, "..", "..", "..", "jobs", "src");

/** Files that create a playbook or bump its version, and keep that version. */
const KEEPS_VERSIONS: Record<string, string> = {
  "api:routers/playbooks.ts":
    "playbooks.create (insert, version 1) and playbooks.update (a definition change bumps version)",
  "api:services/playbooks/playbook-lifecycle.ts":
    "promoteSessionToPlaybook inserts a new playbook (version 1)",
};

/** Files whose playbook writes set no version and insert no row. */
const NO_VERSION: Record<string, string> = {
  "api:services/reversibility/safe-revert.ts":
    "archives a playbook (status only)",
  "api:services/focus-sessions/complete-session.ts":
    "drops a closed session's subject from the pin list (metadata)",
  "api:services/playbooks/cron-automation.ts":
    "stamps or clears flow_automation_id",
  "api:services/playbooks/run-playbook.ts":
    "advances a rotating input cursor (inputStrategy.cursor), a run-time position, never a new definition",
  "api:services/playbooks/playbook-activators.ts":
    "writes the activators' memory into metadata",
  "api:services/capabilities/create-from-definition.ts":
    "stamps metadata.sourceCapability",
};

const WRITE_CALL = /\.(insert|update)\(\s*(playbooks|playbooksTable)\s*\)/g;

function tsFiles(dir: string, acc: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) tsFiles(p, acc);
    else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".d.ts") &&
      !entry.name.endsWith(".test.ts") &&
      !p.includes("__tests__") &&
      !p.includes("__tripwires__")
    )
      acc.push(p);
  }
  return acc;
}

interface Statement {
  kind: "insert" | "update";
  text: string;
}

/** Each write statement on `playbooks` in comment-blanked `src`. */
function statementsIn(src: string): Statement[] {
  const code = stripComments(src, "ts");
  const out: Statement[] = [];
  for (const m of code.matchAll(WRITE_CALL)) {
    const rest = code.slice(m.index!);
    const end = rest.search(/\.returning\(|\.where\(|;/);
    out.push({
      kind: m[1] as "insert" | "update",
      text: rest.slice(0, end === -1 ? 2000 : end),
    });
  }
  return out;
}

const SETS_VERSION = /\bversion\s*[:=]|\bset\.version\b/;

function scan(): Map<string, Statement[]> {
  const found = new Map<string, Statement[]>();
  for (const [prefix, root] of [
    ["api", API_SRC],
    ["jobs", JOBS_SRC],
  ] as const) {
    for (const file of tsFiles(root)) {
      const src = readFileSync(file, "utf8");
      if (!src.includes("playbooks")) continue;
      const statements = statementsIn(src);
      if (statements.length > 0) {
        found.set(
          `${prefix}:${relative(root, file).split("\\").join("/")}`,
          statements
        );
      }
    }
  }
  return found;
}

function srcOf(key: string): string {
  const [prefix, rel] = key.split(":") as [string, string];
  return readFileSync(join(prefix === "api" ? API_SRC : JOBS_SRC, rel), "utf8");
}

describe("tripwire: every writer of playbooks.version keeps the version", () => {
  const found = scan();
  const keys = [...found.keys()].sort();

  it("the scan is non-vacuous and can still see a write", () => {
    expect(keys.length).toBeGreaterThanOrEqual(8);
    expect(tsFiles(JOBS_SRC).length).toBeGreaterThan(50);
    // Self-check: both spellings are seen, prose is not.
    expect(
      statementsIn(
        "await tx\n  .insert(playbooks)\n  .values({ name })\n  .returning();"
      )
    ).toHaveLength(1);
    expect(
      statementsIn(
        "db.update(playbooksTable).set({ version: 2 }).where(x);"
      )[0]!.text
    ).toMatch(SETS_VERSION);
    expect(statementsIn("/** never .update(playbooks) here */")).toEqual([]);
    // The bump in the update door is still where the scan looks for it.
    expect(
      found.get("api:routers/playbooks.ts")!.some((s) => s.kind === "insert")
    ).toBe(true);
  });

  it("every writer is classified", () => {
    const unclassified = keys.filter(
      (k) => !(k in KEEPS_VERSIONS) && !(k in NO_VERSION)
    );
    expect(unclassified).toEqual([]);
  });

  it("every KEEPS_VERSIONS file calls recordPlaybookVersion (reachability, not naming)", () => {
    const missing = Object.keys(KEEPS_VERSIONS).filter(
      (k) => !stripComments(srcOf(k), "ts").includes("recordPlaybookVersion(")
    );
    expect(missing).toEqual([]);
  });

  it("every NO_VERSION file inserts no playbook and sets no version", () => {
    const wrong: string[] = [];
    for (const key of Object.keys(NO_VERSION)) {
      for (const s of found.get(key) ?? []) {
        if (s.kind === "insert") wrong.push(`${key}: inserts a playbook`);
        else if (SETS_VERSION.test(s.text)) wrong.push(`${key}: sets version`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("the lists are shrink-only: every classified file still writes playbooks", () => {
    const stale = [
      ...Object.keys(KEEPS_VERSIONS),
      ...Object.keys(NO_VERSION),
    ].filter((k) => !found.has(k));
    expect(stale).toEqual([]);
  });
});
