# The design system: it probably exists

The recurring defect here is "built, not mounted": the right component shipped and the screen still
hand-rolls a copy. Before you design or write a component, prove it does not already exist. If it
exists, adopt or extend it (an additive variant or optional prop), never build a parallel one.

## 1. Query the catalog first, never your memory

The component catalog is Storybook. It is the truth for which components exist, their props, their
values and examples. Never use a component or prop the catalog does not document.

- **Storybook MCP, when connected:** `docs-list` once to see what exists, then `docs-show` for one
  component's props, usage and stories; `stories-find-by-component` for real usage.
- **Otherwise, the static manifest:** `/manifests/components.json` in the Storybook build. Each entry
  is a component with its props (name, type, required, default) and story examples.
- **Then the component inventory:** `synap-app/apps/storybook/inventory/components.json` lists every
  component family the product needs (universal and Synap-specific), each with its ONE canonical
  component, its variants and states, and a verdict. Its audit, `/component-audit.json` in the
  Storybook build (the `#/map` canvas shows it), adds which families have a story and which copies
  still live. Storybook covers only part of the library, so a family absent from Storybook is not proof
  that nothing exists. `consolidate` names the canonical: build on it, never on a listed copy.
  `missing` means propose the component, story first. `retire` means never use it.
- If you can read neither, stop and say so. Never design from what you remember a component looks like.
- The library lacks what you need? Say so and propose the component, story first. Never fake it with
  a generic box.
- A new or changed primitive ships with its story and JSDoc on the component and its props in the
  same change; the story is what feeds the catalog.

## 2. Stack by surface

| Surface                | Build with                                                                                               |
| ---------------------- | -------------------------------------------------------------------------------------------------------- |
| shared `@synap-core/*` | headless logic plus `--synap-*` tokens; no UI-library imports                                            |
| desktop workbench      | plain CSS plus spatial-ui primitives; a third-party widget only when wrapped and themed with `--synap-*` |
| standalone apps        | HeroUI plus the Synap HeroUI preset                                                                      |
| mobile (relay)         | its own native kit on the native design tokens                                                           |

Tamagui (`@synap-core/ui-system`) was removed. Never reintroduce it.

## 3. The primitives (short form; the catalog is the truth)

| Need                                           | Use                                                                                           | Not                              |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------- | -------------------------------- |
| button, icon button                            | `SpatialButton`, `SpatialIconButton`                                                          | a raw `<button>`                 |
| menu, context menu, stepped picker             | `SpatialMenu`                                                                                 | a positioned div + outside click |
| popover, floating panel, toolbar               | `SpatialAnchoredPopover`                                                                      | a positioned div                 |
| search-as-you-type list under an input         | `SpatialComboBoxPopover`                                                                      | an anchored popover              |
| modal, drawer, confirm, form dialog            | `SpatialModal`, `SpatialDrawer`, `SpatialConfirmDialog`, `SpatialFormDialog`                  | `role="dialog"` by hand          |
| input, select, combo, number, date             | `SpatialInput`, `SpatialSelect`, `SpatialComboBox`, `SpatialNumberField`, `SpatialDatePicker` | raw inputs                       |
| panel, card, clickable card, tabs              | `SpatialPanel`, `SpatialCard` + `SpatialCardAction`, `SpatialTabStrip`, `SpatialTabs`         | positioned divs                  |
| badge, chip, tag, avatar, progress             | `SpatialStatusBadge`, `SpatialChip`, `SpatialTag`, `SpatialAvatar`, `SpatialProgressBar`      | hand-rolled marks                |
| image or file preview                          | `SpatialMediaPreview`                                                                         | a raw `<img>` on a stored blob   |
| dashboard page (Home, project, track, session) | the lens-page components                                                                      | a local section shell or row     |
| an AI turn's process                           | the shared turn-activity component                                                            | a local thinking box or dots     |

- Overlays stay mounted to close: pass `isOpen` / `open` and let the component play its exit. Never
  `{cond && <Modal/>}`.
- `SpatialMediaPreview` is a security boundary: never point an `<img>`, `<video>`, `<iframe>` or
  `<object>` at a stored blob yourself.
- Third-party service marks (Telegram, Gmail, GitHub) come from the one service-mark registry. Never a
  generic glyph or a hand-written service map.

## 4. Tokens

- **Colour:** `--synap-*` only. Ink, muted, surface, border, `--synap-primary` (the one accent),
  `--synap-ai` (AI provenance only), and the status tones, each a fill plus its matching ink. Filled
  primary surfaces use `--synap-primary-button`, not `--synap-primary`. Brand marks and canvas shape
  colours are content, exempt from tokens; everything around them tokenizes.
- **Spacing:** ONE 4px scale, web and mobile. `--synap-space-025` 2, `050` 4, `075` 6, `100` 8, `125`
  10, `150` 12, `200` 16, `250` 20, `300` 24, `400` 32, `500` 40, `600` 48, `800` 64, `1000` 80,
  `1200` 96. The old 6px-base names are deprecated; never use them in new work.
- **Row heights:** `--synap-row-compact` 32 (navigation), `--synap-row` 40 (index rows),
  `--synap-row-roomy` 48 (lens rows, one-line cards). Controls inside a row stay on the button scale.
- **Control sizes:** `xs` 28, `sm` 34, `md` 40, `lg` 46. Never redraw a local small button.
- **Type roles:** `display` and `title` (Fraunces), `heading`, `body`, `caption`, `label`, `num`,
  `num-large`, `row-title`. In CSS use the longhand quartet
  `var(--synap-type-<role>-family|-size|-weight|-leading)`; inline, spread the role object. A size alone
  is `--synap-text-*`; line height `--synap-leading-*`; weight `--synap-weight-*`. When size, weight and
  leading together match a role, use the role.
- **Radius:** `--synap-radius-1` 6 (keycaps, smallest chips), `-2` 8 (icon tiles, small badges), `-3`
  12 (rows, menu items), `-4` 16 (cards, panels), `--synap-radius-round` for pills (buttons, chips,
  search bars, avatars). Same component class, same radius, everywhere; then apply concentric radius.
- **Grid chrome on a canvas:** `--synap-grid` and `--synap-grid-strong`, never a grey literal.

## 5. Labels go through the vocabulary door

Never hand-write a label map for an object kind, action or status, and never capitalise a raw token
at the call site. One door, `@synap-core/types/vocabulary`:

| Need                     | Use                                |
| ------------------------ | ---------------------------------- |
| object kind to noun      | `resolveObjectNoun(kind)`          |
| action to verb           | `resolveActionLabel(action, mood)` |
| lifecycle state to label | `resolveStatusLabel(status)`       |
| tool name to words       | `resolveToolLabel(toolName, mood)` |
| any token to words       | `humanizeToken(token)`             |
| "verb noun" title        | `buildObjectActionTitle({...})`    |
| third-party service name | `resolveServiceName(id)`           |

- Verbs have two moods: imperative ("Create") for buttons and pending proposals; past ("Created") for
  history, feeds and receipts. Never collapse them.
- Unknown values humanize, never leak. A raw token (`entity.create`, `in_review`) shown to a person
  is a defect.
- Dates, durations, sizes, empty-state sentences and domain-specific phrasings are not vocabulary;
  keep them local.

## 6. Motion: the named presets only

Motion is one closed, named menu. A design or an agent says "fade-rise on enter", never a duration,
easing or keyframe. Each preset carries a REQUIRED reduced-motion fallback, and the reader's OS
setting always applies.

| Preset          | Use it for                                                       | Reduced motion      |
| --------------- | ---------------------------------------------------------------- | ------------------- |
| `fade`          | backdrops, swapped content, anything that appears without moving | plays as-is         |
| `fade-rise`     | a card, dialog or toast arriving in the reading flow             | `fade`              |
| `scale-in`      | menus, popovers, pickers                                         | `fade`              |
| `slide-in-side` | drawers and side panels                                          | `fade`              |
| `collapse`      | accordions, disclosures                                          | instant (end state) |
| `list-stagger`  | lists, boards, grids                                             | `fade`, no stagger  |

- Code uses the preset component and the preset names from `@synap-core/web/motion`; never a raw
  duration or easing in a `transition` or `animation` (a guard ratchets them).
- Adding a preset is a design decision for a person, not something you do inline.
