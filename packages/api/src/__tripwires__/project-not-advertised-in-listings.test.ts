import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * TRIPWIRE — a reserved profile slug (`project` / `projects`) is never
 * ADVERTISED as a choosable entity kind by any CREATE/CLASSIFY-facing
 * listing door, even though an active `project`-slug row predates the
 * `reserved-profile-slugs.ts` write-floor reservation (see the companion
 * write-side tripwire `project-is-not-an-entity-profile.test.ts`).
 *
 * Fixed live 2026-09-14: `GET /api/hub/discover` advertised two
 * `profileKind:"kind"` rows with slug `project`, an agent (Raycast) picked
 * one up and filed a proposal that died at approve with
 * "'project' is not an entity kind" (proposal d392b666). The write floor was
 * already correct; the READ floor was not.
 *
 * The fix sits at the ONE point every listing door already shared before
 * this fix — `ProfileRepository.getAccessibleProfiles`
 * (packages/database/src/repositories/profile-repository.ts) — via the
 * `excludeReservedProfiles` filter next to the reservation table
 * (packages/database/src/utils/reserved-profile-slugs.ts). See that file's
 * own unit test for the filter's behaviour; this tripwire proves two
 * different things:
 *
 *  1. `getAccessibleProfiles` actually calls the filter before returning
 *     (so a future refactor of that method can't quietly drop it).
 *  2. Every known CREATE/CLASSIFY-facing listing DOOR is wired to
 *     `getAccessibleProfiles` — directly, or transitively via
 *     `caller.profiles.listProfiles` (hub-protocol) →
 *     `regularProfilesRouter.list` / `.listMulti` (routers/profiles.ts) →
 *     `profileRepo.getAccessibleProfiles`, or via
 *     `ProfileResolutionService.getAccessibleProfiles` (a thin pass-through
 *     to the same repository call, used by the capture structurer
 *     (`routers/capture.ts`), `graph-service.ts`, `builtin-verbs.ts`,
 *     `structuring.ts`).
 *
 * WHAT THIS DOES NOT COVER (measured, not implied):
 *  - browser/relay/synap-app kind pickers and the Raycast/CLI clients: they
 *    call the tRPC `profiles.list` / `profiles.listMulti` procedures over
 *    the wire, which this tripwire DOES statically verify server-side, but
 *    the client call sites themselves are not scanned here — there is no
 *    second filter on the client to drift, since the server never sends the
 *    row.
 *  - a NEW listing door added later that reads `profiles` directly (e.g. a
 *    raw drizzle `.select().from(profiles)` bypassing the repository) is
 *    NOT caught by this file. `project-is-not-an-entity-profile.test.ts`'s
 *    closed-write-site scan is the sibling that would need a closed-READ-
 *    site scan to catch that class; this tripwire only proves the doors
 *    enumerated above are wired correctly today.
 */

const DB_SRC = join(process.cwd(), "..", "database", "src");
const API_SRC = join(process.cwd(), "src");

function read(...parts: string[]): string {
  return readFileSync(join(...parts), "utf8");
}

/** Body of a method, from its signature to the next same-indent method. */
function methodBody(src: string, signature: string): string {
  const start = src.indexOf(signature);
  expect(
    start,
    `expected to find '${signature}' — the tripwire is scanning a stale shape`
  ).toBeGreaterThan(-1);
  const rest = src.slice(start + signature.length);
  const end = rest.search(/\n {2}(?:\/\*\*|async |[a-zA-Z_$][\w$]*\()/);
  return end === -1 ? rest : rest.slice(0, end);
}

describe("tripwire: reserved profile slugs are never advertised by a listing door", () => {
  it("ProfileRepository.getAccessibleProfiles filters through excludeReservedProfiles before returning", () => {
    const src = read(DB_SRC, "repositories", "profile-repository.ts");
    const body = methodBody(
      src,
      "async getAccessibleProfiles(\n    userId: string,\n    workspaceId: string,\n    filters?: AccessibleProfileFilters\n  ): Promise<Profile[]> {"
    );
    expect(
      body,
      "getAccessibleProfiles must return through excludeReservedProfiles(...) — that is the ONE floor every listing door shares"
    ).toMatch(/return\s+excludeReservedProfiles\(/);
  });

  it("ProfileResolutionService.getAccessibleProfiles is a pass-through to the repository (no second, divergent implementation)", () => {
    const src = read(DB_SRC, "services", "profile-resolution-service.ts");
    const body = methodBody(
      src,
      "async getAccessibleProfiles(\n    userId: string,\n    workspaceId: string | null\n  ): Promise<Profile[]> {"
    );
    expect(body).toContain("this.profileRepo.getAccessibleProfiles(");
  });

  it("routers/profiles.ts `list` and `listMulti` (the tRPC doors browser/relay/Raycast/CLI kind pickers call) read through getAccessibleProfiles", () => {
    const src = read(API_SRC, "routers", "profiles.ts");
    const listBody = methodBody(src, "  list: podProcedure");
    expect(listBody).toContain("profileRepo.getAccessibleProfiles(");
    const listMultiIdx = src.indexOf("listMulti: protectedProcedure");
    expect(listMultiIdx).toBeGreaterThan(-1);
    expect(src.slice(listMultiIdx, listMultiIdx + 1200)).toContain(
      "profileRepo.getAccessibleProfiles("
    );
  });

  it("hub-protocol listProfiles (used by discover, GET /profiles, synap_list_profiles) routes to routers/profiles.ts `list`, never a second query", () => {
    const src = read(API_SRC, "routers", "hub-protocol", "profiles.ts");
    const body = methodBody(
      src,
      '  listProfiles: scopedProcedure(["hub-protocol.read"])'
    );
    expect(
      body,
      "hubProfilesRouter.listProfiles must delegate to regularProfilesRouter (caller.list), not re-implement the query"
    ).toContain("caller.list(");
  });

  // ── Every known CREATE/CLASSIFY-facing door calls caller.profiles.listProfiles ──

  const DOORS: ReadonlyArray<{ file: string[]; label: string }> = [
    {
      file: ["routers", "hub-protocol", "rest", "discover.ts"],
      label: "/discover (agent session bootstrap)",
    },
    {
      file: ["routers", "hub-protocol", "rest", "profiles.ts"],
      label: "GET /profiles (Hub REST)",
    },
    {
      file: ["routers", "mcp", "handlers", "read.ts"],
      label: "synap_list_profiles (MCP)",
    },
  ];

  it("the door set above is non-vacuous (self-check the scan can still see its files)", () => {
    expect(DOORS.length).toBeGreaterThanOrEqual(3);
    for (const door of DOORS) {
      expect(() => read(API_SRC, ...door.file)).not.toThrow();
    }
  });

  for (const door of DOORS) {
    it(`${door.label} calls caller.profiles.listProfiles (never a second, unfiltered profiles query)`, () => {
      const src = read(API_SRC, ...door.file);
      expect(
        src,
        `${door.label} must read profiles through caller.profiles.listProfiles`
      ).toContain("caller.profiles.listProfiles(");
    });
  }
});
