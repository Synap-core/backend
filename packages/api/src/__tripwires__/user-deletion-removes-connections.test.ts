import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";

/**
 * Deleting a person must remove their connections first.
 *
 * A connection outlives its owner's `users` row unless something removes it:
 * `secrets` and `governance_rules` carry no foreign key to `users`, and the
 * broker grant lives outside the pod. Left behind, a deleted person's accounts
 * keep being mirrored into the pod by the steady sync. The removal door is
 * `disconnectAllUserConnections` (revoke at the broker, detach rows, retire
 * rules and sync state); its behaviour is pinned by
 * `services/capabilities/__tests__/connection-registry-doors.pglite.test.ts`.
 *
 * The DOOR SET is DERIVED: every non-test source under `src/` that runs
 * `.delete(users)` must be classified below, so a new user-deletion site fails
 * this test until someone decides whether it removes a person's connections.
 * Inside a covered file every `.delete(users)` is pinned too, so a second delete
 * added beside a covered one cannot hide behind it.
 *
 * WHAT IT CANNOT SEE:
 *   - It reads text: a covered site must name the cleanup for the same user
 *     before its delete, but an ignored result or a swallowed error passes.
 *     "Before" is file order, not control flow.
 *   - A user delete spelled differently (raw SQL, `tx.delete(schema.users)`)
 *     is not found by the scan.
 *   - The "agent identity" classification is a judgement recorded here (an
 *     agent user never runs the OAuth connect flow), not something checked.
 */

const srcRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(srcRoot, rel), "utf-8");
const USER_DELETE = /\.delete\(users\)/g;

/** Human-user deletes: each pins the delete and the cleanup that precedes it. */
const COVERED_SITES = [
  {
    file: "routers/system.ts",
    cleanup: "await disconnectAllUserConnections(input.userId)",
    userDelete: "tx.delete(users).where(eq(users.id, input.userId))",
  },
  {
    file: "routers/workspaces/invites.ts",
    cleanup: "await disconnectAllUserConnections(staleUser.id)",
    userDelete: "db.delete(users).where(eq(users.id, staleUser.id))",
  },
  {
    file: "routers/workspaces/invites.ts",
    cleanup: "await disconnectAllUserConnections(input.userId)",
    userDelete: "db.delete(users).where(eq(users.id, input.userId))",
  },
  {
    file: "routers/hub-protocol/rest/setup.ts",
    cleanup: "await disconnectAllUserConnections(existingUser.id)",
    userDelete: "db.delete(users).where(eq(users.id, existingUser.id))",
  },
];

/** Agent-user deletes inside a covered file: deleteUser's child agents. */
const AGENT_DELETES_IN_COVERED: Record<string, number> = {
  "routers/system.ts": 1,
};

/** Files that delete agent users only. */
const AGENT_IDENTITY = [
  "routers/agent-users.ts",
  "routers/intelligence-registry.ts",
  "scripts/provision-agent.ts",
];

function userDeletionSites(): string[] {
  const entries = readdirSync(srcRoot, { recursive: true }) as string[];
  return entries
    .filter(
      (rel) =>
        rel.endsWith(".ts") &&
        !rel.endsWith(".test.ts") &&
        !rel.includes("__tests__") &&
        !rel.includes("__tripwires__")
    )
    .filter((rel) => /\.delete\(users\)/.test(read(rel)))
    .sort();
}

describe("tripwire: deleting a user removes their connections", () => {
  it("every user-deletion site is classified (the set is derived from the source)", () => {
    const sites = userDeletionSites();
    // Non-vacuity: the scan reaches the known human-deletion door.
    expect(sites).toContain("routers/system.ts");
    const covered = [...new Set(COVERED_SITES.map((s) => s.file))];
    expect(sites).toEqual([...covered, ...AGENT_IDENTITY].sort());
  });

  it("every human-user delete is preceded by the connection removal for THAT user", () => {
    for (const site of COVERED_SITES) {
      const text = read(site.file);
      const del = text.indexOf(site.userDelete);
      expect(del, `${site.file}: ${site.userDelete} not found`).toBeGreaterThan(
        -1
      );
      expect(
        text.indexOf(site.userDelete, del + 1),
        `${site.file}: ${site.userDelete} appears twice — pin each site`
      ).toBe(-1);
      expect(
        text.lastIndexOf(site.cleanup, del),
        `${site.file}: ${site.cleanup} must precede ${site.userDelete}`
      ).toBeGreaterThan(-1);
    }
  });

  it("no unpinned user delete hides in a covered file", () => {
    for (const file of new Set(COVERED_SITES.map((s) => s.file))) {
      const total = read(file).match(USER_DELETE)?.length ?? 0;
      const pinned = COVERED_SITES.filter((s) => s.file === file).length;
      expect(total, file).toBe(pinned + (AGENT_DELETES_IN_COVERED[file] ?? 0));
    }
  });

  it("deleteUser removes the connections before its transaction deletes anything", () => {
    const system = read("routers/system.ts");
    const start = system.indexOf("deleteUser: podAdminProcedure");
    expect(start, "deleteUser not found").toBeGreaterThan(-1);
    const end = system.indexOf("\n  /**", start);
    expect(end, "end of deleteUser not found").toBeGreaterThan(start);
    const body = system.slice(start, end);

    const cleanup = body.indexOf(
      "await disconnectAllUserConnections(input.userId)"
    );
    const transaction = body.indexOf("db.transaction(");
    expect(cleanup, "connection removal missing").toBeGreaterThan(-1);
    expect(
      transaction,
      "transaction not found (scan truncated?)"
    ).toBeGreaterThan(-1);
    expect(cleanup).toBeLessThan(transaction);
  });
});
