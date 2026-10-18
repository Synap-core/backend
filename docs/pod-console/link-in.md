# R1: Link in to the Pod Console (Wave 4 research plan)

Read-only research. Repos at `claude/clever-pascal-4v8992`: backend, browser, relay-app, app-bases.
**FACT** means I read it at file:line. **INFER** means I reasoned it from code and did not run it. **DOGFOOD** means it needs a running pod or device to confirm.

---

## 0. Summary

- **The OUT half is mature. The IN half does not exist.** pod-admin has one exit door (`lib/open-in.ts`), a phone-aware exit placement, and cross-repo tripwires. Browser and relay have no "open this in the console" verb. The exceptions are two hard-wired flows (recovery, security) and one stale Trust & Keys link.
- **The console's address is already published.** `GET /api/account-recovery/doors` returns the validated `POD_ADMIN_URL` as `podAdminUrl`. Browser reads it. Relay reads `/doors` but ignores that field. Three other client helpers still _guess_ the host with `pod.`→`pod-admin.`, and two of those guesses disagree with each other.
- **The console's page table lives only inside pod-admin** (`lib/console-nav.ts`). Clients cannot import it, so any client link would hand-copy paths. That is the exact failure `open-in.ts` was built to prevent.
- **Live dead ends today:**
  1. Browser access-request rows in Needs you do nothing when clicked.
  2. Relay draws those same rows inert.
  3. Relay `synap://open/settings/<s>` says "open on desktop" even though relay has a screen for that section.
  4. Relay `synap://open/app/<id>` mis-routes to the App Connect application screen, or to not-found.
- **Sign-in continuity is the real risk.**
  - Browser opens console pages in a tab partition that does not hold the pod session, so the person lands on `/login`.
  - Relay opens SFSafariViewController, whose cookies are isolated from Safari, so the person lands on `/login` at least the first time.
  - Neither is a lockout, because `/login?return=` brings them back to the page. But every "Manage in console ↗" costs a sign-in today.
- **Recommendation:** Option A. One shared console address contract in `@synap-core/types` (pinned by a pod-admin tripwire), plus one pure href builder, plus one verb per client. Ship it with the browser tab-partition session fix. Do not push everything through a backend 302 (Option B); keep that as a fallback for clients that cannot read `/doors`.

---

## 1. Deep-link and open contracts that exist today

### 1.1 Backend (this repo)

| Contract                                             | Evidence                                                                                                                                                                                                                                                                                         | What it does                                                                                                                                                                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openIn(target)`, pod-admin's only exit door         | `apps/pod-admin/lib/open-in.ts:266-311`                                                                                                                                                                                                                                                          | `object` → web `/open/<k>/<id>` when hosted, else `synap://open/<k>/<id>`. `settings` → `synap://open/app/settings/<s>` (`:291-298`). `app` → `synap://open/app/<id>` (`:300-303`). `account`/`guide` → www.synap.live. |
| Phone placement                                      | `open-in.ts:195-204` (`RELAY_OPENABLE_KINDS`), `:211-221` (`SETTINGS_WEB_ALTERNATIVE`), `:358-370` (`placeExit`)                                                                                                                                                                                 | On a phone, a kind relay cannot open becomes "Open this on your computer" plus an optional console page. `open/app/*` is never relay-openable (`:191-194` documents the mis-route).                                     |
| `HOST_TYPES` / `BOUNCE_TYPES`                        | `apps/pod-admin/app/open/open-params.ts:18`, `:22-36`                                                                                                                                                                                                                                            | pod-admin hosts `entity, view, automation, session`. It bounces 13 kinds, including `settings`.                                                                                                                         |
| `TYPED_OPEN_KINDS`, `WEB_HOSTED_OPEN_KINDS`          | `apps/api/src/open-dispatch.ts:27-64`, `:110-115`                                                                                                                                                                                                                                                | Locked against pod-admin by `apps/api/src/open-kinds.lock.tripwire.test.ts`.                                                                                                                                            |
| `dispatchOpen`                                       | `open-dispatch.ts:230-274`                                                                                                                                                                                                                                                                       | Proposal → 302 to the console. Hosted kinds → 302 for humans. Untyped uuid → 302 to the console resolver. `?client=mobile` (`:187-193`) or a bot → bounce page to `synap://`.                                           |
| Public `/open/:type/:id` and bare `/open/:id`        | `apps/api/src/index.ts:613-643` (applyOpenDispatch, bounce page with "View in browser" `podAdminBrowserUrl`), `:645-660` typed, `:662+` bare probe (proposal/entity/view only, project guard)                                                                                                    | Every MCP/create response links `${PUBLIC_URL}/open/<id>`.                                                                                                                                                              |
| Console resolver for a bare id                       | `apps/pod-admin/app/open/[type]/page.tsx:1-40` → `diagnose.resolveOpen` (`packages/api/src/routers/diagnose.ts:82-87` → `resolveOpenTarget`)                                                                                                                                                     | Signed-in, user-floored typing.                                                                                                                                                                                         |
| `/admin/connect`, a server-side 302 into the console | `apps/api/src/index.ts:543-559`                                                                                                                                                                                                                                                                  | **Prior art for Option B.** API origin → `POD_ADMIN_URL/connect`, with a 503 and a remediation code when unconfigured.                                                                                                  |
| Console origin, authoritative                        | `packages/api/src/utils/pod-admin-url.ts:19-48` (`POD_ADMIN_URL`, validated, https in prod) and `deploy/docker-compose.yml:65-66`                                                                                                                                                                | Deploy config is the authority. Its header says it never infers the host.                                                                                                                                               |
| Console origin, a convention guess (backend)         | `packages/api/src/utils/pod-admin-origin.ts:11-33` (`toPodAdminOrigin`: `pod.X`→`pod-admin.X`, `<sub>.X`→`pod-admin.X`)                                                                                                                                                                          | Used for approval links. Note the `<sub>.root` branch.                                                                                                                                                                  |
| Console origin, published to clients                 | `packages/types/src/account-recovery/index.ts:107-114` (`RecoveryDoors.podAdminUrl`) and `apps/api/src/routers/account-recovery.ts:138-140`, `:224-230`                                                                                                                                          | Public, unauthenticated, never guessed, and left out when invalid.                                                                                                                                                      |
| Console IA table                                     | `apps/pod-admin/lib/console-nav.ts:82-306` (CONSOLE_NAV), `navHref` `:334`, `computerHref` `:351`, `pendingIssuerHref` `:397` (`/review?type=access&focus=`), `DIAGNOSE_DESTINATION` `:486+`, legacy 307s (`/trust-keys` `:221,:277`, `/people` `:234`, `/connectors` `:249`, `/origins` `:213`) | pod-admin only. It is deliberately free of imports (`:11-15`).                                                                                                                                                          |
| Console auth gate                                    | `apps/pod-admin/proxy.ts:10`, `:56` (public exemptions), `:89-95` (no session → `/login?return=`), `:107-109` (not admin → `/forbidden`)                                                                                                                                                         | A deep link into the console survives sign-in. A member who follows an admin link gets `/forbidden`.                                                                                                                    |
| Cross-repo tripwires                                 | `apps/pod-admin/__tripwires__/cross-repo-parity.test.ts` (reads browser `SETTINGS_SECTIONS` as source), `exit-door.test.ts`, `console-nav.test.ts`                                                                                                                                               | The house pattern for pinning another repo: parse its source text.                                                                                                                                                      |

### 1.2 Browser (`../browser`, Electron)

- **`synap://` handler.**
  - Grammar is in `electron/renderer/src/hooks/useDeepLinkHandler.ts:27-34`: `open/app/<appId>[/seg]`, `open/<kind>/<id>`, `open/<uuid>`, `open/workflow/...`, and callbacks.
  - `planDeepLink` decides. A miss opens the "Can't open this" surface (`:89-93`).
  - The protocol is claimed at `electron/main/index.ts:75-95` and `:114`.
  - Settings sections are a runtime-validated const at `stores/appStore.ts:136-178`, because pod-admin hands off there.
- **Existing console door, two flows only.**
  - `lib/podAdminDoor.ts:41-101`: reads `/doors.podAdminUrl` (`:53-63`) and opens `/recovery` or `/settings/security` (`:47-50`). It falls back to the Kratos self-service redirect (`:42-44`).
  - It opens the page in an in-app tab: `openPodAdminUrl` → `window.synap.tabs.create` (`:99-101`).
  - Hook: `components/connection/usePodAdminDoor.ts`. Users: `PodSecurityStatus.tsx:40`, `PodRecoveryKit.tsx:54`, `KratosAuthView.tsx:125`.
  - Its docblock (`:11-14`) records that the CP convention (`<sub>-admin.<domain>`) and the backend convention (`pod-admin.<root>`) disagree.
- **No "Manage in console" verb exists anywhere** in `electron/renderer/src` (grep for `in console|Manage in|pod-admin` turns up only comments).

### 1.3 Relay (`../relay-app`, React Native)

- **`synap://` handling is split.** `src/hooks/useDeepLinkHandler.ts` owns callbacks only. `open/*` is expo-router's job (`:146-154`).
  - Routes: `app/open/[kind]/[id].tsx` and `app/open/[kind]/index.tsx` (bare id) → `OpenLinkScreen` → `src/lib/open-link.ts:55-67` → `objectRouteFor` (`src/lib/object-nav.ts:445-455`).
  - `+native-intent.tsx:82-117` only suppresses capture, pair, invite and share.
- **`KIND_ROUTE`** (`object-nav.ts:57+`): `application` and **`app`** → `/application/<id>` (`:251-252`). There is **no `settings` row**. `NO_SCREEN` is at `:314+`.
- **Console doors.**
  - Relay opens only the Kratos browser flow (`src/lib/account-recovery.ts:252-254`) in the **system browser sheet**: `WebBrowser.openBrowserAsync` (`src/components/pod-safety/PodSecuritySection.tsx:53-57`, `src/components/recovery/CantSignInSheet.tsx:155`).
  - Cloud continue uses `openAuthSessionAsync` (`CantSignInSheet.tsx:180`).
  - Its comment says "Relay cannot know pod-admin's own domain (POD_ADMIN_DOMAIN is not published)" (`account-recovery.ts:248-251`). That is **stale**: `/doors` publishes `podAdminUrl`, and relay already fetches `/doors` (`account-recovery.ts:82`).
- **"Stays off the phone" acts** have no door to anywhere. One example is `app/application/[id].tsx:11-12`: "Registering an app, renaming it, issuing its key and changing what it may touch stay off the phone."

### 1.4 app-bases (`../app-bases`)

- `@synap-core/headless/deep-link-constants` (`packages/headless/src/deep-link-constants/index.ts:36-99`) holds `OPEN_HOST` and `buildOpenAppLink`/Entity/View/Proposal. There is **no console grammar**.
- **Console host guess #1:** `@synap-core/headless/auth` `podAdminUrl(podUrl, path)` (`packages/headless/src/auth/pod-admin-url.ts:7-22`).
  - It maps `pod.X`→`pod-admin.X`. For any other host it **prepends** `pod-admin.` (`sub.X` → `pod-admin.sub.X`). That **disagrees** with backend `toPodAdminOrigin`, which swaps the label instead.
- **Console host guess #2:** `derivePodAdminUrl` (`packages/headless/src/external-connect-client/index.ts:236-246`) maps `pod.` only and returns null otherwise.
- **Stale console link:** `apps/base/lib/kit/auth-ui/components/PodConnectionRecoveryScreen.tsx:206-213` links `/trust-keys`. That path now survives only as a legacy 307 (`console-nav.ts:221-231`, `:277-292`).
- **Wrong-grammar emitter:** `packages/web/src/proposals/components/ProposalDetail.tsx:670-672` emits `synap://open/app/proposals/<id>`. Relay routes that to `/application/proposals` (INFER: dead).

### 1.5 Who links where, and the dead ends

| From → To                                                                                                                                         | Link                                                                                                                           | Result                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent / MCP / chat → pod                                                                                                                          | `${PUBLIC_URL}/open/<id>`                                                                                                      | Works. Desktop humans 302 to the console. Phone links carry `?client=mobile` and bounce to relay.                                                                                                                                                                         |
| Console → browser                                                                                                                                 | `synap://open/app/settings/<s>`, `open/app/<id>`, `open/<kind>/<id>`                                                           | Works on desktop (tripwire-pinned). On a phone it is pre-empted by `placeExit`.                                                                                                                                                                                           |
| Console → relay                                                                                                                                   | `synap://open/<kind>/<id>` for 8 kinds                                                                                         | Works.                                                                                                                                                                                                                                                                    |
| Pod `/open/settings/<s>` (owed slot "no agent bound", `open-dispatch.ts:42-45`) → relay                                                           | `synap://open/settings/agents`                                                                                                 | **Dead end.** No `settings` row in relay KIND_ROUTE, so relay shows "Relay doesn't have a screen for it yet. Open it on your desktop." (`OpenLinkScreen.tsx:112-118`). Relay _has_ `app/settings/[section].tsx` with an `agents` section (`SettingsSectionBody.tsx:958`). |
| Anything → relay                                                                                                                                  | `synap://open/app/<appId>` (marketplace install, `ProposalDetail` proposals link)                                              | **Dead end / mis-route.** `app` is aliased to App Connect `/application/<id>` (`object-nav.ts:252`). `open/app/settings/vault` has 3 segments, which matches no expo route and lands on `+not-found` (INFER).                                                             |
| Needs-you access-request row (target `issuer` / `connection-request`, `packages/api/src/services/signals/needs-you-union.ts:1236-1272`) → browser | `objectNavTarget('issuer'…)`                                                                                                   | **Dead click.** No case, so `default: return null` (`navigation/object-nav.ts:835-836`) and `dispatchObjectSurface` returns silently (`:1014`). The path is `useNeedsYouRowVerb.ts` `open(signal)` → `signalNavAddress` (`navigation/signal-target.ts:36-63`).            |
| The same row → relay                                                                                                                              | `lensDoorRoute`                                                                                                                | **Inert.** `objectRouteFor` returns null, so no verb is drawn (`src/components/lens/doors.ts:17-21`). Neither `issuer` nor `connection-request` is in `NO_SCREEN`, so the coverage tests do not see it either.                                                            |
| The console's own receivers for these rows                                                                                                        | `/review?type=access&focus=<id>` (`pendingIssuerHref`, `console-nav.ts:397`), `/connection-requests/<id>` (self-service route) | **Exist.** Review already groups access rows (`app/(admin)/review/_lib/review-rows.test.ts:101-115`).                                                                                                                                                                     |
| Browser / relay → console                                                                                                                         | only `/recovery` and `/settings/security` (plus base-kit `/trust-keys`, `/login`)                                              | No operational link-in.                                                                                                                                                                                                                                                   |

---

## 2. Operational surfaces that should link IN, and what they show today

| Surface                                                                          | Today (file)                                                                                                                                                                                                       | Console page                                                                    | Verb                                                                                                                                                      |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Needs-you access-request rows (both apps)                                        | browser dead click, relay inert (above)                                                                                                                                                                            | issuer → `/review?type=access&focus=<id>`; app → `/connection-requests/<id>`    | **"Review in console ↗"** (fixes a live bug; first priority)                                                                                              |
| Browser Settings › Pod (tabs General / Access / CORS / Users / Health / Updates) | `components/settings/PodSettingsSection.tsx:233-239`: `system.getDataPodStats`, `workspaces.createInvite/listInvites/revokeInvite`, `system.get/updateCorsSettings`, `system.getServiceHealth/getDashboardMetrics` | `/members`, `/applications`, `/updates`, `/home`                                | A row-level "Manage in console ↗". The twin tabs are a **product decision** (§7 Q3). The Plex rule says do not delete what works against a reachable pod. |
| Browser Settings › Developer (pod API keys)                                      | `DeveloperSection.tsx:150-153` `apiKeys.list/create`                                                                                                                                                               | `/keys` (`apiKeys.adminListAll/rotate/revoke/createSystemKey`)                  | "All keys on this pod ↗" (the console sees every key; Developer shows the user's own)                                                                     |
| Browser Settings › Pod redundancy / Copies                                       | `PodRedundancySection.tsx:130`, `PodCopies.tsx:704` `sync.getStatus`                                                                                                                                               | `/backups` (`sync.getStatus`, `sync.resetPeer`, `system.getBackupStatus`)       | "Backups in console ↗"                                                                                                                                    |
| Browser `PodAutoUpdateCard` (U3/U4)                                              | `components/settings/PodAutoUpdateCard.tsx`                                                                                                                                                                        | `/updates`                                                                      | "Update history ↗"                                                                                                                                        |
| Browser Settings › Extensions / packages, connectors                             | `ExtensionsAndPackagesSection.tsx`, `ConnectorsSection.tsx`                                                                                                                                                        | `/marketplace`, `/sources`                                                      | "Manage sources ↗" (marketplace authoring stays in the app)                                                                                               |
| Browser / relay Security (pod account)                                           | already links to `/settings/security` (browser via `/doors`, relay via Kratos)                                                                                                                                     | `/settings/security` (self-service) plus `/security` (admin)                    | Keep. Move relay onto `/doors.podAdminUrl` too.                                                                                                           |
| Browser health band                                                              | `CommandPalette/AttentionBand.tsx` and `apps/processors/FlowHealthBand.tsx:120` (`diagnose.global`)                                                                                                                | Console Home or the section's page (`DIAGNOSE_DESTINATION`)                     | "See all in console ↗" in the band footer (pod altitude)                                                                                                  |
| Relay holder screens: key, application, agent, computer                          | `app/key/[id].tsx`, `app/application/[id].tsx:11-12` ("issue key / change what it may touch stay off the phone"), `app/agent/[id].tsx`                                                                             | `/keys?focus=`, `/applications/<via>/<id>`, `/agents?focus=`, `/computers/<id>` | "Manage in console ↗": the console is the phone's only route to those acts                                                                                |
| Relay Settings › Data pod › Backups                                              | `app/backups.tsx` ("No restore here, by decision (B7)")                                                                                                                                                            | `/backups`                                                                      | "Open Backups in console ↗" (restore is still not a phone act)                                                                                            |
| Relay Settings › Trust / Connections                                             | `SettingsSectionBody.tsx:960-968` (Governance, Applications, Connections)                                                                                                                                          | `/governance/agents`, `/applications`, `/sources`                               | Footer link                                                                                                                                               |
| Relay pod-access requests (CP-level join requests)                               | `src/features/pod-access/PodAccessRequestsSection.tsx`                                                                                                                                                             | —                                                                               | **No.** This is a Control Plane flow, not the pod's. Leave it.                                                                                            |

---

## 3. How a client knows the URL, sign-in continuity, and phone behaviour

### 3.1 The URL

- **Use `/doors.podAdminUrl`.** It is the one authoritative published value (FACT, above). Browser already reads it (`podAdminDoor.ts:53-63`). Relay already fetches the same body (`account-recovery.ts:82`) and drops the field.
- **Every guessing helper is wrong for some pod.**
  - `podAdminUrl` (headless) and `toPodAdminOrigin` (backend) disagree on `<sub>.<root>`.
  - The CP convention `<sub>-admin.<domain>` is a third answer, documented at `podAdminDoor.ts:11-14`.
  - A pod whose `POD_ADMIN_URL` is on an unrelated host defeats all three guesses.
- **Rule for the new contract:** read `/doors`; no `podAdminUrl` means no console link (hide the verb). Never guess. This matches the `/doors` contract comment (`account-recovery/index.ts:110-113`).
- **Smell to flag (not to block):** `/doors` is an account-recovery endpoint. Hanging the general console origin on it is semantic drift. The cheap fix is a one-line note in the type's doc. The clean fix is a public `GET /api/pod/console` (or a field on an existing public info read) that both `/doors` and clients use. Recommendation: reuse `/doors` now and record the debt.

### 3.2 Sign-in continuity

- **Browser.**
  - The pod Kratos session is written to `session.defaultSession` only (`electron/main/connection/connection-manager.ts:686-724`, `writePodSessionCookie`).
  - Web tabs use `persist:browser` (`electron/main/index.ts:290`, `components/views/BrowserView.tsx:137`). Only **Control Plane** cookies are mirrored into it (`connection-manager.ts:893-896`, `:904-923`).
  - INFER (strong): a console tab opened by `openPodAdminUrl` has **no pod session**, so `proxy.ts:89-95` sends it to `/login?return=<page>`. The user signs in (password, or one click with "Continue with Synap Cloud", because the CP cookie _is_ mirrored, `LoginForm.tsx:169`) and lands back on the page.
  - Fix: mirror the pod session cookie into `persist:browser` the way CP cookies already are. Same door, plus the shared sign-out loop at `:1975-1988`. This is a **main-process change with security weight**: any page in any tab could then make credentialed requests to the pod origin, bounded by SameSite (`writePodSessionCookie` sets `sameSite: "no_restriction"`, `:721`). It needs a review and probably SameSite=Lax for the mirrored copy. DOGFOOD.
  - Also DOGFOOD: whether the Kratos cookie really is a parent-domain cookie on cloud pods (`cookie-jar.ts:5-7` says so; I could not find the Kratos cookie config in the repo). When the token came from Cloud adoption and was written host-only on `pod.` (`:703`, `:715-717`), even the main session does not cover `pod-admin.`.
- **Relay.**
  - The app holds a session token, not a cookie (`getItem('relay:sessionToken')`, `PodSecuritySection.tsx:48`).
  - `openBrowserAsync` is SFSafariViewController on iOS. Its cookies have been isolated from Safari since iOS 11, but persist within the app's own view-controller store (sources below).
  - So the first console open on a phone always asks for sign-in. Later opens _probably_ reuse it (INFER/DOGFOOD). Android Custom Tabs share Chrome's jar (vendor claim, unverified).
  - **No token→cookie handoff exists on the pod.** I searched for `continueUrl` / session transfer: the only one is the recovery-code redeem (`apps/api/src/routers/account-recovery.ts:358`).
  - A one-time "console ticket" (app token → short-lived, single-use, origin-bound URL → Kratos session on the console) would remove the prompt. But it is a **new credential-minting endpoint**: an auth design slice, not a link wave. Home Assistant's token bridge into its webview is the cautionary tale: CVE-2026-44698 let a cross-origin iframe steal the access token.
- **Plex lesson (POD-ADMIN-NEXT-DECISIONS.md D3, `:81-83`).** Never make the console the _only_ path for something the app can already do against a reachable pod. Plex's "locked out of Server Settings" article exists because the settings path depended on a second auth identity.
  - Here the risk is real if Wave 4 deletes browser Settings › Pod tabs in favour of the console _and_ the console then fails to sign in (tab partition, host-only cookie, `POD_ADMIN_URL` unset → 503 at `/admin/connect`).
  - Rule: **link in, don't remove, until sign-in continuity is verified.** The verb is hidden when `podAdminUrl` is absent.
- **Members.** A non-admin who follows an admin page link gets `/forbidden` (`proxy.ts:107-109`). Gate the verb on the client's role reading (browser `connectionStore.isPodAdmin` `:442`). The server stays the boundary.

### 3.3 Phone: in-app sheet or system browser

- **Recommendation:** use `WebBrowser.openBrowserAsync` (the in-app Safari / Custom Tab sheet), as relay already does for security.
  - It keeps the user in Relay, and Done returns to the same screen with a refetch (`PodSecuritySection.tsx:53-57` pattern).
  - Its cookies persist across opens inside Relay (INFER), so it costs one sign-in per install, not one per tap.
- Use full Safari only for a flow that must outlive the app (none here).
- **Never** use an embedded WebView with an injected token (Home Assistant CVE above).

---

## 4. Relay `synap://open/app/<id>`: what it targets and what it should do

- **What it targets.** A _desktop app manifest id_ (`marketplace`, `data`, `governance`, `settings/<section>`, `proposals/<id>`). This is browser grammar (`useDeepLinkHandler.ts:28`, `navigation/resolveDeepLink.ts:21`, `appIdAliases.ts`). The console only emits it after `placeExit` has decided the device is not a phone (`open-in.ts:191-194`, `:300-303`). Other emitters are not phone-aware: `ProposalDetail.tsx:670-672` and browser `apps/marketplaceInstallLink.ts:3`.
- **What relay does today.** `objectRouteFor('app', id)` → `/application/<id>` (`object-nav.ts:252`). That reads `app` as an App Connect application, which is a mis-route that ends in a not-found or empty holder (INFER). The 3-segment `open/app/settings/x` matches no expo route (`+not-found`).
- **What it should do: route the grammar, never pass it as an object.**
  1. `open/app/settings/<s>` → relay `/settings/<mapped s>` when a relay section covers it. That needs a small browser→relay section map: `agents`→`agents`, `trust`→`trust`, `connections`/`connectors`→`connections`. When none covers it, use the console page from the shared table (vault → `/my-vault`, connectors → `/sources`, ai-governance → `/intelligence`; the same rows as `SETTINGS_WEB_ALTERNATIVE`, `open-in.ts:211-221`). When there is no console page either, say "Open this on your computer" (an honest "Can't open this" `no-screen`).
  2. `open/app/proposals/<id>` → `/proposal/<id>`, the same as `open/proposal/<id>`.
  3. `open/app/<other>` → the console page if the table names one (`marketplace` → `/marketplace?install=<slug>` is a console receiver only if pod-admin reads `?install`; otherwise `/marketplace/<slug>`). Otherwise `no-screen`.
  4. Remove the `app:` alias from `KIND_ROUTE`, or keep it only when the id looks like an App Connect public id (`app_…`; the event spine's spelling, `object-nav.ts:247-250`). This is a decision: is `{kind:"app"}` from events ever a manifest id? Check emitters before deleting.
  5. Also add a `settings` row so the pod's `/open/settings/<s>` reaches relay settings (fixes the live dead end in §1.5).

This lives in relay `src/lib/open-link.ts` (`planOpen` gains an `app` and `settings` grammar arm) and needs a catch-all route `app/open/app/[...rest].tsx` (or `+native-intent` rewrite). Tests: `src/lib/__tests__/open-link*.test.ts` and the `object-nav` coverage test (`NAVIGABLE_KINDS`/`KNOWINGLY_UNNAVIGABLE_KINDS`, `object-nav.ts:595-601`).

---

## 5. Prior art (web)

| Product                      | Hand-off pattern                                                                                                                                                                       | Lesson                                                                                                                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tailscale**                | Admin is web-only at `login.tailscale.com/admin` (users, devices, DNS, keys). Clients send you there; the app does not duplicate it.                                                   | Clean split. Possible because the console _is_ the identity provider (no second sign-in). Our case differs: the console is on another origin with its own cookie.                 |
| **GitHub Mobile**            | Triage and review in the app; repo/org settings, collaborators and fork are not in the app. Users are sent to the browser (community-reported).                                        | Matches "relay supervises; console administers". The friction users report is having _no_ link at all. Give them the link.                                                        |
| **1Password**                | Billing / account administration on the web (`<team>.1password.com`); the 2023 mobile app moved Families member management _into_ the app.                                             | Things that change often for ordinary users migrate into the app over time. Keep the client copy for frequent acts (invite) and link for rare ones.                               |
| **Home Assistant companion** | The app _is_ a webview of the same frontend, authenticated by an app→webview token bridge (`external_auth=1`, `getExternalAuth`).                                                      | No re-login ever. But **CVE-2026-44698** (CVSS 8.3): the bridge was exposed to cross-origin iframes and leaked the token. So: do not inject the app token into a console webview. |
| **Plex**                     | Settings on the web app depend on the server being claimed by the same plex.tv account. Support article 204281528 ("Why am I locked out of Server Settings…") plus many forum threads. | **What caused lockouts:** an admin surface depending on a second identity that can desync. Keep the app able to do what it does today; the console link is additive.              |
| **Synology**                 | DS finder (mobile) does status, WOL and reboot; full admin is DSM in a browser (`:5000`), plus the cloud Active Insight dashboard for monitoring.                                      | Three tiers: phone for status and one-tap acts, web console for admin, cloud for fleet. Same as relay / pod-admin / CP.                                                           |
| **iOS / Android sheets**     | SFSafariViewController cookies are isolated from Safari since iOS 11; ASWebAuthenticationSession shares persistent (not session) cookies; Custom Tabs are Chrome-based.                | Expect one sign-in on phones. Use a persistent Kratos cookie so it sticks.                                                                                                        |

Sources:

- [Tailscale quickstart](https://tailscale.com/docs/how-to/quickstart.md)
- [Tailscale glossary](https://tailscale.com/docs/reference/glossary.md)
- [About GitHub Mobile](https://docs.github.com/en/get-started/using-github/github-mobile)
- [GitHub community #38409](https://github.com/orgs/community/discussions/38409)
- [1Password new mobile account management (2023)](https://alternativeto.net/news/2023/6/1password-releases-new-mobile-app-with-enhanced-account-management-features)
- [1Password community](https://1password.community/discussion/comment/687401)
- [HA external authentication](https://developers.home-assistant.io/docs/frontend/external-authentication)
- [HA authenticated webview](https://developers.home-assistant.io/docs/app_integration_webview)
- [CVE-2026-44698](https://osv.dev/vulnerability/CVE-2026-44698)
- [Plex: locked out of Server Settings](https://support.plex.tv/articles/204281528-why-am-i-locked-out-of-server-settings-and-how-do-i-get-in/)
- [Plex forum: locked out](https://forums.plex.tv/t/locked-out-of-server-settings/933339)
- [Synology DS finder](https://kb.synology.com/en-my/DSM/help/DSfinder/iPhone?version=6)
- [Synology Active Insight](https://www.synology.com/DSM70/ActiveInsight)
- [Branch: iOS 11 SFSafariViewController cookies](https://www.branch.io/resources/blog/ios-11-safari-view-controller-cookie-passthrough-and-the-future-of-mobile-web/)
- [Nevis: webviews](https://docs.nevis.net/mobilesdk/integration-scenarios/webviews)
- [Apple forum: ASWebAuthenticationSession cookies](https://developer.apple.com/forums/thread/750904)

---

## 6. Options

### Option A (recommended): a shared console address contract, one pure href builder, one verb per client

**Architecture.**

1. **Contract (backend `packages/types`, new subpath `@synap-core/types/console`).** A pure table of console _destinations_ that clients may address, keyed by intent rather than path:

   ```
   CONSOLE_PAGES = { home:"/home", review:"/review", keys:"/keys", members:"/members", apps:"/applications",
     computers:"/computers", agents:"/agents", sources:"/sources", marketplace:"/marketplace",
     backups:"/backups", updates:"/updates", security:"/security", accountSecurity:"/settings/security",
     recovery:"/recovery", intelligence:"/intelligence", governance:"/governance/agents" }
   ```

   Plus `consoleTarget` builders for object receivers:
   - `{page:"review", type:"access", focus}`
   - `{connectionRequest:id}` → `/connection-requests/<id>`
   - `{computer:id}`, `{application:{via,id}}`, `{key:id}` → `?focus=`

   And `consoleHref(origin, target)`: pure, and it returns null when there is no origin.

   It lives in `@synap-core/types` because it is the **only package all four consumers import**: pod-admin (backend workspace), browser, relay, and app-bases (`workspace:*`; browser `package.json:66`, relay `:40`, headless `:122`). pod-admin cannot import app-bases (`cross-repo-parity.test.ts:17-22`).

2. **Pin.**
   - Add to the pod-admin tripwire `__tripwires__/console-nav.test.ts`: every `CONSOLE_PAGES` value equals a `CONSOLE_NAV` href or a known self-service route (`/settings/security`, `/recovery`, `/connection-requests/[id]`). Each `?type=`/`?focus=` key must be a receiver the page reads.
   - pod-admin's own `console-nav.ts` must stay import-free (`:11-15`), so the test imports both. console-nav does not import types.
3. **Origin.**
   - Clients read `/doors.podAdminUrl` (already the contract). Browser: generalise `lib/podAdminDoor.ts` into `consoleDoor(target)`. Relay: add `podAdminUrl` to its doors read and a `useConsoleOrigin()`.
   - Optionally a shared `useConsoleOrigin` in `@synap-core/hooks/pod-client`, but relay and browser fetch differently (relay token `podFetch`, browser main-process `podFetch`). Keep it per-client and share only the pure parse (`publishedPodAdminOrigin` moves into the types/console module, or `@synap-core/headless/auth`).
4. **Verb.** One label from the vocabulary. `manage` exists in `packages/types/src/vocabulary/tool-labels.ts:90`. "Manage in console ↗" vs "Review in console ↗" is a copy decision. Hidden when the origin is absent or the user is not a pod admin (for admin pages).
   - Browser opens it with `openPodAdminUrl` (a tab).
   - Relay opens it with `WebBrowser.openBrowserAsync` and refetches on return.
5. **Retire the guesses.**
   - `@synap-core/headless/auth podAdminUrl` (and its `/trust-keys` caller in `apps/base` kit) moves to the published origin. Keep `/login` derivation only where `/doors` cannot be read _before_ sign-in? Note that `/doors` is public, so it can be read even then.
   - `derivePodAdminUrl` (external-connect-client) stays for CLI/Raycast, documented as a fallback.

**Reuses.** `/doors.podAdminUrl`, `podAdminDoor.ts`/`usePodAdminDoor`, relay `readDoors`, `console-nav.ts` receivers (`?focus=` everywhere, `pendingIssuerHref`), the cross-repo source-parse tripwire pattern, and `openIn`'s `SETTINGS_WEB_ALTERNATIVE` rows (which can be re-expressed from `CONSOLE_PAGES`).

**Cost.** About 1 small backend PR (types module and tripwire), 1 browser PR (verb plus access-row fix plus optional cookie mirror), 1 relay PR (verb, access rows, `open/app` and `settings` grammar), and 1 small app-bases PR (retire guess, fix `/trust-keys`). Medium overall. Mostly additive.

**Risks.**

- The types package must be rebuilt for clients: `dist/` exports (`packages/types/package.json` exports map, +1 subpath). The browser and relay cross-repo tripwires must find the new module.
- Sign-in friction remains until §3.2 is fixed.
- A `/doors` read per open. Cache it per pod in react-query.

### Option B: backend-resolved redirects for everything (`${PUBLIC_URL}/console/<page>[?focus=]` → 302 `POD_ADMIN_URL/<path>`)

**Architecture.** Extend the existing `/admin/connect` pattern (`apps/api/src/index.ts:543-559`) into a generic public `/console/:page` route in apps/api. It holds an allowlisted page table (from `@synap-core/types/console`) and returns 503 with `configure_pod_admin_url` when unconfigured. Clients need only the pod URL, which they always have. For objects, add `issuer` / `connection-request` to the dispatch so `/open/<kind>/<id>` 302s to the console receivers.

**Pros.**

- No client knows the console origin, and no `/doors` read.
- Mirrors how every agent link already works (`/open/<id>`).
- Works for CLI, MCP and email the same way.

**Cons.**

- An extra hop.
- Adding kinds to `TYPED_OPEN_KINDS` fires `open-kinds.lock.tripwire.test.ts`. It forces pod-admin `HOST_TYPES`/`BOUNCE_TYPES` changes plus a typed bounce for bots, and the `EMITTABLE_LABELS ⊆ TYPED_OPEN_KINDS` lock.
- The apps/api route table becomes a second consumer of the page list.
- It does nothing for sign-in continuity.
- A redirect on the API origin cannot know whether the client is a phone. It only knows `?client=mobile`, which must then be carried.

**Cost.** Medium on the backend, low on clients.

**When it is right.** As the **fallback** inside Option A when `/doors` has no `podAdminUrl` but the request can still go through the pod (for example, older clients). It is also the right shape for links minted _server-side_ (notifications, emails) that should open the console.

### Option C: no new contract; per-client hard-coded console paths using existing helpers

Browser extends `POD_ADMIN_PAGE` (`podAdminDoor.ts:47-50`) with keys, members, backups and so on. Relay adds its own copy. app-bases `podAdminUrl(podUrl, "/keys")`.

**Pros.** Fastest. No package change.

**Cons.**

- Three unpinned copies of console paths across repos. That is the exact defect class `open-in.ts:7-15` documents ("every single one of them broken"). The base kit's `/trust-keys` is already a live example of drift.
- It keeps the disagreeing host guesses.
- **Not recommended**, except as a one-day hotfix for the access-row dead click.

### Recommendation

**Option A**, with Option B's `/console/:page` 302 deferred, to be added only if server-minted console links (email or push) become a need. Ship the access-row fix first: it is a live dead click. Gate any removal of browser Settings › Pod twins on the browser tab-session fix being verified (Plex rule).

---

## 7. Phased build list (file ownership per repo)

**Phase 0: live bugs, independent of the contract (can ship now).**

- **relay** (`src/lib/object-nav.ts`, `src/lib/open-link.ts`, new `app/open/app/[...rest].tsx`, tests in `src/lib/__tests__/`):
  - a `settings` route row, mapping browser section ids to relay sections;
  - stop treating `open/app/<manifestId>` as an App Connect application;
  - 3-segment `open/app/settings/<s>`.
  - Failing-before tests: `planOpen({first:'settings', second:'agents'})` → route; `open/app/settings/vault` → cant-open `no-screen` (not `+not-found`).
- **browser** (`navigation/object-nav.ts` or `navigation/signal-target.ts`, `components/attention/useNeedsYouRowVerb.ts`):
  - an access-request row must not dead-click. Interim: open the console Review page through `podAdminDoor` (generalised in Phase 2), or, if Phase 2 is not ready, show the honest "Can't open this" surface.
  - Test: `objectNavTarget('issuer', …)` is non-null, or `signalNavAddress` maps `access-request` to a console target.
- **relay** (`src/components/lens/doors.ts`): access rows get a verb, not an inert row (needs the Phase 2 origin), and add `issuer` / `connection-request` to the coverage lists.

**Phase 1: contract (backend repo).**

- `packages/types/src/console/index.ts` (new folder; `packages/types/package.json` exports `./console`): `CONSOLE_PAGES`, `ConsoleTarget`, `consoleHref`, `publishedConsoleOrigin` (moved from browser `podAdminDoor.ts:53-63` logic). Plus a unit test.
- `apps/pod-admin/__tripwires__/console-nav.test.ts`: pin `CONSOLE_PAGES` ⊆ CONSOLE_NAV hrefs ∪ self-service routes; receivers (`focus`, `type`) are read by their pages.
- `apps/pod-admin/lib/open-in.ts`: re-express `SETTINGS_WEB_ALTERNATIVE` (`:211-221`) through `CONSOLE_PAGES`, so there is one table for "a console page that covers this" (optional, low risk; keep `navHref`).
- `packages/types/src/account-recovery/index.ts:107-114`: document `podAdminUrl` as _the_ console origin for every client door, not just recovery.
- Gates: `pnpm turbo run typecheck --filter=pod-admin --filter=@synap-core/types`, pod-admin `pnpm test`. No tRPC change, so no gen-types.

**Phase 2: verbs (clients).**

- **browser:**
  - `lib/podAdminDoor.ts` + `components/connection/usePodAdminDoor.ts` → `consoleDoor(target)` (keep the recovery/settings Kratos fallback).
  - Add the verb to `PodSettingsSection.tsx` (Users → `/members`, Access → `/applications`, Updates → `/updates`, Health → `/home`), `DeveloperSection.tsx` (→ `/keys`), `PodCopies.tsx`/`PodRedundancySection.tsx` (→ `/backups`), `PodAutoUpdateCard.tsx` (→ `/updates`), `CommandPalette/AttentionBand.tsx` (→ `/home`), access rows (→ `/review?type=access&focus=` or `/connection-requests/<id>`).
  - Role gate via `connectionStore.isPodAdmin`.
  - Tests: `podAdminDoor.test.ts` (extend), the render tests already beside these sections (`PodAutoUpdateCard.render.test.tsx`, `PodBackups.render.test.tsx`, `PodSecurityStatus.render.test.tsx`).
- **relay:**
  - `src/lib/account-recovery.ts` (read `podAdminUrl`; fix the stale comment `:248-251`), a new `src/lib/console-door.ts` (thin), and the verb in `app/key/[id].tsx`, `app/application/[id].tsx`, `app/agent/[id].tsx`, `app/backups.tsx`, `SettingsSectionBody.tsx` (trust / connections footers), and `components/lens/doors.ts` (access rows).
  - `PodSecuritySection.tsx`/`CantSignInSheet.tsx` move to the published origin when present.
  - Tests: `src/lib/__tests__/account-recovery.test.ts`, a new `console-door.test.ts`, and the lens doors test.
- **app-bases:**
  - `packages/headless/src/auth/pod-admin-url.ts` keeps the guess only as a documented no-`/doors` fallback, or is deleted once callers move.
  - `apps/base/lib/kit/auth-ui/components/PodConnectionRecoveryScreen.tsx:206-213`: `/trust-keys` → `CONSOLE_PAGES.keys` (or `security`), plus its test (`.test.tsx:148-154`).
  - `packages/web/src/proposals/components/ProposalDetail.tsx:670-672`: emit `synap://open/proposal/<id>` (`buildOpenProposalLink`, which already exists) instead of `open/app/proposals/<id>`.
  - Layer rule: importing `@synap-core/types/console` from headless/web is downward (fine). No new app-bases folder is needed, so no `@folder` line and no catalogue change.
  - Gates: `pnpm check:architecture`, `type-check`, `test` for touched packages.

**Phase 3: sign-in continuity (separate, security-reviewed slice).**

- **browser main:** `electron/main/connection/connection-manager.ts` mirrors the pod Kratos session cookie into `persist:browser` (same pattern as `mirrorControlPlaneCookiesToBrowser` `:904-923`; remove it on pod sign-out). Consider SameSite=Lax for the mirrored copy. The `cookie-jar.one-door.test.ts` tripwire constrains how. DOGFOOD: the console tab opens signed-in.
- **backend (optional, later):** a single-use "console ticket" (app token → short-lived URL → Kratos session on the console origin) for relay. New auth surface; needs a threat model. Not in a link wave.

**Phase 4 (only if wanted): Option B fallback.** `apps/api/src/index.ts` adds `/console/:page` (allowlisted from `@synap-core/types/console`; reuses `configuredPodAdminBase`) beside `/admin/connect`. Tests sit beside `open-dispatch` tests.

**Tripwires and tests that will fire or need updating:**

- `apps/api/src/open-kinds.lock.tripwire.test.ts`: only if Option B adds `TYPED_OPEN_KINDS`.
- pod-admin `__tripwires__/console-nav.test.ts` (new pin), `exit-door.test.ts` (if open-in changes), `cross-repo-parity.test.ts` (if browser section ids change).
- browser `navigation/deepLinkOneTable.test.ts` (no kind literals in the handler: keep the console mapping out of `useDeepLinkHandler.ts`), `apps/settingsDeepLinkSection.test.ts`, `cookie-jar.one-door.test.ts`.
- relay `object-nav` coverage tests (`NAVIGABLE_KINDS`/`KNOWINGLY_UNNAVIGABLE_KINDS`) and `test/device-one-rule.tripwire.test.ts` (reads `../synap-backend/apps/pod-admin/...`; note that its repo-relative path differs from this checkout's `backend/`).
- app-bases `check:architecture` (retired names, upward imports), `PodConnectionRecoveryScreen.test.tsx`.

---

## 8. Open product decisions (for the owner)

1. **Verb wording.** (a) "Manage in console ↗" everywhere · (b) per act: "Review in console ↗" / "Manage in console ↗" / "See all in console ↗" _(recommended: the verb says what happens next)_ · (c) "Open Pod Console ↗".
2. **Who sees admin links.** (a) admins only, hidden for members _(recommended, mirrors `proxy.ts` `/forbidden`)_ · (b) everyone, and members hit `/forbidden` · (c) everyone, member links rewritten to self-service pages (`/my-vault`, `/my-computers`, `/settings/security`).
3. **Browser Settings › Pod twins (Users / Access / CORS / Updates / Health).** (a) keep them and add the link _(recommended until Phase 3 is verified; the Plex rule)_ · (b) collapse each into a summary plus link after Phase 3 dogfood · (c) delete now.
4. **Phone sign-in.** (a) accept one console sign-in per phone (in-app sheet, persistent cookie) _(recommended now)_ · (b) build a single-use console ticket (auth slice, threat model) · (c) open the system Safari/Chrome instead (shares the user's browser session, but leaves Relay).
5. **Desktop tab session.** (a) mirror the pod session into web tabs (Phase 3; security review) _(recommended)_ · (b) open console pages in a separate dedicated window/partition that shares `defaultSession` · (c) accept a sign-in per tab session.
6. **Where the console origin is published.** (a) keep `/doors.podAdminUrl` and widen its doc _(recommended now)_ · (b) add a neutral public `GET /api/pod/console` and have `/doors` reuse it · (c) server 302 only (Option B) so clients never know it.
7. **Relay `synap://open/app/<id>`.** (a) route `settings/*` to relay sections, everything else to a console page or an honest "on your computer" _(recommended)_ · (b) treat all `open/app/*` as "on your computer" · (c) keep the `app` → App Connect alias (status quo: mis-routes).
8. **Access-request rows in the apps.** (a) "Review in console ↗" _(recommended; the console already renders them in Review)_ · (b) build approve/deny in browser and relay (a second review surface for issuer trust; prior decisions put trust decisions in the console) · (c) hide them in the apps.

---

## Verification status

- **VERIFIED (code read):** everything marked with file:line in §1–§4.
- **INFER:**
  - Relay `/application/marketplace` renders not-found or empty.
  - 3-segment `open/app/settings/x` lands on `+not-found`.
  - The browser console tab lands on `/login`.
  - SFSafariViewController keeps the console cookie between opens.
- **NEEDS-DOGFOOD:**
  - The Kratos cookie domain on cloud pods. I could not find the Kratos cookie config in `deploy/`.
  - Android Custom Tab cookie sharing.
  - A one-click Cloud sign-in on console `/login` inside a browser tab (relies on the mirrored CP cookie).
