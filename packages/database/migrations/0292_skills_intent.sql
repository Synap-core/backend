-- 0292_skills_intent
--
-- A SKILL carries its own ROUTING INTENT — the vendor-independent verb it means
-- (`ABSTRACT_VERBS` / the `capability_intents` vocabulary, migrations
-- 0283/0284) — so an agent can ask "what can send a message?" without already
-- knowing that `gmail_send` is the verb installed.
--
-- WHY A COLUMN AND NOT ONLY THE TOOL'S VERB CATALOG. `intent` used to be
-- persisted in exactly one place: `tools.capabilities[].intent`, written by
-- `deriveToolVerbs` for skills that `requires` that tool. Every reader
-- therefore had to join THROUGH a tool. That holds only while the definition
-- declares a tool to hang the catalog on, and two real shapes do not:
-- `SYNAP_CORE_DEFINITION` (47 builtins) and `web-read.capability.json` both
-- declare `tools: []`. Verified live 2026-10-01: an agent asking
-- `intent: "send_message"` on a pod whose `messaging.send` builtin is installed
-- and runnable received ONLY `gmail_send`. The skill is the thing that actually
-- executes, so the skill row is the right carrier.
--
-- ROUTING, NEVER AUTHORIZATION. An intent resolves to a CONCRETE verb id; the
-- grant gate then decides on that verb exactly as before. Nothing here can
-- widen what a caller may run.
--
-- NO FK. The vocabulary is OPEN (the seed in `ABSTRACT_VERBS` plus whatever
-- rows exist in `capability_intents`), so a foreign key would force a migration
-- to register every new intent. Null means "declares none" and is never guessed
-- into a bucket.
--
-- NO INDEX. `intent` is read only as part of the existing
-- skill→tool join that already fetches the skill rows; it is never a standalone
-- predicate. An index here would be paid for on every insert and used by no
-- query.
--
-- Fresh installs also get the column from 0000_baseline_schema.sql. This file
-- is for pods that already booted.

ALTER TABLE "skills" ADD COLUMN IF NOT EXISTS "intent" text;

-- ── Backfill ────────────────────────────────────────────────────────────────
-- Already-installed rows predate the column. The only place their intent was
-- recorded is the requiring tool's verb catalog entry whose `id` equals the
-- skill's name (see `deriveToolVerbs`), so the derivation is a join:
--
--   skills.id  ← links.from_id        (linkType 'requires', fromType 'skill')
--   tools.id   ← links.to_id          (linkType 'requires', toType 'tool')
--   intent     ← tools.capabilities->*->>'intent'   (the entry with id = skill.name)
--
-- PROPERTIES THIS STATEMENT IS BUILT TO HAVE. All four were violated by the
-- naive form (`UPDATE … FROM` over a multi-row join), which is why this is a
-- set-based aggregate rather than the obvious statement:
--
--  1. DETERMINISTIC for a skill requiring SEVERAL tools. Several of its tools
--     may carry a catalog entry named after it, each with its own intent; a
--     plain join would make the UPDATE non-deterministic (Postgres picks an
--     arbitrary matching row) and, worse, re-run to a different answer.
--     Aggregating to exactly one row per skill, with MIN(intent) as a
--     deterministic tie-break, makes re-running a no-op.
--
--  2. IT NEVER OVERWRITES ANOTHER WRITER'S VALUE. A skill whose intent was set
--     by a later definition re-apply is authoritative. `WHERE intent IS NULL`
--     scopes the write to rows that have none, so this backfill can only ever
--     fill a hole — re-running it is always safe, and a pod that already
--     converged is untouched.
--
--  3. IT CONFLICTS WITH NOTHING. A skill requiring two tools that declare
--     DIFFERENT intents (a template authoring error — one verb, one meaning)
--     cannot be resolved to one truth; MIN() picks one deterministically and
--     `WHERE intent IS NULL` then freezes that choice, so the value is stable
--     rather than oscillating per boot. It is resolved properly on the next
--     definition re-apply, which writes the column directly and overwrites this.
--
--  4. TOOL-LESS SKILLS STAY NULL, which is CORRECT, not a gap. `messaging.send`,
--     `entity.query`, `web.read` and every other Synap Core builtin require no
--     tool, so there is no catalog entry to derive from and no value to invent.
--     Their intent arrives on the next definition re-apply, which projects the
--     definition's top-level `intent` onto the column.
--
--  --  5. THE CATALOG ENTRY MUST BE MATCHED TO THE SKILL, NOT JUST THE TOOL. This
--     is the defect that makes or breaks the whole backfill, and a naive
--     `UPDATE … FROM` over `links → tools` walks straight into it.
--
--     A tool's `capabilities` array holds one entry PER REQUIRING SKILL, each
--     whose `id` EQUALS that skill's name (`deriveToolVerbs` builds exactly
--     that). `CROSS JOIN LATERAL jsonb_array_elements(...)` therefore
--     cross-joins EVERY entry of the tool against EVERY skill linked to that
--     tool — so a Gmail tool whose catalog carries `gmail_send` (send_message)
--     plus `calendar_send` (schedule_event) hands `send_message` to the
--     `calendar_send` skill too. Every skill requiring one tool would then take
--     the alphabetically-first intent on it, regardless of what that verb means.
--     Verified against a real Postgres before this clause existed: three
--     unrelated skills all received `fetch_record` off one shared tool.
--
--     So the entry is filtered to `entry->>'id' = s."name"` — the same identity
--     the applier builds the entry with, which is why it is a real join
--     predicate and not a guess.
--
--  6. THE JOIN CAST IS LOAD-BEARING, IN BOTH PLACES. `links.to_id` and
--     `links.from_id` are `text` (polymorphic by design) while `tools.id` and
--     `skills.id` are `uuid`, and Postgres has NO implicit uuid=text operator
--     (SQLSTATE 42883) — every one of these joins raises
--     `operator does not exist: uuid = text` and aborts the whole migration
--     unless the UUID side is cast. Verified against a real Postgres.
--     `to_id::uuid` would ALSO fail, for a worse reason: it throws 22P02 on a
--     malformed id, and these links are polymorphic across every endpoint type,
--     so a non-uuid id is a normal row rather than corruption. The only safe
--     direction is always uuid → text. Same defect, same fix as the
--     connection-state join in `capability-registry.ts`.
--
-- The `INNER JOIN tools` (rather than LEFT) is deliberate: a link to a tool row
-- that no longer exists has no catalog to read, and yielding NULL for it is the
-- same honest answer as yielding no link at all.

UPDATE "skills" AS s
SET "intent" = derived.intent
FROM (
  SELECT
    l."from_id" AS skill_id,
    -- `jsonb_array_elements` yields ONE column per array element, so the alias
    -- `entry` IS that element and the JSON key is read with `->>`, not as a
    -- sub-column (`entry."intent"` raises `column entry.intent does not exist`
    -- — verified against a real Postgres).
    MIN(entry->>'intent') AS intent
  FROM "links" AS l
  INNER JOIN "tools" AS t
    ON t."id"::text = l."to_id"
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(t."capabilities") = 'array' THEN t."capabilities"
      ELSE '[]'::jsonb
    END
  ) AS entry
  WHERE l."from_type" = 'skill'
    AND l."to_type" = 'tool'
    AND l."link_type" = 'requires'
    -- The load-bearing match — see property 5. `l."to_id"` is the tool, and
    -- the entry names the SKILL. Without this clause the backfill assigns one
    -- skill's verb catalog entry to every other skill on the same tool.
    AND entry->>'id' = (SELECT sk."name" FROM "skills" AS sk WHERE sk."id"::text = l."from_id")
    AND entry->>'intent' IS NOT NULL
    AND entry->>'intent' <> ''
  GROUP BY l."from_id"
) AS derived
-- Same cast rule as property 5 on the OUTER join: `skills.id` is uuid and the
-- derived `from_id` is the links' polymorphic text. Without `::text` on the uuid
-- side this raises `operator does not exist: uuid = text` — the identical
-- defect, in the second place it can appear in this one statement.
WHERE s."id"::text = derived.skill_id
  -- Never overwrite a value another writer owns (property 2). Also makes the
  -- whole statement a no-op on re-run, which is what "safe to re-run" means.
  AND s."intent" IS NULL;