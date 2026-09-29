# Synap — what this actually is

> **This document is the single source of truth for Synap's public claims.**
> The README, the docs site, the pitch, and any deck must agree with it. When
> one of them and this file disagree, this file is right and the other is stale.
>
> It was written by reading the schema, not the marketing. Every structural
> claim below cites the file it came from. If you change the model, change this
> file in the same commit.

Synap is a **sovereign data pod** with a **governed agent runtime** on it. It is
open source, self-hostable, and it is deliberately not a product that owns your
data. Three claims carry the whole thing:

1. **You own the data.** A pod is your own PostgreSQL. Export it, `pg_dump` it,
   self-host it, or let us run it. No lock-in, because the substrate is the
   public one.
2. **Every AI change is reviewed.** Agents propose; you approve. Nothing
   consequential lands unseen, and the history is on an append-only event chain.
3. **Bring your own agent.** We never meter your inference. Claude, ChatGPT,
   Cursor, or anything else that speaks MCP works against your pod under
   permissions you grant.

Everything below is the detail behind those three.

---

## 1. The two layers

Synap has two layers, and confusing them is the single most common way to
describe the product wrong.

| Layer                | What it is                                                           | Is it the feature?                       |
| -------------------- | -------------------------------------------------------------------- | ---------------------------------------- |
| **The data model**   | Kinds, Roles (facets), Views. Typed records, relations, projections. | **No — this is the substrate.**          |
| **The unit of work** | Project → Track → Session, plus Playbooks and Automations.           | **Yes — this is what you actually buy.** |

The data model is what makes the pod _queryable_. The unit of work is what
makes it _yours_: every agent you connect works against the **same unit of
work**, in the same channel bound to it, so the work compounds instead of
scattering across private chats.

Source: `packages/database/src/schema/project-tracks.ts:1-16` (header states the
model explicitly), `projects.ts`, `focus-sessions.ts`.

---

## 2. The data model (the substrate)

- **Kinds** — a typed noun an entity _is_ (`person`, `task`, `event`, `note`,
  `article`, `decision`, `research`, …).
- **Roles** (facets) — a hat an entity _wears_ (`client`, `partner`,
  `blocker`, `milestone`). Roles are **not** separate entities: one person, many
  roles, no duplication. An entity is exactly one kind plus zero or more roles.
  (`packages/database/src/schema/profiles.ts:202`; `entity-facets.ts`.)
- **Views** — projections over the same records, never copies. A list, a board,
  a calendar, a graph are the same data in a different shape.
- **Events** — every write is an append-only event with
  `requested → approved → validated` phases, for a fixed set of core tables.
  (`packages/events/src/generator.ts:100-158`.)

**Why it matters:** your pod stores each person **once**. A CRM view reads the
`client` role; a personal workspace reads the `friend` role. Same record, no
sync job, no second copy of you.

### Kind or Role? (the rule that trips people up)

If something is a _thing_ with its own identity and fields, it's a **kind**. If
it's a _context_ the same thing can wear in different situations, it's a
**role**. `Anna` is a `person` kind. She is a `client` in your business
workspace and a `friend` in your personal one. There is only one `Anna`.

---

## 3. The unit of work (the feature)

This is the part that makes "every AI works on the same thing" a mechanism
rather than a slogan.

```
Project    — long-lived intent. Months. A thing you're actually doing.
  │
  ├── Track    — a METHOD running inside one project
  │              (e.g. "Business model", "Content", "Build").
  │              A project runs N of these.
  │
  │   ├── Session  — short-lived, one task type. Filed at a track + stage.
  │   └── Session
  └── Track

Or just a Session on its own — most of them are.
```

- A **Project** is long-lived intent. It has a `phase` (where the work is) and
  an optional `targetDate`; progress is **derived** from contained work, never
  stored as a percentage. (`projects.ts:62-78`.)
- A **Track** is a _method_ — a reusable way of making progress (a project-scope
  playbook) — running inside one project. A track **pins the definition it
  started from**, so editing the method later never silently rewrites the
  vocabulary a live track sits in. (`project-tracks.ts`, migration 0272/0274.)
- A **Session** is a bounded unit of work toward one goal, with a scope and a
  checkpoint you accept before it runs. Sessions are born inside a track and
  carry `trackId` + the stage they were filed at, stamped at birth and never
  re-derived. (`focus-sessions.ts:103-121`.)

### Repeatability

- A **Playbook** is a session _shape_ you can run again. A playbook can be
  `scope: 'session'` (a template for one kind of work) or `scope: 'project'`
  (a method a project runs as a track). (`playbooks.ts:105`.)
- An **Automation** binds a playbook to a trigger — `event`, `cron`, `webhook`,
  or `manual`. ("When X happens, run this process.") (`automations.ts:902-903`.)

So: you do work once, in a session. It becomes a playbook. You bind it to a
trigger. Now it runs without you — still governed, still auditable.

### The collaboration claim

Every session has a **channel** — a linked room where humans and agents
participate in the same thread of work, with artifacts and proposals visible
in-band rather than locked in a private transcript. (`focus-sessions.ts:225`,
`channels.ts`.)

> ⚠️ **Honest scope.** The channel is created on session start and wired back
> onto the row, so it is nullable until then. And the track layer is
> **optional** — `focus_sessions.trackId` is documented as "NULL for almost
> every session" (`focus-sessions.ts:107-108`). A session may be
> workspace-scoped with no project at all. The hierarchy is where multi-week
> work gets a shape; it is not a precondition for using the pod, and this
> document should not be read as claiming it is.

This is the differentiator: not "an AI that answers you" but a place where
several agents and you work the same goal, on the same records, and you stay in
the approval seat.

---

## 4. Governance (why you can trust an agent with your data)

- **Every AI mutation is a proposal.** The agent proposes a change; you approve
  or reject it. There are no silent writes. (`checkPermissionOrPropose()` is the
  one door.)
- **Proposals are scoped, reviewable, and reversible** — you see what changed,
  why, and can undo it.
- **The event chain is append-only** — the history is the audit trail.
- **Credentials live in a governed capability layer**, not in your prompts. An
  agent can be given a scoped credential it can never exfiltrate.

This is the "git PR for your data" idea, and it's the reason a vibe-coded AI
app that would ship an auth bug to production can't do that here — writes are
gated by design.

---

## 5. Bring your own agent

We do not sell inference, and we do not meter it. An agent connects to your pod
over MCP or the Hub Protocol, with its own identity and RBAC scope, and works
against the same records you do. Switching agents never loses your context —
the data is yours, not the model's.

---

## 6. Where the data lives

A pod is standard infrastructure you can run and open yourself:

- **PostgreSQL** (with **pgvector** for embeddings) — your records.
- **Typesense** — full-text search. (The old vector-search endpoint is
  deprecated; pgvector still backs the agent's internal retrieval behind a
  feature flag.)
- **MinIO** — file storage.
- **Ory Kratos + Hydra** — identity and OAuth2/OIDC.
- **TimescaleDB** — the append-only event chain (a Postgres extension).

The accessibility layer (`packages/api/src/access/`) is the one place scoping
and visibility are decided; every read and write goes through it. Export is
`pg_dump`. There is no proprietary format.

---

## 7. Build on it (it's a backend)

Synap ships a browser app and a CLI, but it is deliberately **a backend first**.
If you want your own app, the public TypeScript SDK is on npm:

```bash
npm i @synap-core/sdk
```

`@synap-core/sdk` is MIT, published, and exposes a typed tRPC client for your
pod. See [`docs/DEVELOPER.md`](./DEVELOPER.md) for a worked example.

---

## The honest summary

Synap is not a "second brain" and it is not a "chat app." It is the sovereign,
governed substrate where your agents do real work on records you own, in units
of work you define, under a review model you control.

The vision line, which lands as the **close** rather than the opening: you're
not just using Synap — you're building a version of yourself that every AI can
understand.
