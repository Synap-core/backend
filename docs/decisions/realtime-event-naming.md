# Realtime event naming: `{actor}:{entity}:{action}`

> Verified against code on 2026-10-20 (backend@cc4b2d81).

- **Status:** Accepted 2026-05-05. Amended in code since (see "State on
  2026-10-20").
- **Scope:** events the API pushes to connected clients through the realtime
  service (`/bridge/emit`, Socket.IO `/presence`). The dotted automation events
  (`entity.create.completed`, see [event-chain](../architecture/event-chain.md))
  are a separate namespace and are not covered.

## Context

Realtime event names had grown without a rule: a mix of two-segment names
(`entity:created`, `chat:stream`) and snake_case (`chat_response`, `ai_step`,
`route_to_channel`). Names were plain strings at every emit site, so typos were
silent; payloads had no schema and drifted between emitters; and nothing said
when to reuse a prefix or invent one. Subscribers that wanted every event of one
origin or one noun could not express it with a wildcard.

## Decision

1. Every new realtime event is named `{actor}:{entity}:{action}`: three
   lowercase segments, colon-delimited, action in the past tense.
2. The actor vocabulary is closed; a new actor needs an amendment to this
   record.
3. The single registry is `EventNames` in `packages/types/src/events/index.ts`.
   Each event has a payload interface and an entry in
   `DomainServerToClientEvents` in the same file.
4. Each new event has a Zod schema in `EventSchemas`
   (`packages/events/src/realtime-schemas.ts`). The bridge validates every
   `/bridge/emit` payload and answers 400 on a mismatch.
5. Emit through `emitTyped<E>()` (`packages/api/src/utils/event-emit.ts`), which
   infers the payload from the name, so a wrong name or shape is a compile error.
6. Existing two-segment events keep working. They are marked
   `@deprecated since 2026-05-05` in `DomainEventNames`; they are neither
   migrated nor extended.

## Alternatives considered

- **Free-form strings (status quo).** No cost now, but every cross-cutting
  subscriber paid for it.
- **Two segments `{domain}:{action}`.** Loses the actor, so "all task events"
  and "all events from one actor" cannot be separated.
- **CloudEvents envelope.** Heavier than an internal bridge needs; the Socket.IO
  event name is already a string and the payload is the envelope.
- **Per-domain enums without a convention.** Gives types but no naming rule for
  new emitters.

## Consequences

- Wildcard subscriptions (`agent:*:*`, `*:message:*`) become possible.
- Adding an event is a fixed recipe instead of a string:
  1. choose actor, entity and action from the vocabulary;
  2. add the constant to `EventNames` and the payload interface plus the
     `DomainServerToClientEvents` entry in `packages/types/src/events/index.ts`;
  3. add a strict `z.object` schema to `EventSchemas` (no passthrough for new
     events);
  4. check that `EventPayloadFor<"your:new:event">` resolves to your interface
     (`never` means the `DomainServerToClientEvents` entry is missing);
  5. emit with `emitTyped`, never by building the bridge POST by hand.
- The bridge returns 400 for a malformed payload instead of fanning it out.
- Legacy events without a schema (`document:updated`, `document:version`,
  `ai:proposal:status`, `chat:message`, ...) still pass through unvalidated.
  Locked-down legacy schemas: `entity:created`, `entity:updated`,
  `entity:deleted`, `chat:stream`, `ai:proposal`.

## State on 2026-10-20

- **Actor vocabulary in the registry:** `user`, `agent`, `synap`, `system`, and
  `openclaw` kept only as a legacy wire name. The original record also listed
  `hermes` (background task daemon); that actor and its four planned
  `hermes:task:*` events are no longer in the registry.
- **`openclaw:message:received`** is emitted by Hub Protocol channel ingestion
  (`packages/api/src/routers/hub-protocol/channels.ts`) for any agent that relays
  an external chat message, not only OpenClaw. The registry documents it as a
  legacy name to be replaced by a generic one.
- **`synap:reply:routed`** is emitted from `packages/api/src/routers/channels/send-message.ts`.
- **Registry entries added after the decision that do not follow the actor
  vocabulary:** `import:file:progress`, `library:item:updated` (first segment is
  a domain, not an actor) and `ui:focus` (two segments). They are in
  `EventNames` with schemas. New events should still follow the rule above; a
  future amendment should either rename these or add their first segments to
  the vocabulary.
- `platform` on external messages is one of `telegram`, `whatsapp`, `signal`,
  `matrix`, `discord`, `voice`.
