## When to extend an existing profile vs. create a new one

Extend when:

- The thing fits an existing category (a "client" is a kind of `contact` — consider inheritance)
- The user needs 1–3 extra fields on an existing type
- The new fields are workspace-specific (use an overlay, see below)

Create new when:

- None of the system profiles fits
- The thing has a clearly distinct set of properties (10+ fields)
- The domain model genuinely calls for a new first-class type (recipe, workout, podcast episode, investment, plant, medication, vehicle, property listing…)

Prefer **inheritance** over new profiles when a system parent fits. `contact extends person` is the pattern — a new `client` profile can `parentProfileSlug: "contact"` and only add the fields that differ.
