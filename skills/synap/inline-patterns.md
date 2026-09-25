## AI Inline Patterns — reference entities in your replies

When the user is interacting with Synap's AI Companion (the in-browser chat panel), you can embed **inline chips** directly in your reply text. These render as clickable buttons the user can tap to open entities, views, or documents without leaving the conversation.

### Syntax

| Pattern                      | Renders as                  | Effect                            |
| ---------------------------- | --------------------------- | --------------------------------- |
| `[[entity:UUID\|Name]]`      | Purple entity chip          | Opens entity detail in side panel |
| `[[view:UUID\|Name]]`        | Blue view chip              | Opens view                        |
| `[[view:UUID]]`              | View chip, named for you    | Same; the label is optional       |
| `[[open:side\|view:UUID]]`   | Amber "Open in side" button | Opens view in side panel          |
| `[[open:main\|view:UUID]]`   | Amber "Open" button         | Opens view in main panel          |
| `[[open:side\|entity:UUID]]` | Amber "Open in side" button | Opens entity in side panel        |
| `[[run:UUID\|Label]]`        | Green "Run" button          | Navigates to automation entity    |
| `[[doc:UUID\|Name]]`         | Gray doc chip               | Opens document                    |

### Rules

- **The label is optional.** `[[kind:UUID]]` is valid: in a document the chip shows the object's current name; in chat, where nothing looks it up, it reads as its kind ("View"). So in a chat reply, write the name you know: `[[view:UUID|Active Tasks]]`. A chip never shows the raw id.
- **Always use real IDs.** Never hallucinate UUIDs. Only emit patterns for entities/views you just created or retrieved via Hub Protocol.
- **Emit after creation.** When you create a view or entity, immediately reference it: `"Created your pipeline → [[view:abc123|Active Tasks]]"`
- **Prefer side panel.** Use `[[open:side|view:UUID]]` so the user keeps their current context.
- **Companion replies and documents.** In a document, `[[entity:…|…]]` / `[[view:…|…]]` render as chips and the editor keeps them (`document-embeds.md`); the `[[open:…]]` / `[[run:…]]` commands are chat-only. Other channels and memory ignore them.
- **Combine with prose.** Don't lead with a chip — embed it naturally: `"Here are your open deals → [[view:xyz|Deals Pipeline]] · [[open:side|view:xyz]]"`

### Proposals

There is no `[[open:…|proposal:…]]` chip — `open`'s `resourceType` only accepts
`entity`, `view`, `doc`, `cell`, `channel`. A proposal is not one of those, so
never invent that form.

When a write returns `status: "proposed"` (or any per-op outcome carrying a
`reviewUrl` — `writeReceipt.reviewUrl`, `perm.reviewUrl`, a capability run's
`kind: "proposed"`), the response also carries that `reviewUrl` (a real,
resolvable `${PUBLIC_URL}/open/<id>` link — never invented). **Surfacing it is
MANDATORY, not optional:** every reply that reports a proposed write MUST
include the link as a plain markdown link, plus one sentence explaining why it
was proposed instead of auto-applied:

> Queued the task deletion for your review — destructive actions always need approval: [Review proposal](https://pod.example.com/open/prp_abc)

A reply that only says "I've proposed that for review" with no link is
incomplete — the user has no way to act on it. `"proposed"` is normal, not an
error — don't apologize for it or wait for the user to approve before
continuing the conversation.
