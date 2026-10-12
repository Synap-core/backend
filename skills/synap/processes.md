# Processes — a playbook that follows a kind's lifecycle

<!-- brief:start -->

A process = `synap_create_playbook` with `subjectProfileSlug`; it FOLLOWS the
lifecycle the kind or role declares (omit `statusProperty`, or name that same
property). Each stage's `subjectStatus` is an EXISTING option of it (read it
with `synap_list_profiles` first — never invent one); `gate: {kind: 'human'}` at
every commitment, `onFail: {toStage}` for rework; typed `expectedOutputs`
(`kind`, `label`, `relationToSubject`); workers = `activators` (`on`, `size`,
default `mode: 'propose'`). What you create is POD-LOCAL, never an official
template.

<!-- brief:end -->

## Writing a process (a playbook that follows a kind's lifecycle)

The status belongs to the **kind or role**, never to a playbook. Its profile declares the lifecycle ONCE, in its
template:

```yaml
lifecycle:
  property: post-status
  options:
    - { key: Idea, category: open }
    - { key: Published, category: done }
    - { key: Archived, category: lost, humanOnly: true }
```

Every option has one category (`open · active · paused · done · lost`); rules read the category, names stay free.
`humanOnly` marks an option no agent sets; an agent's move into `done` or `lost` proposes. Every move goes through
the one status door (`moveStatus`; an agent sends `update_entity` with `expectedStatus`).

A playbook that works that lifecycle is a **process**: it FOLLOWS it. Its stages name options of it, its workers
start on it, and a person decides at the moments that commit the business. It never keeps a second status field.
The reference is Content OS "Produce Content" (`synap-app/packages/workspace-templates/src/content-os.yaml`).

**Official vs pod-local.** An official template or capability lives ONLY in the catalog
(`synap-app/packages/workspace-templates/`, by kind) and is published with
`synap catalog publish --official` (CI on main). A playbook, kind or automation an agent creates on a pod
(`synap_create_playbook`, `synap_define_kind`, …) is **pod-local**: it never reaches the catalog. To make it
official, write it into the catalog file and publish.

| Field                           | Where             | Rule                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `subjectProfile.profileSlug`    | playbook          | The kind or role the process works.                                                                                                                                                                                                                                                                                                                                                                          |
| `subjectProfile.statusProperty` | playbook          | Omit it: the pod follows the profile's declared lifecycle. If you name it, name that same property. A status worker on a role with no declared lifecycle is refused.                                                                                                                                                                                                                                         |
| `stages[].subjectStatus`        | stage             | Entering the stage moves the subject to this option, through the door. Must be an **existing option** of the lifecycle — never invent one.                                                                                                                                                                                                                                                                   |
| `stages[].gate`                 | stage             | `{kind: human}` at every commitment: send to a client, sign, pay, publish, won/lost, anything irreversible. `{kind: check}` only where the stage's own criteria can be verified. A gated stage writes its status only when the gate passes. A check gate judges the stage being LEFT, so never use it to guard an irreversible status.                                                                       |
| `stages[].onFail`               | stage             | `{toStage: <key>}` — where a rejected gate sends the run (rework loop).                                                                                                                                                                                                                                                                                                                                      |
| `stages[].criteria`             | stage             | 2–5 binary statements; `check.kind` evidence (cheapest) · capability · judge · human.                                                                                                                                                                                                                                                                                                                        |
| `expectedOutputs[]`             | stage or playbook | What the step must produce: `kind` + `label` + `relationToSubject` (an existing relation slug, or `none`). The UI shows what was produced from this.                                                                                                                                                                                                                                                         |
| `activators[]` (workers)        | playbook          | `on`: `created` · `enters_status` (+ `status`) · `count` (+ `status`, `min` ≥ 2) · `schedule` (+ `cron`, UTC) · `manual`. `size`: `per_thing` (default) · `per_moment` (count and schedule always are). `mode`: `propose` (default) · `run` only when cheap and safe. `maxPendingApprovals` (default 20) throttles. Compiled to a governed rule the owner can pause; it fires once per thing per transition. |
| `humanOnlyStatuses`             | playbook          | Legacy: the options no stage owns. Mark a person-only option `humanOnly` on the lifecycle instead; while `statusProperty` is set, `synap catalog validate` still checks that stages and this list cover every option.                                                                                                                                                                                        |
| `goalTemplate`                  | playbook          | Placeholders are `{paramName}`. Never `@{arg:…}` (read-only legacy).                                                                                                                                                                                                                                                                                                                                         |
| `params`                        | playbook          | The subject is a `type: entity` param. A required param left unanswered becomes a question owed by the person, not an empty string.                                                                                                                                                                                                                                                                          |

Human moments use an `ask` on an owed slot: `confirm` / `choose` (one `recommended`) / `form` / `act` / `provide`
(connection, file or secret through the vault). Never ask for a secret in a form.

Validation: `synap catalog validate` (process contract, goal grammar, lifecycle coverage ratchet — the count of
lifecycle kinds with no process may only go down).

## Declaring it over MCP

`synap_create_playbook` takes the contract as-is. Before calling it, read the
subject kind (`synap_list_profiles`) and copy the options of its lifecycle
property exactly. Over MCP you cannot declare or change a lifecycle; it comes
with the kind's template.

```json
{
  "name": "Draft a post",
  "goalTemplate": "Draft {post}",
  "params": [{ "name": "post", "type": "entity", "required": true }],
  "subjectProfileSlug": "post",
  "activators": [
    {
      "on": "enters_status",
      "status": "Briefed",
      "size": "per_thing",
      "mode": "propose"
    }
  ],
  "stages": [
    {
      "key": "draft",
      "name": "Draft",
      "category": "started",
      "subjectStatus": "In Draft",
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
      "subjectStatus": "Review",
      "gate": { "kind": "human" },
      "onFail": { "toStage": "draft" }
    }
  ]
}
```

These are the Content OS post options; use the ones the kind really has. A
batch worker looks like `{ "on": "schedule", "cron": "0 8 * * 1", "status":
"Idea", "mode": "propose" }` (one session over every post in Idea, weekly) or
`{ "on": "count", "status": "Review", "min": 5, "mode": "propose" }`.
An agent call lands as a proposal (`status: "proposed"` is success). The
playbook lives on this pod only; to make it an official template, a developer
writes it into the catalog and publishes it with
`synap catalog publish --official`.
