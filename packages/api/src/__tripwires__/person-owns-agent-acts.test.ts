import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, relative } from "path";

/**
 * TRIPWIRE — a person owns what an agent makes; the agent is only the actor.
 * An agent stored as an automation's owner makes its runs resolve the runner,
 * the session, the AI principal and RBAC as the agent. Every door stamps the
 * owner from `ownerAndActor` and the agent as `agent_user_id` (0442).
 *
 * Two checks, over every production `.ts` file of `packages/{api,jobs,database}/src`
 * (derived by walking the tree, never a hand list):
 *
 * The actor tables are DERIVED from the `ADD COLUMN ... "agent_user_id"`
 * lines of the actor migrations ({@link ACTOR_MIGRATIONS}).
 *
 *  1. Every `.insert(<table>)` of a table 0442 or 0446 gave an actor column
 *     stamps
 *     `createdBy: <x>.ownerId` (a value only `ownerAndActor` yields) and sets
 *     `agentUserId`. A REPLICA (`routers/sync.ts`) copies a peer's row
 *     verbatim instead: its row shape must carry `agentUserId`.
 *  1b. Every insert of a table 0445 gave an actor column whose values name
 *     `agentUserId` stamps its owner (`createdBy:` or `userId:`) from `.ownerId` and
 *     sets `agentUserId`. A person's or the system's own insert names none.
 *  2. No owner is written as `<owner key>: <...>agentUserId ?? ...` (the "the
 *     agent if there is one, else the person" expression that made agents
 *     owners): `createdBy:` / `ownerId:` on any code line, `userId:` inside an
 *     insert's values.
 *
 * WHAT IT DOES NOT SEE (measured by reading the scan, not assumed): an owner
 * fed from a variable that holds an agent id without the `??` shape (a key
 * that acts for nobody makes `ctx.userId` the agent itself: `ownerAndActor`
 * at the doors answers that), a `userId:` written outside an insert's values
 * (a spread object built earlier), and a raw SQL insert. Checks 1 and 1b are
 * per insert site; check 2 per code line (comment lines are skipped),
 * granular to the FILE for the frozen list.
 */

const PACKAGES = join(process.cwd(), "..");
const SCANNED = ["api/src", "jobs/src", "database/src"];

/**
 * The migrations that gave tables their actor column, and the check their
 * inserts pass: `every` insert stamps owner and actor (check 1), or only one
 * that `names` an agent does (check 1b).
 */
const ACTOR_MIGRATIONS = [
  { file: "0442_owner_actor_columns.sql", check: "every" },
  { file: "0445_owner_actor_more_tables.sql", check: "names" },
  { file: "0446_run_holder_and_actor.sql", check: "every" },
] as const;

/**
 * `proposals.created_by` is who FILED it, not an owner: the owner floor is
 * `proposals.subject_user_id`, so an agent there is correct. Exact, like the
 * frozen list.
 */
const FILER_NOT_OWNER = new Set<string>([
  "api/src/services/app-access-ask.ts",
  "api/src/services/app-connect.ts",
  "api/src/services/playbooks/stage-gate.ts",
  "api/src/services/proposals/dev-approval.ts",
]);

/** A replica: copies a peer pod's row verbatim, never authors one. */
const REPLICA = new Set<string>(["api/src/routers/sync.ts"]);

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

const FILES = SCANNED.flatMap((d) => tsFiles(join(PACKAGES, d))).map((f) => ({
  rel: relative(PACKAGES, f),
  src: readFileSync(f, "utf8"),
}));

/** Tables a migration gave an actor column, as their drizzle export names. */
function actorTables(migration: string): string[] {
  const sql = readFileSync(
    join(PACKAGES, "database/migrations", migration),
    "utf8"
  );
  const tables = [
    ...sql.matchAll(
      /ALTER TABLE "(\w+)" ADD COLUMN IF NOT EXISTS "agent_user_id"/g
    ),
  ].map((m) => m[1]!);
  // snake_case table → camelCase drizzle export (`playbook_runs` → `playbookRuns`).
  return tables.map((t) =>
    t.replace(/_(\w)/g, (_, c: string) => c.toUpperCase())
  );
}

/** The brace-matched `{...}` opening at `open`. */
function braceBlock(src: string, open: number): string | null {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  return null;
}

/** The `{...}` passed to `.values(` after `start`. */
function valuesBlockAfter(src: string, start: number): string | null {
  const v = src.indexOf(".values(", start);
  if (v < 0 || v - start > 400) return null;
  const open = src.indexOf("{", v);
  if (open < 0 || open - v > 40) return null;
  return braceBlock(src, open);
}

/** Every insert of an actor table: where, and its values block. */
function actorInserts(
  files: Array<{ rel: string; src: string }>,
  tables: string[]
): Array<{ rel: string; table: string; block: string | null }> {
  const out: Array<{ rel: string; table: string; block: string | null }> = [];
  const re = new RegExp(`\\.insert\\(\\s*(${tables.join("|")})\\s*\\)`, "g");
  for (const { rel, src } of files) {
    if (REPLICA.has(rel)) continue;
    for (const m of src.matchAll(re)) {
      const lineStart = src.lastIndexOf("\n", m.index!) + 1;
      // A comment naming the call (`Do NOT add a second db.insert(...)`) is
      // not an insert.
      if (/^\s*(\/\/|\*|\/\*)/.test(src.slice(lineStart, m.index!))) continue;
      out.push({ rel, table: m[1]!, block: valuesBlockAfter(src, m.index!) });
    }
  }
  return out;
}

function stampsOwnerAndActor(block: string | null): boolean {
  return (
    block !== null &&
    /\bcreatedBy:\s*[\w.]+\.ownerId\s*,/.test(block) &&
    /\bagentUserId[:,]/.test(block)
  );
}

const isComment = (line: string) => /^\s*(\/\/|\*|\/\*)/.test(line);
const codeOf = (text: string) =>
  text
    .split("\n")
    .filter((l) => !isComment(l))
    .join("\n");

/** A 0445 insert that names an agent stamps the owner from `ownerAndActor`. */
function namesAgentWithoutOwnerStamp(block: string | null): boolean {
  if (block === null) return true;
  const code = codeOf(block);
  if (!/agentUserId/.test(code)) return false;
  return !(
    /\b(createdBy|userId):\s*[\w.]+\.ownerId\s*,/.test(code) &&
    /\bagentUserId[:,]/.test(code)
  );
}

const AGENT_AS_OWNER_LINE =
  /\b(createdBy|ownerId):\s*\(?\s*[\w.?]*agentUserId\s*\?\?/;
const AGENT_AS_USER_ID_LINE = /\buserId:\s*\(?\s*[\w.?]*agentUserId\s*\?\?/;
/** Per code line: a comment that quotes the old shape is not a write. */
const writesAgentAsOwner = (src: string): boolean =>
  src
    .split("\n")
    .some((line) => !isComment(line) && AGENT_AS_OWNER_LINE.test(line)) ||
  [...src.matchAll(/\.insert\(\s*\w+\s*\)/g)].some((m) =>
    codeOf(valuesBlockAfter(src, m.index!) ?? "")
      .split("\n")
      .some((line) => AGENT_AS_USER_ID_LINE.test(line))
  );

describe("tripwire: a person owns what an agent makes", () => {
  const tablesOf = (check: "every" | "names") =>
    ACTOR_MIGRATIONS.filter((m) => m.check === check).flatMap((m) =>
      actorTables(m.file)
    );
  const tables = tablesOf("every");
  const laterTables = tablesOf("names");

  it("derives the actor tables from the actor migrations (non-vacuity)", () => {
    expect(tables).toEqual(
      expect.arrayContaining(["automations", "playbooks", "playbookRuns"])
    );
    expect(laterTables).toEqual(
      expect.arrayContaining(["tools", "capabilities", "skills"])
    );
    expect(FILES.length).toBeGreaterThan(500);
  });

  it("every insert of an actor table stamps the owner from ownerAndActor and the actor", () => {
    const inserts = actorInserts(FILES, tables);
    // Non-vacuity: the one automation insert (`insertAutomation`, which the
    // automation door, the cron backing row and the reconcile share), the
    // playbook create and promote doors, the four run births.
    expect(inserts.length).toBeGreaterThanOrEqual(7);
    const offenders = inserts
      .filter((i) => !stampsOwnerAndActor(i.block))
      .map((i) => `${i.rel}: insert(${i.table})`);
    expect(
      offenders,
      "Stamp `createdBy: owner.ownerId, agentUserId: owner.agentUserId` from `ownerAndActor(db, <writer>, <agent>)` — never an agent as the owner."
    ).toEqual([]);
  });

  it("every 0445 insert that names an agent stamps the owner from ownerAndActor and the actor", () => {
    const inserts = actorInserts(FILES, laterTables);
    // Non-vacuity: the agent-reachable doors (tool create + approval, the
    // container door, the skill doors, the rule door, the context skill).
    const naming = inserts.filter((i) =>
      /agentUserId/.test(codeOf(i.block ?? ""))
    );
    expect(naming.length).toBeGreaterThanOrEqual(6);
    expect(
      inserts
        .filter((i) => namesAgentWithoutOwnerStamp(i.block))
        .map((i) => `${i.rel}: insert(${i.table})`),
      "Stamp the owner from `ownerAndActor(db, <writer>, <agent>)` (`.ownerId`) and `agentUserId: owner.agentUserId`."
    ).toEqual([]);
  });

  it("a replica carries the actor of every actor table it copies", () => {
    const shapes = FILES.filter((f) => REPLICA.has(f.rel)).flatMap(
      ({ rel, src }) =>
        tables.flatMap((table) =>
          [
            ...src.matchAll(
              new RegExp(`typeof ${table}\\.\\$inferInsert = \\{`, "g")
            ),
          ].map((m) => ({
            rel,
            table,
            block: braceBlock(src, m.index! + m[0].length - 1),
          }))
        )
    );
    // Non-vacuity: sync.ts replicates automations.
    expect(shapes.map((s) => s.table)).toContain("automations");
    expect(
      shapes
        .filter((s) => !/\bagentUserId:/.test(s.block ?? ""))
        .map((s) => `${s.rel}: ${s.table}`)
    ).toEqual([]);
  });

  it("no owner column is written as `agentUserId ?? <person>`", () => {
    const offenders = FILES.filter(
      ({ rel, src }) => !FILER_NOT_OWNER.has(rel) && writesAgentAsOwner(src)
    ).map((f) => f.rel);
    expect(offenders).toEqual([]);
    // The list stays exact: a site that got fixed leaves it.
    const stale = [...FILER_NOT_OWNER].filter(
      (rel) => !FILES.some((f) => f.rel === rel && writesAgentAsOwner(f.src))
    );
    expect(stale, "remove fixed files from the list").toEqual([]);
  });

  it("self-check: the scans still see what they hunt", () => {
    const bad = `await db.insert(automations).values({ workspaceId, createdBy: agentUserId ?? userId, name });`;
    const good = `await db.insert(automations).values({ workspaceId, createdBy: owner.ownerId, agentUserId: owner.agentUserId, name });`;
    expect(
      actorInserts([{ rel: "x.ts", src: bad }], tables).map((i) =>
        stampsOwnerAndActor(i.block)
      )
    ).toEqual([false]);
    expect(
      actorInserts([{ rel: "x.ts", src: good }], tables).map((i) =>
        stampsOwnerAndActor(i.block)
      )
    ).toEqual([true]);
    expect(writesAgentAsOwner(bad)).toBe(true);
    expect(
      writesAgentAsOwner("      createdBy: input.agentUserId ?? ctx.userId,")
    ).toBe(true);
    expect(
      writesAgentAsOwner("  // `createdBy: input.agentUserId ?? input.userId`")
    ).toBe(false);
    expect(writesAgentAsOwner(good)).toBe(false);
    // An owner under another key, inside an insert's values.
    const badSkill = `await db.insert(skills).values({\n  id,\n  userId: input.agentUserId ?? ctx.userId,\n  approved: !input.agentUserId,\n});`;
    const goodSkill = `await db.insert(skills).values({\n  id,\n  userId: owner.ownerId,\n  agentUserId: owner.agentUserId,\n  approved: !input.agentUserId,\n});`;
    expect(writesAgentAsOwner(badSkill)).toBe(true);
    expect(writesAgentAsOwner(goodSkill)).toBe(false);
    // A parameter object is not an owner column.
    expect(
      writesAgentAsOwner(
        "promote({\n  userId: input.agentUserId ?? ctx.userId,\n});"
      )
    ).toBe(false);
    const blockOf = (src: string) =>
      actorInserts([{ rel: "x.ts", src }], laterTables)[0]!.block;
    expect(namesAgentWithoutOwnerStamp(blockOf(badSkill))).toBe(true);
    expect(namesAgentWithoutOwnerStamp(blockOf(goodSkill))).toBe(false);
    // A system insert names no agent.
    expect(
      namesAgentWithoutOwnerStamp(
        blockOf(
          `await db.insert(skills).values({\n  userId: ownerUserId,\n  approved: true,\n});`
        )
      )
    ).toBe(false);
  });
});
