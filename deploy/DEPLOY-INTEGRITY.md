# Deploy Integrity Gate

Closes the stale/wrong-commit deploy hole found in the 2026-07 investigation:
the `synap` CLI's from-source build path ran `docker compose build backend`
against whatever was on disk in the repo checkout, with **no `git pull`/`git
fetch` first** — so a build could silently bake in a stale or drifted
checkout, and nothing in the deploy pipeline or `/status/release` would show
it.

## What changed (this commit, repo-side)

1. **`deploy/Dockerfile`** — runner stage takes `ARG GIT_SHA` and sets
   `ENV SYNAP_GIT_SHA=$GIT_SHA`, so the running container knows the commit it
   was built from.
2. **`deploy/docker-compose.yml`** — `backend` / `realtime` / `backend-migrate`
   build blocks (they all use `deploy/Dockerfile`) pass
   `args: { GIT_SHA: "${GIT_SHA:-}" }`. `pod-admin` uses a different Dockerfile
   (`apps/pod-admin/Dockerfile`) and is untouched.
3. **`apps/api/src/index.ts`** — `/status/release`'s `buildStamp` now reports
   `process.env.SYNAP_GIT_SHA` instead of a hardcoded `null`.
4. **`deploy/verify-deploy.sh`** (new) — post-deploy assertion script:
   asserts `/status/release`'s `migrations.lastApplied` matches the newest
   `packages/database/migrations/*.sql` file in the checkout (works today,
   no image change needed), and — when the image reports a non-null
   `buildStamp` — asserts it equals `git rev-parse HEAD`. Wired into
   `deploy/update-pod.sh` (Step 6b, right after the production health check,
   before image cleanup).
5. **`synap` CLI (`sync_git_before_build`, ~line 92)** — every from-source
   `docker compose build` call (in both `cmd_install` and `cmd_update`,
   including the pull-failure fallback paths) is now preceded by
   `git fetch origin <branch> && git reset --hard origin/<branch>` against
   the repo root, and exports `GIT_SHA` so the build is stamped with the
   commit that was actually built. Opt-out for local/dev iteration only:
   `SYNAP_SKIP_GIT_SYNC=1`.

## Action required on the live pod

The pod's `/opt/synap-backend/synap` is (per the investigation) a checked-out
copy of this repo, not a separate hand-maintained script. Its behavior is
fixed **once that checkout picks up this commit** — but the _old_ copy
running on the pod today still doesn't `git pull` before building, so it
can't upgrade itself in one step. A human needs to run this once,
by hand, on the pod:

```bash
cd /opt/synap-backend
git fetch origin
git reset --hard origin/main   # or the ref the pod tracks, if not main
```

After that one manual sync, every subsequent `synap update` / `synap
install --from-source` self-syncs via `sync_git_before_build` before it
builds anything — no further manual intervention needed.

This repo cannot apply that command for you (out of scope: no SSH to pods,
no editing live pod tooling from an agent session). Verify success with:

```bash
cd /opt/synap-backend && git rev-parse HEAD    # should match `git log -1 origin/main`
```

## Verifying a deploy manually

```bash
deploy/verify-deploy.sh https://your-pod-domain
# or, from inside the deploy dir / on the pod itself:
deploy/verify-deploy.sh http://localhost:4000
```

Exits non-zero on any migration or build-commit mismatch — treat that as
"the deploy did not land as intended," not a cosmetic warning.
