-- 0369 — one input for send_message and request_connection (CRM
-- consolidation plan, Lane 2; founder 2026-10-28: the POD resolves the
-- recipient)
--
-- A pod app asks the person's tools to send a message, or a connection
-- request, to ONE person or company it names by entity id (`to`). The app
-- never sends an address or a provider id: each verb's input map reads the
-- recipient's address with `$to.<address>` (`email`, `phone`,
-- `linkedin.providerId`, `linkedin.publicIdentifier`, `chat`, `attendee`) and
-- the pod resolves it from its own rows when the action runs
-- (`services/capabilities/intent-recipient.ts`).
--
-- Seeded only where none is set, so an edited shape is never overwritten
-- (same rule as 0368). The column itself comes from 0368 and the baseline.

UPDATE "capability_intents"
SET "input_schema" = '{
  "type": "object",
  "properties": {
    "to": {
      "type": "string",
      "format": "uuid",
      "description": "The person or company (pod entity id) the message goes to. The pod finds their address for the tool."
    },
    "text": {
      "type": "string",
      "minLength": 1,
      "maxLength": 10000,
      "description": "The text of the message."
    },
    "subject": {
      "type": "string",
      "minLength": 1,
      "maxLength": 300,
      "description": "A subject line, for tools that take one (email)."
    }
  },
  "required": ["to", "text"],
  "additionalProperties": false
}'::jsonb
WHERE "slug" = 'send_message' AND "input_schema" IS NULL;

UPDATE "capability_intents"
SET "input_schema" = '{
  "type": "object",
  "properties": {
    "to": {
      "type": "string",
      "format": "uuid",
      "description": "The person (pod entity id) to ask to connect. The pod finds their id on the network."
    },
    "text": {
      "type": "string",
      "minLength": 1,
      "maxLength": 300,
      "description": "A short note sent with the request."
    }
  },
  "required": ["to"],
  "additionalProperties": false
}'::jsonb
WHERE "slug" = 'request_connection' AND "input_schema" IS NULL;
