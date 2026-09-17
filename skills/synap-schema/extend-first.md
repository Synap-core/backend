## Extend first — schema moves, in order

Before `define_kind` or a new workspace, walk this list **top to bottom**. Stop at the first move that fits. Load from `system/synap-schema/extend-first`. The conductor for a fuzzy user intent is `system/synap/from-intent`.

A **role (facet) is a hat on any entity kind**, not only person/company. `applicableKinds` is the allowlist (`NULL` = any kind). `kind_mismatch` means **widen the role**, not mint a sibling type.

| #   | If the need is…                                                                              | Do this                                                                                                                                                       | Do not                                                                   |
| --- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1   | An instance of a kind you already have                                                       | `create_entity` / capture on that slug; search first                                                                                                          | A second kind with a similar name                                        |
| 2   | A **hat** on an existing entity (“this item is an X”, “this company is a vendor”)            | `attach_facet`. If the role exists but not on this kind → **widen `applicableKinds`** (same slug, extra kinds) then attach                                    | A new kind or a second role slug (`seller` vs `vendor`)                  |
| 3   | 1–3 extra fields in **one** domain                                                           | Workspace **overlay** property on the existing kind                                                                                                           | A forked kind in that workspace                                          |
| 4   | A true **subtype** with its own fields and life                                              | Child kind: `define_kind` with `parentProfileSlug` of the closest parent                                                                                      | A disconnected top-level kind                                            |
| 5   | A **relationship-with-a-life** (buyer × seller × price × stage, independent of either party) | Own kind (the **deal precedent**). New slug if CRM `deal` is a _sales pipeline_ and this is not that. Overlay if it **is** the same kind in another workspace | Twin slug `deal`; JSON arrays of prices on the thing; Finding-per-scrape |
| 6   | A **stage** inside a domain                                                                  | Status field + view                                                                                                                                           | A workspace per stage                                                    |
| 7   | A **domain** (owns kinds + own team + automations + stable)                                  | Four-test → `agent-os` / template                                                                                                                             | A workspace for a project, a hat, or a shopping list                     |
| 8   | None of the above                                                                            | `define_kind` (pod-wide default)                                                                                                                              | Silent invent                                                            |

Same **kind** across workspaces: **one profile**, overlays for extra fields, optional `entityScope: pod` (pod-admin) so instances are not trapped. Never a second profile with the same name.

### Widen a role

`synap_define_role` with an **existing** slug is slug-idempotent: extra `applicableKinds` are **merged** (widen only). Shrinking the allowlist is not this door.

### Firewalls

- `list_profiles` before every define.
- Prefer attach / widen / overlay / parent over create.
- One structural proposal at a time.
- `proposed` is success.
