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
 * none of them may also call `workspaces.findMany(`.
 *
 * NON-VACUITY: the scan must find the known accept files (invites.ts, setup.ts)
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

const OLD_FAN_OUT = /\bworkspaces\.findMany\s*\(/;
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
      expect.arrayContaining([
        "packages/api/src/routers/workspaces/invites.ts",
        "packages/api/src/routers/hub-protocol/rest/setup.ts",
      ])
    );
  });

  it("the classifier flags the old pattern", () => {
    expect(
      OLD_FAN_OUT.test("const all = await db.query.workspaces.findMany();")
    ).toBe(true);
  });

  it("no accept path lists every workspace", () => {
    expect(
      acceptPaths.filter((f) => OLD_FAN_OUT.test(f.code)).map((f) => f.rel)
    ).toEqual([]);
  });
});
