-- 0429 — provision_compute and release_compute intents (plan a640c5bb B3,
-- ticket 5f3c3a7d; founder decisions of 18 Nov 2026)
--
-- What a capability DOES is a row, not a TypeScript union (0283). An agent
-- that needs a machine for a while (a GPU job, a build, a pod's server) had
-- no provider-neutral seat: every cloud pack spelled start and stop its own
-- way, so a flow had to name the vendor. Two kinds of work had no seat:
--   provision_compute  start a temporary machine at a provider. Every start
--                      carries a time to live (`ttlMinutes`) and a spend
--                      maximum (`maxSpendCents`); the pod refuses a start
--                      without them and releases the machine at its TTL.
--   release_compute    stop (`mode: stop`) or destroy (`mode: destroy`) a
--                      machine started that way, by its `resourceId`.
-- Running a job on the machine and reading its outputs are not new seats:
-- they are run_external_job and fetch_record (0283), which the `compute`
-- need (0431) groups with these two. Stop and destroy are one act with a
-- mode, not two seats (RunPod's v2 API folded its per-action endpoints the
-- same way; 0413 refused a seat per ffmpeg recipe for the same reason).
--
-- EFFECT `act`, like run_external_job: both spend or stop spending money
-- outside the pod, so a pod app's run of either is always proposed
-- (`appRunMustPropose`). No input shape (`input_schema` NULL): a pod app
-- cannot ask for either yet.
--
-- Post-seed rows (REGISTERED_EXTRAS), like 0284, 0314, 0329, 0360, 0370 and
-- 0413. The table exists (0283, and 0000_baseline_schema.sql on a fresh
-- install). Synonyms stay off the media words (0413's ranking guard).

INSERT INTO "capability_intents" ("slug", "effect", "statement", "synonyms")
VALUES
  ('provision_compute', 'act', 'Start a temporary machine at a cloud provider, for a set time and a set spend maximum.',
   ARRAY['start a server', 'spin up a machine', 'gpu worker', 'cloud server', 'virtual machine', 'compute worker', 'rent a gpu']),
  ('release_compute', 'act', 'Stop or destroy a machine started at a cloud provider, so it costs nothing more.',
   ARRAY['stop a server', 'shut down a machine', 'destroy a server', 'terminate a worker', 'tear down', 'delete a server'])
ON CONFLICT ("slug") DO NOTHING;
