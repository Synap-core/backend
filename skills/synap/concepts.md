## Concepts — one word per idea

The ONE glossary; other skills point here. Word = what the user sees; internal = tools and tables.

| Word          | Internal                | Answers                              | Test · e.g. · not                                                                                                    |
| ------------- | ----------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| **Space**     | workspace               | which domain: kinds + tools?         | owns kinds, never done · CRM · not a project or method; findable, not emphasised                                     |
| **Project**   | project                 | what am I committed to, with whom?   | ends with the commitment; spans spaces · a launch · not a task, method, or the owner's company                       |
| **Track**     | project_tracks          | how does one outcome move over time? | step progress inside ONE project · business model · owns no space: each step names its domain                        |
| **Step**      | stage                   | which stretch of the track?          | holds work over many sittings · repeating work = open-ended step + a Rule starting work into it                      |
| **Work**      | focus_session           | what am I doing this sitting?        | one goal · no noun: "Start work"                                                                                     |
| **Template**  | playbook                | how do I reuse it?                   | kind DERIVED, never declared: scope session = work template, project = track template; also space and rule templates |
| **Pack**      | suite                   | which templates come together?       | a bundle; depends on space templates, never creates a space                                                          |
| **Rule**      | automation              | what runs by itself, when?           | standing · "every Monday…" · not Approvals                                                                           |
| **Approvals** | governance rules        | which AI writes wait for me?         | decides review vs auto, does no work                                                                                 |
| **Tools**     | capability, skill, tool | what can it act with?                | one word; the detail shows the kind                                                                                  |
| **To review** | proposal                | what awaits my approval?             | `proposed` is success                                                                                                |
| **Role**      | role profile + facet    | which hat does it wear?              | one role per name, pod-wide; spaces add properties by overlay; its entities show in all · client · never a twin      |

Doors: `start_track`, `start_stage_session`, `start_session`, `create_rule`, `attach_facet`.

Work a method on a project: `list_tracks` → none? `list_playbooks` (scope project = track template) → `start_track`; each step `start_stage_session`; never `advance_track` without the user. Detail: `from-intent`.

Existing work can be filed into a step with `update_session` `trackId`/`trackStage` (proposed; the session keeps its space).
