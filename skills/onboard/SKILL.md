---
name: onboard
description: >
  Use this skill when a Synap workspace exists but is empty or sparse, and the
  user wants it set up — or when the user says "onboard this workspace", "set
  up my <X> workspace", "help me fill this in", or enters a freshly-created
  workspace. This is the ONE shared, adaptive onboarding process: it reads the
  active workspace's own onboarding context (settings.onboarding — declared by
  the workspace's template) and runs a goal-driven interview to collect the
  RIGHT structured data for THAT workspace, whatever its domain. There is no
  per-domain onboarding skill — the domain knowledge is data on the workspace;
  this skill is the reusable intelligence that consumes it.
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

# Onboard — the shared, adaptive workspace onboarding process

You set up a workspace by _interviewing the user_, not by asking them to fill
forms. The same process works for ANY workspace because the **domain-specific
part is data on the workspace** (`settings.onboarding`), and this skill is the
**reusable interview intelligence** that reads it and adapts.

## 1. Detect & load the onboarding context

```
synap orient                      # which workspace is active + its onboarding spec
```

Read the active workspace's `settings.onboarding` (also returned by
`GET /api/hub/workspaces`). It contains:

- **`goal`** — the outcome to achieve (one sentence)
- **`framing`** — the expertise/voice to adopt for this domain
- **`collect`** — the structured data to capture (profiles + key fields)
- **`openingQuestions`** — a few starters (you adapt from here)
- **`doneWhen`** — how to know you're finished

If the workspace has **no onboarding spec**, fall back to first principles:
infer from its profiles/views what it's for, and onboard toward populating its
core entity types.

**Only onboard a sparse workspace.** First check it's actually empty/thin
(`synap ask` / `synap_get_entities`) — never re-run a full interview on a
populated workspace. If it already has data, offer to _extend_, don't restart.

## 2. Adopt the framing, run an ADAPTIVE interview

Become the expert the `framing` describes (brand strategist, staff engineer,
sales lead…). Then:

- Start with the `openingQuestions`, but **adapt every next question to what
  you just learned.** This is a conversation, not a checklist.
- Ask ONE focused thing at a time. Short, specific, in the user's language.
- When the user is vague, **propose** a concrete option and let them react
  ("Sounds like your voice is warm-but-direct — want me to go with that?").
- Infer aggressively, confirm lightly. Don't make the user do the structuring —
  that's your job. Turn their prose into entities.
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

## 4. Self-evaluate against `doneWhen` — loop until satisfied

After each round, check your progress against `doneWhen` and `collect`:

- Missing a target? Ask about it.
- Thin on a key field? Probe deeper.
- Got everything? **Stop** — don't over-interrogate. Summarize what you created
  and where it lives, and hand back control.

The bar is **quality structured data**, not a completed form. A short interview
that captures the real voice + audience beats 20 questions of mush.

## 5. Multi-workspace flow (company onboarding)

When onboarding a whole company (after `agent-os` creates several workspaces),
run this skill **once per workspace**, in sensible order (the foundational
domain first — e.g. Brand before Marketing, so later workspaces can reference
it). Between workspaces, tell the user what's done and what's next. Don't dump
all interviews at once — one workspace, finish, then the next.

## Principles

- **One skill, many domains.** The domain lives in `settings.onboarding`; you
  are the shared process. Never hardcode domain questions here.
- **Adaptive, not scripted.** Reshape questions from what you learn.
- **Ask, then structure.** The user talks; you turn it into linked entities.
- **Sparse-only.** Onboard empty/thin workspaces; extend (don't restart) full ones.
- **Quality over coverage.** Stop when `doneWhen` is met.

## When NOT to use

- Setting up the company structure itself (project + which workspaces) → that's
  the `agent-os` skill (it calls this one per workspace afterward).
- One-off capture into an already-populated workspace → core `synap` skill.
- Schema changes (new profile/field) → `synap-schema`.
