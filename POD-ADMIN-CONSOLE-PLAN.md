# Pod Admin → the Pod Console

> Research + direction. Supersedes the IA half of `POD-ADMIN-NEXT-DECISIONS.md`
> (D1/D2); keeps its D3–D6 findings as constraints. Grounded in a full
> inventory of `apps/pod-admin`, the renderer stack in `packages/types`, the
> Eve dashboard in `Synap-core/hestia-cli`, and a live `diagnose` of the
> owner's pod (2026-10-12).

---

## 1. The thesis

pod-admin is the **only surface that ships with every pod, needs no install,
and opens on every device**. Every review link an agent hands out already
points at it (`orient` → `pod.<host>/open/<id>`). So it is the user's first
page whether we design for that or not.

It should become what a cloud console is to a cloud account: **the place you
operate the pod** — what needs me, what is running, what is broken, who and
what has access, what is installed. Not a second Synap (authoring stays in
browser/relay), not an OS shell (no wallpaper/dock — that's Eve's taste, and
it reads as gamified).

Direction of travel flips: today pod-admin bounces settings *out* to
`synap://open/app/settings/*`. Tomorrow browser/relay link *in* to the
console for anything operational ("Manage in console ↗").

## 2. What is wrong today (evidence)

| Problem | Evidence |
|---|---|
| **Organized by tables, not intent** | 10 flat tabs in a scrolling strip (`tab-strip.tsx`): Overview · Workspaces · People · Entities · App origins · Trust & Keys · Connectors · Marketplace · Intelligence · Audit. |
| **Home answers the wrong question** | Overview = Sync · Backups · Contents · Alerts · Approval queue (rows not clickable). It answers "is the box up?", not "what needs me?". |
| **The right health model exists and is unused** | `diagnoseRouter.global` (`packages/api/src/routers/diagnose.ts`) returns ~10 sections with `status` + plain-language `headline`. pod-admin never calls it. |
| **Approvals are scattered across 5 places** | Audit→Approval queue, Trust & Keys→Issuers, App origins→Needs review, `/approve-agents`, capability approvals (nowhere in pod-admin). |
| **Vocabulary collisions** | "Connection" = 4 things (D2). Entities tab vs `person` kind vs People tab. |
| **Every page hand-renders** | No shared object renderer. `/open` builds `detailRows` by hand; `formatRelative` ×6; API-key UI ×3; tab-sync pattern ×3. 35k LOC, largest page 1660 lines (`intelligence`). |
| **Operational kinds bounce to desktop** | `/open` hosts only `entity` + `view`. `session`, `run`, `automation`, `playbook`, `capability`, `agent` all bounce to `synap://` — exactly the things an operator needs to inspect from a phone. |

What the live pod says *right now* (none of it visible on Overview):

- status **degraded**, 7 areas need attention
- **15 proposals pending, oldest 8 days**
- **13 capabilities awaiting approval, 0 approved**
- "AI Dev Session" playbook: **10 failed runs** in 7 days
- **17 sessions stuck** > 24h; 32 automations never ran; 33 kinds with no records

That list *is* the dashboard. We just don't render it.

## 3. Eve overlap — decide the split once

The Eve dashboard (`hestia-cli/packages/eve-dashboard`) already built Inbox,
Pulse, Data, Agents, Marketplace on the **same stack** (HeroUI 2.4, lucide
0.441, Next) plus the renderers we need (`@eve/fields`,
`@eve/profile-renderer`, `@eve/view-renderer` — mirrors of synap-app
packages). But Eve only exists on self-hosted installs.

**Split by layer, not by feature:**

- **Pod Console (pod-admin)** owns everything about the *pod*: review,
  health of runs/sessions/automations, data browse, agents/apps/keys,
  sources, extensions, people, security. Works for managed and self-hosted.
- **Eve** owns the *host*: Docker components, Traefik/DNS, doctor/repair,
  local AI runtimes. Its Inbox/Data/Agents should deep-link into the
  console rather than re-implement them.

## 4. Information architecture

Grouped left sidebar (Cloudscape/Vercel/Stripe pattern; collapses to a
bottom sheet on mobile). Nouns come from `OBJECT_KINDS`
(`packages/types/src/vocabulary/object-kinds.ts`) — same icon, colour and
label as browser/relay.

```
Home                      what needs me · health · recent activity
Review                    ONE queue: proposals, agent keys, app requests,
                          issuers, capability approvals — filter by type
─ Operate
  Sessions & Tracks       open / stuck / owing grade
  Automations             active / never ran / failing
  Playbooks & Runs        run history, failures, retry
─ Data
  Workspaces              + projects as a filter, not a peer
  Kinds                   profiles: fields, record counts, unused
  Records                 search + purge (today's Entities, demoted)
─ Access
  Agents                  who acts on the pod; scorecard from diagnose.agent
  Apps                    what connects IN (today: App origins + apps)
  Keys & Devices          API keys, computers, OAuth grants
  People                  members, roles, invites
─ Extend
  Sources                 what the pod reaches OUT to (connectors)
  Intelligence            AI providers, models, defaults
  Marketplace             + installed packages, capabilities, skills
─ Pod
  Security                trust (issuers), recovery, your sign-in
  Backups & Sync
  Audit log
```

Rules carried over from D1: never place an admin route under `/open`,
`/proposal*`, `/connect*` (they're self-service in `proxy.ts`); update
`CATEGORY_META` in the same commit as any rename; old URLs get 308s.

## 5. Home — the page that sells the pod

Three bands, top to bottom, all from existing procedures:

1. **Status line** — one sentence: "All good" or "3 things need you".
   Source: `diagnose.global().status/summary`.
2. **Needs you** — a ranked list (max ~7), each row = icon + plain sentence
   + one primary action, inline where safe:
   - "15 changes waiting for review · oldest 8 days" → Review
   - "13 capabilities installed but switched off" → approve batch
   - "AI Dev Session failed 10× this week" → open run, see reason
   - "17 sessions running > 24h" → close / resume
   Source: the `diagnose` sections with `status != ok`, each mapped to a
   console route. Sections that are `ok` collapse into a single "N checks
   passing" chip (progressive disclosure).
3. **Pod at a glance** — workspaces, top kinds with counts (`orient.topKinds`),
   agents active today, backups/sync as small status pills. Today's Overview
   cards shrink into this band.

Non-admin members get the same Home scoped to their own items (their
review queue, their keys, their sessions) — `diagnose` is already
user-floored.

## 6. One object renderer, three depths

Every object page and receiver page uses one layout:

```
[icon] Title                          [status pill]   [primary action]
One sentence: what this is and what it does.            ← always
────────────────────────────────────────────────────────
Overview | Activity | Access | Settings | Advanced      ← tabs per kind
```

- **Depth 1 (default):** the sentence + 3–6 key fields.
- **Depth 2:** tabs — activity (audit/runs), access (grants via
  `resolveHolderAccess`), settings (`ConfigForm`).
- **Depth 3 — Advanced:** ids, raw JSON, governance reason codes, the
  `diagnose(id)` explanation.

Driven by data we already have, not per-page JSX:

| Need | Source |
|---|---|
| Icon, colour, noun | `resolveObjectIdentity` (vocabulary) |
| Fields + how to show them | profile `PropertyDef` + `property-hints` `displayAs` |
| Per-kind custom view | `renderer-binding-service` (`RendererRef`, incl. `declarative` blocks) |
| "Why is this in this state" | `diagnose({ id })` |
| Proposal reasons in words | `governance-policy-sentences.ts` (not used by `ProposalReview` today) |
| Lists, filters, columns | `renderables/views.ts` view definitions (table/list) |

Then widen `/open` `HOST_TYPES` to the operational kinds: `session`, `run`,
`automation`, `playbook`, `capability`, `agent`, `workspace`, `project`
(read + safe actions). Keep bouncing authoring-heavy kinds: `document`,
`cell`, `channel`.

**The blocking dependency:** the React field/profile renderers live in
synap-app (`@synap-core/heroui-fields`, `@synap-core/profile-renderer`);
Eve already carries a hand-synced mirror. A third mirror is the wrong
answer. Publish them (or move the headless parts into `packages/types` and
keep the HeroUI skin thin in pod-admin).

## 7. Sequencing

| # | Slice | Size | Why first |
|---|---|---|---|
| 1 | **Home on `diagnose`** + clickable queue rows | S | Biggest first-impression win; zero new backend |
| 2 | **Unified Review** (5 approval sources → one queue, typed rows) | M | Turns scattered approvals into one habit |
| 3 | **Sidebar IA + vocabulary** (§4, 308s, `CATEGORY_META`) | M | D1 option D, now with a target shape |
| 4 | **Object page + shared renderer** (publish fields/profile packages) | L | Unblocks every page below; kills hand-rolled rows |
| 5 | **Operate pages** — Sessions, Automations, Runs, Capabilities; widen `/open` | M | The operational core that doesn't exist yet |
| 6 | **Eve convergence** — Eve's pod surfaces deep-link to console | S | Removes the duplicate |
| 7 | Hygiene: `formatRelative`×6, API-key UI×3, tab pattern×3, AA contrast (D6.4) | S | Falls out of 3–4 |

## 8. Decisions needed from the owner

1. **Renderer packaging** — publish `heroui-fields` / `profile-renderer`
   from synap-app, or move headless field logic into `packages/types`?
2. **Eve's Inbox/Data/Agents** — retire in favour of console deep links?
3. **Member Home** — do non-admin members get a scoped console, or only the
   receiver pages they have today?
4. **Name** — keep "Pod Admin", or "Pod Console" / "Console" (admin reads as
   "not for me" to a solo owner)?
