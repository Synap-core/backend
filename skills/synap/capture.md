# Capture pipeline — reference

Use the capture pipeline when the user pastes a block of unstructured text (email, meeting transcript, LinkedIn bio, article, screenshot of a whiteboard) and you need to extract multiple entities with their relations.

Chaining manual `POST /entities` + `POST /relations` for this is wasteful — the pipeline extracts everything in one server-side LLM call and returns proposals you can review before committing.

## Two-step flow

### 1. Structure the text

```json
POST /api/hub/capture/structure
{
  "userId":      "{userId}",
  "workspaceId": "{workspaceId}",
  "text":        "Had lunch with Sarah Chen from Acme Corp today. \
                  She's leading their Series B and asked me to send \
                  our sales deck by Friday. Mentioned her VP Engineering \
                  Tom Walker also wants a demo.",
  "context":     { "source": "chat", "channelId": "ch_…" },  // optional
  "profileSlugs": ["person", "company", "task", "event"]     // optional filter
}
```

Response:

```json
{
  "proposals": [
    {
      "tempId": "t1",
      "profileSlug": "person",
      "title": "Sarah Chen",
      "properties": { "companyId": "t2" },
      "action": "create"
    },
    {
      "tempId": "t2",
      "profileSlug": "company",
      "title": "Acme Corp",
      "properties": {},
      "action": "create"
    },
    {
      "tempId": "t3",
      "profileSlug": "person",
      "title": "Tom Walker",
      "properties": { "role": "VP Engineering", "companyId": "t2" },
      "action": "create"
    },
    {
      "tempId": "t4",
      "profileSlug": "task",
      "title": "Send sales deck to Sarah",
      "properties": {
        "status": "todo",
        "dueDate": "2026-04-24",
        "assignee": null
      },
      "action": "create"
    },
    {
      "tempId": "t5",
      "profileSlug": "event",
      "title": "Lunch with Sarah",
      "properties": { "startDate": "2026-04-20", "attendees": ["t1"] },
      "action": "create"
    }
  ],
  "relations": [
    {
      "sourceTempId": "t4",
      "targetTempId": "t1",
      "relationType": "for_person"
    },
    {
      "sourceTempId": "t4",
      "targetTempId": "t5",
      "relationType": "from_meeting"
    }
  ],
  "followUp": "Should I also schedule a reminder to follow up with Tom?"
}
```

**`tempId` is only valid within this response.** It's used to link proposals together before they have real entity IDs.

**`action` can be:**

- `"create"` — new entity
- `"update"` — existing entity found by title match; `existingEntityId` will be set
- `"skip"` — duplicate already exists, nothing to do

### 2. Execute (commit) after user confirmation

Present the proposals to the user. Let them edit, remove, or add items. Then:

```json
POST /api/hub/capture/execute
{
  "userId":      "{userId}",
  "workspaceId": "{workspaceId}",
  "entities":    [ /* edited proposals array */ ],
  "relations":   [ /* edited relations array */ ]
}
```

Response:

```json
{
  "created":  [{ "tempId": "t1", "entityId": "ent_real_1" }, …],
  "updated":  [{ "tempId": "t2", "entityId": "ent_existing" }, …],
  "skipped":  [{ "tempId": "t5", "reason": "duplicate" }],
  "relations": { "created": 2, "failed": 0 },
  "status":   "approved"
}
```

The executor goes through governance (see `governance.md`). Expect the same three `status` values.

## When to use the pipeline vs. manual CRUD

| Situation                                                        | Use                                                 |
| ---------------------------------------------------------------- | --------------------------------------------------- |
| User pastes a chunk of text with multiple people/companies/tasks | Pipeline                                            |
| User says "create a task to call Sarah at 3pm"                   | Manual create (1 entity)                            |
| User forwards an email                                           | Pipeline                                            |
| User asks "remind me to X"                                       | Manual create                                       |
| OCR'd screenshot, meeting transcript, article body               | Pipeline                                            |
| User edits an existing entity                                    | Manual PATCH                                        |
| User wants to save a webpage they're on                          | Manual create (article) + optional capture for body |

Rule of thumb: **one intent, one call.** Multi-entity content, use the pipeline.

## Dedup within the pipeline

The pipeline does its own duplicate check per entity (by title + profileSlug within workspace). When it finds a match, `action` becomes `"update"` with `existingEntityId` set, so the real entity is updated in place, not duplicated.

You can still prefix with a manual search if you want to show the user "I found 3 existing people that might match" before running capture. But the pipeline alone is usually good enough.

## Presenting proposals to the user

A good UX turn:

> I picked up **5 things** from that paste:
>
> - **Sarah Chen** — person at Acme Corp (new)
> - **Acme Corp** — company (new)
> - **Tom Walker** — person at Acme (new)
> - **Task**: Send sales deck to Sarah, due Friday
> - **Event**: Lunch with Sarah today
>
> Plus 2 connections: task → Sarah, task → lunch.
>
> Ship it?

Keep the user in control. Don't auto-execute without confirmation unless the user explicitly told you to.

## Edge cases

- **Empty text → empty proposals.** Don't call execute with zero entities.
- **Ambiguous references ("he", "they").** The pipeline will often return null properties. Prompt the user to clarify before executing.
- **Dates.** Always absolute in responses (ISO 8601). If the input says "Friday," the pipeline resolves it against today.
- **Custom profiles.** If you want the pipeline to consider custom profiles, pass `profileSlugs` in the request. Otherwise it defaults to system profiles only.
- **Rate limits.** 20 captures/hour per user. If you hit the limit, fall back to manual CRUD.

## Followup question

The response includes a `followUp` field — a single sentence question the pipeline thinks is worth asking next. Surface it to the user verbatim. It's a cheap way to deepen capture without extra prompts.
