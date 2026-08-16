import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import { join, relative } from "path";
import {
  isReservedProfileSlug,
  reservedProfileSlugReason,
  assertProfileSlugNotReserved,
  reservedProfileSlugs,
} from "@synap/database";

/**
 * TRIPWIRE — `project` can never be an entity profile.
 *
 * Migration `0151_consolidate_projects_table.sql` moved projects out of
 * `entities` (`profileSlug = 'project'`) and into the `projects` TABLE. Its
 * step 6 set `profiles.is_active = false` for that slug, which is only a SOFT
 * block: nothing stopped a new profile being minted with the same slug, and
 * nothing stopped the retired row being revived. The decision is that the
 * `projects` table is canonical permanently, so the block has to be hard.
 *
 * Three properties, each of which is the reason a door stays shut:
 *
 *  1. The reservation itself refuses `project` (and the plural near-miss
 *     `projects`), case- and whitespace-insensitively, with an ACTIONABLE
 *     message that names the real home.
 *  2. Every write path to `profiles` calls the guard. `ProfileRepository`
 *     `.create()` is the floor under every create door (tRPC, MCP
 *     `synap_define_kind`, proposal materializer, template install,
 *     workspace-definition reconcile, `ensureSystemProfiles`); `.reactivate()`
 *     is the only revive door and is the literal inverse of 0151's flip;
 *     `sync-materializer.ts` holds the one raw insert that does not go through
 *     the repository.
 *  3. The set of files that write to `profiles` at all is CLOSED to those two.
 *     This is the property that makes the other two durable: a future fourth
 *     write path would satisfy (1) and (2) while quietly re-opening the hole,
 *     and only this check catches it.
 *
 * If (3) fails: your new file writes to `profiles` directly. Either route it
 * through `ProfileRepository`, or call `assertProfileSlugNotReserved(slug)`
 * before the write and add the file here with a one-line reason.
 */

const DB_SRC = join(process.cwd(), "..", "database", "src");

/** The two files permitted to write `profiles` rows directly. */
const PROFILE_WRITE_SITES = new Set<string>([
  // The repository — the create/update/reactivate/delete door itself.
  "repositories/profile-repository.ts",
  // Peer sync: materializes a remote pod's profile events. Cannot use the
  // repository (it upserts by id with last-write-wins), so it restates the
  // reservation inline.
  "utils/sync-materializer.ts",
]);

function tsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      tsFiles(p, acc);
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !entry.name.endsWith(".d.ts")
    ) {
      acc.push(p);
    }
  }
  return acc;
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

describe("tripwire: `project` is not an entity profile", () => {
  // ── Property 1: the reservation refuses the slug, actionably ───────────────

  it("refuses `project` and the plural near-miss `projects`", () => {
    expect(isReservedProfileSlug("project")).toBe(true);
    expect(isReservedProfileSlug("projects")).toBe(true);
    expect(reservedProfileSlugs()).toEqual(
      expect.arrayContaining(["project", "projects"])
    );
  });

  it("normalizes case and whitespace, so `  Project ` cannot slip through", () => {
    expect(isReservedProfileSlug("Project")).toBe(true);
    expect(isReservedProfileSlug("  PROJECT  ")).toBe(true);
    expect(isReservedProfileSlug(" Projects")).toBe(true);
  });

  it("does not over-reach onto slugs that merely contain the word", () => {
    for (const free of [
      "project-note",
      "projection",
      "subproject",
      "task",
      "decision",
    ]) {
      expect(isReservedProfileSlug(free), free).toBe(false);
      expect(reservedProfileSlugReason(free), free).toBeUndefined();
    }
  });

  it("names the real home and the door to use instead, not a bare rejection", () => {
    const reason = reservedProfileSlugReason("project");
    expect(reason).toBeDefined();
    // The three things a caller needs: what is reserved, where it lives, what
    // to call instead.
    expect(reason).toContain("project");
    expect(reason).toContain("`projects` TABLE");
    expect(reason).toMatch(/projects\.\*|synap_create_project/);
  });

  it("assertProfileSlugNotReserved throws on reserved, passes on free", () => {
    expect(() => assertProfileSlugNotReserved("project")).toThrow(
      /`projects` TABLE/
    );
    expect(() => assertProfileSlugNotReserved("projects")).toThrow();
    expect(() => assertProfileSlugNotReserved("task")).not.toThrow();
  });

  // ── Property 2: every write path calls the guard ───────────────────────────

  it("ProfileRepository.create() asserts before inserting", () => {
    const src = readFileSync(
      join(DB_SRC, "repositories", "profile-repository.ts"),
      "utf8"
    );
    const body = methodBody(src, "async create(input: CreateProfileInput)");
    expect(
      body,
      "ProfileRepository.create() must call assertProfileSlugNotReserved — it is the floor under every profile create door"
    ).toContain("assertProfileSlugNotReserved(");
    // Ordering: the refusal must precede the write, not follow it.
    expect(body.indexOf("assertProfileSlugNotReserved(")).toBeLessThan(
      body.indexOf(".insert(profiles)")
    );
  });

  it("ProfileRepository.reactivate() asserts before reviving", () => {
    const src = readFileSync(
      join(DB_SRC, "repositories", "profile-repository.ts"),
      "utf8"
    );
    const body = methodBody(src, "async reactivate(id: string)");
    expect(
      body,
      "reactivate() is the inverse of migration 0151's is_active flip — without the assert the reservation is one call deep"
    ).toContain("assertProfileSlugNotReserved(");
    expect(body.indexOf("assertProfileSlugNotReserved(")).toBeLessThan(
      body.indexOf(".update(profiles)")
    );
  });

  it("the peer-sync raw insert refuses a reserved slug before writing", () => {
    const src = readFileSync(
      join(DB_SRC, "utils", "sync-materializer.ts"),
      "utf8"
    );
    const start = src.indexOf("async function materializeProfile(");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start);
    const guard = body.indexOf("reservedProfileSlugReason(");
    const write = body.indexOf(".insert(profiles)");
    expect(
      guard,
      "sync-materializer is the one profile write that bypasses ProfileRepository — it must restate the reservation"
    ).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(write);
  });

  it("the tRPC create door refuses before governance mints a proposal", () => {
    const src = readFileSync(
      join(process.cwd(), "src", "routers", "profiles.ts"),
      "utf8"
    );
    const guard = src.indexOf("reservedProfileSlugReason(input.slug)");
    const propose = src.indexOf("checkPermissionOrPropose(");
    expect(
      guard,
      "profiles.createProfile must refuse a reserved slug up front, or governance proposes a write that can never be applied"
    ).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(propose);
  });

  // ── Property 3: the set of profile write sites is closed ───────────────────

  it("no file outside the two known write sites inserts or updates `profiles`", () => {
    const offenders = tsFiles(DB_SRC)
      .filter((f) => {
        const src = readFileSync(f, "utf8");
        return (
          src.includes(".insert(profiles)") || src.includes(".update(profiles)")
        );
      })
      .map((f) => relative(DB_SRC, f).split(/[\\/]/).join("/"))
      .filter((rel) => !PROFILE_WRITE_SITES.has(rel));
    expect(
      offenders,
      "a new direct write to `profiles` re-opens the reserved-slug hole — route it through ProfileRepository or assert the slug and allowlist the file"
    ).toEqual([]);
  });

  it("no file in api/src writes `profiles` directly at all", () => {
    const offenders = tsFiles(join(process.cwd(), "src"))
      .filter((f) => {
        const src = readFileSync(f, "utf8");
        return (
          src.includes(".insert(profiles)") || src.includes(".update(profiles)")
        );
      })
      .map((f) => relative(join(process.cwd(), "src"), f));
    expect(
      offenders,
      "api/src must go through ProfileRepository for profile writes"
    ).toEqual([]);
  });
});
