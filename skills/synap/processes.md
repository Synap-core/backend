# Processes — a playbook that runs a kind's lifecycle

<!-- brief:start -->

A process = `synap_create_playbook` with `subjectProfileSlug` + `statusProperty`;
each stage's `subjectStatus` is an EXISTING option of that property (read it
with `synap_list_profiles` first — never invent one); `gate: {kind: 'human'}` at
every commitment, `onFail: {toStage}` for rework; typed `expectedOutputs`
(`kind`, `label`, `relationToSubject`); `activators` (`created` |
`enters_status`, default `mode: 'propose'`) and `humanOnlyStatuses` for the
statuses no stage owns. What you create is POD-LOCAL, never an official
template.

<!-- brief:end -->

## Writing a process (a playbook that runs a kind's lifecycle)

A playbook becomes a **process** when it owns a kind's status: each stage writes the subject's status, a status can
start it, and a person decides at the moments that commit the business. The reference is Content OS
"Produce Content" (`synap-app/packages/workspace-templates/src/content-os.yaml`).

**Official vs pod-local.** An official template or capability lives ONLY in the catalog
(`synap-app/packages/workspace-templates/`, by kind) and is published with
`synap catalog publish --official` (CI on main). A playbook, kind or automation an agent creates on a pod
(`synap_create_playbook`, `synap_define_kind`, …) is **pod-local**: it never reaches the catalog. To make it
official, write it into the catalog file and publish.

| Field                                           | Where             | Rule                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subjectProfile.profileSlug` + `statusProperty` | playbook          | The kind the process runs and its lifecycle property. One process owns one property.                                                                                                                                                                                                                                                   |
| `stages[].subjectStatus`                        | stage             | Entering the stage writes this status. Must be an **existing option** of the property — never invent one.                                                                                                                                                                                                                              |
| `stages[].gate`                                 | stage             | `{kind: human}` at every commitment: send to a client, sign, pay, publish, won/lost, anything irreversible. `{kind: check}` only where the stage's own criteria can be verified. A gated stage writes its status only when the gate passes. A check gate judges the stage being LEFT, so never use it to guard an irreversible status. |
| `stages[].onFail`                               | stage             | `{toStage: <key>}` — where a rejected gate sends the run (rework loop).                                                                                                                                                                                                                                                                |
| `stages[].criteria`                             | stage             | 2–5 binary statements; `check.kind` evidence (cheapest) · capability · judge · human.                                                                                                                                                                                                                                                  |
| `expectedOutputs[]`                             | stage or playbook | What the step must produce: `kind` + `label` + `relationToSubject` (an existing relation slug, or `none`). The UI shows what was produced from this.                                                                                                                                                                                   |
| `activators[]`                                  | playbook          | `{on: created \| enters_status, status?, mode: propose \| run}`. Default `propose`; `run` only when cheap and safe. Compiled to a governed rule the owner can pause.                                                                                                                                                                   |
| `humanOnlyStatuses`                             | playbook          | Statuses no stage owns, set only by a person (e.g. Idea, Archived). Together with the stages they must cover every option of the property.                                                                                                                                                                                             |
| `goalTemplate`                                  | playbook          | Placeholders are `{paramName}`. Never `@{arg:…}` (read-only legacy).                                                                                                                                                                                                                                                                   |
| `params`                                        | playbook          | The subject is a `type: entity` param. A required param left unanswered becomes a question owed by the person, not an empty string.                                                                                                                                                                                                    |

Human moments use an `ask` on an owed slot: `confirm` / `choose` (one `recommended`) / `form` / `act` / `provide`
(connection, file or secret through the vault). Never ask for a secret in a form.

Validation: `synap catalog validate` (process contract, goal grammar, lifecycle coverage ratchet — the count of
lifecycle kinds with no process may only go down).

## Declaring it over MCP

`synap_create_playbook` takes the contract as-is. Before calling it, read the
subject kind (`synap_list_profiles`) and copy the status options of its
lifecycle property exactly.

```json
{
  "name": "Produce a post",
  "goalTemplate": "Produce {post}",
  "params": [{ "name": "post", "type": "entity", "required": true }],
  "subjectProfileSlug": "post",
  "statusProperty": "post-status",
  "activators": [
    { "on": "enters_status", "status": "Briefed", "mode": "propose" }
  ],
  "humanOnlyStatuses": ["Idea", "Archived"],
  "stages": [
    {
      "key": "draft",
      "name": "Draft",
      "category": "started",
      "subjectStatus": "Drafting",
      "expectedOutputs": [
        {
          "kind": "document",
          "label": "Draft",
          "relationToSubject": "made_for"
        }
      ]
    },
    {
      "key": "review",
      "name": "Review",
      "category": "started",
      "subjectStatus": "Ready",
      "gate": { "kind": "human" },
      "onFail": { "toStage": "draft" }
    }
  ]
}
```

The status values above are an example: use the options the kind really has.
An agent call lands as a proposal (`status: "proposed"` is success). The
playbook lives on this pod only; to make it an official template, a developer
writes it into the catalog and publishes it with
`synap catalog publish --official`.
