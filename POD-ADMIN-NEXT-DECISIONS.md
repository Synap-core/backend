# Pod Admin — the decisions left, with options

> Companion to `POD-ADMIN-CONSOLIDATION-PLAN.md`. Waves 0,1,2,4,5 shipped.
> Everything below either needs a product call or is a sized follow-up.
> Prior art was researched before writing this; sources are named inline so we
> don't walk a path someone already retracted.

---

## D1 — Wave 3: the information architecture

**State:** still 10 flat tabs. **Prior art is unambiguous here:** tabs carry
3–5 peer options; 10+ destinations want a grouped side nav, and AWS's own
Cloudscape guidance says group by _user intent_, not internal structure. An
overflowing horizontal strip hides options — a real failure, not taste. The
convergent vocabulary across Stripe / GitHub / Vercel / Grafana / Tailscale /
Google Admin is: _Overview · Access · Security · Integrations · Data ·
Observability · Billing_, with Audit/Activity almost always its own top level.

**Verified landmines (cheaper than I assumed):**

- `proxy.ts`'s `isSelfService` list contains **no admin route** — the 10 tabs
  are admin-gated by _omission_, so a rename is **fail-closed**, never
  fail-open. The only catastrophic names are `/open`, `/proposal*`, `/connect*`,
  which would silently drop the `pod_admin` requirement. **Forbid those three.**
- 10 `?focus=`/`?section=` href literals across 2 files; 5 receivers read them
  from the URL and are indifferent to the path.
- `search-modal.tsx`'s `CATEGORY_META` **hardcodes tab display names** — a
  rename half-lands unless it changes too.

| Option                                                    | What                                                                                      | Buys                                 | Costs                                                                       |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------- |
| **A — labels only**                                       | Rename in place, no URL change                                                            | Kills the vocabulary collisions (D2) | Nothing structural                                                          |
| **C — labels + demotions + 2 live fixes** _(recommended)_ | A, plus demote Entities to purge-only under Pod, plus fix Overview's read-only queue card | Both live defects, not just words    | Small, contained                                                            |
| **B — grouping, routes unchanged**                        | Render 6 groups over 10 routes                                                            | Shows the shape                      | A group whose members live at unrelated URLs is a lie the address bar tells |
| **D — full move with 308s**                               | Real route consolidation                                                                  | URL coherence                        | Medium risk; buys something the operator sees once                          |

**My recommendation: C now, D only after dogfood.** Moving four surfaces is
cheaper than moving four surfaces _and_ their old URLs.

---

## D2 — Vocabulary: "connection" means four things

`/connections` = apps connecting **in**. `/connectors` = the pod reaching
**out**. `/my-connections` = **API keys**. `workspaces/[id]` → "Connections" =
keys + webhooks. Direction is encoded nowhere, and `open-in.ts` adds a fifth
by listing both `connectors` and `integrations` as browser settings sections.
Also: "Trust & Keys" is a compound this app invented (the "&" is the tell —
it names a bucket, not an object); "People" collides with `person` entities
browsable one tab away.

**Proposal:** `Apps` (in) · `Sources` (out) · `Trust` · `Identities`.
Zero URL change. Needs `CATEGORY_META` updated in the same commit.

---

## D3 — Is the handoff line in the right place?

**Secrets vault — the handoff is CORRECT, do not reverse it.** The argument is
cryptographic, not scope: per-user vaults are client-side encrypted with the
user's own master password, so there is _nothing for an operator to show_.
Bringing it back means the pod holds decryptable secrets — destroying the
property the product sells. **But** prior art says credential _inventory_
belongs at the trust boundary, and a `secretsVault` router already exists.
**Option: extend the existing handoff card with metadata** — "14 entries across
3 users · contents unreadable by design". One query, no new router. It makes
the trust property _visible_ instead of merely asserted.

**Connector re-auth — this one is arguably on the wrong side.** pod-admin
already hosts `/oauth/consent` and `/connect`; it is the web-native OAuth host
on this origin. Two caveats from prior art: (1) RFC 8252 says native apps
should do OAuth in the system browser with a loopback redirect, so "it's a
redirect" is **not** an argument for the console; (2) Zapier — the canonical
re-auth UX — puts _repair_ next to the running thing, with a broken badge and
one-click Reconnect. **So: inventory in the console, repair launched from
wherever the breakage bites, one door with two launchers.** Cost is backend
(a Nango session-token mint + callback), not UI. **File as its own slice; do
not smuggle it into an IA wave.**

⚠️ **Known-wrong path to avoid (Plex):** never let the console become a
dependency for something the desktop app can already do against a pod it can
reach. Plex has a support article that exists solely because users get locked
out of their own server's settings.

---

## D4 — The `/open` receipt

**Correction to my earlier claim:** the bounce card does _not_ show a UUID —
Wave 4 rewrote it, and the id only ever enters the deep-link href. What is
missing is **identity**: you're told "this document opens in the app", not
_which_ document.

Six of seven bounce kinds have a `get` procedure already reachable on the tRPC
client pod-admin holds (`documents`, `focus-sessions`, `projects`,
`workspaces`, `channels`, `capability-containers`; `cell` is ambiguous —
instance vs definition). The shape already exists: `detailRows()` builds
exactly this for entity/view.

**This is extend, not build.** It does not touch the kind lock.
Options: (a) title only · (b) title + workspace + updated _(recommended)_ ·
(c) skip `cell`, render 6 of 7.

---

## D5 — Receiver pages: we show 2 of the 5 trust signals

Microsoft's anti-consent-phishing guidance (the best public source, and it is
security guidance not aesthetics) says a legitimate consent page shows: **who
is asking · what exactly it will do · on which pod/workspace · you are signed
in as X · where/when the request came from.** `ReceiverShell` currently shows
pod host + signed-in-as. Per route the gap is: _proposal_ — who is asking,
which workspace, when; _approve-agent_ — the REAL scopes (it renders a
hardcoded client-side `SCOPES` list) and when; _consent_ — when; _invite_ —
when (`expiresAt` is already fetched and never rendered).

🔑 **`proposals.source` already exists and has ZERO consumers.** It returns
provenance deeplink targets — session / channel / automation / skill / playbook
/ agent — built for exactly this. **Reuse it; do not build a provenance API.**

---

## D6 — Sized follow-ups (no decision needed, just scheduling)

1. **`apiKeys.adminListAll` doesn't project `workspaceId`.** So
   `api-keys-section.tsx`'s `|| k.workspaceId` skip-branch is dead code and its
   `UnifiedKey` type declares a field the wire never sends. One line to fix, but
   it needs an `api-types` regen — and one is currently uncommitted in the tree,
   so this waits rather than collides.
2. **`/entities` has no `?focus=` receiver** (no `useFocusRow`, no
   `data-row-id`) — every other ⌘K category's page has one. Same for the
   workspace API-keys tab.
3. **`/connection-requests/new` and `/error`** still hand-roll their chrome; a
   reader now traverses `new → [requestId]` and chrome appears mid-flow.
4. **App-wide contrast debt: 287 sites below AA.** The house muted `/55` is
   3.75:1 (143 sites); `/45` is 2.81:1 (54 sites). I fixed only what this wave
   introduced or touched — changing 287 sites under you is not my call.
   Options: a codemod to `/65`, a semantic token, or accept for non-essential
   text only.
5. **Overview's Capacity card** is the 5th disabled frame and still carries its
   `TODO(phase-C)`. It was not converted to a handoff.
6. **`browser` `SettingsApp` uses the wrong store door** — it calls
   `navigateToSettings()`, which does a raw `set({appOverlay:null})`, bypassing
   `closeAppOverlay`'s return-target restore. `setActiveSettingsSection` is
   already what `SettingsView` reads. **NEEDS-DOGFOOD** — traced statically,
   not observed running.
