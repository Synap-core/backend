# Pod Console — wave 5 plan: finish the thesis

> Follows `POD-CONSOLE-WAVE3-PLAN.md`. Wave 4 shipped the obvious follow-ups (see "Wave 4 shipped" below).
> This plan covers what needs a product decision. Each topic has a detailed research plan with file:line
> evidence, prior art and per-repo file ownership in `docs/pod-console/`:
> [link-in.md](docs/pod-console/link-in.md) ·
> [provide-and-notifications.md](docs/pod-console/provide-and-notifications.md) ·
> [open-hosting-and-catalog-signing.md](docs/pod-console/open-hosting-and-catalog-signing.md).

## The thesis, and what is left of it

The console is where you operate the pod (`POD-ADMIN-CONSOLE-PLAN.md` §1). The console itself is built. Two halves of
the thesis are still open:

1. **The apps don't link IN.** Browser and relay have no "Review / Manage in console ↗" verb. Access-request rows are
   dead clicks in browser and inert in relay.
2. **Agents still get stuck on asks nobody can answer.** `provide` asks (a secret, a file, a connection) can't be
   answered anywhere. That pushes people toward pasting secrets into chat, the exact failure the ask design exists to
   prevent.

Smaller gaps: more kinds that open on the web, a notifications page, and Synap's own catalog unsigned.

## Recommended order

| #   | Slice                                                                                                                                                                                                                   | Why this order                                                                       | Detail                                 |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------- |
| 0   | **Owner dogfood of waves 3–4**                                                                                                                                                                                          | Everything below builds on it                                                        | checklist in the wave-4 report         |
| 1   | **Link IN (Option A):** a shared console address contract in `@synap-core/types/console`, pinned by a pod-admin tripwire; one verb per client; access rows fixed                                                        | Finishes the thesis; mostly additive                                                 | link-in.md §6–7                        |
| 2   | **Answer `provide` asks (Option A3):** server doors first (`focusSessions.provideOptions`, connect-and-answer, a session-scoped grant on a handed-over secret, a file-landing rule), then each surface where it is safe | Unblocks agents; removes the reason to paste secrets                                 | provide-and-notifications.md §A        |
| 3   | **Host playbook, run and capability-enable on the web `/open`**, plus `?flowType=` on the public route                                                                                                                  | Every MCP link lands somewhere useful on any device                                  | open-hosting-and-catalog-signing.md §A |
| 4   | **Notifications (B1):** revoke a phone by id, receipts plus a stale sweep, a `/my-notifications` page, relay fixes                                                                                                      | Lost-phone hygiene; dead tokens pile up today                                        | provide-and-notifications.md §B        |
| 5   | **Sign Synap's catalog (S1):** the Control Plane serves a signed digest index; the pod checks it in report-only mode, then enforces                                                                                     | The official catalog is an auto-update channel (it converges installed capabilities) | open-hosting-and-catalog-signing.md §B |
| 6   | **Sign-in continuity:** the desktop tab shares the pod session; a phone ticket (optional)                                                                                                                               | Each "in console" link costs a sign-in until then; needs a security review           | link-in.md §7 Phase 3                  |

## Decisions for the owner

Recommended option first. Answer by number.

**Link IN**

- L1 Verb wording: per action ("Review / Manage / See all in console ↗") · one "Manage in console ↗" · "Open Pod Console ↗".
- L2 Who sees admin links: admins only · everyone (members hit `/forbidden`) · everyone, rewritten to self-service pages.
- L3 Browser Settings › Pod duplicates: keep them and add the link until sign-in continuity is verified (the Plex lockout rule) · collapse each to a summary plus link · delete now.
- L4 Phone sign-in: one console sign-in per phone (in-app sheet) · build a single-use ticket · open the system browser.
- L5 Desktop tab sign-in: mirror the pod session into tabs (security-reviewed) · a dedicated console window · sign in per tab.
- L6 Where clients read the console address: `/doors.podAdminUrl` (already published) · a new neutral endpoint · a server 302 only.
- L7 Relay `synap://open/app/*`: settings go to relay screens, the rest to the console or an honest "on your computer" · everything says "on your computer" · status quo (it mis-routes).
- L8 Access-request rows in the apps: "Review in console ↗" · build approve/deny in the apps · hide them.

**Provide asks**

- P0 The vault is encrypted on the server (isolation, not zero-knowledge). `POD-ADMIN-NEXT-DECISIONS.md` D3 says otherwise. Fix D3's text: yes · no.
- P1 May the console accept a new secret: no, it says "add it in the app" · yes, write-only in Review · yes, plus "New secret" on `/my-vault`.
- P2 Handing over a secret also lets the asking agent read it: yes, a session-scoped 60-minute grant shown in the receipt · no, the agent requests it again · a Once / Session / Always choice. If the agent can't be identified: refuse.
- P3 A file with no session space: put it in the project's home space · refuse.
- P4 Reusing an existing connection: one tap · confirm the account when there are several.

**Notifications**

- N1 Page: `/my-notifications` in the avatar menu · a tab on `/settings/security`.
- N2 Admins see members' phones: no · yes.
- N3 A phone turned off from elsewhere: stays off until re-enabled on that phone · comes back on next launch.
- N4 Stale phones: marked "not seen" at 30 days, stop sending at 90 · FCM's 270.
- N5 Quiet hours: later · now.

**Web `/open`**

- A1 Scope: playbook, run and capability-enable now, agent after A4 · run and playbook only · all four.
- A2 Forward `?flowType=` on the public route (second forwarded param, after `?view=`): yes · no.
- A3 Capability on the web: enable only (connecting stays in the app); `opensIn` becomes per action (an api-types and CLI contract change): yes · no. Its home: `/open/capability/<id>` only · plus a console object page.
- A4 May a pod admin read another member's agent (DECISIONS bug 6): yes · no. Until decided, agent links stay bounced.
- A5 A workspace link for an admin: add "See this space here" to the bounce card · keep the bounce only.

**Catalog signing**

- B1 Signed digest index now (S1), Synap as "just another source" later (S2) · S2 now · TLS only.
- B2 Keys: two offline roots baked into releases, signing a ≤90-day online catalog key, plus an operator override for private mirrors · trust on first fetch (rejected: every new pod's first sync is the attack window).
- B3 Expiry: daily re-sign, 14-day validity; on freeze, keep listing but stop installing and converging · other.
- B4 Air-gapped escape `SYNAP_CATALOG_ALLOW_EXPIRED=1` (env only): yes · no.
- B5 Root key custody and the date of the key ceremony; the Control Plane team's slot for its side.

**Small calls found in wave 4**

- S1 The space API-keys tab lists every key owned by a space member, including their pod-wide keys. Should it list only keys confined to that space (`apiKeys.workspaceId`)?
- S2 An admin can't see app or computer events done by another member (events with no space are shown only to their actor). Add an admin audit read by subject? (A pod-admin-only door, with `appId` and subject filters.)
- S3 Re-installing a third-party pack onto its base space is refused on the pack's own automations, because automations carry no package stamp. Stamp automations at install (`package-apply-post-workspace.ts`) so the exemption works?
- S4 The product name still reads "Pod Admin" in app-bases (recovery copy, hub tile). Rename to "Pod Console" everywhere?
- S5 Relay billing links: route desktop `billing` to relay's `/credits` screen? (One line.)

## Wave 4 shipped (for reference)

Backend branch `claude/clever-pascal-4v8992`, plus the same branch in browser, relay-app and app-bases:

- **Marketplace safety:**
  - A removed source's id stays bound to its key.
  - Template automations and playbooks can't overwrite same-named ones.
  - Reusing your existing connection needs an explicit confirm.
  - The removal race and the localhost guard are verified on real engines.
- **Console:**
  - Activity tabs on every app page.
  - Rules on the shared table.
  - 152 muted-text sites raised to AA.
  - Run links keep their flow type.
  - The consent page shows when the app registered.
  - The `/open` card shows "Updated".
- **Backend hygiene:**
  - `main`'s red tests fixed.
  - Sibling-repo tests skip with a reason when the sibling is absent.
  - Lint errors fixed.
  - Keys carry `workspaceId`.
  - Rate-limit variables are settable.
  - Upgrade notes added in `deploy/README.md`.
- **Cross-repo:**
  - The recovery screen links to Pod security.
  - The desktop health band counts verbs not turned on.
  - Agent screens stay calm on NOT_FOUND.
  - Relay opens settings links and proposal links.

## Cleanup to schedule

- Drop the diagnose `capabilities.detail.unapproved` compatibility field (`packages/api/src/services/diagnose/global.ts`) once the desktop build that reads `verbsAwaitingEnable` has shipped to users.
- About 14 more tests hard-code sibling-repo paths. Move them to `scripts/sibling-checkout.mjs`.
- Six icon-only buttons at `/40` fail the 3:1 non-text contrast bar (list in the wave-4 report).
- pod-admin's own `eslint.config.js` can't parse `import type`; lint from the repo root works.

## Decisions taken (owner, 2026-10-19)

All recommendations were taken except A1, where the owner chose **all four kinds now** (playbook, run,
capability enable and agent), which A4 = yes makes possible.

| Topic           | Decision                                                                                                                                                                                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Link in         | L1 per-action wording · L2 admins only · L3 keep the desktop twins and add the link · L4 one console sign-in per phone · L5 share the pod session with desktop tabs · L6 read `/doors.podAdminUrl` · L7 route what relay can · L8 "Review in console ↗"          |
| Provide asks    | P0 fix D3 (vault is server-encrypted) · P1 console sends new secrets to the app · P2 session-scoped 60-minute grant, refused when the agent is unknown · P3 project home space · P4 confirm the account when several                                             |
| Notifications   | N1 `/my-notifications` · N2 admins don't see members' phones · N3 off until re-enabled on that phone · N4 30/90 days · N5 quiet hours later                                                                                                                      |
| Web `/open`     | A1 all four now · A2 forward `?flowType=` · A3 enable verbs from the web, `opensIn` per action · A4 admins read members' agents · A5 "See this space here"                                                                                                       |
| Catalog signing | B1 S1 now, S2 later · B2 two offline roots signing a short-lived catalog key, plus an operator override · B3 freeze installs and updates, keep listing · B4 `SYNAP_CATALOG_ALLOW_EXPIRED` env-only · B5 founders hold the roots; schedule the Control Plane side |
| Small calls     | S1 space keys tab lists keys confined to the space · S2 admin-only activity read · S3 stamp automations with their package · S4 "Pod Console" everywhere · S5 relay billing opens Credits                                                                        |
