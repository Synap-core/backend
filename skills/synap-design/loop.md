# The design-to-code loop

```
catalog ──► Puck JSON ──► 3 ui-design variants ──► critique ──► a person picks one, approves
                                                                        │
             merged + verified ◄── gates + compare + dogfood ◄── implement from the approved design
```

The process "Design to implementation" (Builder space) carries a design from draft to merged. A
person, or an agent asked to, starts it on the request design with `synap_run_playbook`; it does not
start itself on every new `ui-design`, because sibling variants are `ui-design`s too.

## 1. The design is Puck JSON from real components

```json
{
  "content": [
    {
      "type": "SpatialPanel",
      "props": { "id": "SpatialPanel-1", "title": "Agents" }
    },
    {
      "type": "SpatialButton",
      "props": {
        "id": "SpatialButton-1",
        "children": "Add agent",
        "size": "md"
      }
    }
  ],
  "root": { "props": { "title": "Settings › Agents" } },
  "zones": {}
}
```

- `content[]` is the page, top to bottom. Each item is `{ type, props }`; `props.id` is required and
  unique (`<Type>-<n>` is fine).
- `type` is a component name from the manifest, spelled exactly, and placeable (it has a story tagged
  `canvas`). `props` are props it declares, with values of the declared type: an enum takes one of its
  literals. Function props, `className`, `style`, `as` and raw HTML are never accepted.
- A `children` prop of type ReactNode is a slot that holds an array of blocks. Other ReactNode props
  (`label`, `title`) are plain text. Keep `zones` as `{}`. `root.props` holds page settings only.
- No hex, rgb, px or font family in a prop; colour, spacing and type come from components and tokens.
- Motion is not in the props. List it in the design's `motion` property as
  `[{ "trigger": "enter", "target": "SpatialPanel-1", "preset": "fade-rise" }]` with named presets only.
- Lay out every state the screen has: empty, loading, failed, full, long content. Each empty state is
  OMIT, INVITE, EXPLAIN or REASSURE; a failed read is its own state with a retry.
- The canvas validates on load: an unknown `type` refuses the whole design; an undeclared or wrong prop
  is stripped and listed. Check yours with the canvas's Paste JSON.

## 2. Save it as a `ui-design` entity

Find before you create: `synap_find` for an existing `ui-design` on the same `target-surface`.

- Create with `synap_create_entity`, `profileSlug: "ui-design"`, a title, and properties:
  `target-surface` (app and screen), `design-scope` (`component` or `page`), `design-goal` (the job the
  screen does; the critique judges against it), `design-json`, `components-used` (the distinct `type`
  values, derived from the JSON, never typed by hand), `schema-version` (`1`), `motion`,
  `current-story-id` (the story of the screen as it is today, when it exists), `design-notes`.
- **Three variants by default.** One request is three designs: the request plus two siblings, sharing
  one `variant-group`, `target-surface`, `design-scope` and `design-goal`. Make them genuinely
  different answers (structure, density, order), not three colourings. Link each sibling to the
  request with `relates_to`. If the person asks for one, make one.
- Read the person's references first (linked with `references` via `synap_link_entities`).
- Revise with `synap_update_entity`, writing `design-json` and `components-used` together.
- `proposed` is success: a person reviews the write. Do not retry.
- Never save a screenshot as the design, and never mirror components into the pod as entities.

## 3. Critique: three tiers, not equally trusted

Every finding names a rule id from the critique rubric (`design-critique` skill); no rule id, no
finding. Write the list into each variant's `critique`.

| Tier        | Who decides                                                                                                                                                        | May block | Applied automatically       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- | --------------------------- |
| **Checked** | a tool or a measurement (axe, contrast, target size, tokens only, manifest only, named motion)                                                                     | yes       | the generator fixes it      |
| **Pattern** | you classify what is on screen; a fixed house rule judges (marks, empty answers, doors, caps, order, one primary, AI colour, creation, raw tokens, states covered) | yes       | the generator fixes it      |
| **Opinion** | your judgement, tied to one named Nielsen heuristic, low confidence                                                                                                | never     | **never**; a person decides |

- Run the tool for a Checked rule; never estimate. Unmeasured is low confidence, never a pass.
- The gate passes when every variant going to review has its critique and no open Checked or Pattern
  blocker. Opinions never decide it.
- A failing gate goes back to generation; then critique again from scratch. Never edit or delete a
  finding to clear the gate. Only a person dismisses.

## 4. The human gate

`design-status`: `draft`, `in-review`, `approved`, `implementing`, `implemented`, `archived`.

- Every move is `synap_update_entity` with the new `design-status` AND `expectedStatus` set to the
  status you read. A conflict means someone moved it: re-read, decide again.
- **`approved` is a person's call.** Put the design `in-review`, ask for the review, wait. A rejection
  sends you back to revise.
- The person picks ONE variant. Inside the process, if they choose a sibling, write its
  `design-json`, `components-used` and `motion` into the request design before approval. Archiving
  the others is the person's call.

## 5. Implement from the approved design

- Start only from `approved` (or `implementing` when the process already moved it). Draft or in
  review: stop and say so. Move `approved` to `implementing` with `expectedStatus: "approved"`.
- Read it with `synap_get_entity`. For each distinct `type`, confirm the component and its props in
  the catalog. A missing type or prop: stop, record it in `design-notes`, propose the component.
- Build only those components, in the order of `content[]` and its slots, with tokens only and the
  named motion presets. The design gives layout, not data wiring: data still flows through the layers.
- Give the screen a story and record its id in `implemented-story-id`. Never edit `design-json` to
  match what you built; revise as a new draft instead.

## 6. Verify against the design

- Run the gates yourself and quote them: type-check, story tests (render, interaction, axe), visual
  regression when a primitive changed (a moved pixel is a finding first, never a baseline update),
  the token, hex and motion guards.
- **Compare Today, Design and Built.** Capture the built story and, when set, the `current-story-id`
  (today) with `pnpm --filter @synap-core/storybook capture`, the one capture door; render the design on
  the canvas; list every difference. Then run the Checked tier on the built story.
- Walk the screen in the running app with screenshots: WORKS, BROKEN or CANNOT-TELL.
- Open the PR and record its URL in `implementation-pr`. Inside the process stop there: Done is a
  person's gate that writes `implemented`. Outside it, a move to `implemented` proposes and a person
  confirms the merge. Report VERIFIED separately from NEEDS-DOGFOOD.

## 7. Where designs are viewed

- **Team devbox, always on, built from `main`:** an index at `http://devbox:3000`, Storybook, the
  design canvas (`#/design`) and the token page (`#/design-tokens`) at `http://devbox:3007`, and the
  Storybook MCP at `http://devbox:3006/mcp`. These hosts are on the founder's private tailnet only:
  an agent or pod outside it cannot reach them.
- **Locally, for unmerged work:** `pnpm --filter @synap-core/storybook storybook` from the monorepo
  root (127.0.0.1:6006, MCP at `/mcp`).
- The Storybook MCP has no authentication. Reach it only on your own machine or over a private
  network, never register it as a public pod MCP server. An agent on a remote pod reads the static
  `/manifests/components.json` of a Storybook build instead.
