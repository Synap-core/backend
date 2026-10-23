/**
 * TRIPWIRE — no pod-invite accept path fans out over `workspaces.findMany()`.
 *
 * A pod invite's accept used to add the invitee, with the invite's role (which
 * can be `admin`), to EVERY space, including the `pod-admin` system space where
 * admin means pod admin. Every accept path now takes its spaces from
 * `listPodInviteFanOutWorkspaceIds` (ordinary spaces only).
 *
 * HOW (derived, not hand-listed): every non-test `.ts` under `packages/api/src`
 * and `apps/api/src` that calls `recordInviteAcceptance` is an accept path;
 * none of them may also call `workspaces.findMany(` WITHOUT a `where`. A
 * filtered read (e.g. `updateMemberRole` enumerating pod-visible spaces for a
 * newly promoted pod admin) is not a fan-out of the invite's role.
 *
 * NON-VACUITY: the scan must find the one accept door (accept-invite-for.ts)
 * and its classifier must flag a literal sample of the old pattern.
 *
 * WHAT IT DOES NOT SEE (stated): a fan-out written with another query shape
 * (`select().from(workspaces)`), or in a file that does not call
 * `recordInviteAcceptance`.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripComments } from "../../../../scripts/strip-comments.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../../..");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name)) out.push(full);
  }
  return out;
}

const FIND_MANY = /\bworkspaces\.findMany\s*\(/g;

/** The text between a call's parentheses, starting after the `(`. */
function callArgs(code: string, from: number): string {
  let depth = 1;
  let i = from;
  for (; i < code.length && depth > 0; i++) {
    if (code[i] === "(") depth++;
    else if (code[i] === ")") depth--;
  }
  return code.slice(from, i - 1);
}

/** Does the code list EVERY workspace: a `workspaces.findMany(` with no `where`? */
function listsEveryWorkspace(code: string): boolean {
  return [...code.matchAll(FIND_MANY)].some(
    (m) => !/\bwhere\s*:/.test(callArgs(code, m.index + m[0].length))
  );
}
const isAcceptPath = (code: string) => /\brecordInviteAcceptance\b/.test(code);

const files = [
  ...walk(join(REPO, "packages/api/src")),
  ...walk(join(REPO, "apps/api/src")),
].map((file) => ({
  rel: relative(REPO, file),
  code: stripComments(readFileSync(file, "utf8"), "ts"),
}));
const acceptPaths = files.filter((f) => isAcceptPath(f.code));

describe("tripwire: a pod invite never fans out over every space", () => {
  it("the scan sees the known accept paths (non-vacuity)", () => {
    expect(files.length).toBeGreaterThan(300);
    const rels = acceptPaths.map((f) => f.rel);
    expect(rels).toEqual(
      // The one accept door (`acceptInviteFor`, called by both
      // `workspaces.acceptInvite` and `/setup/accept-invite`).
      expect.arrayContaining([
        "packages/api/src/routers/workspaces/accept-invite-for.ts",
      ])
    );
  });

  it("the classifier flags the old pattern, not a filtered read", () => {
    expect(
      listsEveryWorkspace("const all = await db.query.workspaces.findMany();")
    ).toBe(true);
    expect(
      listsEveryWorkspace(
        "await db.query.workspaces.findMany({ columns: { id: true } });"
      )
    ).toBe(true);
    expect(
      listsEveryWorkspace(
        "await db.query.workspaces.findMany({ where: eq(workspaces.x, f(1)) });"
      )
    ).toBe(false);
  });

  it("no accept path lists every workspace", () => {
    expect(
      acceptPaths.filter((f) => listsEveryWorkspace(f.code)).map((f) => f.rel)
    ).toEqual([]);
  });

  it("ONE accept door: only acceptInviteFor spends an invite into access", () => {
    // A second accept path is how the console's "Create account and join"
    // once wrote bare member rows with no audit line and never told the CP.
    expect(acceptPaths.map((f) => f.rel)).toEqual([
      "packages/api/src/routers/workspaces/accept-invite-for.ts",
    ]);
    const callers = files
      .filter((f) => /\bacceptInviteFor\s*\(/.test(f.code))
      .map((f) => f.rel)
      .sort();
    expect(callers).toEqual([
      "packages/api/src/routers/hub-protocol/rest/setup.ts",
      "packages/api/src/routers/workspaces/accept-invite-for.ts",
      "packages/api/src/routers/workspaces/invites.ts",
    ]);
  });
});
