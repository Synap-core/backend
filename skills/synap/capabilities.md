# Capabilities — discover, run, and the when-blocked reflex

Capabilities are the verbs a workspace's connected services and applied
templates unlock — `gmail_send`, `gmail_search`, `calendar_create`,
`drive_search`, and so on. They are the bridge between "I can talk about it"
and "I can actually do it."

## Discover: `list_capabilities`

MCP: `synap_list_capabilities`. IS: `list_capabilities`. Takes
`{ query, kind?, limit? }` (plus `workspaceId`).

**Search first — never dump-and-eyeball.** A workspace can carry 100+
capability entries; call with a `query` describing the action you're after
("send email", "search calendar") and read the ranked, compact results. Don't
fetch the unfiltered list and scan it yourself.

Each entry carries:

- `name` (the `verbId` you pass to `run_capability`), `label`, backing tool
- `paramsSchema` — the shape `parameters` must satisfy; check it before calling
- `enabled` — `true` means it will run right now. `false`/DRAFT means it's
  installed but the user hasn't approved it yet (Settings → Capabilities)

## Run: `run_capability`

MCP: `synap_run_capability`. IS: `run_capability`. Pass `verbId` (or
`skillId`) + `parameters` + `workspaceId`.

```json
{
  "verbId": "gmail_send",
  "parameters": { "to": "…", "subject": "…", "body": "…" },
  "workspaceId": "{workspaceId}"
}
```

Check `paramsSchema` from discovery before calling — a missing required
parameter is refused, not guessed.

**`proposed` is a normal outcome, not a failure.** A capability run can land
as a proposal exactly like any other governed write (see `governance.md`):
tell the user why, share the `reviewUrl`, and don't retry.

**Provider results can be 200-with-error-body.** A successful HTTP call to
Gmail/Calendar/Drive can still carry `result.success: false` +
`result.error` — an auth expiry, a bad recipient, a quota limit. **Always
check `result.success`/`result.error` in the response before telling the
user the action worked.** A 200 status is not proof of success here.

## The when-blocked reflex

When you cannot do something the user asked for — no matching tool, a
"not found" verb, "no connection", "not enabled" — do not fabricate a result
and do not silently give up. Follow this order:

1. **Search first.** `list_capabilities({ query })` for what the user actually
   wants. Capabilities are added over time; don't assume today's tool list is
   the ceiling.
2. **Found but blocked?** If the verb exists but is DRAFT (not enabled) or its
   backing connection is missing, tell the user exactly what to do and where:
   "This needs Gmail connected — enable it in Settings → Capabilities" (or
   the equivalent connect deep-link the error hands you). Don't attempt the
   run again until they've acted.
3. **Still nothing? Search the marketplace.** `market.search({query, kind?})`
   over what could be _installed_ (capabilities, automations, workspace
   templates, cells) — a cache read, not a live fetch, so it's always fast.
4. **Found in the marketplace?** `market.install({slug, kind, version?})`. As
   an agent this ALWAYS lands as a reviewable proposal — never auto-installs,
   even with a grant on the verb itself. Share the `reviewUrl`; don't retry.
5. **Truly nothing, anywhere?** That is escalation-ladder **L2 empty → L3**:
   say precisely what's missing (the action, not "I can't"), offer to capture
   the gap, and if the need is structural (new capability package, template,
   automation), propose via marketplace/install or meta tools — never
   dead-end and never fabricate a result.

<!-- brief:start -->

When blocked (ladder L2→L3): (1) `list_capabilities({query})` first — never
assume today's list is the ceiling. (2) Found but DRAFT/no connection → tell
the user exactly what to enable/connect and where; don't retry until they've
acted. (3) Still nothing → `market.search({query, kind?})`; `market.install`
on a hit always proposes for an agent. (4) Truly nothing → say precisely
what's missing, offer to capture the gap or propose L3 structure — never
fabricate, never silent give-up. Provider 200-with-error-body: always check
`result.success`/`result.error` before claiming success.

<!-- brief:end -->

## Errors — what they mean, what to do next

| You see roughly...                          | Meaning                                                                   | Next step                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| verb/skill "not found" in this workspace    | No capability by that name is registered here                             | `list_capabilities({query})`; if nothing, tell the user what's missing          |
| capability "not approved" / DRAFT           | It exists but the user hasn't enabled it yet                              | Tell the user to enable it (Settings → Capabilities); don't retry               |
| a required parameter is missing             | Your `parameters` didn't satisfy the verb's `paramsSchema`                | Re-check `paramsSchema` from discovery, fill the gap, retry once                |
| no connection / credential for this service | The verb needs a connected account (Gmail, Calendar, …) that isn't set up | Hand the user the connect link; don't retry until connected                     |
| `status: "proposed"`                        | Normal governed outcome — this run needs human approval                   | Share `summary` + `reviewUrl`; don't retry (see `governance.md`)                |
| `status: "denied"`                          | Workspace policy blocked it outright                                      | Explain the reason; don't retry                                                 |
| provider result with `success: false`       | The call reached the provider but the provider itself rejected it         | Read `result.error`; tell the user what actually happened, don't report success |

## What NOT to do

- Don't dump the full unfiltered capability list and eyeball it — search.
- Don't retry a `proposed` or `denied` result as if it were a transient error.
- Don't tell the user an action "worked" without checking `result.success`.
- Don't invent a capability, verb, or connection that discovery didn't return.
