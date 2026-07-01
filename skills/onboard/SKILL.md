---
name: onboard
description: >
  Use this skill when the active LENS (a workspace, a project, or both) has
  little/no data and the user wants it set up — including a NEW project that is
  empty even though its workspace already holds other projects' data. Triggers:
  "onboard this", "set up my <X> workspace", "set up this project", "help me
  fill this in", a freshly-created workspace, or scoping to a project with no
  entities. This is the ONE shared, adaptive onboarding process: it detects
  emptiness THROUGH the active lens, reads the workspace's onboarding context
  (settings.onboarding) for the domain knowledge, runs a goal-driven interview,
  and scopes every captured entity to the active lens (workspace + project). No
  per-domain skill — the domain is data on the workspace; this skill is the
  reusable intelligence that consumes it.
metadata:
  openclaw:
    requires:
      env: [SYNAP_HUB_API_KEY, SYNAP_POD_URL]
    primaryEnv: SYNAP_HUB_API_KEY
    homepage: https://synap.live
    capabilities: [onboarding, adaptive-interview, capture]
    os: [macos, linux, windows]
    userInvocable: true
---

# Onboard — the shared, adaptive onboarding process (lens-aware)

You set up the user's data by _interviewing them_, not by asking them to fill
forms. The same process works anywhere because the **domain-specific part is
data on the workspace** (`settings.onboarding`) and this skill is the
**reusable interview intelligence** that reads it and adapts.

Onboarding is keyed to the **active lens**, not to a workspace. A workspace is
just a lens; a project is a cross-cutting lens; they compose. You onboard when
**the active lens has little/no data** — whatever that lens is.

## 1. Detect emptiness THROUGH THE ACTIVE LENS

```
synap orient --details    # projects + workspaces, with each workspace's onboarding hint (empty ones)
```

Figure out the active lens (workspace, project, or both — `synap lens`), then
check for data **scoped to that lens**:

- **Project lens active** → is the PROJECT empty? Ask scoped to it:
  `synap ask "…" --projectId <id>` / `synap_get_entities` with `projectId`.
  A workspace can be full of OTHER projects' data while THIS project has zero —
  that still means "onboard." (e.g. Builder is full of Synap-project work; a new
  "Client X" project scoped to Builder has no entities → onboard Client X.)
- **Project × Workspace** → is there data for this project _within_ this
  workspace? Scope the check by both `projectId` and `workspaceId`.
- **Workspace only (no project)** → is the workspace raw-empty?

If the lens has data, **don't re-run** a full interview — offer to _extend_.

## 1b. Load the onboarding context (the WHAT)

The domain knowledge lives on the **workspace** (`settings.onboarding`, also in
`GET /api/hub/workspaces`):

- **`goal`** — the outcome to achieve (one sentence)
- **`framing`** — the expertise/voice to adopt for this domain
- **`collect`** — the structured data to capture (profiles + key fields)
- **`openingQuestions`** — a few starters (you adapt from here)
- **`doneWhen`** — how to know you're finished

Which workspace's spec?

- Workspace lens active → that workspace's spec.
- Project lens only (no workspace) → the project may span several workspaces.
  Confirm with the user which area to set up first, switch to that workspace,
  use its spec. Onboard one workspace's worth at a time.
- No onboarding spec on the workspace → fall back to first principles: infer
  from its profiles/views and onboard toward its core entity types.

## 2. Adopt the framing, run an ADAPTIVE interview

Become the expert the `framing` describes (brand strategist, staff engineer,
sales lead…). Then:

- Start with the `openingQuestions`, but **adapt every next question to what
  you just learned.** This is a conversation, not a checklist.
- Ask ONE focused thing at a time. Short, specific, in the user's language.
- **Let the `framing` set your posture.** When it says interrogate / pressure-test
  (e.g. Foundation's skeptical cofounder), that OVERRIDES the propose-then-refine
  reflex below: draw the real answer out of them, refuse fuzzy answers, propose a
  concrete option only as a last resort when they're genuinely stuck.
- **Strategic DNA vs operational detail — capture them differently.** For
  strategy (mission, positioning, voice, differentiators), thin inference becomes
  generic strategy — *extract* the real thing, don't hand them a plausible one.
  Propose-then-refine is fine for operational fields (a deal stage, a task
  priority): when the user is vague there, **propose** a concrete option and let
  them react ("Sounds like your voice is warm-but-direct — want me to go with
  that?"), infer aggressively, confirm lightly. Don't make them do the
  structuring — that's your job. Turn their prose into entities.
- Re-evaluate as you go: if an answer opens a more important thread, follow it.

## 3. Capture as you learn — structured, linked

As each piece firms up, write it immediately (don't wait until the end):

```
synap capture --type <kind> --claim "…"     # or synap_create_entity for precise profiles
```

For each `collect` target, create the entity with its `keyFields` filled, and
**link it** into the graph (`synap_link_entities`) — an isolated entity is
anti-value. Respect governance: a `proposed` result is normal (queued for the
user's review), not an error.

**Scope every created entity to the active lens.** Create it in the active
workspace, and — if a **project lens is active** — link it to that project
(`belongs_to_project`) so the project fills up, not just the workspace. This is
the whole point of the project-emptiness trigger: onboarding a new project
populates _that project's_ slice, even inside a workspace that already has other
projects' data.

## 4. Self-evaluate against `doneWhen` — loop until satisfied

After each round, check your progress against `doneWhen` and `collect`:

- Missing a target? Ask about it.
- Thin on a key field? Probe deeper.
- Got everything? **Stop** — don't over-interrogate. Summarize what you created
  and where it lives, and hand back control.

The bar is **quality structured data**, not a completed form. A short interview
that captures the real voice + audience beats 20 questions of mush.

## 5. Multi-workspace / multi-project flow

**New company** (after `agent-os` creates several workspaces): run this skill
**once per workspace**, foundational domain first (e.g. Brand before Marketing).
One workspace, finish, then the next.

**New project on an existing pod** (the common case): the workspaces already
have data from other projects, but the new project is empty. Walk the user
through the workspaces the project will touch, and for each, run a focused
interview for **this project's** slice — every entity linked to the new project.
The user can scope tight ("just set up Client X in CRM") — honor that.

## Principles

- **Lens-aware, not workspace-bound.** Onboard when the active LENS (workspace,
  project, or both) is empty — including a new project inside a full workspace.
- **Scope output to the lens.** Created entities go in the workspace AND link to
  the active project.
- **One skill, many domains.** The domain lives in `settings.onboarding`; you
  are the shared process. Never hardcode domain questions here.
- **Adaptive, not scripted.** Reshape questions from what you learn.
- **Ask, then structure.** The user talks; you turn it into linked entities.
- **Sparse-only, through the lens.** Onboard when the active lens is empty/thin
  (a new empty project counts, even in a full workspace); extend — don't restart
  — when the lens already has data.
- **Quality over coverage.** Stop when `doneWhen` is met.

## When NOT to use

- Setting up the company structure itself (project + which workspaces) → that's
  the `agent-os` skill (it calls this one per workspace afterward).
- One-off capture into an already-populated workspace → core `synap` skill.
- Schema changes (new profile/field) → `synap-schema`.
