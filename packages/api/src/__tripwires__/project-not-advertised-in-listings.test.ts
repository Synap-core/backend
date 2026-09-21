import { describe, it, expect } from "vitest";
import { isReservedProfileSlug } from "@synap/database";
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
 *  - the MCP TOOL SURFACE is covered by the last test here, added 2026-09-21
 *    after the same defect recurred through a different surface: the pod
 *    listing doors were filtered, but `synap_create_entity`'s own
 *    `profileSlug` description still read "(e.g., note, task, project, …)",
 *    and a Raycast agent built a whole mental model on it (property defs on a
 *    project, a `wedge_stage` field) before asking why the tool was missing.
 *    A filtered listing does not help an agent that reads the KIND out of the
 *    tool description it is handed first.
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

  /**
   * Keys whose description names WHICH ENTITY KIND to pick. `synap_get_graph`'s
   * `type` is deliberately NOT here: it enumerates OBJECT kinds (entity,
   * project, view, session…), where a project is a real, addressable object —
   * the reservation is about entity PROFILES only.
   */
  const KIND_CHOOSING_KEYS = new Set([
    "profileSlug",
    "profileSlugs",
    "kindSlug",
  ]);

  it("no MCP tool advertises a reserved slug as a choosable entity kind", () => {
    const manifest = JSON.parse(
      read(API_SRC, "routers", "mcp", "tools", "mcp-tools.manifest.json")
    ) as { tools: Array<Record<string, any>> };
    expect(
      manifest.tools.length,
      "manifest parsed no tools — the scan proves nothing"
    ).toBeGreaterThan(30);

    const scanned: string[] = [];
    const offenders: string[] = [];
    for (const tool of manifest.tools) {
      const props = (tool.inputSchema?.properties ?? {}) as Record<
        string,
        { description?: string }
      >;
      for (const [key, schema] of Object.entries(props)) {
        if (!KIND_CHOOSING_KEYS.has(key)) continue;
        const description = schema?.description;
        if (typeof description !== "string") continue;
        scanned.push(`${tool.name}.${key}`);
        // Bare words only: `synap_create_project` is a TOOL NAME an agent
        // should be pointed at, and `_project` carries no word boundary.
        for (const word of description.match(/\b[a-z][a-z-]*\b/g) ?? []) {
          if (isReservedProfileSlug(word)) {
            offenders.push(`${tool.name}.${key}: "${word}"`);
          }
        }
      }
    }
    // Non-vacuity: these keys exist on the create/classify tools today.
    expect(
      scanned.length,
      "found no kind-choosing property at all — the key set is stale"
    ).toBeGreaterThanOrEqual(2);
    expect(offenders, "reserved slug advertised as an entity kind").toEqual([]);
  });

  it("self-check: the manifest scan flags a synthetic offender", () => {
    const bare = "Entity profile slug (e.g., note, project, person).";
    const pointer = "Not an entity kind — use synap_create_project.";
    const words = (d: string) =>
      (d.match(/\b[a-z][a-z-]*\b/g) ?? []).filter(isReservedProfileSlug);
    expect(words(bare)).toEqual(["project"]);
    // The tool-name pointer must stay allowed, or the fix is unwritable.
    expect(words(pointer)).toEqual([]);
  });
});
