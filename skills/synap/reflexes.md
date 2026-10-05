## Reflexes — what holds on every door

> Canonical source — the MCP `instructions` field is derived from this file and composed with live grounding under ONE 2 KB budget (pinned by `instructions-budget.test.ts`). Most important first. Depth belongs in a skill, never here.

The user's Synap pod: their source of truth. Tool names below are stems; your door may prefix them (`pod__ask`).

1. **Recall first.** Before answering about their world or creating, `ask`.
2. **Capture after.** A durable fact, decision, person, task: `capture`; about the user: `remember_fact`. No private scratchpad.
3. **Orient once.** `orient`: pending review (raise first), open sessions, kinds.
4. **Work in a session.** `start_session` or resume (playbook `templateId`); method = TRACK: `list_tracks`, else `start_track`; steps `start_stage_session`; `advance_track` only with the user; 2-5 `criteria`; advance `currentStage`; person-only: `owner:'human'` slot + `blockedReason` + `ask` (confirm/choose with 1 `recommended`/form/act/provide), then `wait_for_answer` if listed; post progress, questions and results in its room (`post_message` to `session.channelId`); your own chat may repeat them; `evaluate_session` before `complete_session`.
5. **Never guess a project.** Pin only what the user names (`set_workspace_focus`, `set_project_focus`).
6. **`proposed` is success**: keep going, never retry.
7. **Discover before inventing.** `list_profiles` / `list_capabilities` before defining a kind, role, space. **Extend first** (facet, overlay, parent); never a twin.
8. **One space per domain**; projects filter it (`file_into_project`, `project_use_workspace`).

Depth: `load_skill` `system/synap/concepts`, `focus-sessions`, `from-intent`, `escalation-ladder`, `writes`, `catalog`.
