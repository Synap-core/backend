# Pod Console — structural plan & decisions (wave 2+)

> Companion to `POD-ADMIN-CONSOLE-PLAN.md` (direction). Wave 1 shipped on
> `claude/clever-pascal-4v8992`: Home on `diagnose`, shared
> `lib/format.ts` / `PageHeader` / `UrlTabs`, invite expiry, proposal
> "why", API-keys focus receiver. This file is what the five research
> lanes found and the calls that need the owner before wave 2 code.
> Every claim was traced to `file:line` by the research lanes; the key
> ones are repeated here. Eve/hestia convergence is explicitly out of scope.

---

## 0. Corrections to the direction doc (research overturned these)

| Plan said                                                  | Reality                                                                                                                                                                                                                                                                                                              | Consequence                                                              |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| "Publish `heroui-fields` / `profile-renderer`" (§6)        | `heroui-fields` was merged into `@synap-core/web/entity-card`; `profile-renderer` lives in `@synap-core/hooks`. Shared web UI is spatial-ui CSS + React Aria, and app-bases forbids `@heroui/react` in shared code (`app-bases/CLAUDE.md:95`). The packages are private, source-only, linked across 3 repos.         | Publishing is L–XL and imports a foreign visual system. See **D3**.      |
| "Review = build one queue" (§4)                            | It already exists: `signals.list({lens:"needs-you"})` + `signals.count` (`packages/api/src/routers/signals.ts:1190-1323`) merge proposals, unread asks, owed human slots, sessions awaiting review — floored, ranked, read by browser and relay. pod-admin never calls it.                                           | Review **extends** `signals`. See **D2**.                                |
| Nouns: Workspaces, Automations, Playbooks, Records, People | Registry words: **Spaces, Rules, Templates, Entity/Thing, Members** (`packages/types/src/vocabulary/object-kinds.ts`); "People" is the contact kind                                                                                                                                                                  | Nav labels come from the registry. See **D4**.                           |
| "Apps" at `/apps`                                          | `/apps/*` is self-service in `proxy.ts:101`; `apps.*` is self-scoped. Only `applicationConnections.list` is admin-wide.                                                                                                                                                                                              | An admin Apps list needs a backend procedure.                            |
| Forbidden admin prefixes: `/open`, `/proposal`, `/connect` | Also `api*`, `login*`, `recovery*`, `forbidden*`, `setup*`, `invite*` — the proxy **matcher** (`proxy.ts:44`) excludes them by prefix with no trailing slash, so `/api-keys` or `/invites` would skip auth entirely — plus `apps/`, `approve-agent*`, `connection-requests/`, `device`, `my-*`, `settings/security`. | Guarded by a route-policy tripwire in stage 1.                           |
| "13 capabilities awaiting approval" is a to-do             | `capabilities.approved` (container flag) has **no reader** on any execution path found; the real gates are the verb flags (`skills/tools/mcp_servers.approved`, `capability-registry.ts:683,996`).                                                                                                                   | The Home row may be nagging about a flag that gates nothing. See **D5**. |

## 1. Bugs found on the way (not yet fixed — need a call or a separate slice)

1. **Issuer notification never clears.** `system.issuer_pending_approval` (`setup.ts:486`) counts as a needs-you item, has no click-through, and `TrustedIssuerService.approve/reject` never mark it read (`trusted-issuer-service.ts:76-129`). It stays in browser/relay "Needs you" forever. Fix lands with D2.
2. **api-types regen drift.** `gen-types` in this environment reorders ~12 unrelated unions + changes the schema hash; the committed file was generated with a different ordering. Blocks any API-output change (it is why `apiKeys.adminListAll` still lacks `workspaceId`; lane C took the dead-code deletion instead). Fix: one clean regen commit on the canonical toolchain, then re-add the projection. **Owner action.**
3. **`/workspaces?focus=` is dead** — search-modal produces it (`search-modal.tsx:221`), the page never calls `useFocusRow`. Stage-1 fix.
4. **Search unreachable at phone width** — the TopNav trigger is `hidden md:flex`. Stage-1 fix (drawer Search row).
5. **`agentUsers.governance` has no ownership floor on `agentUserId`** (`agent-users.ts:651-705`) — inference: any member can read any agent's posture. NEEDS-VERIFY → security slice.
6. **`diagnose.agent` / `agentProfile` are owner-floored** — a pod admin can't see another member's agent scorecard.
7. **Audit "Approval queue" ignores `viewerCanReview`** — lists rows the viewer can't decide, with raw type tokens (`approval-queue-section.tsx:57,326-375`). Superseded by Review.

## 2. Decisions

Each has a recommendation; pick or override.

### D1 — Who does the console see: the owner's lens, or the whole pod?

Every Operate read is user-floored (`protectedProcedure` + `userVisibleWhere`); writes to pod-wide rows (`automations.activate/pause/trigger`, `containers.update`) pass only for the row's **creator** (`workspace-write-access.ts:57-65`). On a single-owner pod this is invisible; on a multi-member pod an admin sees and can act on less than "the pod".

- **(a) Keep user-floored** — honest, zero backend. Home says "your lens".
- **(b) Admin widening, reads only** — `isPodAdmin` branch on `diagnose.global`, `automations.listPage`, `capabilities.containers.list`, `focusSessions.browse`.
- **(c) Reads + writes on pod-wide rows for admins** — (b) plus admins pass `assertWorkspaceWrite` on null-workspace rows.
- **Recommend (a) now, (c) as one backend slice before multi-member pods ship.** It widens disclosure, so it's your call.

### D2 — Review: extend `signals` (recommended) vs client fan-in vs new `review.list`

- **Recommend extend `signals`**: two admin-only `settle()` halves (pending trusted issuers; pending app-connection requests), class `access`, routed through `floorLens`; a `kinds?` filter; drop the issuer notification from the union once the table half exists (fixes bug 1). Browser/relay get the rows for free (they need a generic "Open in console ↗" verb).
- Client fan-in = Eve's mistake (counts drift from browser/relay badges). A new `review.list` = a second attention door.
- **Never queue** device-flow approvals (RFC 8628: approving a code you didn't type = consent phishing) or OAuth consent; invites belong to the invitee.
- UI: `/review` (admin-gated), chips **Access · Changes · Asks**, one "Review" action per row, inline Approve only for non-access, non-removal proposals where `viewerCanReview`; batch only within Changes; "Always approve" only from the drawer. Drawers reuse `ProposalReview`, `PendingAccessBlock`, the issuer scope picker, `ConnectionRequestReview` (without its `returnUrl` redirect). Audit's queue tab, Origins' "needs review" block and the Home queue card become links into Review.

### D3 — Object rendering: where does the field logic live?

- **(b) Recommended: move the headless logic down into `packages/types`** (`classify-property`, `entity-field-plan`, pure parts of `kind-card-model`, `fieldFormatters`/`statusSemantics` as semantic tones, `structured-value` — ~1.5k lines _moved_, not written), plus `RendererRef`/`DeclarativeBlock` from `packages/database` into types. Thin HeroUI skin in pod-admin (~500 lines: `ObjectHeader`, `FieldList`, `RelationsSummary`, `ActivityList`, `AdvancedPanel`, `DeclarativeBlocks`). Same precedent as `types/lens/page-model.ts`. App-bases follow-up re-points its imports (web 20 files, relay 5, browser 1).
- (a) publish app-bases — L–XL, foreign visual system, second tRPC provider. (c) mirror — rejected: Eve's mirror already points at a package that no longer exists, and `RendererRef` has drifted three ways (backend 8 kinds, app-bases 7, Eve 5). (d) keep hand-rolling — multiplies today's duplication.
- **Needs a cross-repo PR in app-bases** — confirm you want that.

### D4 — Navigation, routes, vocabulary

**Shell:** grouped left sidebar replaces the 10-pill tab strip (224px → 56px icon rail at md → left drawer with a Search row on phones). One pure config `lib/console-nav.ts` drives sidebar, ⌘K labels, `next.config` redirects, and Home's diagnose-section exits (`DIAGNOSE_DESTINATION`) so nothing can drift. Badges = actionable counts only, from the same `diagnose`/`signals.count` queries as Home.

**Groups and labels (registry words):**
Home · Review · _Operate:_ Sessions, Rules, Runs, Templates · _Data:_ Spaces, Kinds, Entities · _Access:_ Agents, Apps, Keys, Members · _Extend:_ Sources, Intelligence, Marketplace · _Pod:_ Pod security, Backups, Audit log.
Personal pages (`/my-connections`, `/my-vault`, `/settings/security` "Security") go in the avatar menu — today nothing links to them.

**Route moves (staged, recommended option B):**

1. Sidebar + nav config + labels + route-policy tripwire at **current** URLs; fix bugs 3–4.
2. Each new page ships at its final URL; splits move with it: `/audit?section=queue|proposals` → `/review`; agents out of `/people` → `/agents`, humans → `/members`; `/trust-keys` → `/keys` (api-keys) and `/security` (issuers trusted list, secrets inventory); Failed AI turns out of `/intelligence` → `/runs`.
3. Pure renames: `/connectors` → `/sources`, `/overview` → `/home`.
4. After dogfood: 307 → 308 (308s are cached forever by browsers; don't use them while experimenting). Update app-bases' `PodConnectionRecoveryScreen` copy + `/trust-keys` link; check synap-cp for console links.

Blast radius is small: **no backend, MCP, email or skill emits an admin-tab URL**; every backend producer targets self-service receivers that do not move.
Open choices: "Rules" vs "Automations" for automations (registry says Rule; browser governance calls trust rules "Approvals" — keep Review ≠ Approvals); "Entities" vs "Things" (registry vs concepts doc disagree — vocabulary owner decides).

### D5 — Capabilities approval flag

- **(a)** `capabilities.approved` is meant to gate execution → wire the gate, keep the Home row, add batch approve on the Capabilities page.
- **(b) Recommended if confirmed unused:** drop the container count from `diagnose` and count the verb flags instead; the Capabilities page toggles verbs via `setToolEnabled`.
- Until decided, Home's "13 capabilities switched off" row may be noise.

### D6 — `/open` hosting on the web (operational kinds)

Hosting a kind on the web needs **four** coordinated changes, not one: `open-params.ts` HOST/BOUNCE, the frozen copy in `open-kinds.lock.tripwire.test.ts`, `apps/api/src/open-dispatch.ts` (human redirect only sends entity/view today), and the bare `/open/:id` probe (MCP `ok()` links every tool result to `/open/<id>`; untyped ids bounce). Recommended: bare untyped ids redirect humans to a new pod-admin `/open/<id>` page that calls `diagnose.resolveOpen` with the cookie (keeps type lists out of the public route). Also: every `openIn({kind:"object"})` caller whose label says "desktop app" must switch to `objectInApp`.
Order: **automation** (pause is de-escalation, safe) → **session** (cancel/rerun; `?view=room` keeps bouncing) → playbook → capability → agent. **Run** waits on a flowType fix (`/open/run/<id>` carries no flowType). **Workspace** stays the admin page for admins. **Document** stays bounced (markdown render = new dependency).

### D7 — Naming

"Pod Admin" → **"Pod Console"** (admin reads as "not for me" to a solo owner). Touches root `<title>`, top bar, app-bases recovery copy.

### D8 — Members' Home

`diagnose` and `signals` are already user-floored, so a member Home is cheap. Recommend: members get Home + Review scoped to themselves; admin groups hidden. Today members only get receiver pages.

## 3. Operate pages — readiness and order (no backend change needed unless noted)

| #   | Page                  | Data                                                                                        | Actions                                    | Gap                                                              |
| --- | --------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------- |
| 1   | Capabilities (Extend) | `capabilities.compositions` (real per-container health) + `containers.list`                 | toggle verbs / approve                     | D5                                                               |
| 2   | Rules                 | `automations.listPage` (`runCount`, `failureCount`, `lastRunAt` on the row) ⨝ `runs.groups` | pause (safe), activate/trigger (governed)  | creator-only writes on pod-wide rows (D1c)                       |
| 3   | Runs                  | `runs.groups` board, `runs.list`/`runs.get` (failure reason on row)                         | cancel (playbook), "Run again" via trigger | `runs.list` has no cursor (>100 unreachable) — add keyset cursor |
| 4   | Agents                | `agentUsers.list` ⨝ `diagnose.agents`                                                       | `disconnect`                               | scorecards owner-only (bug 6); daily cap read-only               |
| 5   | Sessions              | `focusSessions.browse` (status, verdict, liveness) + `owed`                                 | close, cancel, pause/resume                | no pod-wide tracks list (`tracks.list` per project)              |
| 6   | Templates             | `playbooks.listAllPage` ⨝ `runs.groups`                                                     | link out to edit                           | authoring stays in browser                                       |
| 7   | Kinds                 | `profiles.list` + `entities.adminListProfiles` + diagnose schema sections                   | retire via `proposeRetire` → Review        | `proposeRetire` needs a workspace header                         |

Authoring (rule editor, template editor, kind editor) stays in the desktop app; the console reads, operates, and links out ("Create in app ↗").

## 4. Rules from prior art (adopted)

- One "Needs you" list first, severity then age, capped ~7 with "+N more"; group repeats ("failed 10×") into one row. Done in wave 1.
- Separate "needs a decision" from "something is broken" — different tone, different verb.
- No health score, no configurable dashboard in v1; healthy = one calm line + last-checked time.
- Fixed severity vocabulary (Home Assistant repairs): critical is rare; never badge something the owner can't act on.
- Detail pages: one header (name, status sentence, owner/source, last activity, primary action), tabs ≤1 level, Advanced last and collapsed, dangerous actions at the bottom with an impact preview.
- Approvals: diff/plain "what will change", reject-with-reason fed back to the agent, batch only within one risk class, never batch access, "always allow" = narrow, named, visible rules.
- Never gate local administration on a cloud account (Plex lesson); keep IA stable after launch, redirect every move.

## 5. Proposed wave order

| Wave | Content                                                                                                            | Depends on |
| ---- | ------------------------------------------------------------------------------------------------------------------ | ---------- |
| 2    | Stage-1 shell: sidebar, `console-nav.ts`, route-policy tripwire, avatar-menu personal links, bugs 3–4, rename (D7) | D4, D7     |
| 3    | Review on `signals` (backend halves + `/review` + drawers), retire duplicate queues, fix bug 1                     | D2         |
| 4    | Operate: Capabilities, Rules, Runs (+ `runs.list` cursor)                                                          | D1, D5     |
| 5    | `packages/types/property-render` move + console skin + `/open` hosting for automation & session                    | D3, D6     |
| 6    | Agents, Sessions, Templates, Kinds; route stages 2–3                                                               | D1         |
| —    | Owner: clean api-types regen commit (bug 2)                                                                        | —          |
