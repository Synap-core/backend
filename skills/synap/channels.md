## Channels — the conversation with a person

A **channel** bound to a person (a `person` or `company` record) is THE conversation the pod holds with them on one outside tool: LinkedIn, email, Discord, WhatsApp. One channel per person, tool and connected account. Every message in it, sent or received, is a row in that channel; nothing about the conversation lives anywhere else (no outreach-touch records, no notes copying the text).

**Read it.**

- Agents: `synap_get_channel` with `mode: "person"` and `entityId` → each channel's tool (`provider`), account, chat id (`externalId`, null until the first send opens the chat), last message, `unread` and its pending proposed messages.
- Hub REST: `GET /api/hub/entities/{id}/channels` (the person's channels), `GET /api/hub/threads/{channelId}/messages?limit=50&before=<ISO>&beforeId=<message id>` (one page, oldest first; `beforeId` is the id of the message the last page ended on), `GET /api/hub/channels/{channelId}/proposed-messages`.
- A message carries `direction` (`inbound` = they wrote, `outbound` = we wrote; null = in-pod chat) and, when outbound, `deliveryStatus` (`sent` → `delivered` → `read`, or `failed`). "Replied" is never stored: it is an inbound message after an outbound one.

**Who reads it.** A channel bound to a person follows the person, whatever space it was filed in: whoever can read the record can read its channel, and a member of that space who cannot read the record does not see it. An app also needs `channel.read` in its requested access (the person consents to sharing their DMs), then reads the channels of the records its space reaches. A record you cannot read answers 404, never an empty list.

**Write to a person: propose, never send.** File the message with `synap_run_capability` `messaging.send` `{to: <person's entity id>, text}` (or `{channelId, text}` for one of the person's channels you can read, from any space). It lands as a **proposed message**: a pending `messaging.external.send` proposal shown inline in the person's channel, which the person approves (then it is sent and becomes an outbound row) or rejects. Never create an outreach touch, a note or a task holding the text of a message. An agent never sends to a person on its own; the proposal is the only way into a person's channel.

**How a channel opens and binds.**

- It exists from the FIRST draft: filing `messaging.send` to a person with no channel on that tool opens a pending one (no chat id); the first send fills the chat id in.
- An inbound message binds to the person through their identity: email, `linkedinUrl`, or the provider's own id stored as an external id signal (`linkedin:<id>`, `instagram:<id>`, `discord:<id>`). Writing `linkedinProviderId` on a person registers that signal. A sender the pod cannot match stays unbound: the pod never creates a person for an unknown sender.
- History from before the account was connected is imported **silently** and only for people already in the pod: no event fires, no automation runs on it.

**What happens on a message.** An inbound message emits `external_message.received` (with `isReply` when it answers an outbound one); an outbound one emits `external_message.sent`. Automations hang off those events (a reply moves a lead to `engaged`; a send sets the next follow-up), never off agent prose.
