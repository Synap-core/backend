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
 *     `sync-materializer.ts` holds the one drizzle insert that does not go
 *     through the repository; `conversions/engine.ts` `applySeedKindProfile`
 *     holds the one RAW-SQL insert (plus its dry-run count).
 *  3. The set of files that write to `profiles` at all is CLOSED — for drizzle
 *     writes (`.insert(profiles)` / `.update(profiles)`) AND for raw SQL
 *     (`INSERT INTO profiles` / `UPDATE profiles`). This is the property that
 *     makes the other two durable: a future write path would satisfy (1) and
 *     (2) while quietly re-opening the hole, and only this check catches it.
 *
 * If (3) fails: your new file writes to `profiles` directly. Either route it
 * through `ProfileRepository`, or call `assertProfileSlugNotReserved(slug)`
 * before the write and add the file here with a one-line reason.
 *
 * WHAT THE RAW-SQL SCAN CANNOT SEE (read off the regex, not implied):
 *  - a table name built at runtime (`UPDATE ${tableName}`, `"prof" + "iles"`),
 *    and any `sql.unsafe(...)` / `sql.raw(...)` string concatenation;
 *  - `.sql` migration files, DB functions, triggers, and `COPY profiles`;
 *  - `*.test.ts` files (excluded from every scan here) and any file outside
 *    `packages/{database,api,jobs}/src` (e.g. `apps/`);
 *  - a column assignment the SET parser cannot split (a value containing a
 *    comma): that fails RED as "not permitted", never silently green.
 * It DOES see comments: prose containing `UPDATE profiles` in a non-allowlisted
 * file turns it red. That is the deliberate fail-loud direction — reword the
 * comment rather than widening the allowlist.
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

const PACKAGES = join(process.cwd(), "..");
const API_SRC = join(process.cwd(), "src");
const JOBS_SRC = join(PACKAGES, "jobs", "src");
/** Every source root scanned for raw-SQL profile writes. */
const RAW_SQL_ROOTS = [DB_SRC, API_SRC, JOBS_SRC];

/**
 * A raw-SQL write to `profiles`: `INSERT INTO` or `UPDATE`, optionally
 * `public.`-qualified and/or double-quoted, or a drizzle `sql` template that
 * interpolates the table object (`UPDATE ${profiles}`). `profiles\b` keeps
 * `profiles_archive` and `profile_properties` out.
 */
const RAW_PROFILE_WRITE =
  /\b(INSERT\s+INTO|UPDATE)\s+(?:(?:"?public"?\.)?(?:"profiles"|profiles\b)|\$\{profiles\})/gi;

/**
 * Files permitted to write `profiles` with RAW SQL, keyed by path under
 * `packages/`, each with its reason. Every hit inside an allowlisted file is
 * still classified below — the allowlist admits a FILE, not every statement.
 */
const RAW_SQL_PROFILE_WRITE_SITES: ReadonlyMap<string, string> = new Map([
  [
    "database/src/conversions/engine.ts",
    "the ontology conversion engine runs on raw postgres.js by design (migrate.ts contract). " +
      "Its one INSERT seeds a kind profile and asserts the reservation first; its UPDATEs only " +
      "flip profile_kind / applicable_kinds / ui_hints or DEACTIVATE (is_active = false) — " +
      "none renames a slug or revives a row, the two ways around the reservation.",
  ],
]);

/**
 * Columns an allowlisted raw UPDATE may assign. `slug` is absent (a rename can
 * mint a reserved slug); `is_active` is present but may only be set to `false`
 * (setting it true is a revive, the inverse of migration 0151).
 */
const PERMITTED_RAW_UPDATE_COLUMNS = new Set([
  "profile_kind",
  "applicable_kinds",
  "ui_hints",
  "updated_at",
  "is_active",
]);

interface RawProfileWrite {
  verb: "INSERT" | "UPDATE";
  index: number;
  statement: string;
}

function rawProfileWrites(src: string): RawProfileWrite[] {
  return [...src.matchAll(RAW_PROFILE_WRITE)].map((m) => {
    const index = m.index ?? 0;
    // A postgres.js / drizzle template ends at the next backtick.
    const close = src.indexOf("`", index);
    return {
      verb: /^insert/i.test(m[1]) ? ("INSERT" as const) : ("UPDATE" as const),
      index,
      statement: src.slice(index, close === -1 ? index + 400 : close),
    };
  });
}

/** Drops block comments and whole-line `//` comments, so prose cannot satisfy an assertion. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Why an allowlisted raw write is still illegal, or null when it is fine. */
function rawWriteViolation(src: string, hit: RawProfileWrite): string | null {
  if (hit.verb === "INSERT") {
    const fnStart = Math.max(
      ...[
        "\nasync function ",
        "\nexport async function ",
        "\nfunction ",
        "\nexport function ",
      ].map((sig) => src.lastIndexOf(sig, hit.index))
    );
    const before = stripComments(src.slice(Math.max(fnStart, 0), hit.index));
    return before.includes("assertProfileSlugNotReserved(")
      ? null
      : "INSERT INTO profiles with no assertProfileSlugNotReserved() before it in the same function";
  }
  const set = /\bSET\b([\s\S]*?)(?:\bWHERE\b|\bFROM\b|\bRETURNING\b|$)/i.exec(
    hit.statement
  );
  if (!set) return "UPDATE profiles with no parseable SET clause";
  const assignments = [...set[1].matchAll(/([a-z_]+)\s*=\s*([^,]*)/gi)];
  if (assignments.length === 0) {
    return "UPDATE profiles assigns no column the scan can read";
  }
  for (const [, column, value] of assignments) {
    if (!PERMITTED_RAW_UPDATE_COLUMNS.has(column.toLowerCase())) {
      return `UPDATE profiles assigns \`${column}\`, which is not a permitted raw-update column`;
    }
    if (column.toLowerCase() === "is_active" && !/^\s*false\b/i.test(value)) {
      return "UPDATE profiles sets is_active to something other than false — that is a revive";
    }
  }
  return null;
}

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

  it("the conversion engine's raw seedKindProfile INSERT asserts before writing (apply AND dry run)", () => {
    const src = readFileSync(join(DB_SRC, "conversions", "engine.ts"), "utf8");
    const start = src.indexOf("async function applySeedKindProfile(");
    expect(
      start,
      "applySeedKindProfile moved or was renamed — the tripwire is scanning a stale shape"
    ).toBeGreaterThan(-1);
    const rest = src.slice(start);
    const next = rest.slice(1).search(/\n(?:export )?(?:async )?function /);
    const body = stripComments(next === -1 ? rest : rest.slice(0, next + 1));
    const write = body.search(/INSERT\s+INTO\s+profiles/);
    const guard = body.indexOf("assertProfileSlugNotReserved(op.slug)");
    expect(
      write,
      "applySeedKindProfile no longer inserts into profiles"
    ).toBeGreaterThan(-1);
    expect(
      guard,
      "applySeedKindProfile is a raw INSERT that bypasses ProfileRepository.create() — it must restate the reservation"
    ).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(write);

    // The dry-run count refuses too, so an operator sees it before --apply.
    const counts = src.indexOf("export async function computeCounts(");
    expect(counts).toBeGreaterThan(-1);
    const caseStart = src.indexOf('case "seedKindProfile": {', counts);
    expect(caseStart).toBeGreaterThan(-1);
    const caseEnd = src.indexOf("case ", caseStart + 1);
    expect(stripComments(src.slice(caseStart, caseEnd))).toContain(
      "assertProfileSlugNotReserved(op.slug)"
    );
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

  // ── Property 3b: raw-SQL writes to `profiles` are closed too ───────────────

  it("the raw-SQL pattern still sees what it hunts (literal self-check)", () => {
    const hits = (s: string) => rawProfileWrites(s).length;
    expect(hits("INSERT INTO profiles (slug) VALUES ('project')")).toBe(1);
    expect(hits('insert into "profiles" (slug) values ($1)')).toBe(1);
    expect(hits('UPDATE "public"."profiles" SET slug = $1')).toBe(1);
    expect(hits("UPDATE public.profiles\n  SET is_active = true")).toBe(1);
    expect(hits("UPDATE ${profiles} SET slug = ${x}")).toBe(1);
    // Near-misses that are not writes to `profiles`.
    expect(hits("UPDATE profile_properties SET x = 1")).toBe(0);
    expect(hits("INSERT INTO profiles_archive (slug) VALUES ('a')")).toBe(0);
    expect(hits("INSERT INTO profile_workspace_access VALUES ($1)")).toBe(0);
    expect(hits("SELECT 1 FROM profiles WHERE slug = $1")).toBe(0);

    // The classifier refuses the two ways around the reservation, and a
    // comment cannot stand in for the assert.
    const one = (s: string) => rawWriteViolation(s, rawProfileWrites(s)[0]);
    expect(one("UPDATE profiles SET slug = 'project' WHERE id = 1")).toMatch(
      /slug/
    );
    expect(one("UPDATE profiles SET is_active = true WHERE id = 1")).toMatch(
      /revive/
    );
    expect(
      one(
        "UPDATE profiles SET is_active = false, updated_at = now() WHERE id = 1"
      )
    ).toBeNull();
    expect(
      one("async function f() {\n  INSERT INTO profiles (slug) VALUES ($1)")
    ).toMatch(/assertProfileSlugNotReserved/);
    expect(
      one(
        "async function f() {\n  // assertProfileSlugNotReserved(op.slug)\n  INSERT INTO profiles (slug) VALUES ($1)"
      )
    ).toMatch(/assertProfileSlugNotReserved/);
  });

  it("no file writes `profiles` with raw SQL outside the allowlist, and allowlisted writes stay within their reason", () => {
    const perRoot = RAW_SQL_ROOTS.map((root) => tsFiles(root));
    // Non-vacuity: every root is real and populated — a moved package would
    // otherwise scan nothing and pass.
    for (const [i, files] of perRoot.entries()) {
      expect(
        files.length,
        `raw-SQL scan root ${RAW_SQL_ROOTS[i]} yielded almost no files — stale path?`
      ).toBeGreaterThan(20);
    }

    const offenders: string[] = [];
    let allowlistedInserts = 0;
    let allowlistedUpdates = 0;
    for (const file of perRoot.flat()) {
      const src = readFileSync(file, "utf8");
      const hits = rawProfileWrites(src);
      if (hits.length === 0) continue;
      const rel = relative(PACKAGES, file).split(/[\\/]/).join("/");
      if (!RAW_SQL_PROFILE_WRITE_SITES.has(rel)) {
        offenders.push(
          `${rel}: ${hits.length} raw write(s) to profiles in a non-allowlisted file`
        );
        continue;
      }
      for (const hit of hits) {
        if (hit.verb === "INSERT") allowlistedInserts++;
        else allowlistedUpdates++;
        const why = rawWriteViolation(src, hit);
        if (why) {
          const line = src.slice(0, hit.index).split("\n").length;
          offenders.push(`${rel}:${line}: ${why}`);
        }
      }
    }

    // Non-vacuity: the scan must still find the engine's known writes, or it
    // has stopped looking at what it claims.
    expect(
      allowlistedInserts,
      "expected the engine's seedKindProfile INSERT"
    ).toBeGreaterThanOrEqual(1);
    expect(
      allowlistedUpdates,
      "expected the engine's kind-flip / deactivation UPDATEs"
    ).toBeGreaterThanOrEqual(1);

    expect(
      offenders,
      "a raw-SQL write to `profiles` re-opens the reserved-slug hole — route it through ProfileRepository, or assert the slug first and allowlist the file with a reason"
    ).toEqual([]);
  });
});
