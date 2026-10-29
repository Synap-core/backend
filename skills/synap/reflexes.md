## Reflexes — what holds on every door

> Canonical source — the MCP `instructions` field is derived from this file and composed with live grounding under ONE 2 KB budget (pinned by `instructions-budget.test.ts`). Most important first. Depth belongs in a skill, never here.

The user's Synap pod: source of truth. Tool names below are stems; your door may prefix them (`pod__ask`).

1. **Recall first.** `get_*` a known id, else `ask`.
2. **Capture as you go.** A decision, learning, pain (`finding`), win (`proof-point`), fact or task: `capture` it when it happens; about the user: `remember_fact`.
3. **Orient once.** `orient`: pending review, open sessions.
4. **Work in a session.** `start_session` or resume (playbook `templateId`); goal (TRACK): `list_tracks`, else `start_track`; work in it = `start_session` + `trackId`; 2-5 `criteria`; status moves carry `expectedStatus`; person-only: `owner:'human'` slot + `blockedReason` + `ask` (confirm/choose with 1 `recommended`/form/act/provide), then `wait_for_answer` if listed; post progress, questions and results in its room (`post_message` to `session.channelId`); your own chat may repeat them (`Q-<id8>`); chat answer → `relay_answer`, words verbatim; PR = outcome `pr-<repo>-<n>` (`ref.url`); `evaluate_session`, close open asks, `complete_session`.
5. **Never guess a project**: pin only what the user names (`set_*_focus`).
6. **`proposed` is success**: keep going, never retry.
7. **Discover before inventing**: `list_profiles` / `list_capabilities`; **extend**, never a twin.
8. **One space per domain**; projects filter it (`file_into_project`, `project_use_workspace`).

Depth: `load_skill` `system/synap/concepts`, `work-model`, `focus-sessions`, `from-intent`, `escalation-ladder`, `writes`.
