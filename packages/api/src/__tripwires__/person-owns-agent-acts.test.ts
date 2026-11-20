import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, relative } from "path";

/**
 * TRIPWIRE — a person owns what an agent makes; the agent is only the actor
 * (consolidation W1, founder decision; tickets 01b5b0b3, da1199bb).
 *
 * An automation an agent authored used to be OWNED by the agent
 * (`automations.created_by` = the agent), so every run resolved its runner
 * roster, run session, AI principal and RBAC against the agent: an external
 * runner the person operates was refused and the run session was invisible to
 * the person. 0442 gave the tables an actor column (`agent_user_id`); every
 * door now stamps the OWNER from `ownerAndActor` (owner-person.ts: an agent
 * resolves to its person) and the agent as the actor.
 *
 * Two checks, over every production `.ts` file of `packages/{api,jobs,database}/src`
 * (derived by walking the tree, never a hand list):
 *
 *  1. Every `.insert(<table>)` of a table that has an actor column — the set is
 *     DERIVED from migration 0442's `ADD COLUMN ... "agent_user_id"` lines —
 *     stamps `createdBy: <x>.ownerId` (a value only `ownerAndActor` yields) and
 *     sets `agentUserId`. Exempt: `routers/sync.ts`, a REPLICA copying a peer
 *     pod's row verbatim (fidelity; it never authors a row).
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

/** The `{...}` passed to `.values(` after `start`, brace-matched. */
function valuesBlockAfter(src: string, start: number): string | null {
  const v = src.indexOf(".values(", start);
  if (v < 0 || v - start > 400) return null;
  const open = src.indexOf("{", v);
  if (open < 0 || open - v > 40) return null;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  return null;
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

describe("tripwire: a person owns what an agent makes (W1)", () => {
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
