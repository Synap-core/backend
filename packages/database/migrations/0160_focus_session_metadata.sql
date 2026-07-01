-- Focus session metadata bag (ADDITIVE).
-- focus_sessions.metadata — free-form jsonb bag. Shallow-merged by the Hub PATCH
-- door and the automation `session_update` output subtype (e.g. `grantStatus`
-- while an automation drives a playbook session). Defaults to '{}' — never NULL.
ALTER TABLE focus_sessions ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
