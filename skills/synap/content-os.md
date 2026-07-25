## Content OS — the editorial model

Some workspaces run an editorial engine: `pillar`, `post`, `platform`, `newsletter`, plus the reused `campaign` and `sponsor`. Content OS is a **derived lens**, not a silo — the journey it can reason about is a function of what else exists in the pod. Understand this before proposing posts, pillars, or a content plan.

**The editorial core:**

- **`pillar`** — a recurring theme the audience knows the operator for. Two to four, not twelve. `pillar-status` (Active, Developing, Paused, Retired), `pillar-goal`, `pillar-formats`, `posting-frequency`.
- **`post`** — the atomic unit. `post-status` moves Idea → Briefed → In Draft → Review → Scheduled → Published → Archived. Plus `post-format`, `post-platform`, `publish-date`, `post-hook`, `post-cta`; measured by `engagement-score` and `post-reach`.
- **`platform`** — a publishing account (social, newsletter publication, podcast). Carries its own cadence and audience metrics.
- **`newsletter`** — one issue of the owned channel. `newsletter-status`, `newsletter-pillar`.
- **`campaign`** and **`sponsor`** — reused from marketing / foundation, not owned here.

**The journey layer (optional, additive):**

- **`journey-stage`** — where a reader is. Each stage names the belief it installs, the doubt it dissolves, and the action that advances them. Unordered _tagging_.
- **`series`** — an ordered curriculum, prerequisite-bearing: chapter by chapter.
- **`offer`** — the thing being sold. Owned by the `foundation` workspace, pod-wide. **Frequently absent — see the degradation rule.**

A post joins these through `post-stage`, `post-series`, `post-offer`; a repurposed post points at its source with `derived-from`.

**Two axes, both optional, composable:** CURRICULUM (`series` — ordered, "which chapter is this?") and AUDIENCE STAGE (`journey-stage` — an unordered tag, "where is the reader?"). A post carries at most one of each. With neither, Content OS still works exactly as a post tracker — that is a valid end state, not an incomplete one.

## The degradation rule — check before you assume

Read the world before you reason about it: `list_profiles` tells you the vocabulary actually provisioned, and the `## Pod Domains` block in your context tells you which domains exist.

- **No offer-bearing domain, no `offer` entities** → the journey is pure audience-building. **Do NOT invent commerce.** No CTA to a product that does not exist, no fabricated `offer`, no "book a call" the operator never mentioned. Reason on the curriculum and stage axes and stop there.
- **`foundation` exists** → bind pillars to its real `audience`, `pain-point` and `positioning` entities rather than inventing personas. A pillar aimed at a persona you made up is worse than a pillar with no audience named.
- **`journey-stage` / `series` / `offer` absent from `list_profiles`** → this pod runs the plain editorial model. Do not reference those slugs at all.

Absence is information, not a hole to fill.

## Pillars before posts

A creator known for two to four themes compounds; one posting about everything stays noise. If the operator hands you a dozen post ideas but cannot name the themes underneath, surface THAT before filling the calendar. Every post you propose hangs off a pillar — `post-pillar` plus a `belongs_to_pillar` relation. An unpillared post is drift.

## AI behavior — placing a post on the journey

When the operator describes a content idea, propose the post WITH its placement — never a bare title:

```json
POST /api/hub/entities
{ "userId": "{userId}", "workspaceId": "{wsId}",
  "profileSlug": "post",
  "title": "Why your pricing page loses the sale",
  "properties": {
    "post-status": "Idea",
    "post-format": "Article",
    "post-platform": "LinkedIn",
    "post-pillar": "ent_pillar_positioning",
    "post-stage": "ent_stage_evaluating"
  }
}

POST /api/hub/relations
{ "userId": "{userId}",
  "sourceEntityId": "ent_post_pricing",
  "targetEntityId": "ent_pillar_positioning",
  "type": "belongs_to_pillar"
}
```

Omit `post-stage` when no `journey-stage` exists, and omit `post-offer` when no `offer` exists. An empty commercial field is correct; a fabricated one is a defect. Use `derived-from` when the post is a repurpose of an existing one — one idea legitimately becomes a thread, a video, and a newsletter section.

## Gap analysis — proposing the next piece

"What should I write next" is an audit, not a brainstorm:

1. **Read the corpus** — one batched `list_entities` pass over `post` and `pillar`. Never one call per post; that is a cost failure.
2. **Map it** — each post to its pillar × its stage (or its place in a series). Build the grid before judging it.
3. **Find the holes** — a pillar with nothing at the earliest stage; a stage every pillar skips; a series that stops mid-curriculum; a pillar whose last post is months old.
4. **Propose the hole, not a topic** — "Pillar X has nothing that removes the pricing objection" beats "here are ten content ideas". Name the pillar, the stage, the belief to install, and the format.
5. **Ground it** — a proposed post cites the pillar it serves and, when `foundation` exists, the real `audience` or `pain-point` entity it answers. Otherwise it is a guess dressed as a plan.

Rank gaps by what the operator is actually known for, not what they wish they were known for.

## Resolution discipline — resolve BEFORE you create

Standard resolve-before-create applies (search once, batched, before proposing anything). Domain-specific matching keys: **platforms** resolve on handle or URL, **offers** on name, **pillars** on theme. Never placeholder — no pillar named "General", no `platform` for an account the operator doesn't have, no `offer` invented so a post has something to sell. Every post you propose attaches to at least a pillar; a post with no pillar and no stage is a note, not content.

## Kind vs facets, and governed writes

`sponsor` is a role-profile (`profileKind: role`) — per ENTITY MODEL, resolve the real company first, then `attach_facet`; a sponsoring company is never a second entity, and graph links attach to the parent, not the facet.
