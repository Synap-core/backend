## Concepts — one word per idea

The ONE glossary; other skills point here. Word = what the user sees; internal = tools and tables.

| Word          | Internal                | Answers                            | Test · e.g. · not                                                                                                    |
| ------------- | ----------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Space**     | workspace               | which domain: kinds + tools?       | owns kinds, never done · CRM · not a project or method; findable, not emphasised                                     |
| **Project**   | project                 | what am I committed to, with whom? | ends with the commitment; spans spaces · a launch · not a task, method, or the owner's company                       |
| **Track**     | project_tracks          | what lasting goal am I pursuing?   | inside ONE project, lasts; work in it = sessions · grow the newsletter · stages optional (legacy)                    |
| **Step**      | stage                   | which stretch of a staged track?   | legacy: only a track started with a method has steps; a new track needs none                                         |
| **Work**      | focus_session           | what am I doing this sitting?      | one goal · no noun: "Start work"                                                                                     |
| **Template**  | playbook                | how do I reuse it?                 | kind DERIVED, never declared: scope session = work template, project = track template; also space and rule templates |
| **Pack**      | suite                   | which templates come together?     | a bundle; depends on space templates, never creates a space                                                          |
| **Rule**      | automation              | what runs by itself, when?         | standing · "every Monday…" · not Approvals                                                                           |
| **Approvals** | governance rules        | which AI writes wait for me?       | decides review vs auto, does no work                                                                                 |
| **Tools**     | capability, skill, tool | what can it act with?              | one word; the detail shows the kind                                                                                  |
| **To review** | proposal                | what awaits my approval?           | `proposed` is success                                                                                                |
| **Role**      | role profile + facet    | which hat does it wear?            | one role per name, pod-wide; spaces add properties by overlay; its entities show in all · client · never a twin      |

Doors: `start_track`, `start_session`, `create_rule`, `attach_facet`.

A lasting goal on a project: `list_tracks` → none? `start_track` (`name`, `direction`, a `kpi` only if the person names one; no method needed); work in it = `start_session` + `trackId`, as many sessions as it takes. Detail: `from-intent`.

Existing work can be filed into a track with `update_session` `trackId` (proposed; the session keeps its space). Stages are legacy: a track started from a track template has steps (`start_stage_session`; never `advance_track` without the user).
