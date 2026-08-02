-- 0222: role-category marker on profiles
--
-- WHY. An automation must be able to select entities wearing ANY role in a
-- CATEGORY without hardcoding the role list. The networking intro-matcher wants
-- to query "providers" ONCE and have every supply role qualify —
-- `solution-provider` (networking) + `market-maker` / `security-auditor` /
-- `dev-shop` / `marketing-agency` / `paid-ads-agency` / `kol`
-- (blockchain-ecosystem) — extensible to future roles with ZERO matcher edits.
--
-- WHAT. A nullable `role_category` text column on `profiles`. A role-profile
-- (profile_kind = 'role') tagged with a category joins that category's cohort.
-- The `entity.query` flow verb resolves `roleCategory` → every profile carrying
-- it → the polymorphic facet-EXISTS scope predicate (profileScopeConditions),
-- ANDed with the caller's access floor exactly like the single-slug path.
--
-- Sibling of `semantic_slug` (0054): a nullable text grouping key, NULL = "no
-- category". No CHECK constraint (free-string, template-defined vocabulary), no
-- backfill (existing rows keep NULL until a template/write tags them).

ALTER TABLE "profiles" ADD COLUMN IF NOT EXISTS "role_category" text;

-- Partial index: the only read is "profiles WHERE role_category = ?", and the
-- overwhelming majority of profiles carry no category (NULL).
CREATE INDEX IF NOT EXISTS "profiles_role_category_idx"
  ON "profiles" ("role_category")
  WHERE "role_category" IS NOT NULL;
