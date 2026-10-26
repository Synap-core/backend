# Release security runbook

How this repository publishes, which credentials each door uses, and the steps
only an organization owner can take. Workflow comments cite this file by
section (`SECURITY-RELEASE-RUNBOOK.md §5`), so keep the section numbers stable.

Vulnerability reports go to [SECURITY.md](SECURITY.md), not here.

## 1. The publish doors

| What                                               | Workflow                               | Credential                                                  |
| -------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------- |
| `@synap-core/types`, `@synap-core/api-types` (npm) | `.github/workflows/publish-types.yml`  | npm Trusted Publishing (OIDC), see §2                       |
| The version-bump commit back to `main`             | `publish-types.yml`, last step         | `GITHUB_TOKEN` today; the Release App once it exists (§5.2) |
| Pod images (GHCR) and the signed pod release       | `.github/workflows/docker-publish.yml` | `GITHUB_TOKEN` plus keyless cosign (OIDC)                   |
| Reads of the private sibling repos in CI           | `.github/actions/monorepo-setup`       | the Reader App (§5.1), else `CROSS_REPO_TOKEN` (§4)         |

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
repo pins Node in `.node-version` for install, build and tests; the publish
steps alone switch to an exact Node (22.18.0) and an exact npm (Node 22 ships
npm 10). Both pins are
exact on purpose: a floating `22` or `npm@11` would let a registry release
change what publishes.

## 3. Pod images and releases

`docker-publish.yml` pushes images to GHCR with `GITHUB_TOKEN` and signs the
release manifest keylessly with cosign; `install.sh` and the `synap` operator
CLI check that signature. It creates GitHub releases and tags but never pushes a
commit to a branch, so the `main` ruleset (§6) does not affect it.

## 4. Cross-repo read token (transition)

CI lays out private sibling repositories beside this checkout for the
cross-repo tripwires. Until the Reader App (§5.1) is live, it reads them with
the `CROSS_REPO_TOKEN` secret: a fine-grained personal access token with
**Contents: read** on the sibling repositories only.

Delete `CROSS_REPO_TOKEN` from a repository only once that repository's
workflows mint a Reader App token and a run shows the mint step succeeding.
Today only this repository reads `SYNAP_READER_APP_*`; the others still read
`SYNAP_RELEASE_APP_*` for their cross-repo reads (§5.4), so they keep
`CROSS_REPO_TOKEN` until they are switched.

## 5. The two GitHub Apps (organization owner)

Two Apps, so the credential that can push to `main` is never in reach of a
pull request:

- the **Reader App** (§5.1): Contents: read. CI on every repository uses it for
  cross-repo checkouts. Its key is a repo secret wherever CI needs it.
- the **Release App** (§5.2): Contents: write, installed on `backend` only. The
  type publish uses it to push its version-bump commit, and it is the only
  App allowed to bypass the `main` ruleset (§6). Its key is a secret of the
  `production` environment only: that environment needs a reviewer's approval
  and deploys only from `main` and `v*` tags, so neither a pull request nor
  `ci.yml` can read it.

Workflows read only each App's ID and private key, so the display names are
free. Both are created the same way:

1. GitHub → the `Synap-core` organization → **Settings → Developer settings →
   GitHub Apps → New GitHub App**.
2. **Name** (see below). **Homepage URL**: this repository's URL.
3. **Webhook**: untick **Active**. The App receives no events.
4. **Repository permissions**: **Contents** as given below, **Metadata:
   Read-only** (required), nothing else. No organization or account
   permissions.
5. **Where can this GitHub App be installed?** → **Only on this account**.
6. **Create GitHub App**. Note the **App ID** shown at the top of its page.
7. On the same page → **Private keys → Generate a private key**. A `.pem` file
   downloads. It is a credential: do not commit it or paste it into chat, and
   delete it once the secret is set.

If a key is lost, generate a new one on the App page, set the secret again and
revoke the old key there.

### 5.1 Reader App

Name `Synap CI Reader`, **Contents: Read-only**. Install it (App page →
**Install App** → `Synap-core` → **Only select repositories**) on:

| Repository          | Read by                               |
| ------------------- | ------------------------------------- |
| `backend`           | app-bases, synap-cli and relay-app CI |
| `control-plane-api` | backend, app-bases and relay-app CI   |
| `app-bases`         | backend and relay-app CI              |
| `browser`           | app-bases and relay-app CI            |
| `relay-app`         | app-bases CI                          |
| `synap-cli`         | relay-app CI                          |

Then, for this repository:

```bash
gh variable set SYNAP_READER_APP_ID -R Synap-core/backend --body "<Reader App ID>"
gh secret set SYNAP_READER_APP_KEY -R Synap-core/backend < path/to/reader.pem
```

Check: re-run the latest CI run on `main` (Actions → CI → **Re-run all jobs**).
The "Mint control-plane-api read token (GitHub App)" step must succeed. That
step is `continue-on-error`, so a failed mint falls back to `CROSS_REPO_TOKEN`
quietly: read the step, not the job colour.

### 5.2 Release App

Name `Synap Release`, **Contents: Read and write**. Install it on **`backend`
only**. Then set its ID and key **in the `production` environment**, never as
repository-level values:

```bash
gh variable set SYNAP_RELEASE_APP_ID -R Synap-core/backend --env production --body "<Release App ID>"
gh secret set SYNAP_RELEASE_APP_KEY -R Synap-core/backend --env production < path/to/release.pem
```

`publish-types.yml` mints the token as its first step whenever
`SYNAP_RELEASE_APP_ID` is set, so a broken App fails the run before anything
reaches npm. The token is handed only to the final fetch, pull and push of the
bump commit; checkout keeps no credential in `.git/config`.

### 5.3 Make the Release App the only bypass on `main`

From a checkout of this repository, logged in with `gh` as an organization
owner:

```bash
scripts/apply-main-protection.sh <Release App ID>            # prints everything, changes nothing
scripts/apply-main-protection.sh <Release App ID> --apply    # writes the ruleset
```

The dry run prints the ruleset before and after, the bypass actors it
**removes**, and whether the Release App is ready. Read that removal list
before `--apply`. Today it removes **Integration 1236702, the Claude GitHub
App**, which can now push straight to `main`. After the change, Claude's
changes reach `main` only through pull requests. Keeping it is a decision to
take before running, not after: edit the bypass list in the script if so.

`--apply` refuses unless the `production` environment exists with a required
reviewer and a branch policy, holds `SYNAP_RELEASE_APP_ID` equal to the ID
given and holds `SYNAP_RELEASE_APP_KEY`, and the key is **not** also a
repository secret. A failed read (auth, network) stops the script with its
error; it is never taken for "not set".

### 5.4 Owed in the other repositories

These workflows still read `vars.SYNAP_RELEASE_APP_ID` /
`secrets.SYNAP_RELEASE_APP_KEY`:

- cross-repo reads: app-bases (`ci.yml`, `changeset.yml`,
  `publish-packages.yml`, `publish-official-templates.yml`, the
  `sibling-repos` action), synap-cli (`publish-cli.yml`), relay-app
  (`ci.yml`). Each must switch to `SYNAP_READER_APP_*`.
- a write: browser (`browser-release.yml`) mints Contents: write on
  `browser-exec` for its desktop release uploads. It needs its own write App
  installed on `browser-exec` only, with its key in that workflow's protected
  environment.

**Never set `SYNAP_RELEASE_APP_KEY` in those repositories**: it would put the
key that can push to backend's `main` in reach of their workflows. Until each
one is switched, it keeps `CROSS_REPO_TOKEN` (§4).

## 6. The `main` ruleset

Ruleset **"base branch security"** on the default branch. After §5.3 it holds:

- **Restrict deletions** and **Block force pushes** (unchanged).
- **Require a pull request before merging**, with 0 required approvals: a
  merge needs a PR and green checks, not a second person. Pass
  `--approvals N` to the script to require reviews instead.
- **Require status checks to pass**, each pinned to the GitHub Actions app so
  another integration cannot post a check with the same name:
  - `Release gate` (`ci.yml`)
  - `Full suite` (`ci.yml`)
  - `API e2e` (`ci.yml`)
  - `Reference docs are current` (`reference-docs.yml`)

  These names come from the check runs of a recent `main` commit; the script
  refuses a name that main's latest CI run did not report. All four workflows
  run on every pull request to `main` with no `paths:` filter. If a job is
  renamed, update `REQUIRED_CHECKS` in the script and re-run it, or every pull
  request waits on the old name.

- **Bypass list**: organization admins (always) and the Release App (always).
  Nothing else.

`Full suite` includes `pnpm audit --prod --audit-level=high`. Once it is
required, a new high advisory in a production dependency blocks every merge
until it is fixed or ignored with a written reason (`auditConfig` in
`pnpm-workspace.yaml`).

To undo, edit the ruleset in **Settings → Rules → Rulesets**. The script prints
the ruleset as it was before writing, so the previous state is in the terminal.
