# The design-to-code loop

```
catalog ──► Puck JSON ──► 3 ui-design variants ──► critique ──► a person picks one, approves
                                                                        │
             merged + verified ◄── gates + compare + dogfood ◄── implement from the approved design
```

The process "Design to implementation" (Builder space) carries a design from draft to merged. A
person, or an agent asked to, starts it on the request design with `synap_run_playbook`; it does not
start itself on every new `ui-design`, because sibling variants are `ui-design`s too.

## 1. The design is a canvas of Puck pages from real components

A design is a canvas (`schema-version` `3`): one frame per screen, and a single screen is a canvas with one
frame (section 1b). This section is the rules of a frame's page, the Puck data each frame holds:

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
        "children": [
          { "type": "Text", "props": { "id": "Text-1", "text": "Add agent" } }
        ],
        "size": "md"
      }
    }
  ],
  "root": { "props": { "title": "Settings › Agents" } }
}
```

- `content[]` is the page, top to bottom. Each item is `{ type, props }`; `props.id` is required and
  unique (`<Type>-<n>` is fine).
- `type` is a component name from the manifest, spelled exactly, and placeable (it has a story tagged
  `canvas`). `props` are props it declares, with values of the declared type: an enum takes one of its
  literals. Function props, `className`, `style`, `as` and raw HTML are never accepted.
- A `children` prop of type ReactNode is a slot that holds an array of blocks. Other ReactNode props
  (`label`, `title`) are plain text. A frame's page is slots only: no `zones`. `root.props` holds page settings only.
- No hex, rgb, px or font family in a prop; colour, spacing and type come from components and tokens.
- A canvas design (schema-version 3) lays each frame's page on a column grid: `Section` blocks hold it
  (12 / 8 / 4 columns by the frame's width), a block in a Section or Grid takes `span` and `hide` per width
  class, and a frame with `pageOf` shows another frame's page at its own width. The full shape is in
  `designing-with-real-components`.
- Motion is not in the props. List it in the design's `motion` property as
  `[{ "trigger": "enter", "target": "SpatialPanel-1", "preset": "fade-rise" }]` with named presets only.
- Lay out every state the screen has: empty, loading, failed, full, long content. Each empty state is
  OMIT, INVITE, EXPLAIN or REASSURE; a failed read is its own state with a retry.
- The Map canvas (Design app, `#/map/canvas/<id>`) opens the design and validates on load: an unknown
  `type`, an undeclared or wrong prop and a block a slot does not allow are dropped and named. Open yours
  there.

## 1b. The canvas: one frame per screen

**Every design is a canvas**: `schema-version` `3`, and `design-json` is a board of frames, each frame
holding one screen's Puck page. One screen is a canvas with one frame; several screens or a user flow
are several frames. Always write `schema-version` `3`, never `1` or `2`: the canvas migrates an older
design on read (a page becomes one frame) and every save writes 3.

```json
{
  "format": "synap-board/2",
  "frames": [
    {
      "id": "f1", "name": "Home", "x": 0, "y": 0, "w": 1440, "h": 900,
      "page": {
        "root": { "props": {} },
        "content": [
          { "type": "Stack", "props": { "id": "s1", "gap": "space-300", "padding": "space-400", "children": [
            { "type": "Heading", "props": { "id": "h1", "text": "Welcome back", "level": "title" } },
            { "type": "SpatialButton", "props": { "id": "b1", "variant": "primary", "children": [
              { "type": "Text", "props": { "id": "t1", "text": "Continue" } } ] } } ] } }
        ]
      }
    }
  ]
}
```

- `frames[]` is the canvas. `x`, `y` place a frame on the canvas; `w` is the page width (1440 desktop,
  1280 laptop, 834 tablet, 390 phone); `h` is a minimum, the frame grows with its content. Name each
  frame for its screen or state; one frame per screen.
- Each `page` follows every rule of section 1: real components only, `props.id` unique in its frame,
  no hex, rgb, px or font family. Layout is flow only: stack blocks with `Stack`, `Row`, `Grid`, `Box`;
  a component never gets its own x or y.
- Layout blocks take exact values, never pixels: `gap`, `padding`, `paddingX`, `paddingY` take `none` or a
  spacing name (`space-025`, `space-050`, `space-075`, `space-100`, `space-125`, `space-150`, `space-200`,
  `space-250`, `space-300`, `space-400`, `space-500`, `space-600`, `space-800`, `space-1000`,
  `space-1200`); a `Box` `background` takes `none`, `background`, `background-surface` or `paper`;
  `radius` takes `none`, `radius-container` or `radius-floating`; `border` takes `none` or `hairline`.
- A label slot (a button's `children`) holds only inline blocks: `Text` or a component whose name ends in
  `Icon` or `Glyph`. Never another button or a layout block.
- The canvas drops and names, at any depth: an unknown `type`, an undeclared or wrong prop, and a block
  a slot does not allow. Check yours on the Map canvas.
- `components-used` is the distinct `type` values across every frame, nested slot blocks included,
  sorted.

## 2. Save it as a `ui-design` entity

Find before you create: `synap_find` for an existing `ui-design` on the same `target-surface`.

When the pod has the `design` capability installed, create and change designs through its three verbs
(section 2b), not raw entity writes: the pod then checks every block against the catalog before it
lands. The rules below still say what a design holds.

- Create with `synap_create_entity`, `profileSlug: "ui-design"`, a title, and properties:
  `target-surface` (app and screen), `design-scope` (`component` or `page`; a canvas is `page`), `design-goal` (the job the
  screen does; the critique judges against it), `design-json`, `components-used` (the distinct `type`
  values, derived from the JSON, recursive across every frame of a canvas, never typed by hand),
  `schema-version` (`3`), `motion`,
  `current-story-id` (the story of the screen as it is today, when it exists), `frame-stories` (the
  built stories per frame of a multi-frame design, see section 5), `design-notes`.
- **Three variants by default.** One request is three designs: the request plus two siblings, sharing
  one `variant-group`, `target-surface`, `design-scope` and `design-goal`. Make them genuinely
  different answers (structure, density, order), not three colourings. Link each sibling to the
  request with `relates_to`. If the person asks for one, make one.
- Read the person's references first (linked with `references` via `synap_link_entities`).
- Revise with `synap_update_entity`, writing `design-json` and `components-used` together.
- `proposed` is success: a person reviews the write. Do not retry.
- Never save a screenshot as the design, and never mirror components into the pod as entities.

## 2b. The design door: `design.read`, `design.catalog`, `design.apply`

Three verbs of the `design` capability (`synap_run_capability`). Without it installed they are not
there: say so, and fall back to section 2.

- **`design.catalog`** (read): the installed kit (`kitId`, `hash`), its `components` and their props
  (a slot is a prop of kind `slot`, with `allow` when it takes only some blocks), the canvas blocks
  (`layout`: Section, Box, Stack, Row, Grid, Heading, Text, Motion; their spacing, radius and colour
  props take token steps), the grid (12 / 8 / 4 columns, breakpoints 600 / 1024) and the frame presets.
  Read it before you design; never guess a component or a prop value.
- **`design.read {designId}`** (read): the design (`status`, `updatedAt`, `appId`, whether it is
  `editable`), its `board`, an outline per frame (width class, columns, block ids and types), and
  `dropped`: what the catalog cannot place. Keep `updatedAt`: it is your `baseUpdatedAt`.
- **`design.apply {designId, baseUpdatedAt, ops}`** (write): ops applied in order, all or nothing.
  - `create_design {title, appId?, projectId?}`, first and with no `designId`: a new design for that
    app (`devplane_app`), filed into the project. The rest of the batch fills it.
  - frames: `add_frame {preset: desktop|laptop|tablet|phone, name?, id?, pageOf?}` (`pageOf`: this
    frame shows that frame's page at its own width),
    `update_frame {frameId, name?, preset?, x?, y?, w?, h?}`, `remove_frame {frameId}`.
  - blocks: `add_block {frameId, parentId?, slot?, index?, type, props?}` (no `parentId`: the page's
    own content; give `props.id` to name it in a later op), `update_block {id, props?, unset?}`,
    `move_block {id, frameId?, parentId?, slot?, index?}`, `remove_block {id}`.
  - grid: `set_span {id, class: compact|medium|expanded, span}` (whole columns, 1 to 4 / 8 / 12; `null`
    clears), `set_hide {id, class, hide}`.
  - whole pages: `replace_page {frameId, page}` (a generated page), `replace_board {board}`.
- A refusal changes nothing and names the op's index, why (an unknown component, a prop value that is
  not a token step, a span wider than the grid, a block a slot does not take) and the catalog hash.
  Fix that op and send the batch again. A design changed since you read it is refused too: read it
  again. A stored design the catalog cannot fully place is refused until you pass `acceptDrops: true`.
- The answer is `applied`, `created`, `proposed` (a person reviews it: success, do not retry) or
  `revised`: a design past its review (`approved` and after) is never written; the change becomes a
  new design in `draft` (`revisedFrom` names the old one).
- `design.apply` never moves `design-status`: that stays section 4's move with `expectedStatus`.

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
- Build only those components, in the order of `content[]` and its slots (for a canvas, one screen per
  frame: each frame's `page` is that screen's design), with tokens only and the
  named motion presets. The design gives layout, not data wiring: data still flows through the layers.
- Record the built stories on the design. A single-frame design records its story id in
  `implemented-story-id`. A design with several frames records a map in `frame-stories`,
  `{ "<frameId>": ["<storyId>", ...] }`: every frame id of `design-json` is a key, and one frame may
  serve several stories (its states), so a story is never guessed from a frame's name. Leave
  `implemented-story-id` empty for a multi-frame design; existing designs are not migrated, so a
  reader uses `implemented-story-id` when the map is empty. Never edit `design-json` to match what
  you built; revise as a new draft instead.

## 6. Verify against the design

- Run the gates yourself and quote them: type-check, story tests (render, interaction, axe), visual
  regression when a primitive changed (a moved pixel is a finding first, never a baseline update),
  the token, hex and motion guards.
- **Compare Today, Design and Built.** Capture each built story (`implemented-story-id`, or every
  story in `frame-stories`, compared frame by frame) and, when set, the `current-story-id`
  (today) with `pnpm --filter @synap-core/storybook capture`, the one capture door; render the design on
  the canvas; list every difference. Then run the Checked tier on the built story.
- Walk the screen in the running app with screenshots: WORKS, BROKEN or CANNOT-TELL.
- Open the PR and record its URL in `implementation-pr`. Inside the process stop there: Done is a
  person's gate that writes `implemented`. Outside it, a move to `implemented` proposes and a person
  confirms the merge. Report VERIFIED separately from NEEDS-DOGFOOD.

## 7. Where designs are viewed

- **Team devbox, always on, built from `main`:** an index at `http://devbox:3000`, Storybook, the
  Design app at `http://devbox:3007`: the Map (`#/`, every component Figma-style; tokens on its
  Foundations page, also at `#/design-tokens`), a design on the Map canvas (`#/map/canvas/<id>`, one frame at
  `#/map/canvas/<id>/frame/<frameId>`) and the Lab
  (`#/lab`, live full experiences), and the
  Storybook MCP at `http://devbox:3006/mcp`. These hosts are on the founder's private tailnet only:
  an agent or pod outside it cannot reach them.
- **Locally, for unmerged work:** `pnpm --filter @synap-core/storybook storybook` from the monorepo
  root (127.0.0.1:6006, MCP at `/mcp`).
- The Storybook MCP has no authentication. Reach it only on your own machine or over a private
  network, never register it as a public pod MCP server. An agent on a remote pod reads the static
  `/manifests/components.json` of a Storybook build instead.
