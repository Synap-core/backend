## UI for a playbook: one verb first

"Build me an app for my lead pipeline", "a UI for this process", "a dashboard for Win a deal": when the work is a playbook over a kind, call **`synap_propose_app_from_playbook { playbookId }`** (group `build`) before composing anything by hand.

- It reads the facts (the playbook, the kind it works, the kind's declared lifecycle, the states its stages own) and files **ONE proposal** holding: the kind's `pipeline` view, a bento over the same kind, a generated board cell that reads `flow.of` (columns = states in declared order, headed by the stage that owns each; moves are governed `update_entity` writes), and that cell on the playbook's own page (`detail`). Nothing is created until the person approves it: `proposed` is success, pass on `reviewUrl`.
- Run it again any time: a part that exists is skipped (`alreadyExists`), a page that already shows something is never replaced (`leftOut`, with the call to do it by hand), and while the proposal is pending the same one comes back (`status: "duplicate"`).
- Refused with the next step when a fact is missing: the playbook works no kind (`synap_update_playbook` its `subjectProfile`), or the kind declares no lifecycle (`synap_declare_lifecycle` first). Model first, UI second (`rules/apps-are-views-of-pod-state`).

Compose by hand only when the verb does not fit (no playbook, a kind's own card or dashboard, a view the bundle does not hold): `synap_create_view` (a `pipeline` needs `config.profileSlug`), `synap_update_view` (a bento's blocks), `synap_create_cell` + `synap_promote_cell_to_renderer` (the recipe in `system/synap/viewframe-cells`), `synap_set_start_page`.
