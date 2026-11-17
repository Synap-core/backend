/**
 * TRIPWIRE — no two migrations share a number.
 *
 * The runner (`src/scripts/migrate.ts`) sorts `packages/database/migrations/*.sql`
 * by filename and records each applied file BY FILENAME in `_migrations`, so
 * two files with one number both apply (in alphabetical order of the rest of
 * their name) and nothing breaks at deploy. What breaks is the reader: a
 * number no longer names one migration ("0427" in a commit, a plan or a test
 * name is ambiguous), and two lanes that both took the next free number land
 * a pair nobody chose, whose relative order is decided by the words after
 * the number. Before this guard nothing checked it: main reached 11 repeated
 * numbers, the latest 0427 (`0427_linkedin_account_ceilings.sql` and
 * `0427_one_live_run_per_subject.sql`, merged the same day by two lanes).
 *
 * The rule: a new migration takes a number no other file has. A file that
 * must sit between two shipped ones takes a letter suffix (`0338b_…`), which
 * is its own number here.
 *
 * NEVER RENAME A SHIPPED MIGRATION to fix a pair. Pods record the filename:
 * a renamed file is a NEW migration to every pod that already applied the old
 * name, and runs again. So the pairs that already shipped are allowlisted
 * below, exactly (each group's full file list): a third file on a listed
 * number, a new pair, or a listed file that disappears (renamed or deleted)
 * all fail this test.
 *
 * The scanned set is DERIVED: every `.sql` in the migrations directory. A
 * `.sql` whose name does not start with a number would escape the check, so
 * it fails too.
 *
 * NOT covered: the legacy root `migrations/` directory (no longer written);
 * a number reused on two branches is caught only once both reach one tree
 * (the merge queue's combined run, or main).
 */
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../migrations"
);

/** `0427_name.sql` → `0427`; `0338b_name.sql` → `0338b`. */
const NUMBERED = /^(\d{4}[a-z]?)_[^/]+\.sql$/;

/**
 * Shipped before this guard existed: never renamed (see above). Each entry is
 * the group's COMPLETE, sorted file list.
 */
const SHIPPED_REPEATS: Record<string, readonly string[]> = {
  "0009": ["0009_agents_table.sql", "0009_remove_legacy_thread_kinds.sql"],
  "0020": [
    "0020_api_keys_workspace_scope.sql",
    "0020_pod_settings.sql",
    "0020_workspaces_archived_at.sql",
  ],
  "0149": ["0149_knowledge_pod_scoped.sql", "0149_skills_document_ids.sql"],
  "0150": ["0150_provider_integrations.sql", "0150_skills_body_document.sql"],
  "0216": [
    "0216_knowledge_facts_dedup.sql",
    "0216_messaging_accounts_workspace_id.sql",
  ],
  "0328": [
    "0328_cp_catalog_cache_listing.sql",
    "0328_library_groups.sql",
    "0328_projects_icon.sql",
  ],
  "0329": [
    "0329_agent_assignment_and_pause.sql",
    "0329_read_webpage_intent.sql",
  ],
  "0330": [
    "0330_governance_ceiling_axes_fold.sql",
    "0330_skills_url_patterns.sql",
  ],
  "0339": ["0339_app_person_sign_in.sql", "0339_oauth_refresh_tokens.sql"],
  "0412": [
    "0412_playbook_on_end_retired.sql",
    "0412_presence_device_links.sql",
  ],
  "0427": [
    "0427_linkedin_account_ceilings.sql",
    "0427_one_live_run_per_subject.sql",
  ],
};

/** Every number held by more than one file, with its sorted files. */
function repeatedNumbers(files: readonly string[]): Map<string, string[]> {
  const byNumber = new Map<string, string[]>();
  for (const file of files) {
    const m = NUMBERED.exec(file);
    if (!m) continue;
    const list = byNumber.get(m[1]!) ?? [];
    list.push(file);
    byNumber.set(m[1]!, list);
  }
  return new Map(
    [...byNumber]
      .filter(([, list]) => list.length > 1)
      .map(([n, list]) => [n, [...list].sort()])
  );
}

const sqlFiles = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));

describe("tripwire: every migration has its own number", () => {
  it("scans the real migrations directory (non-vacuous)", () => {
    expect(sqlFiles.length).toBeGreaterThan(300);
    expect(sqlFiles).toContain("0000_baseline_schema.sql");
    // The detector still sees a repeat, and a letter suffix as its own number.
    expect(
      repeatedNumbers(["0900_a.sql", "0900_b.sql", "0901_c.sql", "0901b_d.sql"])
    ).toEqual(new Map([["0900", ["0900_a.sql", "0900_b.sql"]]]));
  });

  it("every .sql file starts with a number (none escapes the check)", () => {
    expect(sqlFiles.filter((f) => !NUMBERED.test(f))).toEqual([]);
  });

  it("no new migration reuses a number; the shipped repeats stay exactly as they are", () => {
    const found = Object.fromEntries(repeatedNumbers(sqlFiles));
    expect(
      found,
      "Two migration files share a number. Give the NEW file the next free " +
        "number (never rename a migration that already shipped: pods record " +
        "filenames). If a listed shipped group changed, a shipped file was " +
        "renamed or deleted: put it back."
    ).toEqual(SHIPPED_REPEATS);
  });
});
