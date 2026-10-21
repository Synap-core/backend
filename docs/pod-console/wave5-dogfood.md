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
  - `SYNAP_CATALOG_ENFORCE_SIGNATURE`: blocks what does not verify. Leave it unset in production until after the
    ceremony; see "Catalog signing" below.
  - `SYNAP_CATALOG_ALLOW_EXPIRED`: accepts expired signed files, for air-gapped pods only.
  - The `RATE_LIMIT_*` settings are unchanged.

Desktop, phone and the apps build from their own branches at the heads above.

### Pod names (wave 6)

A new pod is `<name>.pod.synap.live` and its console is `admin.<name>.pod.synap.live`. Anything else the tenant runs
is `<label>.<name>.pod.synap.live`. The sign-in cookie is scoped to `<name>.pod.synap.live`. Every pod today keeps
`pod.<name>.synap.live` and `pod-admin.<name>.synap.live` until the Control Plane moves it
(`pnpm ops:move-pod-names`). Flat pods (`<name>.synap.live`) are still refused a shared session.

- The rule is stated once, in `@synap-core/types/tenancy`. The installer `synap`, desktop main and the Control Plane
  keep copies, and a parity test pins each one to it.
- `synap install --name <name>` now installs `<name>.pod.synap.live` and registers `admin.<name>.pod.synap.live`. The
  Control Plane must accept those names in the same release.
- The move sends one `configure` that sets the new `DOMAIN` / `POD_ADMIN_DOMAIN` and names the old pair in
  `SYNAP_LEGACY_DOMAIN` / `SYNAP_LEGACY_POD_ADMIN_DOMAIN`. For 90 days Caddy answers each old name with a `308` to the
  same path and query on the new host. ACME challenges are the only exception. The host re-derives
  `SYNAP_BASE_DOMAIN`, rewrites the old origins in `ALLOWED_ORIGINS` and re-renders `kratos.yml` for the new names.
- What people see after a move: they sign in once on the new host. Passkeys registered on the old name have to be
  added again, because their rp id was the old name. Desktop and phone pick up the new URL from the Control Plane.
  Agent MCP configs that hold the old pod URL have to be pointed at the new one.
- Pods behind Traefik (Eve-managed) or a custom `CADDYFILE_PATH` don't get the redirect blocks. Their edge has to
  redirect the old names itself.

## Dogfood checklist

### Signing in and links into the console

- [ ] On desktop, an admin sees "Review in console ↗" (or "Manage…" / "See all…") where a console page does the job.
      A member does not see it on admin pages.
- [ ] Desktop tabs that open the console are already signed in: the pod session is shared. A console on another site
      gets no session.
- [ ] On a pod moved to `<name>.pod.synap.live`: the old pod and console addresses answer `308` to the new ones
      (`curl -sI https://pod.<name>.synap.live/health`), you sign in once on the new console, desktop opens it signed
      in, and `https://admin.<other>.pod.synap.live` gets no session.
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

## Catalog signing

**Live once the CP deploys (wave 6):** the Control Plane signs and serves Synap's catalog (`/api/marketplace/
synap-catalog-keys.json`, `synap-index.json`, each with a `.sig`). Pods verify it, and record the result, in report
mode. Private capabilities from the authenticated `/internal/capabilities/:key` door are exempt and show as
"private, verified by the Control Plane connection". The contract and what was built are in
`open-hosting-and-catalog-signing.md` §B.8.

**Needs the founders' ceremony** (about 15 minutes; runbook in `control-plane-api` `ops/catalog-signing/README.md`):

1. Each founder runs `root-keygen` on an air-gapped machine (current and standby, separate custody).
2. CP ops run `online-keygen`, and put the PEM in the CP secret `SYNAP_CATALOG_SIGNING_KEY`.
3. Sign the first statement with `sign-keys --first`, then upload it with `PUT /admin/catalog-signing/keys-statement`.
4. Set `SYNAP_CATALOG_ROOT_PUBLIC_KEYS=<current>,<standby>` on the CP. In the pod release, set
   `catalogRootKeys(["<current>", "<standby>"])` in `packages/jobs/src/workers/official-catalog-signature.ts`.
5. Serve the files first, then ship the release. Turn on `SYNAP_CATALOG_ENFORCE_SIGNATURE=1` after report mode has
   run clean.

Until then, pods say "Synap's catalog isn't signed yet" and block nothing. Leave `SYNAP_CATALOG_ENFORCE_SIGNATURE`
unset in production.

**Staging, to dogfood enforcement before the ceremony:**

- [ ] Generate a throwaway staging root and online key with the ceremony tool, and sign a statement.
- [ ] On the staging CP, set `SYNAP_CATALOG_ROOT_PUBLIC_KEYS=<staging root>` and `SYNAP_CATALOG_SIGNING_KEY=<staging PEM>`.
      Upload the statement. Then `GET /admin/catalog-signing` should show `serving.index: true` and no warnings.
- [ ] On a staging pod, set `SYNAP_CATALOG_PUBLIC_KEYS=<staging online public key>` and
      `SYNAP_CATALOG_ENFORCE_SIGNATURE=1`, then click Sync now in Marketplace › Sources.
  - [ ] Sources shows the signing key's fingerprint and no unverified rows.
  - [ ] An official capability, template, cell, skill, view and automation install.
  - [ ] A private capability you own installs, and the pod log says "private, verified by the Control Plane
        connection".
  - [ ] Set the staging pod's `SYNAP_CATALOG_PUBLIC_KEYS` to a different key (any `online-keygen` output), then
        Sync now. Installs and automatic updates pause, the catalog stays listed, and Sources says why in one
        sentence. Restore the key and Sync now, and installs resume.
- [ ] `node ops/catalog-signing/cli.mjs verify --roots <staging root> --keys <served statement> --index <served index>`
      passes against what the staging CP serves.

## Known gaps and risks

- **Same-site rule:** decided in wave 6. Desktop bundles a public-suffix list and treats `pod.synap.live` and
  `synap.live` as public suffixes. On Synap Cloud it shares the session only with the console the Control Plane issues
  for that pod: `admin.<name>.pod.synap.live`, or `pod-admin.<name>.synap.live` for a pod that hasn't moved yet.
  `pod.synap.live` goes to the Public Suffix List once every pod has moved (`docs/pod-console/psl-submission.md`).
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
