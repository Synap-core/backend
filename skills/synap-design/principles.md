# Design principles: how a screen is arranged

Every rule here was dictated after dogfooding a screen that broke it. Apply all of them; a reviewer
checks each one.

## 1. State is a mark, not a sentence

A reader must know where a thing stands without reading. Colour and icon first; text only to
disambiguate what the mark cannot carry.

- Derive state once, from the shared unit state: it returns a tone and a glyph, never a colour and
  never a sentence. Never re-derive it locally.
- A tone has two values: a FILL for marks, dots and rails (3:1) and an INK for text and icons (4.5:1).
  Never use a fill as text; it fails contrast on light palettes.
- A status that is only ever prose is a defect. If you wrote a sentence to convey state, you owed a chip.
- Reduce text everywhere. Two lines that a chip plus four words would say is slop.

## 2. Classify every section's empty answer

Never a bare grey caption. Pick one deliberately:

| Answer       | When                                                  | Render                                                                  |
| ------------ | ----------------------------------------------------- | ----------------------------------------------------------------------- |
| **OMIT**     | absence already says zero and the user cannot fill it | nothing at all, not even the heading                                    |
| **INVITE**   | the user can fill it                                  | quiet empty state with the one action that fills it                     |
| **EXPLAIN**  | only an agent fills it                                | why it is empty plus an escape hatch (ask the AI, open the source chat) |
| **REASSURE** | empty is the good outcome                             | an "All clear" state                                                    |

A failed read is none of these: it is a failed state with the retry inside it. A read in flight is a
skeleton of the real row shape. Never fold a failure into calm empty copy, and never let a failed
lookup render as "empty".

## 3. Everything named is a door

- A count, chip, card or provenance line that names an object opens that object's own page through
  the one route table. Never a scroll-to-anchor; a scroll is the absence of a detail page.
- Provenance is a door, not a caption: "Started from a chat" opens the chat; "in project X" opens X.
- Show objects, not identifiers. An object with a title is a chip that opens it. A bare id with no
  title is a short mono chip with copy; never invent a label for it.
- Anything the reader is told about and cannot act on is either missing its door or should not be
  on the screen.

## 4. Lists are bounded and shaped

- Never an unbounded list in a detail screen. Cap it, then "Show all N" into a dedicated page that
  carries its scope in the address.
- Shape from the item: a horizontal row of cards for browseable peers (outputs, sessions,
  projects); a column for things that need a verb on each row (decisions, blocks).

## 5. No carousel over content the page already has

A swipeable deck is undiscoverable on a phone and, when its slides repeat sections below, pure
redundancy. Slides are only for content that exists nowhere else.

## 6. What it produced outranks how it worked

Order by what the reader came for. Outcomes sit above steps, narrative and context, never at the
bottom. Fold context, never outcomes.

## 7. One primary action, sized like an action

- Each section has ONE primary action at `md`; secondary actions are `sm`; `xs` is only for inline,
  row and toolbar actions.
- A full-width filled bar is a billboard. A single "start something" affordance is a round `+` that
  opens a picker of what can be started.
- Put the primary job's remedy next to the problem, with primary weight.
- One action grammar everywhere: the same verbs through hover menu, right-click and keyboard.
  Inapplicable verbs are absent, never disabled. A door the host did not supply means the affordance
  does not render; never a dead button.
- No warning buttons. Warnings are banners or callouts; a risky action is `tone="danger"`.

## 8. Progressive disclosure ladder

Write the rungs before building. Each answers one question and leads to the next: what happened,
then where, then why, then the thing itself.

- The default state answers the primary question on arrival. A triage surface pre-selects the
  failure; a summary surface shows the summary.
- The last rung is always the real object, never a description of it. Raw JSON is never a rung,
  only an escape hatch under a menu.
- Nothing that shows nothing at rest: collapsed boxes that cost height and deliver zero information
  get a pane they deserve, or go behind a rung that earns them.
- Calm default: surface attention only when it exists. An attention strip that is absent when
  nothing waits beats a permanent status panel.
- Configuration is the last rung, never the first. Controls that configure the system (renderer,
  layout, schema, governance) live behind a menu or in Settings. Editing the data itself (a title, a
  status, a date) stays easy and inline.
- Max two levels of disclosure on a dashboard.

## 9. Object creation: the minimum to exist, then the detail page

Ask only what the object needs to exist, land on its detail page, configure there. No wizards. A
"+ New" that does not actually create is a lie; a create menu offers the types, and each lands on
the new object.

## 10. Honesty

- No empty shells, no fabricated labels, provenance or defaults, no success state the data cannot
  prove. A rejected clipboard write never shows "Copied".
- Aggregates state their scope ("across the 20 most recent runs").
- Enumerate states before building: loading, each kind of empty, failed, one item, very long label,
  very many items, live, narrow. Truncated text needs a way to read it whole.

## 11. Colour, depth and shape

- **Tokens only.** Colours, spacing, radius, type and motion come from `--synap-*` tokens (or the
  components that use them). Never a hex, rgba, px, ratio, weight or font-family literal.
- **90% neutral, 10% accent.** Colour is earned: an element gets accent only when it is selected,
  focused, primary or AI. Icons rest neutral. Colour and icon are redundant encodings of one state,
  which is what makes a mark glanceable and accessible.
- **One accent for control states.** Switches, checkboxes and selected segments use
  `--synap-primary` when on, including on AI settings. Human selection is `--synap-primary`.
- **AI colour is provenance only.** `--synap-ai` (the logo yellow) marks AI-attributed or
  agent-touched work, and an action that starts AI work is `primary tone="ai"`. Nothing else wears it,
  and AI never wears another colour. To mark an AI section, colour its icon or heading, not its
  controls. A filled AI surface is `--synap-ai-surface` under `--synap-ai-foreground`.
- **Contrast by measurement.** Text on a colour fill is picked by measured contrast (WCAG 4.5:1),
  never by a luma threshold or a hard-coded white. Compute it; do not eyeball or trust a claimed ratio.
- **No shadows on in-flow surfaces.** Depth is `--synap-border-color` plus a luminance step. Only
  floating layers get a restrained glass lift (glass tokens, blur, 1px border).
- **A page never paints a background.** Only the app plane and the desk ground paint
  `--synap-background`; `--synap-background-surface` is a card film, never a page. A full-bleed canvas
  is the one exception: it is the ground.
- **Concentric radius.** `parent_radius = child_radius + gap`. Nested rounded surfaces nest; they
  never collide.
- **Interaction states.** Hover is an opacity or background change; press is `scale(0.96 to 0.98)` on
  a control; focus is an outline only, never a border-width change.
- **Floating menus** take a min and a max width, never a fixed width, and use the menu or anchored
  popover primitives, which portal and own focus, dismiss and keyboard.
- **Targets** are at least 24px (WCAG 2.2).
