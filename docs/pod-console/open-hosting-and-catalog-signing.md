# R3 — `/open` hosting for the remaining operational kinds · signing Synap's own catalog

Research lane, read-only. Base: backend `claude/clever-pascal-4v8992` @ c89a1f0a3. Paths relative to this repo unless absolute.

---

## A. Host run / playbook / capability / agent on the web `/open`

### A.0 State today (verified in code)

`/open` is web-hosted for `entity, view, automation, session`, and every other typed kind bounces to `synap://`. D6's "four coordinated places" are already wired, and the bare-id half of D6 has shipped:

| #             | Place             | file:line                                                                                                                                                                                                                                                                                                                                                                                    | Today                                                                    |
| ------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 1             | pod-admin parser  | `apps/pod-admin/app/open/open-params.ts:18` (`HOST_TYPES`), `:22-36` (`BOUNCE_TYPES`), `:66-68` (host kinds require a uuid)                                                                                                                                                                                                                                                                  | 4 host, 13 bounce                                                        |
| 2             | frozen lock       | `apps/api/src/open-kinds.lock.tripwire.test.ts:17-37` (frozen copies), `:54-58` (HOST == `WEB_HOSTED_OPEN_KINDS`), `:60-67` (HOST ∪ BOUNCE == `TYPED_OPEN_KINDS`), `:132-141` (`TYPED_OPEN_KINDS ⊇ EMITTABLE_LABELS`, parsed from `resolve-browser-route.ts`)                                                                                                                                | green                                                                    |
| 3             | public dispatcher | `apps/api/src/open-dispatch.ts:27-64` (`TYPED_OPEN_KINDS`; the run note at `:59-63`), `:110-115` (`WEB_HOSTED_OPEN_KINDS`), `:128-135` (`podAdminTarget`, which builds the path only and carries no params), `:155-166` (`podAdminBrowserUrl`), `:230-274` (`dispatchOpen`: hosted kinds 302 humans; bots and `?client=mobile` bounce; `?view=` is the only forwarded param, `:207`, `:272`) |                                                                          |
| 4             | bare `/open/<id>` | `apps/api/src/index.ts:691-765` (the public probe types only proposal, entity and view; every other uuid 302s to the pod-admin resolver via `podAdminResolveTarget`, `open-dispatch.ts:143`) → `apps/pod-admin/app/open/[type]/page.tsx` + `resolve-open.tsx:71` (`diagnose.resolveOpen`, `packages/api/src/routers/diagnose.ts:82`) → `open-model.ts:66-72` `openPathForResolved`           | **already done** (D6's "recommended" bare-id page exists)                |
| 5 (not in D6) | the exit door     | `apps/pod-admin/lib/open-in.ts:104` `WEB_HOSTED_OBJECTS = new Set(HOST_TYPES)`; `:276` sends `openIn({kind:"object"})` to the web for hosted kinds                                                                                                                                                                                                                                           | derived, so it follows automatically. Each caller must be audited (A.5). |
| 6 (not in D6) | routing           | `apps/pod-admin/app/open/[type]/[id]/OpenSurface.tsx:61-71` (the switch over host kinds), `apps/pod-admin/app/open/_views/*.tsx` (one thin file per kind)                                                                                                                                                                                                                                    |                                                                          |

The pattern to reuse is the one rules and sessions already follow: one object body per kind, drawn in two frames. `ObjectFrame` (`apps/pod-admin/app/_lib/object/views/object-frame.tsx:24-42`) has two implementations: `consoleFrame(list)` (`:48-87`) and `OPEN_FRAME` (`apps/pod-admin/app/open/open-shell.tsx:100-107`). `AutomationObject` (`_lib/object/views/automation-object.tsx`) is drawn by `/rules/[id]` (`(admin)/rules/[id]/page.tsx:27`) and by `/open/automation` (`open/_views/automation-view.tsx:13`). `SessionBody` follows the same split.

**Live bug found (run flowType is dropped on the web path).** The resolver already knows a run's flowType. `resolve-browser-route.ts:145-146` projects `automation_run` and `playbook_run` to `{label:"run", params:{flowType}}`, and `resolve-open-target.ts:38-39,82` returns `params`. But pod-admin's `ResolvedOpen` (`open-model.ts:25-31`) has no `params` field, and `openPathForResolved` (`:66-72`) emits `/open/run/<id>` without them. `BounceView` then hands `synap://open/run/<id>` to the app, and the app defaults to `automation` (`browser/electron/renderer/src/navigation/object-nav.ts:633`). So today, any MCP `ok()` link to a playbook-run id (`packages/api/src/routers/mcp/handlers/shared.ts:207`, `openLink(id)`) that a human opens in a browser lands on the wrong reader. The desktop path is correct, because `deepLinkDecision.ts:230` merges the resolver's params. This can be fixed independently of hosting (phase A1).

### A.1 Per kind: the body to reuse, the doors it needs, member vs admin

| Kind                      | Existing console body                                                                                                                                                                     | Read doors (floor)                                                                                                                                                                                                                                       | Acts on the page (floor)                                                                                                                                                                                                                                                                                        | Member vs admin on `/open`                                                                                                                                                                                                                            |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **run**                   | `(admin)/runs/_lib/run-drawer.tsx` (300 lines, a `DetailDrawer`, not an object page). `RunTarget` needs `{flowType,id}` (`:33-38`). Also opened from `/rules/[id]` and `/templates/[id]`. | `runs.get({flowType,id})`, protected, user-floored (`packages/api/src/routers/runs.ts:165-176`). `flowType` is a 7-value enum (`runs.ts:39-47`).                                                                                                         | cancel a playbook run: `playbookRuns.cancelRun` (person-only). Run again: `automations.trigger` (governed; may come back `proposed`).                                                                                                                                                                           | Same page for both. The resolver floors on `userVisibleWhere(workspaceId)` (`resolve-object-kind.ts:294-322`).                                                                                                                                        |
| **playbook**              | `(admin)/templates/[id]/page.tsx` (346 lines, `consoleFrame` inline, not extracted)                                                                                                       | `playbooks.get` (scopedDb, user-floored, `playbooks.ts:1743`), `runs.groups`/`runs.list` (protected). **But `workspaces.adminListAll` is `podAdminProcedure`** (`templates/[id]/page.tsx:75`, `workspaces.ts:1090`), so it 403s for a member.            | `playbooks.archive` (may route to review). No "Run now" (needs the inputs form).                                                                                                                                                                                                                                | Body works for members only after the space-name read moves to `workspaces.list` (or `adminListAll` is only enabled for admins).                                                                                                                      |
| **capability**            | **None.** The console only has list rows (`(admin)/marketplace/_lib/installed-tab.tsx`, tools toggles in `tools-tab.tsx:58` `capabilities.setToolEnabled`).                               | `capabilityContainers.get` (protected, `userVisibleWhere`, `capability-containers.ts:125`) plus the catalog card status                                                                                                                                  | Enable a verb: `capabilities.setToolEnabled` / `skills.setApproved`, **workspace-owner only** (`services/capabilities/set-skill-approved.ts:43`). Connect an account: Nango Connect, **not on the web** (pod-admin has no Nango frontend; `connectors.session` exists server-side at `connectors-trpc.ts:476`). | Member sees state plus "Ask an owner" / "Connect in app". Owner sees toggles. This is the highest-traffic link (`openTypedLink("capability", id)` on every "not enabled / not connected" refusal, `services/capabilities/capability-enable-link.ts`). |
| **agent**                 | `(admin)/agents/_lib/agent-drawer.tsx` (509 lines, drawer)                                                                                                                                | `diagnose.agent` scorecard, **owner-floored** (`services/diagnose/agent-scorecard.ts:218`). `agentUsers.governance` (agent / owner / admin). The resolver's agent probe is also **owner-floored** (`resolve-object-kind.ts:326-345`, `createdByUserId`). | `agentUsers.disconnect` (owner or pod admin, `agent-users.ts:1021-1023`), `removeByUserId` (`podAdminProcedure`, `:1341`)                                                                                                                                                                                       | **Pod admin who isn't the creator gets "Nothing here" from a bare link** (resolver floor), and the typed page's scorecard is empty (bug 6 in DECISIONS §3). The page can only be honest for the owner until the floor is decided.                     |
| workspace                 | `(admin)/workspaces/[id]`                                                                                                                                                                 | admin                                                                                                                                                                                                                                                    |                                                                                                                                                                                                                                                                                                                 | Stays bounced. Small win: `BounceView` offers "See this space here" (`/workspaces/<id>`) to a pod admin, which `open-in.ts:225-235` already does for phones.                                                                                          |
| document / cell / channel |                                                                                                                                                                                           |                                                                                                                                                                                                                                                          |                                                                                                                                                                                                                                                                                                                 | Stay bounced (D6).                                                                                                                                                                                                                                    |

### A.2 The run flowType problem: options

| Option                                                      | How                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Cost                                   | Risk                                                                                                                                                                                |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R1. Carry `flowType` in the URL** (recommended)           | Allowlist a second forwarded param beside `view`: `OPEN_FLOW_TYPE_VALUES` in `open-dispatch.ts` (frozen copy of the `runs.ts:39` enum, lock-tested by parsing like `EMITTABLE_LABELS`). `podAdminTarget`/`dispatchOpen` append `?flowType=` on the 302 **and** on the bounce (`synap://open/run/<id>?flowType=playbook`, which the desktop already reads via `deepLinkDecision.ts`). `openPathForResolved` appends `resolved.params`. The `/open/run/[id]` page reads `searchParams.flowType`. | S–M                                    | A typo'd value has to be dropped, not forwarded (same rule as `isOpenViewValue`). The cache key varies with the query, which is fine (`private, no-store`).                         |
| R2. Resolve server-side on the page                         | `/open/run/<id>` without a flowType calls `diagnose.resolveOpen` and takes `params.flowType`.                                                                                                                                                                                                                                                                                                                                                                                                  | S                                      | The resolver only knows `automation_run`/`playbook_run`. Capture, capability, session, chat and agent_write runs live elsewhere and come back `unknown`. Adds one extra round trip. |
| R3. Make `runs.get.flowType` optional and probe in `getRun` | Server tries the flow tables in order.                                                                                                                                                                                                                                                                                                                                                                                                                                                         | M (api-types regen, tRPC input change) | A second probe list beside `resolveObjectKind`, which is the twin the resolver doc warns against.                                                                                   |
| R4. Encode flowType in the id (`playbook:<uuid>`)           |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | M                                      | Breaks `isUuid` gates, `SAFE_ID_RE`, and every producer. Rejected.                                                                                                                  |

**Recommendation: R1, with R2 as the fallback when the param is absent.** R1 is exact for producers that know the flow (console rows, `runs.list` rows carry `flowType`). R2 covers bare MCP ids, the common case, for the two run kinds the resolver types. Don't build R3.

### A.3 Architecture options for hosting

- **A-opt 1. One kind per lane, in D6 order: playbook → capability (enable only) → run → agent (recommended).** Each kind gets an extracted `XObject({id, frame})` in `app/_lib/object/views/`, a thin console route plus a thin `_views/<kind>-view.tsx`, and one line in each of the 4 lists. Per-kind cost is S–M. The risk is low: the lock fails on any half change.
- **A-opt 2. Host all four at once behind a generic "operational object" page.** One component with per-kind adapters. The diff is smaller, but it rebuilds the twin the ObjectFrame split exists to prevent, and agent and capability have different floors. Rejected.
- **A-opt 3. Host only run and playbook (read plus de-escalation); keep capability and agent bounced until their floors and doors exist.** This is the cheapest honest subset if the owner won't decide D-A3/D-A4 now.

Reuse first: `ObjectPage/ObjectHeader/FactsGrid/AdvancedPanel/DangerZone`, `run-board.ts` (`runActions`, `flowHealthPill`, `triggeredByLabel`), `template-model.ts`, `agent-roster.ts`, `installed-model.ts`, `load-failure.ts`, `OpenInAppLink` (`_lib/object/open-in-app-link.tsx`, already `objectInApp`).

### A.4 Phased build list (file ownership)

**A1 — fix the dropped run flowType (bug fix, before any hosting).** Owner: pod-admin `/open` + apps/api dispatcher.

- `apps/pod-admin/app/open/open-model.ts` (+test): `ResolvedOpen.params`; `openPathForResolved` appends allowlisted params.
- `apps/api/src/open-dispatch.ts` (+ `open-dispatch.test.ts`): `OPEN_FLOW_TYPE_VALUES`; forward `flowType` for `type==="run"` on the bounce.
- `apps/api/src/index.ts` `applyOpenDispatch` (~`:611-640`): pass `flowType: c.req.query("flowType")`. The lock test pins `client:` and `view:`, so add a `flowType` assertion in `open-kinds.lock.tripwire.test.ts` `:178-199`.
- `apps/pod-admin/app/open/_views/bounce-view.tsx`: pass the param into `OpenInAppLink` / `objectInApp`. This needs `params` on `ExitTarget` `objectInApp` in `lib/open-in.ts:112-123` and `objectLink` `:246`. Keep `exit-door.test.ts` green: still exactly one `synap://` minter.
- Update the stale comment at `open-dispatch.ts:59-63`.
- Failing-before test: resolver body `{type:"run", params:{flowType:"playbook"}}` → path `/open/run/<id>?flowType=playbook`.

**A2 — playbook.** Owner: pod-admin.

- Extract `app/_lib/object/views/playbook-object.tsx` from `(admin)/templates/[id]/page.tsx`. Swap `workspaces.adminListAll` for `workspaces.list`, or gate it on the viewer being a pod admin. `members` (`listPodMembers`) is protected and stays.
- `(admin)/templates/[id]/page.tsx` → thin `consoleFrame` wrapper. Add `open/_views/playbook-view.tsx`.
- Move `playbook` from BOUNCE to HOST in 4 places: `open-params.ts`, the lock's frozen copies, `WEB_HOSTED_OPEN_KINDS`, and the `OpenSurface` switch.
- Effects: the `open-model.test.ts:53` bounce sentence is derived, so update its expectation. In `open-in.ts:281-284`, update the "capability, playbook have no web renderer" comment.

**A3 — run.** Owner: pod-admin (+ A1 done).

- Extract `app/_lib/object/views/run-object.tsx` from `run-drawer.tsx` (the drawer keeps using it). Add `open/[type]/[id]` support for a `searchParams.flowType`: thread `searchParams` through `page.tsx` → `OpenSurface` → `RunView`. Missing or unknown flowType → R2 (`diagnose.resolveOpen`), else an honest "Can't tell which run this is" with Open in app.
- Move `run` to HOST in the 4 places. The `run` label stays in `EMITTABLE_LABELS`.
- `consoleFrame.pathFor` ignores `kind` (`object-frame.tsx:59`). A console route for runs would need `/runs/<id>?flowType=`, or keep runs drawer-only in the console and host only on `/open` (one body, two frames still holds).

**A4 — capability (enable only).** Owner: pod-admin + packages/api (`capability-enable-link.ts`, hub codec).

- New `app/_lib/object/views/capability-object.tsx`: header sentence from `capabilityNextAction`-equivalent status, verbs list with toggles for owners (reuse the tools-tab mutation), "Connect in app" (`objectInApp`) when `kind==="connect"`. Console route `(admin)/marketplace/capability/[id]` or a `?focus=` receiver. Pick one (D-A3).
- Move `capability` to HOST in the 4 places.
- **api/contract effect:** `CapabilityActionSurface` (`capability-enable-link.ts`, `"desktop"` only) gains `"web"`. `opensIn` becomes `"web"` for enable/run/none and stays `"desktop"` for connect. Touches `routers/hub-protocol/rest/capabilities-catalog.ts:144` `z.enum(["desktop"])`, `_codecs/proposal.ts:192`, `packages/api-types` regen (`generated.d.ts:11039`), and the tripwire `__tripwires__/capability-refusal-carries-enable-link.test.ts`. CLI consumers that match `opensIn` need a heads-up.
- `deep-links.ts:99` `TYPED_DEEP_LINK_KINDS` is unchanged.

**A5 — agent.** Owner: pod-admin; packages/api only if D-A4 widens the floor.

- Extract `agent-object.tsx` from `agent-drawer.tsx`. Move `agent` to HOST. Blocked on D-A4: today an admin reading someone else's agent gets "Nothing here" (resolver) or an empty scorecard.

**A6 — `openIn({kind:"object"})` caller audit (with each kind).** Once a kind is hosted, these callers switch from `synap://` to the web: `proposal/[id]/ProposalReviewCard.tsx:74`, `(admin)/review/_lib/ask-answer.tsx:173,178,187,365`, `review/_lib/review-rows.ts:107`, `members/_lib/member-drawer.tsx:37,219`, `workspaces/[id]/page.tsx:51`, `workspaces/page.tsx:325`, `runs/_lib/run-drawer.tsx:202`. Any whose label says "in app" moves to `objectInApp`. Relay table `open-in.ts:194-203` is unchanged.

**External clients.** MCP `ok()` / `openLink(id)` stays the same bare shape (`deep-links.ts:60`). Humans get the web page through the resolver, while bots and `?client=mobile` bounce as today. `capability-enable-link` output changes as noted in A4. Relay and the browser need no change, except that R1 `?flowType=` on `synap://open/run` is already read by the desktop; relay has no run route (`RELAY_OPENABLE_KINDS`).

### A.5 Gates per lane

pod-admin `pnpm test` (open-params / open-model / exit-door / cross-repo-parity), `vitest apps/api/src/open-*.test.ts`, `tsc -p apps/api`, `pnpm --filter pod-admin build`, plus `gen-types` + `gen-types:check` only for A4.

### A.6 Note for the CLI team: `opensIn` is now per action (shipped, wave 5)

A capability's `nextAction` (`GET /api/hub/capabilities/catalog` cards, the `enable` / `blocked` block on a capability refusal, and a proposal's `setup.nextAction`) carries the same `url` as before: `${PUBLIC_URL}/open/capability/<containerId>`. What changed is `opensIn`:

| `nextAction.kind`            | `opensIn` before | `opensIn` now |
| ---------------------------- | ---------------- | ------------- |
| `connect`                    | `"desktop"`      | `"desktop"`   |
| `enable`                     | `"desktop"`      | `"web"`       |
| `run`                        | `"desktop"`      | `"web"`       |
| `none` (with a container)    | `"desktop"`      | `"web"`       |
| `add`, `none` (no container) | absent           | absent        |

- The type is `"web" | "desktop"` (`CapabilityActionSurface`, `packages/api/src/services/capabilities/capability-enable-link.ts`; zod in `capabilities-catalog.ts` and `_codecs/proposal.ts`; `@synap-core/hub-rest-client` `types.ts`).
- `"web"`: a signed-in person can follow the link in any browser. The public route 302s them to the Pod Console's `/open/capability/<id>`, which shows the capability's state and lets its space owner (or a pod admin, for a pod-wide one) turn its actions on. Bots and `?client=mobile` still bounce to `synap://`.
- `"desktop"`: connecting an account still needs the desktop app (the web has no Connect flow).
- What to change: any code that matches `opensIn === "desktop"` to decide whether to print "open in the desktop app" should branch on the value. Print the link for both; add "(needs the desktop app)" only for `"desktop"`. Never build a different URL from `opensIn`.

Also new on the public route (A2): `/open/run/<id>?flowType=<automation|playbook|capture|capability|session|chat|agent_write>` keeps the flow type on the 302 and on the `synap://` bounce. Any other value is dropped. A link without it still works for automation and playbook runs, because the web page asks the resolver.

---

## B. Signing Synap's official catalog

> **Status (wave 6):** both sides are built, end to end. The pod verifies (S1, report-only by default) and the
> Control Plane signs and serves (`control-plane-api` `src/lib/catalog-signing/`). The offline ceremony tool is
> `control-plane-api` `ops/catalog-signing/`. **What is left is the founders' root ceremony** (about 15 minutes, runbook
> in `ops/catalog-signing/README.md`). Until then, `SYNAP_CATALOG_ROOT_KEYS` stays empty and pods say "not signed
> yet". B.0–B.7 are the research as written; **B.8 is the binding Control Plane contract**, and §B.8.8 records what
> was built against it.

### B.0 How the pod reads the official catalog today (verified)

- **Seam.** `catalogSources()` / `describeCatalogSources()` in `packages/jobs/src/workers/cp-catalog-sync.ts:231-272`. The official source is `id:"synap"`, `trust:"official"`, `publicKey: SYNAP_CATALOG_PUBLIC_KEY` (`:182`, **null**), and its URL is `CONTROL_PLANE_URL || CP_URL || https://api.synap.live` (`:189-195`). `SYNAP_CATALOG_SOURCE=off` locks it off (`:198`).
- **Sync.** `handleCpCatalogSync` (`:844-866`) runs every 10 minutes and on boot. Official → `syncOne(url, kind)` for capability | automation | template | cell against `/api/marketplace/capabilities`, `/api/packages?category=workflow|workspace` (paged, `includeRetired`), and `/api/marketplace/cells`. Rows are upserted into `cp_catalog_cache` **with inline `definition` for capabilities and cells** (`:686-697`). A complete fetch prunes; stamps go through `recordCatalogSyncStamp`. Third-party → `syncThirdPartySource` (`marketplace-source-sync.ts`): signed index → `verifyIndex` (`marketplace-source-verify.ts:152-265`: size, schema, source-id pin, key pin / key_changed, ed25519, expiry ≤31d, monotonic `expires` floor) → replace rows. Definitions are fetched at install and digest-checked (`verifyDefinitionBytes`, `:280`).
- **After an official sync, installed capabilities are auto-converged.** `apps/api/src/index.ts:1941-1950` → `reconcileChangedCapabilityTemplates()`. **The official catalog is an auto-update channel into running pods.** That is the main reason to sign it.
- **Other unsigned official reads that a signed index must also cover:** install by key `services/capabilities/marketplace-install.ts:247-248,308-330` (`/api/packages/:slug[/:version]`, `/api/marketplace/cells?q=`), `services/capabilities/cp-template-client.ts:64,131,172` (`/api/marketplace/capabilities[/:key]`), `services/capabilities/resolve-workspace-template.ts:148-151`, `utils/tier-check.ts:106`, `routers/cells.ts:85`, and the legacy `jobs/src/workers/capability-template-sync.ts`. Official trust is asserted by URL in `services/capabilities/market-sources.ts:51`.
- **Format gaps** in `synap-index.json` v1 (`packages/types/src/marketplace-source/index.ts`, docs/marketplace-source.md) for the official catalog: there are no `retiredAt/replacedBySlug/retiredReason` fields (template health needs them), no `tier` beyond `requiredTier`, no `vendor`/`tags` parity, a cap of 2000 packages / 2 MB, and `source.id` may not be `synap` (`:57`).

### B.1 What signing buys, and what it doesn't

- It does make **mirrors and air-gapped copies safe**, because trust moves from the TLS origin to the key. It protects against a misconfigured or hijacked `CONTROL_PLANE_URL`, a DNS or CDN compromise, and a stale-replay attack (the monotonic `expires`).
- It **does not protect against a compromised CP** if the signing key lives on the CP. The catalog changes on every `POST /api/packages`, so signing has to happen online. Hence the two-tier key design below: an offline root and an online, short-lived catalog key (the TUF root/timestamp split).

### B.2 Options

| Option                                                                                | Architecture                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Cost              | Risks                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **S1. Signed digest manifest beside the existing endpoints (recommended first step)** | The CP serves `GET /api/marketplace/synap-index.json` + `.sig` in the **same v1 format** with `source.id:"synap"` (the schema refusal is relaxed only for the built-in path), extended with optional `retired*`, `vendor` and `tier` fields (back-compatible minor). The pod keeps today's paged endpoint sync for content, and **accepts a row only if its `(kind, slug, version)` and sha256 (definition, or `contentHash`) match the verified index**. By-key install paths verify against the cached signed listing. Converge runs only over verified rows. Report-only mode first, then enforce. | M (pod), S–M (CP) | Two reads that must agree: hash canonicalisation has to be identical (reuse `applied-package-version.ts` content hash, already documented). A drift bug shows up as "unverified" rows, so stage behind report-only.                               |
| S2. Official becomes "just another source"                                            | The official source goes through `syncThirdPartySource`, and the CP endpoints are no longer read for the catalog. Every by-key path (`cp-template-client`, `tier-check`, `cells.ts`, `resolve-workspace-template`) goes through the index plus digest-checked definition fetch.                                                                                                                                                                                                                                                                                                                       | L                 | Needs a v2 format (retirements, cells with code, tiers), and the 2000/2 MB caps may bind. The converge handler must fetch definitions (today they come inline). It breaks many by-key fallbacks at once. Best as the end state, after S1 has run. |
| S3. Stay TLS-only and harden                                                          | Require https, refuse a non-https `CONTROL_PLANE_URL` override, optionally pin the CP's SPKI.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | S                 | No mirror or air-gap story, no protection against an origin compromise, and cert pinning is a known lockout source.                                                                                                                               |

**Recommendation: S1 now (report-only, then enforce), S2 later as the convergence that docs/marketplace-source.md already promises.**

### B.3 Key distribution

| Option                                                                    | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **K1. Baked into the pod release (recommended base)**                     | Replace `SYNAP_CATALOG_PUBLIC_KEY: string \| null` with `SYNAP_CATALOG_ROOT_KEYS: readonly string[]` (current + one offline standby). This is Homebrew's model: the API JSON is verified against a key shipped in `brew`, and `HOMEBREW_API_DOMAIN` allows mirrors.                                                                                                                                                                                                           |
| K2. Fetched and pinned on first sync (TOFU)                               | Fine for third parties (F-Droid fingerprint flow, already built). **Wrong for the official source**: the first sync of every new pod is the attack window, and there is no person to compare a fingerprint. Rejected.                                                                                                                                                                                                                                                         |
| **K3. Signed rotation / delegation statement (recommended on top of K1)** | Root keys (offline, baked) sign a small `synap-catalog-keys.json`: `{keys:[{publicKey, notAfter}], version, expires ≤ 1y}`. The index is signed by an **online catalog key** listed there (KMS/HSM on the CP, rotated ≤90 days without a pod release). The pod verifies root → keys statement → index, with the statement's `version` monotonic (TUF root/targets chain). Root rotation = the old root signs the new keys statement, plus a pod release carries the new root. |
| K4. Operator override                                                     | `SYNAP_CATALOG_PUBLIC_KEYS` env (server env is already root-equivalent) for private mirrors or an enterprise re-signed catalog. Logged loudly at boot.                                                                                                                                                                                                                                                                                                                        |

Failure-mode design, from prior art:

- Overlap keys, never swap. Ship the standby root in the release a year ahead. Pods that stay unpatched past a root change keep working through the K3 chain.
- Never lock out silently. A verification failure keeps the last verified rows **listed**, blocks installs and converge with one plain sentence on Marketplace › Sources and Home "Needs you", and never wipes the cache (the existing never-wipe rule).
- Expiry vs freeze. The CP re-signs **daily** with `expires = now + 14d`, which leaves two weeks of slack before pods freeze, inside the 31-day cap. Alert on the CP side at 7 days remaining.
- Rollback. Keep the monotonic `expires` floor (already built), and add a monotonic `version` for the keys statement.

### B.4 Offline and air-gapped pods

- `SYNAP_CATALOG_SOURCE=off` stays as it is.
- **Mirror.** Point `CONTROL_PLANE_URL` (or a new `SYNAP_CATALOG_URL`) at an internal mirror of the signed files, and trust comes from the key, not the host. **Conflict:** `publicOnlyFetch` (`marketplace-source-fetch.ts:83-124`) refuses private addresses for added sources. The official path doesn't use it today, so it must keep allowing an operator-configured internal mirror.
- **Sneakernet.** The ≤31-day expiry means a mirror must be refreshed monthly, or installs stop. Offer `SYNAP_CATALOG_ALLOW_EXPIRED=1` (apt's `check-valid-until=no` precedent: Debian archived suites broke builds when Release `Valid-Until` passed). It's an env-only operator choice, never a console toggle, and the console shows "verifying with expired metadata". This is an owner decision (D-B4).

### B.5 CP-side contract (the CP repo isn't here; this is the spec)

1. `GET {CP}/api/marketplace/synap-index.json` and `.json.sig`. Same rules as docs/marketplace-source.md: exact-bytes ed25519, base64 signature ≤512 B, `Accept: application/json`, anonymous, no redirects.
   - Body: `schemaVersion: 1`, `source: {id:"synap", name:"Synap", homepage, publicKey:<online catalog key>}`, `expires` (now+14d, monotonic), `packages[]` with `slug, kind (capability|automation|template|cell|skill|view), version, displayName, description, icon, tags, definitionUrl (same origin, e.g. /api/packages/<slug>/<version>/definition.json returning exact stored bytes), sha256, requiredTier`.
   - Optional additions (pod tolerates them; v1 parsers must ignore unknown keys, so check `marketplaceIndexSchema` isn't `.strict()`): `retiredAt, replacedBySlug, retiredReason, vendor, contentHash`.
2. `GET {CP}/api/marketplace/synap-catalog-keys.json` and `.sig`, signed by a root key. Format: `{schemaVersion:1, version:<int, monotonic>, expires:<≤365d>, keys:[{publicKey, notAfter}]}`.
3. Signing service: index built from the published-package table on every publish/retire (debounced) plus a daily re-sign cron. Online key in KMS; root keys offline (2 of them, separate custody). A runbook for a root ceremony.
4. Definitions are served as **stored bytes** (no re-serialization), or `sha256` must cover the canonical content hash instead. Pick one; the content-hash route reuses `h-` versions.
5. Size: the index stays ≤2 MB, ≤2000 packages. Above that, shard by kind (`synap-index.capability.json`, …) listed in a small signed root index. This is a v2 concern.

### B.5a Checked against the CP repo (../control-plane-api @ 38d2d56; it arrived late in this lane)

- The CP serves the catalog from `src/routes/marketplace-apps.ts` (`GET /api/marketplace/cells` :233, `GET /api/marketplace/capabilities` :345) and `src/routes/packages.ts` (`GET /:slug` :1738, `GET /:slug/:version` :1870, publish `POST /` :2314, retire and unpublish). There is no catalog signing today.
- Definitions are stored as **jsonb** (`src/db/schema/packages.ts:1052`). That means the "exact bytes" a `definitionUrl` serves get re-serialized on every read. Two ways out: (a) the index's `sha256` covers bytes produced by ONE fixed serializer, used both when building the index and by the definition endpoint; or (b) the official index pins the **content hash** (`contentHash`, already computed per capability and workspace package, :377/:495) and the pod recomputes it (`applied-package-version.ts`). (b) is recommended, because it survives re-serialization.
- The CP already has an **ES256 signing key with a kid-per-key JWKS and rotation** (`src/lib/signing-key.ts`, `signing-key-material.ts`, `/.well-known/jwks.json`) for CP→pod JWTs. **Don't reuse it for catalog signing.** It's an online server key with a different purpose, and pods fetch the JWKS from the issuer, which is effectively TOFU. Reuse the _pattern_ (key id = thumbprint, publish the next key before switching) for the online catalog key in K3. Use ed25519 so the pod's existing `verifyEd25519` applies unchanged.

### B.6 Phased build list (file ownership)

- **B1 (types).** `packages/types/src/marketplace-source/index.ts`: optional `retired*`, `vendor`, `contentHash` fields; allow `source.id === "synap"` only through an explicit `parseOfficialIndex` (keep the refusal for added sources); keys-statement schema. Tests in `marketplace-source.test.ts`. Owner: types lane.
- **B2 (jobs verify).** `marketplace-source-verify.ts`: `verifyKeysStatement(rootKeys, bytes, sig, lastVersion, now)`, and `verifyIndex` accepting `pinnedKeys: string[]` (the any-of set from the statement). Pure plus vitest. Owner: jobs lane.
- **B3 (jobs sync, report-only).** `cp-catalog-sync.ts`: `SYNAP_CATALOG_ROOT_KEYS` replaces `SYNAP_CATALOG_PUBLIC_KEY` (also in `describeCatalogSources` `:245`, `keyFingerprint` there). Official sync fetches keys + index; in `syncOne` each row is tagged verified or unverified (a new `cp_catalog_cache.verified` column, or a status in `catalog-sync-stamps`). Hand-written migration in `packages/database/migrations/`. Report-only: log and stamp, change nothing. Owner: jobs + database.
- **B4 (api enforce).** `marketplace-install.ts`, `cp-template-client.ts`, `resolve-workspace-template.ts`, `tier-check.ts`, `routers/cells.ts`: by-key fetches verify sha256 against the cached signed listing (reuse `verifyDefinitionBytes`). Converge `reconcileChangedCapabilityTemplates` skips unverified rows. Flag `SYNAP_CATALOG_ENFORCE_SIGNATURE` defaults to off, then flips to on in a later release. Owner: api capabilities.
- **B5 (console).** `(admin)/marketplace/_lib/sources-tab.tsx` / `sources-model.ts`: the official row shows "Signed by Synap · fingerprint · valid until", "Not verified (reason)" and expiry warnings, plus a Home "Needs you" item on a freeze. `marketplace.sources.list` wire gains `verification`, which means an api-types regen. Owner: pod-admin + api router.
- **B6 (docs).** `docs/marketplace-source.md` "Synap's own catalog" section; operator docs for the env vars.
- **B7 (later, S2).** Route the official source through `syncThirdPartySource`; delete the endpoint reads.
- **Tripwire ideas.** (a) No code path installs or converges an official definition without passing `verifyDefinitionBytes` once enforcement is on: a source scan for `fetch(` of `/api/packages` or `/api/marketplace` outside one allowlisted module. (b) `SYNAP_CATALOG_ROOT_KEYS` is non-empty in release builds.

### B.7 Prior art: what went wrong, and what we adopt

- **TUF / Uptane.** Separate offline root from online timestamp/snapshot keys. Threshold roots. Root rotation by a chain signed by the old root. Explicit defenses against freeze, rollback and mix-and-match. Failures in practice: clients that cache metadata until expiry and so pick up fixes slowly (sigstore/sigstore#1091); a client that didn't enforce sequential root versions, allowing rollback (tough, CVE-2025-2885). **Adopt:** the two-tier keys and the monotonic `version`; the pod re-reads every sync and never trusts a cache past `expires`.
- **Sigstore / npm.** npm moved from PGP to ECDSA registry signatures in 2023 and serves keys with an `expires` field at `/-/npm/v1/keys`; Sigstore distributes its trust root over TUF with short-lived roles. **Adopt:** keys carry `notAfter`, served from a signed statement rather than an unsigned endpoint.
- **Homebrew.** Since 4.1 the JSON API is fetched from a signed endpoint and verified client-side; mirrors via `HOMEBREW_API_DOMAIN`. **Adopt:** K1 (key in the release) plus mirror support.
- **VS Code Marketplace.** The repository signs every extension at publish, and verification is enforced at install by default. Publisher signing is still roadmap. **Adopt:** repository signature now; per-publisher provenance is a later layer (`sourcePackage` stamping already exists).
- **F-Droid.** The repo key is pinned by fingerprint (TOFU, already mirrored in our third-party flow); index-v2 has a signed entry point. Critiques note weak key-rotation support. **Lesson:** TOFU is fine for third parties, and rotation must be designed in up front.
- **apt / Debian / Kubernetes.** Release `Valid-Until` freezes archived or stale mirrors (`check-valid-until=no` workaround). Expired or rotated repo keys broke installs fleet-wide: EXPKEYSIG on pkgs.k8s.io; the legacy apt.kubernetes.io repos frozen in 2023. An agent fleet couldn't update after a root key rotation failed to store the new key (SecurityHive). **Adopt:** overlap keys, a long standby, CP-side expiry alerting, never wipe on failure, a clear console sentence, and an operator-only expired-metadata escape.

### B.8 Control Plane contract (binding)

The owner's decisions: **B1** S1 now (a signed digest index beside today's endpoints; Synap as "just another
source" later), **B2** two offline root keys compiled into the pod release (current + standby) sign a statement
naming a short-lived online catalog key (≤90 days) that signs the index, plus an operator override for private
mirrors (trust on first fetch rejected), **B3** on an expired or failed index: keep listing, block installs and the
automatic capability updates, one sentence in the console, never wipe, **B4** `SYNAP_CATALOG_ALLOW_EXPIRED=1`
env-only, **B5** the founders hold the root keys; the ceremony has not happened.

**What the pod does today.** It ships with `SYNAP_CATALOG_ROOT_KEYS = []`
(`packages/jobs/src/workers/official-catalog-signature.ts`): it fetches nothing, blocks nothing, and Marketplace ›
Sources says "Synap's catalog isn't signed yet". Once a release carries the roots (or an operator sets keys), every
official catalog sync checks root → keys statement → index, stores the verified digests in
`official_catalog_digests`, and checks every official definition against them before it installs or converges
(`packages/api/src/services/capabilities/official-catalog-trust.ts`). Until `SYNAP_CATALOG_ENFORCE_SIGNATURE=1` a
failed check is only logged and reported.

#### 1. Endpoints

Under the catalog base URL (the CP's public origin, the one that serves `/api/marketplace/capabilities`):

| Path                                               | Signed by             | Cap   |
| -------------------------------------------------- | --------------------- | ----- |
| `GET /api/marketplace/synap-catalog-keys.json`     | a root key            | 64 KB |
| `GET /api/marketplace/synap-catalog-keys.json.sig` | —                     | 512 B |
| `GET /api/marketplace/synap-index.json`            | an online catalog key | 2 MB  |
| `GET /api/marketplace/synap-index.json.sig`        | —                     | 512 B |

- Anonymous `GET`, `Accept: application/json`, no cookie or credential. Answer `200` with the file's exact bytes;
  **never a redirect** (the pod refuses one). A `.sig` is the base64 ed25519 signature over the exact bytes of its
  file (surrounding whitespace ignored).
- A file the pod cannot fetch is an outage: the last verified index stays in force until its `expires`.
- Cache for at most a few minutes: the pod reads both every 10 minutes and on "Sync now".

#### 2. Keys statement — `synap-catalog-keys.json`

```json
{
  "schemaVersion": 1,
  "version": 7,
  "expires": "2027-04-01T00:00:00Z",
  "keys": [
    {
      "publicKey": "<raw ed25519, base64, 44 chars>",
      "notAfter": "2026-12-20T00:00:00Z"
    },
    { "publicKey": "<next key>", "notAfter": "2027-01-15T00:00:00Z" }
  ]
}
```

The pod (`verifyKeysStatement`) accepts it only when it is signed by **any** root compiled into its release; it is
not past `expires` and `expires` is at most **366 days** ahead; `version` (an integer ≥ 1) is **not lower** than the
last one the pod accepted; and at least one key is usable. A key is usable while `notAfter` is ahead and **at most 90
days** ahead of the moment the pod reads it. A key valid for longer is ignored, so roots must re-sign the statement
at least every ~75 days (keep 2 weeks of slack). 1–8 keys.

#### 3. Index — `synap-index.json`

The v1 format of `docs/marketplace-source.md` (same caps: 2 MB, 2000 packages, `expires` at most 31 days ahead,
monotonic) parsed by `officialIndexSchema` (`packages/types/src/marketplace-source/index.ts`):

- `source`: `{ "id": "synap", "name": "Synap", "publicKey": <the online key that signed this file> }`. That key must
  be usable in the current keys statement.
- `expires`: **now + 14 days**, re-signed **daily** and on every publish, retire and unpublish (debounced). Never
  earlier than the last `expires` served. Alert on the CP at 7 days remaining.
- `packages[]`: one per `(kind, slug)`, keyed **as the pod's catalog cache keys it**:

| Field                                                    | Value                                                                                                                                                                              |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`                                                   | `capability`, `template`, `automation`, `skill`, `view` or `cell` (`workspace`/`workflow` accepted as aliases)                                                                     |
| `slug`                                                   | capability: its `key`; packages: the package slug; cell: `<packageSlug>/<cellKey>`. Lowercase `[a-z0-9._-]` (a row that cannot be written so cannot verify — normalize or flag it) |
| `version`                                                | exactly the `version` the CP endpoint serves for that row (cells: the owning package's `version`)                                                                                  |
| `contentHash`                                            | the content digest (§4), 64 lowercase hex                                                                                                                                          |
| `sha256`                                                 | **the same value** as `contentHash` (an index where they differ is refused)                                                                                                        |
| `definitionUrl`                                          | same origin, serving the canonical bytes of §4 (for S2; the pod does not fetch it in S1). E.g. `/api/packages/<slug>/<version>/definition.json`                                    |
| `displayName`, `description`, `icon`, `tags`             | as listed today                                                                                                                                                                    |
| `requiredTier`                                           | the package's tier. Once enforced, the pod's install tier check takes it from here instead of `GET /api/packages/:slug`                                                            |
| `vendor`, `retiredAt`, `replacedBySlug`, `retiredReason` | optional, as today's DTOs carry them                                                                                                                                               |

- **Which rows.** Everything an anonymous pod-facing door serves: every capability key served by
  `GET /api/marketplace/capabilities` **and** by `GET /api/marketplace/capabilities/:key` (public owners with
  `syncByDefault: false` too); every public workspace, workflow, skill and view package at the version
  `GET /api/packages/:slug` serves (an install pinned to another version is refused under enforcement); every cell
  of a public package. Retired rows may be listed with `retiredAt` (the pod never installs a retired row).
- Private packages are not listed (a public file must not reveal them). Consequence below (§7).

#### 4. The content digest

`contentHash = sha256( canonicalJSON( D′ ) )`, hex, where:

- `D` is the definition object **exactly as the pod receives it from today's endpoint, read back from the
  database** (jsonb normalizes numbers and key order; the digest must be computed over the stored value, never over
  the publish payload):
  - capability: the card's `definition` from `/api/marketplace/capabilities[/:key]` (the stored
    `definition.capability`);
  - workspace, workflow, skill, view: `package.definition` from `GET /api/packages/:slug[/:version]`;
  - cell: the cell's own entry of the package's `definition.cells[]`.
- `D′` is `D` without its top-level `_meta`, `contentHash` and `sourcePackage`, and, for a cell, without the fields
  `/api/marketplace/cells` adds: `packageSlug`, `packageName`, `author`, `packageVersion`, `installCount`,
  `isVerified`.
- `canonicalJSON` is the CP's existing one (`src/seeds/capability-content-hash.ts`): keys sorted recursively,
  arrays in order, `JSON.stringify` with no whitespace.

So `contentHash` is the full form of what the CP already computes: `capabilityContentHash(capability)` for a
capability and `templateContentHash` of the definition minus `sourcePackage` and `_meta` for a package. Its first 12
hex are the row's `h-` version. Because `_meta` is outside the digest, the pod also refuses a served definition whose
`_meta.slug` is not the listed slug; `serveCatalogRow` keeps `_meta.slug` equal to the row's slug.

**Parity.** Pin one literal on both sides: the pod's `official-catalog-verify.test.ts` hashes
`{"profiles":[{"name":"Deal","slug":"deal"}],"workspaceName":"CRM"}` (from a definition carrying `_meta`) to
`68f8c9908b0cacaed63dd011d3275521e51e663865e882ac800c32f862cbec54`. Add the same literal and digest to a CP test.

#### 5. Keys, custody and rotation

- **Algorithm:** ed25519 for every key (the pod verifies with Node's built-in ed25519, `verifyEd25519`). Do not
  reuse the CP's ES256 JWT key (`src/lib/signing-key.ts`): it is a different purpose and is distributed by fetch.
- **Root keys:** two, offline, separate custody by the founders. Both public keys are compiled into
  `SYNAP_CATALOG_ROOT_KEYS`, current first. A statement carries one signature; any compiled root is accepted.
- **Online catalog key:** in the CP's KMS/HSM; listed in the statement with `notAfter` ≤ 90 days.
- **Rotating the online key:** sign a statement listing the current and the next key; switch the index to the next
  key at least 14 days later; drop the old key from the next statement.
- **Rotating a root:** ship the replacement as the standby in a pod release well ahead (a year, per B.3). Sign
  statements with a root every supported release carries. A compromised root is retired by signing with the
  standby and shipping a release without it.
- **The ceremony (B5):** generate both roots offline, record their fingerprints (first 32 hex of sha256 over the raw
  key), put the public keys in `SYNAP_CATALOG_ROOT_KEYS`, sign the first statement. Serve the files **before** the
  pod release that carries the roots.

#### 6. Pod behaviour (what the CP can rely on)

| Situation                                       | Pod                                                                                                                                                         |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No root keys in the release, no operator keys   | Fetches nothing, blocks nothing. Console: "Synap's catalog isn't signed yet."                                                                               |
| Verified                                        | Replaces `official_catalog_digests`; installs and converges what the index vouches for                                                                      |
| File unreachable / 404                          | Last verified index stays in force until its `expires`                                                                                                      |
| Bad signature, refused file, replayed statement | Last verified digests kept (never wiped). Report mode: logged + console sentence. Enforced: installs and automatic updates paused, the catalog stays listed |
| Index expired, no fresh one                     | Same as above; `SYNAP_CATALOG_ALLOW_EXPIRED=1` accepts expired signed files (air-gapped pods)                                                               |
| A definition the index does not vouch for       | Report mode: logged. Enforced: that install or update is refused with the reason                                                                            |

Operator override: `SYNAP_CATALOG_PUBLIC_KEYS` (comma-separated ed25519 keys) replaces the root chain. The index
must then be signed by one of those keys directly, and no keys statement is read. It is logged loudly at boot.
Enforcement ships off (`SYNAP_CATALOG_ENFORCE_SIGNATURE`); its default flips in a later release, once report-only has
run clean.

Reads covered: `marketplace-install.ts` (by cache row and by key, every kind), `cp-template-client.ts`
(`fetchCPCapabilityTemplate`, the door for capability installs, the capability reconcile and connector templates),
`resolve-workspace-template.ts` (falls back to the bundled template), `utils/tier-check.ts`, `routers/cells.ts` and
the Hub REST `POST /cells/install`, the standalone view/skill/automation reconcile, and the after-sync capability
converge (`reconcileChangedCapabilityTemplates`, paused as a whole while a freeze is enforced).

#### 7. Open points for the owner and the CP team

- **Private capabilities** (resolved in wave 6 as an explicit exemption). A capability that the pod's authenticated
  `/internal/capabilities/:key` door serves with `isPublic: false` is not checked against the public index: the
  authenticated connection is its trust. The exemption covers only that door's private answer, and never a key the
  signed index lists (or one whose listing cannot be read). It shows in logs and on Marketplace › Sources as "private,
  verified by the Control Plane connection" (`admitPrivateCapability`, `official-catalog-trust.ts`).
- **Payload-in installs (RC4)**, where a CP-authenticated client sends the definition itself, are not catalog
  reads and are not checked.
- The **boot** capability reconcile is checked per template (it loads through `fetchCPCapabilityTemplate`) but is
  not paused as a whole by a freeze; only the after-sync converge is.
- The retired `capability-template-sync` worker still writes `capability_template_cache`, which nothing reads.
- **Two public authors on one slug** (non-official only, since an official slug is reserved). The index lists the
  row the CP's own precedence picks: per category, an official row first, then the newest public row. A pod whose
  cache kept the other row (its dedupe keeps the "newest version") is told the row is unverified, and an enforcing
  pod refuses that install. Rows the format cannot carry (an uppercase capability key, a cell key with `:`) are left
  out, and listed in the CP's `GET /admin/catalog-signing` under `index.skipped`.

#### 8. What was built (wave 6)

**Control Plane** (`control-plane-api`):

- `GET /api/marketplace/synap-catalog-keys.json[.sig]` and `synap-index.json[.sig]` serve the stored exact bytes:
  anonymous, `200`, `Cache-Control: public, max-age=60`, never a redirect. They answer `404` before anything is
  published, and `503` for an index the current statement does not name as usable. There is also
  `GET /api/marketplace/synap-definitions/:kind/:slug?version=`, the canonical bytes `definitionUrl` names (for S2).
- The index is built from the anonymous doors' own resolution (`catalog-rows.ts`, with the capability key rule and
  `toCapabilityCard`) and hashed with the §4 rule (`content-digest.ts`, the CP's `canonicalJSON`, the pod's field
  lists). It is checked against the pod's format before it is signed. It is signed by the online key behind the
  `CatalogSigner` interface (env: `SYNAP_CATALOG_SIGNING_KEY`, an ed25519 PKCS#8 key; a KMS signer can replace it).
  `expires` is now + 14 days and never earlier than the last; the CP's own `version` counter goes up by one each time.
  Re-signing runs on every publish, edit, unpublish, retire and statement upload (pg-boss, debounced 30 s), daily
  at 04:45 UTC, and at startup. Warnings, logged and sent to Sentry, start at 7 days left on the index and 14 days on
  the statement or the online key.
- The keys statement comes from the offline ceremony and is uploaded with `PUT /admin/catalog-signing/keys-statement`
  (`{statement: base64, signature}`). The CP stores it only when a pod would accept it: signed by one of
  `SYNAP_CATALOG_ROOT_PUBLIC_KEYS`, current, not older than the one served, a reused version refused. Status is at
  `GET /admin/catalog-signing`; `POST /admin/catalog-signing/sign` signs now. Both files are stored in
  `catalog_signed_files` (migration 0090).
- `GET /internal/capabilities/:key` now also answers `isPublic` and `version`.
- `ops/catalog-signing/cli.mjs` (no dependencies) handles the root ceremony: `root-keygen` (encrypted with scrypt and
  AES-256-GCM), `check-root`, `online-keygen`, `sign-keys`, `verify` and `fingerprint`.

**Pod:** `catalogRootKeys([...])` makes compiling the two roots a one-line change (a malformed root, or anything but
none or two, throws). The private-capability exemption is above.

**Proof:** cross-repo fixtures signed with TEST-only keys. They are committed in both repos, CP
`src/lib/catalog-signing/__fixtures__/official-catalog/` and pod
`packages/jobs/src/workers/__tests__/fixtures/official-catalog-cp/`, and pinned by one fixture-set sha256 on both
sides. The CP regenerates them through the production path. The pod verifies those bytes with its own verifier,
recomputes every digest from the definitions as the doors serve them, and runs them through
`checkOfficialCatalogSignature` on PGlite with enforcement on, with zero unverified rows.

---

## Owner decisions

- **D-A1.** Hosting order and scope: all four (playbook → capability → run → agent), or A-opt 3 (run and playbook only)? Recommended: playbook, run and capability-enable now; agent after D-A4.
- **D-A2.** Run addressing: R1 (`?flowType=` forwarded) with R2 fallback, as recommended. OK to add a second forwarded query param to the public route?
- **D-A3.** Capability on the web: enable only (connect stays in the app), with `opensIn` becoming `"web" | "desktop"` per action (an api-types and CLI contract change)? Console home: a new `/marketplace/capability/[id]` object page vs only `/open/capability/<id>`?
- **D-A4.** Agent floor: should a pod admin (not the creator) read another member's agent (resolver probe plus scorecard)? This is DECISIONS bug 6. Until then, agent stays bounced.
- **D-A5.** A workspace link for an admin: keep the bounce, or add "See this space here" (`/workspaces/<id>`) on the bounce card?
- **D-B1.** S1 (signed manifest beside the endpoints, report-only, then enforce) now, S2 later?
- **D-B2.** Keys: K1 + K3 (baked offline roots, plus a signed online catalog key ≤90 days), plus K4 operator override?
- **D-B3.** Expiry policy for the official index: daily re-sign, 14-day validity. On freeze: list but don't install or converge?
- **D-B4.** Air-gapped escape `SYNAP_CATALOG_ALLOW_EXPIRED=1` (env only): yes or no?
- **D-B5.** The CP team owns B.5. Who holds the root keys (custody), and when is the root ceremony?
