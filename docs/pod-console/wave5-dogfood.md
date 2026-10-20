# Pod Console wave 5: deploy and dogfood

This is what to deploy and what to try by hand. Everything below has passed its automated gates. The items listed
here are the ones only a live pod and real devices can confirm.

## Heads

| Repo      | Branch                        | Head        |
| --------- | ----------------------------- | ----------- |
| backend   | `claude/clever-pascal-4v8992` | `b5bfb539f` |
| app-bases | `claude/clever-pascal-4v8992` | `d2e7c143`  |
| browser   | `claude/clever-pascal-4v8992` | `0bdaa977`  |
| relay-app | `claude/clever-pascal-4v8992` | `8bad12e`   |

`origin/main` is merged into all four branches. Relay's `monorepo.json` pins backend `b5bfb539f`, app-bases
`d2e7c143`, browser `9266b366` (for a test of its words) and control-plane-api `6cbbc78c`, the tip of its main.

## Deploy the pod

On the pod host:

```bash
git fetch origin claude/clever-pascal-4v8992
git checkout claude/clever-pascal-4v8992
git reset --hard origin/claude/clever-pascal-4v8992
cd deploy && synap update --from-source
```

- Migration `0331_official_catalog_digests.sql` runs on its own. The runner applies every file it has not applied
  yet, so its number sitting below main's `0333` doesn't matter.
- The pod-admin image now derives every workspace manifest from the tree (main's Dockerfile). The missing
  `markdown-core` manifest is no longer a problem.
- All new environment settings are optional:
  - `SYNAP_CATALOG_SOURCE`: `off` turns the official catalog off.
  - `SYNAP_CATALOG_PUBLIC_KEYS`: catalog keys for a private mirror.
  - `SYNAP_CATALOG_ENFORCE_SIGNATURE`: blocks what does not verify. Leave it unset; see "Catalog signing" below.
  - `SYNAP_CATALOG_ALLOW_EXPIRED`: accepts expired signed files, for air-gapped pods only.
  - The `RATE_LIMIT_*` settings are unchanged.

Desktop, phone and the apps build from their own branches at the heads above.

## Dogfood checklist

### Signing in and links into the console

- [ ] On desktop, an admin sees "Review in console ↗" (or "Manage…" / "See all…") where a console page does the job.
      A member does not see it on admin pages.
- [ ] Desktop tabs that open the console are already signed in: the pod session is shared. A console on another site
      gets no session.
- [ ] On the phone, the first console link asks you to sign in once. Later links open signed in.
- [ ] On the phone, a desktop-only place (Settings → Developer, Pod, Vault, AI governance, Marketplace) offers the
      console page that covers it.
- [ ] In base, studio and devplane, the user menu shows "Pod Console ↗" with its icon, aligned with the other rows.

### Provide asks (a file, an account or a secret)

- [ ] Review → an agent asks for a file. Upload, then check:
  - [ ] a file of the wrong type is refused in plain words;
  - [ ] the file lands in the project's home space.
- [ ] An agent asks for an account and you have several. The console asks which one. A signed-out account shows but
      can't be picked.
- [ ] An agent asks for a secret:
  - [ ] the note above the button names the agent and the 60 minutes;
  - [ ] a new secret sends you to the app;
  - [ ] after you answer, the agent can read the secret for 60 minutes and no longer.
- [ ] Change the session's agent between opening and answering. Desktop shows a toast and the phone shows a banner
      saying the agent changed. No access is granted.
- [ ] If an answer is refused after an upload went through, you're told the file is still saved in the space.

### Notifications

- [ ] Avatar menu → My notifications lists your phones with their platform, app version and last seen.
- [ ] Revoking a phone stops its pushes, and it stays off until you re-enable it on that phone.
- [ ] An admin doesn't see members' phones.

### Web `/open`

- [ ] `/open` shows the content of each kind, read-only:
  - [ ] a playbook, a run, a capability, an agent;
  - [ ] a document: its markdown is rendered, not just its title;
  - [ ] a channel: its messages, with Retry when the read fails.
- [ ] `?flowType=` survives the bounce into the app.
- [ ] A capability's verbs can be turned on from the web. Each action says whether it opens on the web or on the
      desktop.
- [ ] An admin can read a member's agent. A space offers "See this space here".

### Small calls

- [ ] A space's Keys tab lists only the keys confined to that space.
- [ ] An admin can read activity on a subject. A member can't.
- [ ] Relay billing opens the Credits screen.

## Catalog signing (report-only)

The pod checks the official catalog's signatures and records what it finds, but it blocks nothing. It ships with no
root keys: the founders hold them, offline, and the Control Plane side of the key ceremony is still to schedule (the
contract is in `open-hosting-and-catalog-signing.md` §B.8). Do not set `SYNAP_CATALOG_ENFORCE_SIGNATURE` until roots
and a signed catalog exist. Once enforcement is on, private capabilities served from `/internal/capabilities/:key`
will be refused unless they are signed or exempted.

## Known gaps and risks

- **Same-site rule:** desktop decides whether a console shares the pod session by whether it's on the same site, and
  it has no public-suffix list. On Synap Cloud every `<name>-admin.synap.live` console counts as the same site as
  every other tenant. Needs a product call: bundle a public-suffix list, or match exact origins.
- **Old phone builds:** they can't re-enable a revoked phone, and phones on old builds aren't swept.
- **Desktop provide:** submitting again after a refusal creates a second vault entry.
- **`run` metadata:** this session metadata key is not server-owned, so a remote runner can still write it.
- **Phone exits for spaces and agents:** relay has screens for both now. The console still sends phones to the space's
  console page and tells them to open an agent on the computer. Switching to relay links is a product change.
- **Phone links for members:** the console's phone links to admin pages don't check the viewer's role. A member who
  follows one lands on the forbidden page.
- **Found on main, not wave 5:** session outputs parse `ask` as `z.custom<Ask>()`, which validates nothing. Asks are
  re-parsed when a slot is born, but 9 tests in `focus-sessions` fail on main because of this and other mock drift.
- **Found on main, not wave 5:** main's `installed-webhook-steps.css` is above its type-size ceiling. The browser
  typecheck ratchet shows 2 errors that only occur in a root without relay's dependencies.
