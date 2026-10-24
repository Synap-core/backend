# Release security runbook

How this repository publishes, which credentials each door uses, and the steps
only an organization owner can take. Workflow comments cite this file by
section (`SECURITY-RELEASE-RUNBOOK.md §5`), so keep the section numbers stable.

Vulnerability reports go to [SECURITY.md](SECURITY.md), not here.

## 1. The publish doors

| What                                               | Workflow                               | Credential                                                      |
| -------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------- |
| `@synap-core/types`, `@synap-core/api-types` (npm) | `.github/workflows/publish-types.yml`  | npm Trusted Publishing (OIDC), see §2                           |
| The version-bump commit back to `main`             | `publish-types.yml`, last step         | `GITHUB_TOKEN` today; the Synap Release App once it exists (§5) |
| Pod images (GHCR) and the signed pod release       | `.github/workflows/docker-publish.yml` | `GITHUB_TOKEN` plus keyless cosign (OIDC)                       |
| Reads of the private sibling repos in CI           | `.github/actions/monorepo-setup`       | the Synap Release App, else `CROSS_REPO_TOKEN` (§4)             |

The rules every publish workflow must satisfy, in every repo, are checked by
`ci/scripts/check.mjs` and described in [ci/README.md](ci/README.md).

## 2. npm Trusted Publishing

No npm token is stored anywhere. npm mints a short-lived credential for the
publishing job from its GitHub OIDC token (`id-token: write`), and provenance
comes with it. Setup and the per-package npm settings:
[ci/README.md, "Authentication: Trusted Publishing, not tokens"](ci/README.md).

### 2.1 Toolchain of the publishing process

npm Trusted Publishing needs **Node >= 22.14.0 and npm >= 11.5.1 in the process
that runs `npm publish`** (pnpm hands the upload to the `npm` on `PATH`). The
repo pins Node 20 in `.node-version` for install, build and tests, so the
publish steps alone switch to an exact Node 22 and an exact npm. Both pins are
exact on purpose: a floating `22` or `npm@11` would let a registry release
change what publishes.

## 3. Pod images and releases

`docker-publish.yml` pushes images to GHCR with `GITHUB_TOKEN` and signs the
release manifest keylessly with cosign; `install.sh` and the `synap` operator
CLI check that signature. It creates GitHub releases and tags but never pushes a
commit to a branch, so the `main` ruleset (§6) does not affect it.

## 4. Cross-repo read token (transition)

CI lays out private sibling repositories beside this checkout for the
cross-repo tripwires. Until the App in §5 exists, it reads them with the
`CROSS_REPO_TOKEN` secret: a fine-grained personal access token with
**Contents: read** on the sibling repositories only. Once the App is live and a
CI run shows the "Mint control-plane-api read token (GitHub App)" step
succeeding, delete `CROSS_REPO_TOKEN` from every repository that holds it.

## 5. Create the Synap Release GitHub App (organization owner)

One GitHub App serves every Synap repository's CI: it mints short-lived tokens
for cross-repo reads and is the only actor allowed to push straight to
`main` here (the type-package version bump). Workflows read only its ID and
private key, so its display name is free.

### 5.1 Create it

1. GitHub → the `Synap-core` organization → **Settings → Developer settings →
   GitHub Apps → New GitHub App**.
2. **Name**: `Synap Release` (or any free name). **Homepage URL**: this
   repository's URL.
3. **Webhook**: untick **Active**. The App receives no events.
4. **Repository permissions**:
   - **Contents: Read and write**
   - **Metadata: Read-only** (GitHub sets it; it is required)
   - nothing else. No organization or account permissions.
5. **Where can this GitHub App be installed?** → **Only on this account**.
6. **Create GitHub App**. Note the **App ID** shown at the top of its page.
7. On the same page → **Private keys → Generate a private key**. A `.pem` file
   downloads. It is a credential: do not commit it, paste it into chat or
   keep it after step 5.3.

### 5.2 Install it on the repositories that use it

App page → **Install App** → `Synap-core` → **Only select repositories**:

| Repository             | Why                                                            | Token requested                                       |
| ---------------------- | -------------------------------------------------------------- | ----------------------------------------------------- |
| `backend`              | the type-package bump commit; read by other repos' CI          | Contents: write (`publish-types.yml`), read elsewhere |
| `control-plane-api`    | cross-repo tripwires                                           | Contents: read                                        |
| `app-bases`            | cross-repo tripwires                                           | Contents: read                                        |
| `browser`, `relay-app` | app-bases and relay CI layouts                                 | Contents: read                                        |
| `browser-exec`         | desktop release uploads (browser repo's `browser-release.yml`) | Contents: write                                       |

Every workflow narrows its token to named repositories and an explicit
permission (`actions/create-github-app-token` with `repositories:` and
`permission-contents:`). The App's own ceiling is still Contents: write on
every repository it is installed on, so its private key is a write credential
for all of them: store it only in repositories whose workflows mint a token,
and install the App on no repository that does not appear in this table.

### 5.3 Give the workflows the ID and the key

For each repository whose workflows read `vars.SYNAP_RELEASE_APP_ID` (today:
`backend`, `app-bases`, `synap-cli`, `browser`, `relay-app`):

```bash
gh variable set SYNAP_RELEASE_APP_ID -R Synap-core/<repo> --body "<App ID>"
gh secret set SYNAP_RELEASE_APP_KEY -R Synap-core/<repo> < path/to/key.pem
```

Then delete the downloaded `.pem`. If it is lost, generate a new key on the App
page and set the secret again; revoke the old key there.

Check: re-run the latest CI run on `main` (Actions → CI → **Re-run all jobs**).
The "Mint control-plane-api read token (GitHub App)" step must succeed. A
`continue-on-error` mint that fails would silently fall back to
`CROSS_REPO_TOKEN`, so read the step, not the job colour.

### 5.4 Make the App the only bypass on `main`

With the App ID in hand, run (from a checkout of this repository, logged in
with `gh` as an organization owner):

```bash
scripts/apply-main-protection.sh <App ID>            # prints the new ruleset, changes nothing
scripts/apply-main-protection.sh <App ID> --apply    # writes it
```

What the script writes is described in §6. From then on the type publish
pushes its bump commit with the App's token (`publish-types.yml` mints it as
its first step whenever `SYNAP_RELEASE_APP_ID` is set) and every other change
reaches `main` through a pull request.

## 6. The `main` ruleset

Ruleset **"base branch security"** on the default branch. After §5.4 it holds:

- **Restrict deletions** and **Block force pushes** (unchanged).
- **Require a pull request before merging**, with 0 required approvals (a
  merge needs a PR and green checks, not a second person). Pass
  `--approvals N` to the script to require reviews instead.
- **Require status checks to pass**, each pinned to the GitHub Actions app so
  another integration cannot post a check with the same name:
  - `Release gate` (`ci.yml`)
  - `Full suite` (`ci.yml`)
  - `API e2e` (`ci.yml`)
  - `Reference docs are current` (`reference-docs.yml`)

  These names come from the check runs of a recent `main` commit. All four
  workflows run on every pull request to `main` with no `paths:` filter, so a
  required check can never be left waiting for a run that does not start. If a
  job is renamed, update `REQUIRED_CHECKS` in the script and re-run it, or
  every pull request will wait forever on the old name.

- **Bypass list**: organization admins (always) and the Synap Release App
  (always). Nothing else.

To undo, edit the ruleset in **Settings → Rules → Rulesets** or re-run the
script from a previous commit; `--apply` prints the ruleset as it was before
writing, so the previous state is in the terminal.
