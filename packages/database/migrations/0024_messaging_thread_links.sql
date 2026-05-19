-- messaging_thread_links: maps external messaging threads to CRM entities

CREATE TABLE IF NOT EXISTS messaging_thread_links (
  id            text        PRIMARY KEY DEFAULT gen_random_uuid()::text,
  external_thread_id  text NOT NULL,
  account_id    text        NOT NULL REFERENCES messaging_accounts(id) ON DELETE CASCADE,
  entity_id     text        NOT NULL,
  linked_by_user_id text    NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_msg_thread_links_entity_id
  ON messaging_thread_links(entity_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_thread_links_thread_entity
  ON messaging_thread_links(external_thread_id, entity_id);
