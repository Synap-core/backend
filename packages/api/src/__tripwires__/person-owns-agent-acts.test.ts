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
 *  1. Every `.insert(<table>)` of a table that has an actor column — the set is
 *     DERIVED from migration 0442's `ADD COLUMN ... "agent_user_id"` lines —
 *     stamps `createdBy: <x>.ownerId` (a value only `ownerAndActor` yields) and
 *     sets `agentUserId`. A REPLICA (`routers/sync.ts`) copies a peer's row
 *     verbatim instead: its row shape must carry `agentUserId`.
 *  2. No owner column anywhere is written as `createdBy: <...>agentUserId ?? ...`
 *     (the "the agent if there is one, else the person" expression that made
 *     agents owners). The tables below have no actor column yet and still
 *     store the agent as owner; they are a frozen list (a follow-up moves
 *     them), so a NEW site fails.
 *
 * WHAT IT DOES NOT SEE (measured by reading the scan, not assumed): an owner
 * column written under another key name (`userId:` on skills/views/artifacts),
 * a `createdBy` fed from a variable that holds an agent id without the `??`
 * shape, and a raw SQL insert. Check 1 is per insert site; check 2 per code
 * line (comment lines are skipped), granular to the FILE for the frozen list.
 */

const PACKAGES = join(process.cwd(), "..");
const SCANNED = ["api/src", "jobs/src", "database/src"];

/** Writers of tables with no actor column yet (follow-up), frozen. */
const KNOWN_AGENT_AS_OWNER = new Set<string>([
  "api/src/routers/tools.ts", // tools.created_by — capability-gate owner-bypass reads it
  "api/src/routers/proposals/executors/tool.ts",
  "api/src/routers/capability-containers.ts", // capabilities.created_by
  "api/src/routers/proposals/executors/capability.ts",
  "api/src/services/focus-sessions/create-session.ts", // playbook_runs.created_by — the activity feed reads it as actor
  "api/src/services/focus-sessions/follow-playbook.ts",
  // proposals.created_by: overloaded "who filed it", not an owner (the owner
  // floor is proposals.subject_user_id).
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

/** Tables 0442 gave an actor column, as their drizzle export names. */
function actorTables(): string[] {
  const sql = readFileSync(
    join(PACKAGES, "database/migrations/0442_owner_actor_columns.sql"),
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

const AGENT_AS_OWNER_LINE = /\bcreatedBy:\s*\(?\s*[\w.?]*agentUserId\s*\?\?/;
/** Per code line: a comment that quotes the old shape is not a write. */
const writesAgentAsOwner = (src: string): boolean =>
  src
    .split("\n")
    .some(
      (line) =>
        !/^\s*(\/\/|\*|\/\*)/.test(line) && AGENT_AS_OWNER_LINE.test(line)
    );

describe("tripwire: a person owns what an agent makes", () => {
  const tables = actorTables();

  it("derives the actor tables from 0442 (non-vacuity)", () => {
    expect(tables).toEqual(
      expect.arrayContaining(["automations", "playbooks"])
    );
    expect(FILES.length).toBeGreaterThan(500);
  });

  it("every insert of an actor table stamps the owner from ownerAndActor and the actor", () => {
    const inserts = actorInserts(FILES, tables);
    // Non-vacuity: the automation door, the cron backing row, the reconcile,
    // the playbook create and promote doors.
    expect(inserts.length).toBeGreaterThanOrEqual(5);
    const offenders = inserts
      .filter((i) => !stampsOwnerAndActor(i.block))
      .map((i) => `${i.rel}: insert(${i.table})`);
    expect(
      offenders,
      "Stamp `createdBy: owner.ownerId, agentUserId: owner.agentUserId` from `ownerAndActor(db, <writer>, <agent>)` — never an agent as the owner."
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

  it("no owner column is written as `agentUserId ?? <person>` outside the frozen follow-up list", () => {
    const offenders = FILES.filter(
      ({ rel, src }) =>
        !KNOWN_AGENT_AS_OWNER.has(rel) && writesAgentAsOwner(src)
    ).map((f) => f.rel);
    expect(offenders).toEqual([]);
    // The frozen list stays exact: a site that got fixed leaves it.
    const stale = [...KNOWN_AGENT_AS_OWNER].filter(
      (rel) => !FILES.some((f) => f.rel === rel && writesAgentAsOwner(f.src))
    );
    expect(stale, "remove fixed files from KNOWN_AGENT_AS_OWNER").toEqual([]);
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
  });
});
