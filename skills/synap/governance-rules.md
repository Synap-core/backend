## Writing — governance in one paragraph

Every write returns a `status` field:

```
"approved"  → done, use { id }
"proposed"  → queued for user approval; response also carries { proposalId, summary, reasoning, reviewPath, reviewUrl } — surface the link
"denied"    → blocked, explain reason to user
```

**`"proposed"` is not an error.** It's the governance system queueing your change. When you get it:

1. Tell the user exactly what was queued — use the `summary` field **verbatim**. Don't paraphrase.
2. Give them the link to review — `reviewUrl` opens the proposal in Synap Studio. Show the link as-is.
3. Move on with the conversation. Don't wait or poll.

### The `reasoning` field — required, structured, contextual

Every write call (create, update, delete) must include a `reasoning` field. This is what the governance reviewer reads to understand your decision. It is **not optional**.

Use this exact structure:

```
Context: [what the user said or what event triggered this write — one sentence]
Intent:  [what this entity or change accomplishes — one sentence]
Links:   [actual entity IDs or slugs this relates to, e.g. "ent_abc, ent_xyz"]
```

For updates, add:

```
Changed: [field] [old value] → [new value]
```

**Example (create):**

```
Context: User asked to track the Acme deal they mentioned in today's call.
Intent:  Creates a deal entity for Acme at lead stage linked to Alice Johnson.
Links:   ent_person_alice_johnson, ent_company_acme
```

**Example (update):**

```
Context: User confirmed the Acme deal moved to proposal stage.
Intent:  Advances the deal through the pipeline so it appears in the proposal view.
Links:   ent_deal_acme, ent_person_alice_johnson
Changed: dealStage lead → proposal
```

Rules:

- One sentence per field. No padding.
- `Links` must reference real entity IDs or slugs visible in the current context — not descriptions like "the related project".
- **"Agent requires proposal for all write operations."** is never acceptable as a `reasoning` value. That is an internal governance message, not agent reasoning. Write it and the proposal is meaningless to the reviewer.

Example response to the user:

> I queued **Delete task "Q2 plan review"** for your review. Destructive actions need your approval. Open it: synap://open/proposal/prp_abc

Auto-approved by default (for agent API keys): `entity.create`, `entity.update`, `document.create`, `relation.create`, `view.create`, `profile.create`, `property_def.create`, `channel.create`, `memory.*`, all reads. Destructive actions (`delete`, `archive`, `purge`) always propose in agent-owned workspaces.

For the full whitelist, agent-user semantics, and workspace overrides, read **`governance.md`**.
