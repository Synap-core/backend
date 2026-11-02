-- 0392 — server_faults: the exact cause of each 5xx, keyed by the errorId the
-- client was given (founder ask 2026-11-02: "know the exact error instead of
-- that bad code error").
--
-- A server fault's client body is generic on purpose (the egress rule,
-- packages/api/src/middleware/error-egress.ts): it must never carry a driver
-- message, a query or a stack. Until now the cause lived only in the pod's
-- stdout, nested under the wrapper's `context`, so reading it took ssh. One row
-- per fault, written by the API's two error doors (the REST egress middleware,
-- which sees every REST 5xx, thrown or returned; tRPC's errorFormatter), read
-- only by pod admins (Hub `GET /api/hub/errors/:errorId`, pod admin
-- "Server errors").
--
-- Stored: the original error's name, message and stack, and its `cause` chain
-- (bounded), with a Drizzle query's bound `params:` line cut out; the redacted
-- path, method, status and caller. Never a request body or a secret value.
-- Kept 30 days, pruned by the writer (services/server-faults/record.ts), which
-- also caps how many rows one process writes per minute.
--
-- Telemetry, not governance lineage: no FK to users (a removed member keeps
-- the faults they met). Additive; the previous release neither reads nor
-- writes it.

CREATE TABLE IF NOT EXISTS "server_faults" (
  "error_id"      text        PRIMARY KEY,
  "occurred_at"   timestamptz NOT NULL DEFAULT now(),
  "door"          text        NOT NULL,
  "method"        text,
  "path"          text,
  "status"        integer     NOT NULL,
  "user_id"       text,
  "agent_user_id" text,
  "error_name"    text        NOT NULL,
  "message"       text        NOT NULL,
  "stack"         text,
  "causes"        jsonb       NOT NULL DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS "idx_server_faults_occurred_at"
  ON "server_faults" ("occurred_at");
