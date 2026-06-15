# Workspace-as-Lens Consolidation Plan

> **Principle:** A workspace is a **lens** (an optional filter you apply or remove), **not a blocker** (a required key without which the system fails). `workspaceId = null` is a _valid, first-class state_ — pod-wide capture, onboarding before any workspace exists, agents acting pod-wide, and cross-workspace surfaces (Eve OS) all legitimately have no workspace. Filtering is by **user**; the workspace only _narrows_.
>
> Origin: the capture widget "Something went wrong" 500 (2026-06-15) — `getAccessibleProfiles(userId, workspaceId ?? "")` bound `""` into a `uuid` column. That was one symptom of a systemic seam. This plan resolves the whole class, centrally.

## The root: a type-honesty failure

A signature of `workspaceId: string` (non-null) declares "no workspace" _illegal_. Callers that legitimately have no workspace then smuggle it past with `?? ""`, and the lie surfaces as `invalid input syntax for type uuid: ""` at the database. **The fix is not more guards — it's making absence representable** (`string | null`, `null` = no lens) and resolving visibility through one seam that is null-safe by construction.

## Two regimes coexist (the diagnosis)

|                | **Lens regime (canonical)**                                                                                                                              | **Scope regime (legacy)**                                                                                         |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Mechanism      | `userVisibleWhere` → `scopedDb` → `access/registry.ts`                                                                                                   | hand-rolled `where(eq(table.workspaceId, x))`                                                                     |
| Rule           | `workspaceId IS NULL (globals) OR ∈ user's workspaces`, by **user**                                                                                      | `workspaceId = <required>`                                                                                        |
| Null workspace | valid → globals + everything I'm in                                                                                                                      | unrepresentable → `?? ""` → crash                                                                                 |
| Examples       | entities, notifications, automations, channels, artifacts, playbooks, links… (11 registered) + property-defs & knowledge-keys repos (3-state, exemplary) | `getAccessibleProfiles`, `relationDef.list`, `role.findByWorkspace`, 4 insert sites, hub `/profiles` & `/capture` |

The newer code already embodies "lens not scope" (it's even written down in the `workspace_as_lens` principle and the `.list`/`.listAll` backend rule). The legacy repos/routes predate it. **Every finding below is the seam between the two.**

---

## P0 — LIVE DEFECTS found during the audit (fix immediately; not just plan)

These are real bugs in the deployed code, same root as the capture crash. All in the clean backend tree.

### P0.1 — 4 more crash-on-empty sites (`""` → uuid insert) — **HIGH, trivial fix**

Fix shape: `?? ""` → `?? null` (all are _nullable_ uuid columns; `null` = pod-wide). Mirrors already-correct code in the same files.

1. `api/src/routers/hub-protocol/linking.ts:114` — `linkEntity` → `channelContextItems` insert. **Linking anything to a personal/pod-wide channel (workspaceId null) crashes.** (Line 161 in the same file already does `?? undefined` correctly.)
2. `api/src/routers/hub-protocol/linking.ts:205` — `linkDocument` → same insert, same crash.
3. `database/src/utils/sync-materializer.ts:410` — `materializeDocument` → `documents` insert. **Dual-pod sync of any workspace-less document crashes.** (Sibling entity path at :320/:368 already correct.)
4. `database/src/utils/sync-materializer.ts:456` — `materializeRelation` → `relations` insert. Same for synced relations.

### P0.2 — `getAccessibleProfiles` workspace-less crash — **DONE (2026-06-15)**

`profile-repository.ts` now guards `hasWorkspace = Boolean(workspaceId)` → SYSTEM+USER fallback. NEEDS-DEPLOY (`@synap/database`).

### P0.3 — cross-workspace READ LEAK in hub knowledge — **HIGH security**

`api/src/routers/hub-protocol/rest/knowledge.ts` `list` (`workspaceId = query.workspaceId ?? authUserId`) and `search` (~:240) pass a **caller-supplied** `query.workspaceId` to `knowledgeKeysRepository.list({ workspaceId })` with **no membership check** — only the `hub-protocol.read` _capability_ is verified, not that the agent key's user belongs to that workspace. An agent key scoped to one workspace can read **any** workspace's knowledge keys. (Facts are fine — user-scoped.) **Neither tripwire catches this: the read tripwire scans only tRPC `routers/`, never hub Hono routes; the write-gate tripwire ignores reads.** Fix: membership-check `query.workspaceId` against the agent user (or route through `AccessContext.agent(ctx)` + `scopedDb`).

---

## P1 — Repo null-safety (make absence representable)

Only **3 reader surfaces** are true legacy-hard-scope (everything else is already-lens or a legit workspace-bound write):

- **`getAccessibleProfiles`** — done (P0.2). Follow-up: drop the two `?? ""` coercions at `profile-resolution-service.ts:180,229` → pass nullable through (cosmetic now, but removes the anti-pattern tell). 12 call sites unaffected.
- **`relationDef.list(workspaceId: string)` / `.getBySlug`** (`relation-def-repository.ts:88,103`) — the OR-with-globals logic is already correct; only the **signature is null-unsafe**. Change to `string | null` (`null` ⇒ globals-only, drop the `eq` branch). ~5 call sites. Low-risk, mechanical.
- **`role.findByWorkspace`** (`role-repository.ts:101`) — hard scope, no globals union; split from `findGlobalRoles`. Migrate null-safety; **decision gate:** RBAC is workspace-bound by nature — confirm whether role reads should become a user-lens (all my workspaces + globals) or stay single-workspace before widening.

**Reference implementations to copy (already correct — do not touch):** `property-def-repository.ts` and `knowledge-keys-repository.ts` both use the 3-state convention (`undefined`=unfiltered · `null`=base/globals only · `string`=overlay). This is the target shape.

---

## P2 — Over-blocking procedures (lens mis-implemented as tollgate)

Reads/pod-wide actions that reject `null` workspace though the repo already tolerates it. Ranked by impact (top two break the V0 "Bring Your Own Agent" promise):

| #   | Route                                                                                                                                     | Fix                                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 1   | Hub `GET /profiles` (`rest/profiles.ts:120`) — 400s without workspace → **breaks agent self-discovery** (`list_profiles` at runtime)      | drop ws requirement; pass `?? null` (repo tolerant)          |
| 2   | Hub `/capture/*` via `resolveActingContext` (`rest/_shared.ts:131`) — 400 "No accessible workspace" → **breaks pod-wide & first-capture** | optional-workspace acting context (no 400 on zero-ws)        |
| 3   | `profiles.list/get/getEffectiveProperties/getHierarchy` — `workspaceProcedure`                                                            | → `podProcedure`, pass `ctx.workspaceId ?? null`             |
| 4   | `entities.search` (`entities.ts:924`) — `workspaceProcedure` but body is already pod-scope-aware                                          | → `podProcedure` + null-guard ws branches                    |
| 5   | `intelligence.memoryFacts/searchMemory` (`:780,798`, the `workspaceId!` tell) — memory is **user-scoped**                                 | → `protectedProcedure`; resolve service without mandatory ws |
| 6   | `relation-defs.list` + hub `/relation-defs`                                                                                               | optional-ws lens + add `.listAll` sibling                    |
| 7   | `property-defs.list` (`:47`) — `workspaceProcedure` (update/delete already aren't)                                                        | → `podProcedure` (base defs when null)                       |
| 8   | `intelligence.listAllAgents` (the cross-ws variant is itself ws-gated)                                                                    | make the `.listAll` variant `protectedProcedure`             |

**Missing `.listAll` siblings** (Eve-OS/agent cross-workspace stranded): relation-defs, property-defs, intelligence agent-registry reads, `cells.listInstalled`, `skills.listTriggers`.

**Legit-required (leave):** all `create/update/delete` of workspace-scoped resources, channel/project/membership mutations, `purgeWorkspaceData`, profile grant/revoke.

---

## P3 — Structural: one seam + a tripwire (prevent regression)

1. **Register the clean-fit tables** in `access/registry.ts` as `workspace` rules (mechanical, removes hand-rolled unions): `relationDefs`, `widgetDefinitions`, and opportunistically `inboxItems`, `skills`, `focusSessions`, `secretsVault`, `webhookSubscriptions`, `aiProviderCredentials`, `intelligenceCommands`, `agentConfigs`.
2. **`profiles` needs a CUSTOM rule** — its visibility is a 4-way `scope` enum (SYSTEM/WORKSPACE/USER/SHARED) + a `profile_workspace_access` grant join, which the plain `workspace` rule cannot express (it would silently drop USER & SHARED or leak). Add a `{ kind: "custom"; predicate }` variant (or a `profile` variant) wrapping the existing `ProfileRepository` logic. Same caveat for `propertyDefs` (profileId × workspaceId 3-layer) — register only if the rule can express the overlay, else leave encapsulated and document why (like `entityTemplates`).
3. **Close the tripwire blind spot:** there is **no tripwire guarding hub-protocol REST reads** for cross-workspace visibility (P0.3 lives in that gap). Extend a tripwire to scan `hub-protocol/rest/*` Hono reads, and add a lint/tripwire for the coercion tell: **`workspaceId ?? ""` (or `|| ""`) bound into a query** — declaration-or-throw, the same discipline the access layer already uses.

---

## P3 FOUNDATION — BUILT (2026-06-15, verified: api tsc 0, 19/19 access tests)

The decisions (pod-wide kept · option B dynamic routing · layered RBAC · zero-workspace first-class · one central handler) are now expressed in the access layer. Four surgical extensions, all backward-compatible (lens defaults to user-wide = prior behavior, so the 11 already-registered tables are unchanged):

1. **`workspaceLensWhere(col, userId, lens?)`** (`utils/user-visible-where.ts`) — the 3-state lens over the user floor: `undefined` = all my workspaces + globals (pod-wide view) · `null` = globals only · `"<id>"` = that workspace + globals, **intersected with the user floor** so a stale/forged lens can only narrow, never widen.
2. **`AccessContext.workspaceLens` + `.withLens(id)`** (`access/context.ts`) — opt-in lens; a context with no lens stays user-wide. This is the dynamic routing: one read path, the presence of a lens decides the breadth (no twin `.list`/`.listAll`).
3. **`workspaceOwned` rule** (`access/visibility.ts`) — `eq(userColumn, userId) AND workspaceLensWhere(...)`. The **user floor for private data**, so a `NULL`-workspace (unfiled) row is visible only to its owner, never pod-wide. (Decision #1's safety half.)
4. **`custom` rule** — `predicate: (access) => SQL`, lens/user-aware, for tables a uniform rule can't express (`profiles`, `propertyDefs`, `events`).

RBAC layering (decision #3) now falls out for free: a `workspace`-ruled `roles` read with a lens returns global roles (`NULL`, the base) + that workspace's roles (the override); the shadow-merge is an app-layer concern (like `getEffectiveProperties`).

### Migration recipe (per table — now mechanical)

1. Pick the rule kind: **shared config/containers → `workspace`** · **user-private data → `workspaceOwned`** · **odd shape → `custom`**.
2. `registerVisibility({ table, query: () => db.query.<t>, rule })` in `access/registry.ts`.
3. Replace the router's hand-rolled read (`repo.list(workspaceId)` / `db.query.<t>.findMany({where: eq(ws,…)})`) with `scopedDb(AccessContext.from(ctx).withLens(ctx.workspaceId)).findMany(table, {...})`.
4. Delete the now-dead bespoke scoping method/branch on the repo (keep writes).
5. Verify: tsc + the read tripwire goes green for that route.

### Per-table rule assignment (from the audit)

| Rule                                      | Tables                                                                                                                                                                                                    |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace` (shared lens)                 | **relationDefs**, **widgetDefinitions** (next), + inboxItems, skills, intelligenceCommands, agentConfigs, webhookSubscriptions, aiProviderCredentials, secretsVault, focusSessions(config part)           |
| `workspaceOwned` (private + userId floor) | **entities**, documents, backgroundTasks, apiKeys, messagingAccounts, sourceConfigs, focusSessions(if user-private)                                                                                       |
| `custom`                                  | **profiles** (4-way scope enum + `profile_workspace_access` EXISTS) · **propertyDefs** (profileId×ws 3-layer) · **events** (workspace in JSONB; or justified allowlist) · entityTemplates (includePublic) |
| `user`                                    | knowledgeFacts                                                                                                                                                                                            |

**Pre-existing finding (not from this work):** `events.ts::aggregateTimeSeries` trips the read tripwire — safe by discipline (`searchEvents` floors by `userId`, `input.workspaceId` is membership-checked) but not by structure. Resolve via a `custom` rule or a justified allowlist entry when migrating events.

## Sequencing

1. **P0 now** — 4 crash fixes (`?? "" → ?? null`) + ship P0.2 + the knowledge-keys leak fix. Real defects, clean tree, low-risk, high-value. _(P0.1 + P0.3 done this turn; see commit.)_
2. **P1** — repo null-safety (relationDef signature, role decision-gate).
3. **P2** — over-blocks, prioritising the two agent-path breaks (hub `/profiles`, `/capture`).
4. **P3** — registry registration + custom profile rule + the two tripwires (lock it so it can't regress).

P0–P1 are backend-only, low blast radius. P2 touches procedure builders (coordinate with any active capture/agent work). P3 touches the shared access layer — stage deliberately.
