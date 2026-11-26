## Which body

| The intent is to…                                                                                   | Body                       | Door                                                                                                                                       | Not                                 |
| --------------------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------- |
| see or edit many records of one kind                                                                | View                       | `synap_create_view` (type from `system/synap-ui/view-types`; a kind with a lifecycle → `pipeline` with `config.profileSlug`)               | a bento or HTML that redraws a list |
| write or read mostly text: spec, memo, brief, research, notes, a status read-out, a report's source | Document                   | `synap_create_document` (markdown; live embeds `:::synap-view`, `:::synap-entity`, `:::synap-cell`)                                        | HTML                                |
| monitor or operate something living: health, pipeline numbers, KPIs, a project cockpit, a radar     | Bento                      | `synap_create_view` with `type: "bento"` and catalog cells; for one object, `attachTo` it (or `synap_create_surface` with `body: "bento"`) | a document full of embeds           |
| present, explain, pitch, announce, or share outside the pod with a custom design                    | HTML artifact              | `synap_create_document` with `type: "html"`                                                                                                | a bento screenshot                  |
| think, brainstorm, map ideas, work together live                                                    | Whiteboard                 | `synap_create_view` with `type: "whiteboard"`, then `synap_update_view_content`                                                            | a document                          |
| make a kind look different everywhere                                                               | renderer binding (renders) | `synap_promote_cell_to_renderer` with `profileSlug` and `slot`                                                                             | a per-object frame                  |
| give ONE object an extra screen                                                                     | attached surface           | `synap_create_surface` with the object as `anchor`, or `synap_attach_surface` for one that exists                                          | a kind default                      |
| show a visual unit the catalog does not have                                                        | new Cell type              | `synap_create_cell`, then place, embed or attach it                                                                                        | one-off HTML                        |

**Tie-breakers.** Internal and mostly text → Document. Numbers that change → Bento. Audience outside the pod → HTML artifact. Unfinished thinking → Whiteboard. Read once → Document; watched every day → Bento. Who builds it (a person or you) never changes the body.

**Reports**: write the report as a Document first (pod skill `reports/markdown-first`); when it goes outside, generate its HTML artifact from it.

**Decks**: "pitch deck for investors" is an HTML artifact deck (one page per slide), attached to the project it is for, its colours from the brand kit. When the person wants to co-edit it live, it is a whiteboard whose artboards a presenter plays.

## The body ladder (cheapest first)

saved View → Bento of catalog cells → a generated Cell on declared reads → an HTML artifact → an external app.

Stop at the first rung that serves the intent. A funnel, a stat, a list, a chart that the catalog has is a catalog cell, never a generated one.
