-- 0237_events_hypertable_coherence_and_retention.sql
--
-- Two problems with the `events` table, both surfaced while adding the
-- observations door (hub-protocol `observations.append`).
--
-- ── 1. HYPERTABLE COHERENCE ────────────────────────────────────────────────
-- Five code comments assert `events` is a TimescaleDB hypertable with
-- columnstore compression, and on EXISTING pods it is — created by the legacy
-- `001_add_timescale_compression.sql`, which no longer exists as a file but is
-- seeded into `_migrations` as already-applied (0000_baseline_schema.sql).
-- Because it can never re-run, a FRESHLY PROVISIONED pod gets a PLAIN TABLE:
-- no partitioning, no compression, and every comment about it silently wrong.
-- That divergence is invisible until a new pod grows.
--
-- This migration makes both shapes converge. It is written to be a no-op on a
-- pod that already has the hypertable, and to create it on one that does not.
--
-- ── 2. RETENTION — WIRED, BUT OPT-IN ───────────────────────────────────────
-- Nothing anywhere calls `add_retention_policy` or `drop_chunks`. Compression
-- (after 7 days) reduces size but never removes rows, so `events` grows without
-- bound. The observations door changes the volume class: a dev tool shipping
-- per-commit facts, and later CI, write orders of magnitude more.
--
-- But `events` is also the audit and event-sourcing spine — schema/events.ts
-- states rows are NEVER deleted and subjects rebuild by replay, and governance
-- lineage (proposal_id, ungoverned-write history) lives here. Expiring that on
-- every pod as a SIDE EFFECT of adding a logging door would be a data-policy
-- decision taken on the owner's behalf. So the policy is wired but DISABLED
-- until `synap.events_retention_days` is set deliberately.
--
-- TWO BLOCKS, different failure semantics, on purpose:
--   • shape convergence — NO exception handler. A failure must abort, or the
--     runner records this migration as applied and the divergence becomes
--     permanent and unfixable, exactly as the legacy one did.
--   • retention — guarded. It is operational; a policy that fails to install
--     must not take pod startup down with it.
--
-- On a Postgres without TimescaleDB both blocks return early: the table stays
-- plain and growth must be managed externally.

DO $$
DECLARE
  has_timescale boolean;
  is_hypertable boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'timescaledb'
  ) INTO has_timescale;

  IF NOT has_timescale THEN
    RAISE NOTICE '0237: timescaledb extension absent — events stays a plain table (no partitioning, no retention). This is supported; growth must be managed externally.';
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM timescaledb_information.hypertables
    WHERE hypertable_name = 'events'
      AND hypertable_schema = current_schema()
  ) INTO is_hypertable;

  -- ── Converge shape: create the hypertable if this pod never got one ──────
  IF NOT is_hypertable THEN
    RAISE NOTICE '0237: events is a plain table — converting to a hypertable.';
    -- migrate_data moves existing rows into chunks. On a fresh pod there are
    -- none; on a pod that somehow missed the legacy migration this is the
    -- catch-up. if_not_exists keeps it idempotent.
    PERFORM create_hypertable(
      'events', 'timestamp',
      migrate_data => true,
      if_not_exists => true
    );

    ALTER TABLE events SET (
      timescaledb.compress,
      timescaledb.compress_segmentby = 'user_id, subject_type',
      timescaledb.compress_orderby = 'timestamp DESC'
    );

    PERFORM add_compression_policy('events', INTERVAL '7 days', if_not_exists => true);
  ELSE
    RAISE NOTICE '0237: events is already a hypertable — leaving shape untouched.';
  END IF;

-- NO exception handler here, deliberately.
-- Migrations run inside a transaction and the runner records 0237 as applied on
-- success. Swallowing a conversion failure would print "applied", make the file
-- un-rerunnable, and silently recreate the exact "fresh pod gets a plain table"
-- divergence this migration exists to close — the same way the legacy
-- 001_add_timescale_compression.sql divergence survived. A shape failure must
-- abort loudly so it can be fixed and re-run.
END $$;

-- ── Retention, in its OWN block ──────────────────────────────────────────────
-- Deliberately separate from the shape conversion above. In a single block, a
-- failure in `create_hypertable` aborts everything after it — including the
-- retention policy — while the migration still reports success. That would
-- silently omit the retention mitigation on exactly the pods whose shape is
-- already unusual, i.e. the ones most likely to need it.
DO $$
DECLARE
  is_hypertable boolean;
  retention_days int;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    RAISE NOTICE '0237: timescaledb absent — no retention policy possible; events growth must be managed externally.';
    RETURN;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM timescaledb_information.hypertables
    WHERE hypertable_name = 'events'
      AND hypertable_schema = current_schema()
  ) INTO is_hypertable;

  IF NOT is_hypertable THEN
    RAISE WARNING '0237: events is NOT a hypertable, so no retention policy was applied. It will grow without bound — investigate.';
    RETURN;
  END IF;

  -- OPT-IN, by operator decision only.
  --
  -- `schema/events.ts` states events are NEVER updated or deleted and that
  -- subjects rebuild by replay; governance lineage (proposal_id, ungoverned-write
  -- history) lives here too. Silently expiring that on every pod, as a side
  -- effect of adding a logging door, is a data-policy change the pod owner has
  -- to make — not something a migration should decide for them. There are no
  -- continuous aggregates on `events`, so nothing precomputes what would be lost.
  --
  -- Set SYNAP_EVENTS_RETENTION_DAYS (e.g. 400) to enable. Until then the
  -- hypertable is converged and compressed but never expires.
  retention_days := NULLIF(current_setting('synap.events_retention_days', true), '')::int;

  IF retention_days IS NULL OR retention_days <= 0 THEN
    RAISE NOTICE '0237: no retention policy applied (synap.events_retention_days unset). events will grow without bound — set it deliberately once the volume class is understood.';
    RETURN;
  END IF;

  PERFORM add_retention_policy('events', make_interval(days => retention_days), if_not_exists => true);
  RAISE NOTICE '0237: retention policy on events set to % days.', retention_days;

EXCEPTION WHEN OTHERS THEN
  RAISE WARNING '0237: could not apply the events retention policy: % (%). Events will grow without bound until this is applied.', SQLERRM, SQLSTATE;
END $$;
