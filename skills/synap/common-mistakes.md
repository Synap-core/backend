## Common mistakes — core data operations

1. **Creating orphan entities.** Always connect to at least one other entity on creation. Search first; if nothing links, reconsider whether this should be memory.
2. **Guessing profile slugs.** Always `GET /profiles` first. `deal`, `capture`, and custom profiles may not exist in this workspace.
3. **Using the deprecated `type` field.** Always `profileSlug`.
4. **Treating `"proposed"` as an error.** It's a governance queue.
5. **Forcing `source` to bypass governance.** Governance is determined by the agent user + whitelist, not by `source`. Don't set it.
6. **Not knowing your userId.** Use `{SYNAP_USER_ID}` from the env (set by `synap connect`). Or call `GET /api/hub/users/me` → `.id` once and cache it. Never hardcode or guess.
7. **Skipping the search step.** Duplicates degrade the graph more than missing data.
8. **Forgetting that `GET /channels/personal` needs `hub-protocol.write`** scope — it's get-or-create, not a pure read.
9. **Routing known-structure data through free-text capture.** If you already know the profileSlug + fields, create the entity directly — smart capture can degrade to a single flat note.
10. **Paragraph session goals.** The goal is one line; put detail and deliverables in expectedOutputs.
