# Pod Console — wave 3: asks, computers, apps, marketplace

> Follows `POD-ADMIN-CONSOLE-DECISIONS.md` (waves 1–2 shipped on
> `claude/clever-pascal-4v8992`). Grounded in two research lanes (ecosystem
> completeness; marketplace architecture) and the owner's dogfood report
> (2026-10-13). Mockups: the design canvas, row 3 ("Asks, computers, apps,
> marketplace").

## Already being fixed (no decision needed)

| Item                                                                                | Why                                                                                                                                                          |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Marketplace signs the user out → `/login` shows "Failed to create login flow (400)" | An upstream failure was read as an expired session; `/login` didn't handle an existing session. Root-cause fix in progress.                                  |
| "Open in app" on phones                                                             | `synap://` opens Relay on a phone, which can't open app/settings/workspace/channel targets. Console now offers the web page or says "open on your computer". |
| Keys labelled "Operator" for app and computer keys                                  | Wrong noun for who holds access.                                                                                                                             |
| Session room view dropped on "Needs you" links                                      | Context lost.                                                                                                                                                |
| Pod › Updates (auto-update, channel, last outcome) + Home row on rollback           | The pod already exposes `/api/pod-updates`; the console showed nothing.                                                                                      |

## A. Answer the AI's questions in the console (P0)

**Today:** Review's "Asks" rows open a session page with no answer controls —
a dead end. Agents wait until you open the desktop or phone app.

**Proposal:** answer in the Review detail column, one control per ask mode,
using the backend's existing doors (`focusSessions.owed / answerOutput /
attestOutput / askAboutSlot`) and the shared ask rules in
`@synap-core/types/ask` (same validation the apps use):

| Mode                                 | Console control                                                                                                                    |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| confirm                              | Yes / No as equals + optional note                                                                                                 |
| choose                               | options, recommended pre-selected, "Other…" when allowed                                                                           |
| form                                 | a flat form from the field spec (secrets are never asked by form)                                                                  |
| act                                  | the link shown in full, numbered steps, "I did this" / "Not mine"                                                                  |
| provide (secret / file / connection) | not answerable anywhere yet (same copy as the apps) + "Ask the agent about it"; later: connection → Sources, secret/file → the app |

Every ask also offers "Ask the agent about it" and shows what the agent looked
at. **Decision needed: none** — unless you want `provide` handed off to the
desktop app now (it can't answer it either today).

## B. Computers (P1)

A computer is already a first-class backend object (`machines.*`: list,
rename, key lifetime, revoke — revoke also cuts its agents' keys, governed).
The console has no page for it.

- **Access › Computers** (`/computers`) list + object page (shared object skin).
- Pod-default key lifetime moves from Keys to this page's header.
- Agents link to their computer.
- Members see their own computers (avatar menu "My computers").
- Backend: `machines.adminList` (pod admin, every member's computers + owner).

**Decision D9:** should a member see and revoke their OWN computers in the
console (recommended: yes — same `machines.list` the desktop uses)?

## C. Apps — one page for every way an app connects (P1)

Three connection models exist; the console shows one.

| Model                                                | Backend                                        | Console today                |
| ---------------------------------------------------- | ---------------------------------------------- | ---------------------------- |
| Key (the app holds a pod key, acts as its own agent) | `apps.*` (owner-scoped)                        | only `/my-connections`, self |
| Sign in with your pod (federated)                    | `applicationConnections.*`, `trustedIssuers.*` | `/origins` ("Apps")          |
| Claude / MCP (OAuth)                                 | `oauth_clients` + minted keys                  | nowhere                      |

- One **Apps** list (filter by how it connects), one object page per app:
  identity, what it can reach (`appHolderAccess`), who uses it, keys,
  activity, revoke / remove for good. Pending requests stay in Review.
- Backend: `apps.adminList`, an OAuth clients list + revoke, optional
  last-used for federated connections.

**Decision D10:** route — keep `/origins` (renamed page, URL unchanged) or move
to `/applications` with a redirect (recommended: `/applications` + 307;
`/apps/*` stays the self-service app page).

## D. Marketplace (P0 for the bug class, P1/P2 for sources)

**Finding:** the console talks to the Control Plane directly from its own
server routes, with no credential, and only installs spaces (other kinds
return 501). The pod backend already keeps a multi-source catalog cache,
synced every 10 minutes, with install doors for every kind and governance
for agents.

**Phase 1 — the pod owns the catalog (recommended now):** a pod
`marketplace.list / get / preflight / install` API over the existing cache and
install core; the console's Control Plane routes are deleted. Fixes the
sign-out class of bug for good, makes every kind installable from the
console, and works offline (last synced catalog, or a calm "no sources").

**Phase 2 — sources you choose (your idea, recommended with guard-rails):**
a **Sources** tab: Synap (official, built in, can be disabled, not removed)
plus any URL you add.

| Trust level   | Meaning                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Official      | every kind; agents may propose installs                                                                                        |
| Trusted       | humans install after a preflight that discloses network access, connectors and cell code; agents only if you opt in per source |
| Showcase only | listed; Install opens the source's own site (your "send to the landing page" idea)                                             |

Guard-rails (from prior art — HACS, Umbrel, Open VSX, npm incidents):
a signed source index with an expiry, the source's key confirmed on first add
(F-Droid style) and blocking on key change, every definition checked against
its digest, ids qualified by source (`acme/crm` ≠ `synap/crm`), agents can
never add a source, updates from non-official sources go back through you.
A public `synap-index.json` format so anyone can run a marketplace — the
Synap marketplace becomes "just the default source".

**Decision D11:** go with Phase 1 now and Phase 2 as designed? Alternatives:
(a) Phase 1 only; (c) showcase-only for everything (no installs from the
console). Recommended: Phase 1 now, Phase 2 next.

## E. Later (P2)

- Notifications: push preferences and phones list (+ backend revoke by id).
- Provide-answers once vault-first doors exist.
- Relay: route `synap://open/app/<id>` properly (cross-repo).

## Proposed order

1. (in progress) bug fixes + handoffs + key labels + Updates.
2. A — answer asks in Review.
3. D Phase 1 — marketplace through the pod.
4. B — Computers. 5. C — Apps.
5. D Phase 2 — sources (after D11).
