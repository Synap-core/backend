# Synap design

Load this when you design, review or build any Synap UI, or a UI for a user's pod: a screen, page,
panel, section, card, component, empty state or dashboard. It is the one place the design rules live
for every agent. For views, bento dashboards and workspaces over pod data, also load `synap-ui`.

Most bad screens here are not styling failures. They are modelling failures: the object was never
named, so the screen borrowed a foreign card and inherited its verbs. Get the object and the job right
first; the layout follows from them.

## Before anything: name the object and the job

- Write one sentence: "This surface renders ONE ___." Check that the card, row or panel you plan to
  use was built for that object. If none fits, model the object; never bend a foreign one.
- Write the reader's primary job as the question they arrive with, then the secondary one. A surface
  that serves its secondary job by default has failed.
- Ground truth first. Read the component that renders it today and the data the backend really
  returns. Never design from a description or from memory.

## The loop (six steps)

1. **Discover what exists.** Query the component catalog before you design or build anything
   (`system.md`). If the thing exists, even imperfectly, the work is adopt, extend or consolidate,
   and the diff should shrink.
2. **Design with real components.** A design is data, not a picture: Puck JSON whose every block is a
   real component from the catalog, saved as a `ui-design` entity. Three genuinely different variants
   by default. Lay out every state (`loop.md`).
3. **Critique.** Run the three-tier rubric on each variant: Checked, Pattern, Opinion. Fix every
   Checked and Pattern blocker and critique again. Opinions go to the person, never applied by you.
4. **Human review gate.** Move the design to `in-review` and wait. `approved` is a person's call; you
   never set it, and you never implement from a draft.
5. **Implement.** Build exactly the approved design from the same components and tokens. Do not
   reinterpret it.
6. **Verify against the design.** Run the gates yourself, then compare Today, Design and Built side
   by side, and walk the screen in the running app. Report what is VERIFIED (a gate proved it)
   separately from what NEEDS-DOGFOOD (only a running app can show it).

## Files

| File            | Read it for                                                                                                            |
| --------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `principles.md` | how a screen is arranged: marks, empty states, doors, lists, order, actions, disclosure, colour, depth                 |
| `system.md`     | what you build with: the catalog, tokens, the primitive table, labels, motion presets                                  |
| `loop.md`       | the design-to-code loop: the `ui-design` entity, variants, critique tiers, approval, implement, compare, where to view |
