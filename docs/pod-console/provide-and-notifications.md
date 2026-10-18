# R2 — Answering `provide` asks · Notification prefs and phones (Pod Console wave 4)

Research lane, read-only. All paths are on the `claude/clever-pascal-4v8992` checkouts. Backend paths are relative
to this repo unless stated otherwise.

---

## 0. Two facts that change the brief

1. **D3's premise is stale. The vault is NOT zero-knowledge any more.** `packages/api/src/routers/secrets-vault.ts:1-17`
   says it: `encryptionMode='server'` is the default and the **only write path**. The server encrypts with
   `VAULT_SERVER_KEY` and _can_ decrypt (`reveal` :459, `resolveVaultSecret` `packages/database/src/utils/vault-resolver.ts:335`).
   It has to, because that is how an agent redeems a granted credential. Client-mode rows are legacy and read-only.
   The console already says so: `apps/pod-admin/app/my-vault/page.tsx:14-21` ("It is not zero-knowledge, and it must
   never say so … the property a vault actually gives you is ISOLATION"). POD-ADMIN-NEXT-DECISIONS.md D3 ("client-side
   encrypted with the user's own master password … pod must never hold decryptable secrets") contradicts the code.
   **So the rule this plan keeps is the one the code actually enforces:**
   - a secret's plaintext enters only through a vault _create_ door that a human uses (`secretsVault.create` :537
     refuses an acting agent; agents use Hub `POST /vault/secrets`);
   - plaintext never goes into a slot, a room message, an event or a param (`AskProvideRefSchema` parses only
     `vault://<uuid>`; `param-slots.ts:118-123`; form asks drop credential fields);
   - nothing outside the desktop app shows plaintext again (`/my-vault` deliberately does not call `reveal`);
   - an agent reads a value only through a grant (`resolveVaultSecret(..., {requireGrant})`).
     → Owner decision **P0** below: correct D3 in the decisions doc.

2. **Server-side, `provide` is already answerable. Only the clients and two pieces of glue are missing.**
   `answerOutput` (`routers/focus-sessions.ts:2859`) → `answerSessionSlot` (`services/focus-sessions/session-answer.ts:691`)
   accepts `value: {type:'provide', ref}`. It checks shape and kind with the pure rule (`@synap-core/types/ask`
   `validateAnswerAgainstAsk`, `provide_mismatch` :741-752). It checks ownership with `checkProvideRef`
   (`services/focus-sessions/provide-ref.ts`, refusal `provide_unreachable` at session-answer.ts:735-750). And it
   writes the receipt words with `summarizeAnswer` (ask/index.ts:896-901: "Stored the secret "X" in the vault",
   "Connected Stripe"). Every client simply refuses to offer it: `ASK_COPY.provideTitle = "Not answerable here yet"`
   (`packages/types/src/ask/card.ts:64-65`) and `askRowRegion → "none"` for provide (card.ts:184).

---

## A. Answering `provide` asks

### A.1 Map of current doors

**The ask contract** (`packages/types/src/ask/index.ts`)

- Kinds: `ASK_PROVIDE_KINDS = connection | file | secret` (:82-84). The ask carries `connection{service}`,
  `file{accept?}` and `secret{name}` (:381-401).
- Answer value: `AskProvideRefSchema` (:500-512). `secret → vaultRef: vault://<uuid>`, `connection → connectionId`
  (a `secrets` row uuid with `capability_id` set), `file → fileId` (an entity uuid).
- Resolution: `resolveAskResolution` → `answer` for provide (:540-546). Refusal codes `provide_mismatch` and
  `provide_unreachable` (:604-610).
- Agents author it through MCP (`routers/mcp/tools/index.ts:390`: "'provide' (connection {service} | file {accept} |
  secret {name}, via the vault)").

**Session doors** (`packages/api/src/routers/focus-sessions.ts`)

- `owed` :2988 (owner-floored slot list), `attestOutput` :2810 (act), `answerOutput` :2859 (refuses agent keys,
  `assertKeyMayWrite`, carries `askFingerprint`), `askAboutSlot` :2894, `delegateOutput` :2657.
- Owner floor: `answerSessionSlot` loads the session with `focusSessions.userId = p.userId` (session-answer.ts:700-712).
  Only the session's owner can answer.

**What "answered" means per kind today** (`provide-ref.ts`)

| kind       | ref                               | pod check                                                                               | what the agent can do with it afterwards                                                                                                                                                                                                                     |
| ---------- | --------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| secret     | `vault://<id>`                    | live `secrets` row owned by the answerer (`secrets.user_id`). Pod-wide rows are refused | **Nothing yet.** It holds a ref but no grant, so it must file `POST /vault/request` (`hub-protocol/rest/vault.ts:135`), which is a second proposal the person approves with `secretsVault.grantAIAccess` (:942). That is two acts of consent for one intent. |
| connection | `secrets.id` with `capability_id` | owned by the answerer, or pod-wide                                                      | Usable through the capability/connector it belongs to (capability grants).                                                                                                                                                                                   |
| file       | entity id                         | `isOutputRefVisible` (same floor as output refs)                                        | Readable like any visible entity. The summary carries the file's title.                                                                                                                                                                                      |

**Vault doors**

- tRPC `secretsVault` (`routers/secrets-vault.ts`): `list` :405 (metadata), `reveal` :459, `create` :537 (human-only,
  returns `vaultRef` precisely so a review form can drop it into params), `grantAIAccess` :942 (proposal-bound),
  `listGrants`/`revokeGrant`/`usedBy`.
- Hub REST (`routers/hub-protocol/rest/vault.ts`): `POST /vault/request` + poll `GET /vault/request/:id` (agent asks to
  read), `POST/GET/DELETE /vault/secrets` (agent stores what it already holds).
- Grant write, shared: `services/vault-secret-grant.ts` (`applyVaultSecretGrant` :63, `findActiveSecretGrant` :32).
  Grants are firewalled to an agent or a workspace (`assertGrantScoped`). `focus-sessions.ts:2440-2475` already
  issues `scope:'session'` grants for capabilities.

**Connection doors**

- `connectors.session` (`routers/connectors-trpc.ts:476-551`) mints a Nango/CP-broker Connect session. It returns
  `{token, nangoHost, connectLink}` (it can restrict to one provider).
- `connectors.connections` (:422) is the post-OAuth refetch. It mirrors new connections into `tools` / `secrets`
  (`mirrorObservedConnections` :101, `reconcileLiveConnections`). **It returns Nango connections, not the `secrets`
  row id that `AskProvideRef.connectionId` needs.**
- `capabilities.credentials.list({capabilityId})` (`routers/capabilities.ts:840`) does return `secrets` rows, but it
  is keyed by capability. The ask is keyed by `service`. **No door answers "my usable connection rows for service X".**
- Console: `/connect` (`apps/pod-admin/app/connect/page.tsx`) mints **integration keys** (CLI/Raycast/MCP), not
  third-party OAuth. `/oauth/consent` is the pod's own OAuth server. Neither is a Nango connect host. `/sources` is
  the admin aggregate (`connectors.providers`, `allConnections`), and it hands editing off to the app.
- Clients: `@synap-core/web/connectors` `useConnectors` (app-bases `packages/web/src/connectors/hooks/useConnectors.ts:138-230`)
  covers web (popup on `connectLink` / `@nangohq/frontend`) and Electron (`openOAuthWindow`). The browser has a
  tripwire, `electron/renderer/src/__tripwires__/connectors-session-one-door.test.ts`. Relay has its own
  `src/hooks/useConnectors.ts` + `useConnectionSync.ts` (system browser).

**File doors**

- `POST /api/files/upload` (multipart) and presigned `POST /api/files/uploads` + `/uploads/finalize`
  (`routers/file-upload.ts:537,736,771`, mounted at `apps/api/src/index.ts:1183`). Kratos cookie, guests refused,
  **`workspaceId` required** (`canWriteWorkspace`). The entity is created as `file`. `focus_sessions.workspace_id`
  is nullable (a project-only session has none). This is a gap for a file answer.
- `files.*` tRPC is podAdmin MinIO browsing. It is not an answer door. MCP `store_file` is the agent-side twin.
- Clients: browser `electron/renderer/src/hooks/usePodFileUpload.ts`, relay `src/lib/pod-file-upload.ts`
  (+ `useAskAttachments`, expo-document-picker / image-picker). The console has none.

**Ready-made "type a new key or pick one" control (the main reuse)**

- `ProposalSetupSection` (app-bases `packages/web/src/proposals/components/ProposalSetupSection.tsx`) does this for
  capability installs. It offers a segmented existing-secret / new-key control (`vaultChoicesFrom`, `runSetupSubmit`
  in `packages/headless/src/property-renderer/proposalSetup.ts:432,527`). It writes vault-first:
  `secretsVault.create` → `vaultRef`, then `proposals.revise`. Its connection step is a door, never a text box.
- Relay twin: `src/features/decide/ProposalSetupSection.tsx`, `setup-submit-doors.ts`, `src/components/secret-picker-state.ts`.
- Browser: `stores/secretsStore.ts`, `components/system-requests/VaultRequestFloatingCard.tsx`. app-bases kit:
  `apps/base/lib/kit/vault/components/VaultRequestCard.tsx` (the vault.request grant card).

**Clients today**: console `review/_lib/ask-answer.tsx:444-462` (provide gets an Alert plus "Open in app"),
browser `components/sessions/AskCard.tsx:244`, relay `src/components/session/AskAnswer.tsx:581`. All three show
"Not answerable here yet".

### A.2 Who can do each kind safely, and what is missing server-side

| kind           | console (web)                                                                                                                                      | desktop                                                   | phone                                                                                        | missing server-side                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **connection** | Yes. OAuth is web-native. Popup or redirect on `connectLink`. Needs ~40 lines of glue (no `@synap-core/web` in pod-admin)                          | Yes. `useConnectors` (Electron OAuth window)              | Yes. Relay `useConnectors` in the system browser (RFC 8252)                                  | **(S1)** the answer must find the `secrets` row id. Best done server-side: _connect-and-answer_ (below). **(S2)** confirm that `ask.provide.service` uses the Nango integration `uniqueKey` vocabulary (or map it)                                                                                                                                                                                                                                                           |
| **file**       | Yes, with a new small upload control (`/api/files/upload` + cookie; check CORS on the pod origin as tRPC does)                                     | Yes. `usePodFileUpload`                                   | Yes. `pod-file-upload` + picker                                                              | **(S3)** a workspace for the upload when the session has none: pass the session's workspace, else the project's home space, else refuse with words. Optional `accept` re-check server-side                                                                                                                                                                                                                                                                                   |
| **secret**     | Possible but sensitive. Write-only entry is safer than `reveal`, yet it goes against the `/my-vault` "does not author" rule. **Owner decision P1** | Yes. The vault lives here. Reuse the setup secret control | Yes. Relay already types new keys in ProposalSetup (masked, secure-store-free, never echoed) | **(S4)** one consent, not two: answering with a secret should also write a **session-scoped grant** for the asking agent (`applyVaultSecretGrant`, scope `session`, TTL). Otherwise the agent must file `vault.request` and the person approves again. **(S5)** who is the grantee: the session has no `agent_user_id` column. Resolve the declaring agent of the slot (slot metadata / session origin), else scope to the session's workspace (wider, so owner decision P2) |

Cross-kind server gap **(S6)**: one read door so clients don't each work out "what can I hand over":
`focusSessions.provideOptions({sessionId, expectedLabel})` →

- `connection`: `{ connectable: boolean, rows: [{id, label, accountHint, podWide}] }`, the person's usable rows for
  this service (the same floor as `checkProvideRef`);
- `secret`: `{ rows: [{ref, name, type}] }`, the person's own vault metadata (never values; same as `secretsVault.list`);
- `file`: `{ workspaceId | null, accept }`, where the upload will land.
  It is owner-floored like `owed` and is a pure projection of existing reads.

### A.3 Prior art

- **MCP elicitation (2025-11-25 and the 2026 draft)**: servers MUST NOT ask for passwords, API keys or tokens in
  _form_ mode. They use _URL mode_, where the value never passes through the client or model, only a URL the client
  opens after showing the host. Our `provide` is exactly this split (`form` drops credential fields; `provide` hands
  over a reference). A hosted provide page would be our URL mode.
  [spec](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation.md),
  [draft](https://modelcontextprotocol.io/specification/draft/client/elicitation.md)
- **GitHub Codespaces "recommended secrets"**: `devcontainer.json` names a secret (name, description, docs URL). The
  person is prompted at creation in a dedicated settings form, the value is stored as a user secret, and supplying it
  is optional. Name and purpose come from the requester, the value goes through the platform's own door. That
  matches our `provide{secret{name}}`.
  [docs](https://docs.github.com/en/enterprise-cloud@latest/codespaces/setting-up-your-project-for-codespaces/configuring-dev-containers/specifying-recommended-secrets-for-a-repository).
  GitHub Actions masks secrets in logs. That is the fallback layer, not the design.
- **1Password Connect / Secrets Automation, Doppler**: machines get _references_ (`op://vault/item/field`, Doppler
  service tokens scoped to one config), and the human manages values in the vault UI. A ref plus a scoped,
  revocable token is the norm. Our `vault://` ref plus a scoped `vault_grants` row is the same shape.
- **Zapier / n8n "connect an account to continue"**: the step that needs auth shows a Connect button inline, and
  OAuth happens in a popup. Afterwards the new account is _selected automatically_ in the step (the user never copies
  an id). Repair sits beside the broken thing. That is the argument for connect-and-answer.
- **Slack-hosted agents (eve, Kortix, Inkeep patterns)**: a public, link-free status in the thread and the sign-in
  challenge _ephemerally to the one user_. After linking, the original request resumes. Lesson: the room shows "waiting
  for your Stripe connection". Only the owner's surface carries the door, and the work resumes on completion.
  [eve docs](https://cdn.jsdelivr.net/npm/eve@0.12.0/docs/channels/slack.mdx)
- **ChatGPT / Claude connectors**: an OAuth handoff to the provider in the browser, back to the chat, and the tool call
  retries. Tokens never enter the transcript.
- **What failed**: secrets pasted into chat or tickets (GitGuardian-style leak reports from Slack, Jira and LLM
  transcripts). Once in a transcript, a secret ends up in logs, embeddings and backups and can't be recalled. Two-step
  "approve the ask, then approve the grant" flows cause approval fatigue. Asking in a form field and relying on
  redaction later leaks under prompt injection. Our code already blocks all three at the parse. The remaining risk
  is UX-driven: a person who sees "not answerable" pastes the key into "Talk it through". **Today's dead end
  actively pushes people toward the failure mode.** That is the strongest argument for shipping A soon.

### A.4 Options

**Option A1: native per client, console stays a handoff.**
Desktop and phone each wire the three kinds from their existing primitives. The console keeps "Open in app" and
"Ask the agent".

- Reuse: high per client (setup secret control, `useConnectors`, upload hooks).
- Cost: medium-high. Two client repos × three kinds, plus `@synap-core/types` card changes.
- Risk: Review in the console stays a dead end for provide. That is the Plex warning in reverse: the agent waits on
  an app that may not be open.

**Option A2: one hosted provide page on the pod (MCP URL-mode style).**
`/provide/<sessionId>?slot=<label>` in pod-admin does all three kinds. Desktop, phone, MCP clients and Review open or
embed it.

- Reuse: one implementation.
- Cost: medium. It also needs an **auth handoff into a system/in-app browser for phones** (relay signs in through
  the CP and its Kratos cookie is not in the system browser), which means a one-time code door.
- Risk: secret entry on a shared web machine (owner P1). The console becomes a dependency for something the
  desktop already does (D3's Plex warning). Desktop users leave the app.

**Option A3 (recommended): server first, then each kind where it is naturally safe.**

1. Server glue that every client shares: `provideOptions` (S6), **connect-and-answer** (S1), **secret answer =
   ref + session grant in one act** (S4/S5), file workspace resolution (S3).
2. **Connection: every surface, console included.** OAuth already belongs on the web.
3. **File: every surface.** Upload doors exist everywhere.
4. **Secret: desktop + phone natively** (the existing setup secret control). The console gets "Add it in the
   app" by default, or write-only entry if the owner chooses (P1).

- Reuse: maximal. The ask contract, answer door, `checkProvideRef`, `applyVaultSecretGrant`, `connectors.session`,
  upload doors and the setup secret control are all reused. The only new doors are `provideOptions` and an optional
  `answerFor` on `connectors.session`.
- Cost: medium. About 1 backend slice + 1 console slice + 1 browser slice + 1 relay slice + types copy.
- Risk: low. Connect-and-answer needs an idempotent matcher (below).

**Connect-and-answer (the core of A3).** `connectors.session` gets an optional `answerFor: {sessionId, expectedLabel,
askFingerprint}`. The pod checks that the caller owns the slot and that the ask is `provide/connection` for this
provider, then records a short-lived pending intent (a small table, or slot metadata `providePending{startedAt,
provider}`, TTL ~30 min). When `reconcileLiveConnections` (connectors-trpc.ts:129, also the Nango webhook path)
materializes a **new** `secrets` connection row for (user, provider) while an intent is pending, the pod calls
`answerSessionSlot` itself with `{type:'provide', ref:{kind:'connection', connectionId}}`. Two cases:

- An existing row: the client answers directly with the id from `provideOptions` ("Use my existing Stripe account").
- OAuth finished in a phone's system browser: the app lost context, but the slot still gets answered. This matches
  how Zapier auto-selects the new account.
  The fingerprint guard (`ask_changed`) prevents answering a re-asked slot.

### A.5 Effects across repos

- `@synap-core/types/ask` (backend `packages/types`): `askRowRegion` stops returning `none` for provide kinds a host
  can answer. It should take `{canProvide: Partial<Record<AskProvideKind, boolean>>}` so each surface declares what
  it wires. `ASK_COPY` gains provide words ("Connect Stripe", "Use an existing account", "Upload a file", "Add the
  secret", plus a receipt). `provideTitle`/`provideBody` stay for unwired kinds. Tests: `card.test.ts`, `ask.test.ts`.
  **This is a contract change that browser, relay and app-bases consume via workspace link, so land the types change
  backward-compatibly first (new option is optional, default = today's `none`).**
- app-bases: no layer move needed. The secret control already lives in `@synap-core/headless/property-renderer` +
  `@synap-core/web`. If desktop's ask card wants it, import from `@synap-core/web/proposals` or factor a
  `ProvideSecretField` into `@synap-core/web/property-renderer` (extend the existing folder; no new folder, so
  `check:architecture` / FOLDERS.md are unaffected). Retired-name check: none of the names used are retired.
- browser: `connectors-session-one-door` tripwire. The connect step must go through `useConnectors`, never a second
  `connectors.session` caller. Relay `test/ask-card-wiring.test.ts` and `session-ask-inline.render.test.ts` pin the
  `none` region. Update them with the change.
- Backend tests: `focus-sessions.ask-doors.test.ts` / `door-parity.test.ts` (add provide-with-grant), a new
  `provide-options` pglite test, a connect-and-answer pglite test (intent → reconcile → answered once, re-ask →
  not answered), `secrets-vault.agent-refused.test.ts` stays green.
- gen-types: `focusSessions.provideOptions` and the `connectors.session` input change require
  `pnpm --filter @synap/api gen-types` + `gen-types:check`.

### A.6 Phased build list (file ownership)

| phase     | lane            | owns                                                                                                                                                                                                                                                                                      | content                                                                                                                        |
| --------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| A-0       | docs (backend)  | `POD-ADMIN-NEXT-DECISIONS.md`                                                                                                                                                                                                                                                             | Correct D3's vault premise (after P0)                                                                                          |
| A-1       | backend         | `services/focus-sessions/provide-options.ts` (new), `routers/focus-sessions.ts` (provideOptions), `services/focus-sessions/session-answer.ts` + `provide-ref.ts` (grant on secret answer, via `services/vault-secret-grant.ts`), file-workspace resolver, tests, `packages/api-types` gen | S3, S4, S5, S6                                                                                                                 |
| A-2       | backend         | `routers/connectors-trpc.ts` (`answerFor`), `services/capabilities/capability-connections.ts` / the reconcile path, intent store (+ hand-written migration if it is a table), tests                                                                                                       | S1 connect-and-answer; S2 service-id check                                                                                     |
| A-3       | types (backend) | `packages/types/src/ask/card.ts` (+ tests)                                                                                                                                                                                                                                                | `askRowRegion` per-kind capability, provide copy (backward-compatible)                                                         |
| A-4       | console         | `apps/pod-admin/app/(admin)/review/_lib/ask-answer.tsx`, `ask-detail.ts` (+ test), new `_lib/provide-connect.ts` (pure state)                                                                                                                                                             | Connection (popup → wait → answered), file upload, secret = handoff or write-only (P1). Shared primitives only                 |
| A-5       | browser         | `components/sessions/AskCard.tsx`, `ask-card-model.ts`, `cells/OwedSlotDetailCell.tsx`                                                                                                                                                                                                    | All three kinds via `useConnectors`, `usePodFileUpload`, the setup secret control                                              |
| A-6       | relay           | `src/components/session/AskAnswer.tsx`, `src/lib/ask-card-model.ts`, tests                                                                                                                                                                                                                | All three kinds via relay `useConnectors`, `pod-file-upload`, `secret-picker-state`                                            |
| A-7 (opt) | backend         | `param-slots.ts`                                                                                                                                                                                                                                                                          | A credential-named param slot becomes `provide{secret}` writing the `vault://` ref into params, instead of "Set it on the run" |

A-1, A-2 and A-3 can run in parallel. A-4, A-5 and A-6 come after A-3 lands (and after A-1/A-2 for the doors).

### A.7 Owner decisions

- **P0**: Accept that the vault is server-encrypted (isolation, not zero-knowledge) and fix D3's text?
  _Recommended: yes._ The code and `/my-vault` already say so.
- **P1**: May the console accept a **new** secret (write-only, masked, never shown back)?
  (a) No, the console offers "Add it in the app" (recommended for now; keeps `/my-vault` "does not author").
  (b) Yes, in Review only, write-only.
  (c) Yes, plus a "New secret" action on `/my-vault`.
- **P2**: Does handing over a secret also let the asking agent read it?
  (a) Yes, a session-scoped grant to that agent, TTL 60 min, shown in the receipt ("Stripe key · the agent can use it
  for this session"). Recommended.
  (b) No, the agent files `vault.request` and you approve again.
  (c) A pills choice (Once / Session / Always) as `grantAIAccess` has.
  If the agent can't be identified, should the grant be refused or workspace-scoped? _Recommended: refuse, so the
  agent asks via `vault.request`._
- **P3**: A file with no session workspace: upload to the project's home space, or refuse?
- **P4**: Is "Use an existing connection" one tap, or does it confirm which account (accountHint) when there are
  more than one?

---

## B. Notifications: push preferences and phones

### B.1 Map

- **Storage**
  - Devices = `messaging_accounts` rows with `provider='expo'`. Unique key `(user_id, provider, external_id=token)`.
    `status` is `connected` or `disconnected`, `metadata{platform, deviceName, appVersion}`, `updated_at`. There is
    no last-seen and no last-delivery column (`packages/database/src/schema/messaging-accounts.ts`).
  - Push categories = `notification_preferences.push_prefs` on the person's **pod-wide** row, stored sparse
    (`packages/api/src/notifications/push-prefs.ts`, migration 0289). The contract is `@synap-core/types/push`:
    `PUSH_CATEGORIES` (blocking-ask, decision-blocking, work-broke, mention, system), policy, labels and
    `pushPrefsView`.
  - Quiet hours / mute / routing = `getPrefs`/`updatePrefs` (`workspaceProcedure`, pod scope by default).
- **Doors** (`packages/api/src/routers/notif-center.ts`)
  - `pushPrefs` :517 and `setPushPrefs` :525 (agent keys refused).
  - `registerDevice` :570 (Expo token regex; upsert flips the row back to `connected`).
  - `unregisterDevice` :611 (**by token only**, owner-floored, sets `disconnected`).
  - `listDevices` :634 (own rows, id/displayName/status/metadata/dates, no token).
  - `getPrefs` :358, `updatePrefs` :408, `requestHandoff` :672.
  - **Revoke by id does not exist.** `listDevices` has **no consumer in any repo**.
- **Sending**
  - `notifications/expo-push.ts` reads only `connected` rows (:89-104).
  - A `DeviceNotRegistered` **ticket** marks the row `disconnected` (:50, :237).
  - **Expo receipts are never fetched.** Most `DeviceNotRegistered` errors arrive in receipts, so dead tokens linger.
- **Relay**
  - `src/lib/push-registration.ts:117-145` registers on every session start (`SynapProvider.tsx:544-550`), but it
    **short-circuits locally when the token is unchanged**. The comment says "nothing else clears" the row, which is
    already false (dead tickets clear it) and becomes worse with remote revoke: a phone revoked from the console stays
    silently revoked while the phone believes it is registered.
  - It sends **no `deviceName`**, so every row reads "ios device" or "android device". A list would be unusable.
    `expo-constants` is installed (`Constants.deviceName`).
  - Categories UI: `src/features/phone/PushCategoryList.tsx` + `src/hooks/usePushPrefs.ts` (in Settings). Sign-out
    unregisters (`SynapProvider.tsx:854`).
- **Desktop (browser)**: `components/settings/NotificationsSection.tsx` covers in-app prefs only. No push categories,
  no phone list. Desktops are reached over the socket `user:<id>` room, not push, so they are not "devices" here.
  Computers (`machines.*`, `/my-computers`) are a separate registry for CLI/desktop agent keys.
- **app-bases**: `@synap-core/web/notifications` `NotificationPreferences.tsx` (getPrefs/updatePrefs), with no push.
- **Console**: nothing. The self-service pattern exists: `PERSONAL_LINKS` in
  `app/(admin)/components/top-nav.tsx:51-55` (My connections / My computers / My vault, plus Security) and
  `lib/route-policy.ts:55-95` (owner-floored self-service exemptions with a test in `route-policy.test.ts`).

### B.2 Prior art

- **Home Assistant Companion**: each phone is a "Mobile App" integration entry and its own `notify.mobile_app_<id>`
  target. Removing a phone means deleting that entry. A known pain point is that reinstalling re-registers a
  duplicate, and old refresh tokens linger, so users have to revoke them separately. Lessons: name devices after the
  device, de-duplicate on re-register, and make "remove" mean the phone also stops trying.
  [HA community](https://community.home-assistant.io/t/how-to-delete-devices/254111/26),
  [stale devices rule](https://developers.home-assistant.io/docs/core/integration-quality-scale/rules/stale-devices)
- **Slack / Linear / GitHub preferences**: per-person, few categories, plus a schedule (quiet hours / DND) and a
  "mobile only when inactive on desktop" rule. GitHub keeps a per-channel matrix (web / email / mobile) per event
  family. Linear has per-channel toggles for a short list of events. None of them shows an admin other members'
  devices. Our category set already follows the "push only if blocked on you or something broke" rule.
- **Apple / Google / Expo hygiene**: stop sending on `Unregistered`/`DeviceNotRegistered`. Fetch **Expo receipts**
  (ticket id → receipt) to learn about dead tokens. FCM recommends refreshing tokens on app open, keeping a
  timestamp, and pruning tokens not refreshed in about a month (FCM itself treats inactive >270 days as expired).
  Re-registering on every launch is the norm, which argues against relay's local short-circuit.
  [Expo forum: receipts ↔ tickets](https://forums.expo.dev/t/expo-push-api-how-to-identify-failed-token-from-error-message/61464),
  [Expo: stop sending on DeviceNotRegistered](https://forums.expo.io/t/how-to-properly-handle-push-notification-errors/31424),
  FCM token management (firebase.google.com/docs/cloud-messaging/manage-tokens).

### B.3 Options

**Option B1 (recommended): "Notifications" self-service page in the console + backend hygiene + relay list.**

- Backend:
  - `notifCenter.revokeDevice({id})`: owner-floored, refuses agent keys, sets `status='revoked'` plus
    `metadata.revokedAt` (distinct from `disconnected`, which means sign-out or a dead token).
  - `registerDevice` answers `{status:'connected'|'revoked', id}` and **does not** flip a `revoked` row back unless
    the device sends `reenable:true`, which happens only when the person turns push on from that phone.
  - `listDevices` adds `isThisDevice` (when called with `token`, or via a token fingerprint), `lastRegisteredAt` and
    `lastDeliveredAt`/`lastError`.
  - Expo **receipt job** in `packages/jobs`: store ticket ids briefly, fetch receipts about 15 minutes later, and
    disconnect on `DeviceNotRegistered`.
  - **Stale sweep**: rows not re-registered in N days read as "Not seen since …", and after M days are disconnected.
- Console `/my-notifications` (avatar menu "Notifications"):
  - a SectionCard of push categories from `pushPrefs` / `setPushPrefs`, labelled with `PUSH_CATEGORY_LABELS`;
  - a SectionCard of phones (ResponsiveTable: name, platform, app version, last seen, StatusPill), "Stop
    notifications to this phone" in a confirm modal, plus `?focus=` support;
  - quiet hours later (they need `getPrefs`, which is a `workspaceProcedure`; the console sets no workspace header,
    so this needs a pod-scope read or a `context.workspaceId`).
- Relay:
  - drop the local short-circuit (one cheap upsert per launch) and react to `revoked` ("Notifications were turned off
    for this phone from another device · Turn back on" → `reenable:true`);
  - send `deviceName` from `expo-constants`;
  - optionally show "Your phones" under the existing PushCategoryList.
- Shared shaping: a pure `deviceView(row, now)` (label, platform word, last-seen words, status) in
  `@synap-core/types/push` so the console and relay don't fork the words.
- Cost: medium (backend 1 slice + jobs, console 1 page, relay small). Risk: low. The revoke semantics are the subtle
  part and are covered by tests.

**Option B2: phone-only.** Relay gets a device list and remote revoke. The console stays silent.

- Cost: lower. But you can't silence a lost phone from the desk, which is the main reason to have a list at all
  (Home Assistant and Google "Your devices" are managed from the web). Not recommended.

**Option B3: one "My devices" registry** merging computers (`machines`) and phones (`messaging_accounts`).

- Matches how people think ("my devices"). But the two are different objects: a computer is a key holder with
  agents, and its revoke cuts keys. A phone is a delivery address, and its revoke stops pushes. Merging tables is
  large and risky.
- A **UI-only** compromise could come later: `/my-computers` and `/my-notifications` cross-link. Not now.

### B.4 Effects across repos

- Backend: `routers/notif-center.ts`, `notifications/expo-push.ts`, a new receipts job in `packages/jobs`, a schema
  change only if `last_seen_at`/`last_delivered_at` become columns (a hand-written migration; or keep them in
  `metadata`). Tests: `notif-center.push-prefs.pglite.test.ts` and a new `notif-center.devices.pglite.test.ts`
  (revoke by id floors on owner; a revoked row survives a plain re-register; `reenable` flips it; agent key refused;
  another user's id gives the same NOT_FOUND). gen-types.
- `@synap-core/types/push`: `deviceView` + copy (`push.test.ts`).
- Console: `top-nav.tsx` PERSONAL_LINKS, `lib/route-policy.ts` + its test (a new self-service exemption with an
  owner-floor comment), the new page, `_lib/devices-model.ts` + test.
- Relay: `src/lib/push-registration.ts` (+ tests), `useNotifications.ts`, `PushStatusRow.tsx`; the
  `write-effects.ts` entry for `notifCenter.revokeDevice` → invalidate `notifCenter.listDevices`.
- Browser / app-bases: none required. Optional later: push categories in `@synap-core/web/notifications` for desktop
  settings, reusing `@synap-core/types/push`.

### B.5 Phased build list

| phase | lane         | owns                                                                                                        | content                                                                                       |
| ----- | ------------ | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| B-1   | backend      | `routers/notif-center.ts`, `notifications/expo-push.ts`, tests, api-types gen                               | revokeDevice(id), revoked-vs-disconnected, registerDevice status/reenable, listDevices enrich |
| B-2   | backend jobs | `packages/jobs/*` (receipt worker), `notifications/expo-push.ts` (ticket id capture)                        | Receipts + stale sweep                                                                        |
| B-3   | types        | `packages/types/src/push/index.ts` + test                                                                   | `deviceView`, copy                                                                            |
| B-4   | console      | `app/my-notifications/*` (new), `top-nav.tsx`, `lib/route-policy.ts(+test)`, `_lib/devices-model.ts(+test)` | Categories + phones page                                                                      |
| B-5   | relay        | `src/lib/push-registration.ts`, `src/hooks/useNotifications.ts`, `src/features/phone/*`, `write-effects.ts` | No short-circuit, deviceName, revoked state, optional phones list                             |

B-1 must land before B-4 and B-5. B-2 is independent.

### B.6 Owner decisions

- **N1**: Where does the console page live? `/my-notifications` in the avatar menu (recommended; matches
  `/my-computers`), or a tab on `/settings/security`.
- **N2**: Can a pod admin see or revoke _members'_ phones? _Recommended: no._ Phones are personal delivery addresses,
  and none of Slack, Linear or GitHub does this. Member removal already cuts sessions.
- **N3**: Does a phone revoked from elsewhere stay off until turned on _from that phone_ (recommended), or come back
  on the next app launch?
- **N4**: Stale policy. Mark "not seen" after 30 days and stop sending after 90 (recommended), or follow FCM's 270.
- **N5**: Quiet hours in the console now (needs a pod-scope read of `getPrefs`), or categories and phones only first
  (recommended)?
