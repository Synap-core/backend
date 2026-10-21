# Self-hosting a Synap pod

This directory holds everything a pod runs in production: the Compose stack
(`docker-compose.yml`), the Caddy edge, the environment schema (`env.schema`),
and the scripts the `synap` operator CLI calls. The CLI itself is the
[`synap`](../synap) script at the repository root.

The same guide is published in the Run section of the documentation:
<https://docs.synap.live/docs/run>.

Two tools are both called `synap`. Do not mix them up:

| Tool                                     | Where it runs     | What it does                                              |
| ---------------------------------------- | ----------------- | --------------------------------------------------------- |
| `synap` (the script in this repository)  | On the pod's host | Install, update, back up, restore and operate the pod     |
| `@synap-core/cli` (npm package, `synap`) | On your laptop    | Connect AI agents and tools to a pod (`synap init`, etc.) |

## Requirements

- A Linux host with Docker and Docker Compose v2. `install.sh` installs Docker
  (from get.docker.com) and `curl`, `tar`, `jq`, `openssl` (with `apt-get`) when
  they are missing, so it needs root on a bare host.
- A domain whose DNS points at the host, and an email address for the TLS
  certificate. Caddy obtains and renews the certificate.

## Install

Install the latest stable release on a bare host:

```bash
curl -fsSL https://github.com/synap-core/backend/releases/download/channel-stable/install.sh \
  | sudo bash -s -- --domain pod.example.com --email you@example.com
```

What `install.sh` does (see its header for the full contract):

1. Installs the prerequisites above if they are missing.
2. Fetches the release manifest for `--release` (default `stable`; `fast` is
   the latest green `main` build; a release id such as `v1.1.3` pins one).
3. Downloads that release's deploy bundle, checks its sha256 against the
   manifest, and unpacks it into `--dir` (default `/opt/synap`).
4. Links the operator CLI to `/usr/local/bin/synap`.
5. Runs `synap install --non-interactive --release <id>` with every other flag
   you passed. Images are pulled by digest; nothing is built on the host.

`SYNAP_RELEASE_VERIFY=warn|enforce|off` (default `warn`) controls the check of
the release manifest's signature.

Every flag other than `--release` and `--dir` goes to `synap install`. The
common ones:

| Flag                                         | Meaning                                                                    |
| -------------------------------------------- | -------------------------------------------------------------------------- |
| `--domain <domain>`                          | The pod's domain                                                           |
| `--email <email>`                            | Contact for the TLS certificate                                            |
| `--admin-email <e>` + `--admin-password <p>` | Create the first admin during install (otherwise see "First admin" below)  |
| `--with-rsshub`                              | Also start RSSHub and browserless (Compose profile `rsshub`)               |
| `--tunnel cloudflare\|pangolin`              | Expose the pod through a tunnel; pair with `--tunnel-token-file <path>`    |
| `--intelligence-url <url>`                   | An Intelligence Service for the pod to use (with `--intelligence-key <k>`) |
| `--smtp-uri <uri>`                           | SMTP relay for sign-in and recovery emails (see "Email" below)             |

`synap install --help` lists them all.

### Install from a clone

From a checkout of this repository, the same engine installs the pod. Inside a
git checkout it builds the images from source by default; add `--from-image`
to use published images instead.

```bash
git clone https://github.com/synap-core/backend.git
cd backend
./synap install --domain localhost                  # build from source
./synap install --from-image --domain pod.example.com --email you@example.com
```

### First admin

Unless you passed `--admin-email` and `--admin-password`, the pod starts with
no owner. Create one from the host:

```bash
synap setup admin --status                            # needed | ready
synap setup admin --email you@example.com --magic-link # prints a one-hour sign-in link
```

### Connect an agent

Agents connect from your own machine, not from the server:

```bash
npm install -g @synap-core/cli
synap init --pod-url https://pod.example.com
```

## Operate

On the host, `synap help` lists every command. The ones used most:

```bash
synap health                    # local health check (Docker + services)
synap doctor                    # read-only checks: env drift, release, backups, pgdata
synap ps                        # services and their status
synap logs backend --tail 100   # logs of one service (no service: pick from a list)
synap restart backend           # restart one service (no service: pick from a list)
synap config list               # the one validated writer of deploy/.env
synap config set KEY=VALUE      # then `synap apply` to recreate services with it
synap users list                # pod users (also add-admin, reset-password, delete)
```

## Update

```bash
synap update                     # SYNAP_UPDATE_CHANNEL from deploy/.env, else stable
synap update --release fast      # the latest green main build
synap update --release v1.1.3    # one specific release
synap update --from-source       # build this checkout and apply it as a release
```

Every update takes a lock, reads the release manifest, runs preflight checks,
pulls images by digest, takes a verified backup, runs the migrations, starts a
canary, swaps services, and verifies. Any failure rolls back to the previous
images and deploy files; it never restores data. The database keeps the schema
the migrations left (migrations are forward-only, see CONTRIBUTING.md), and the
engine prints the `synap restore <pre-update dump>` command for an operator who
chooses to discard what was written since. The outcome is recorded in
`deploy/state/last-update.json` (`dbRestored: false`, `schema`, `backup`).

### Automatic updates (owner setting) and failed updates

Each pod stores its owner's choice in `pod_settings.settings.updates`:
`auto` (default **on**) and `channel` (`stable` = tagged `v*` releases, the
default; `fast` = every green `main` build). A pod admin changes it with
`PUT /api/pod-updates/settings` (`{ "auto": false }`), and reads it with
`GET /api/pod-updates`. The pod is the one source of truth: the Control Plane
only reads it (`GET /api/provision/status` → `updates`) and, when `auto` is
off, sends an "update available" email instead of pushing the release.

Every `synap update` writes its outcome to `state/last-update.json`. The
backend reads it through its read-only deploy mount; after a rollback
(`rolled_back`, `rollback_failed`, `failed`) every pod admin gets one in-app
notification per update, and a managed pod's owner also gets one email from
the Control Plane. `SYNAP_UPDATE_CHANNEL` in `.env` remains only the default
for an operator typing a bare `synap update`.

### Upgrade notes

What changes for an operator when a pod updates past a release. Newest first.

#### Pod Console (2026-10)

- **Outbound catalog fetch.** Every pod now reads the Synap marketplace
  catalog every 10 minutes (and once at boot): from `CONTROL_PLANE_URL` when
  set, else anonymously from `https://api.synap.live` — no cookie, key or
  identity is sent. To opt out, set `SYNAP_CATALOG_SOURCE=off`
  (`synap config set SYNAP_CATALOG_SOURCE=off && synap apply`); the pod then
  stops fetching Synap's catalog, and the console cannot switch it back on. A
  source the owner added (below) has its own switch.
- **Marketplace sources.** An owner can add other catalogs beside Synap's.
  What a source serves and what the pod checks:
  [`docs/marketplace-source.md`](../docs/marketplace-source.md).
- **Synap's catalog signature.** The pod checks Synap's catalog against a
  signed index once its release carries Synap's root keys; until then it says
  "Synap's catalog isn't signed yet" in Marketplace › Sources and blocks
  nothing. The check only reports until `SYNAP_CATALOG_ENFORCE_SIGNATURE=1`.
  A private mirror or re-signed catalog sets its own index keys in
  `SYNAP_CATALOG_PUBLIC_KEYS` (logged at boot); an air-gapped pod whose
  mirror can't be refreshed sets `SYNAP_CATALOG_ALLOW_EXPIRED=1`. Details:
  [`docs/marketplace-source.md`](../docs/marketplace-source.md), "Synap's own catalog".
- **Rate limits for signed-in people.** The API now gives each signed-in
  person their own request budget instead of sharing the per-address one. Two
  new variables tune it, read by the API process:
  `RATE_LIMIT_CRUD_SESSION_MAX` (default `3000` per 15-minute window, per
  person) and `RATE_LIMIT_CRUD_IP_CEILING` (default `15000`, five times the
  person budget: every request from one address, whatever budget it spends).
  Leave them unset for the defaults, or set them on the pod
  (`synap config set RATE_LIMIT_CRUD_SESSION_MAX=6000 && synap apply`).
- **Migration 0327** (split `source` into `provenance` and `leadSource`) runs
  automatically during `synap update`; nothing to do.
- **Console URL.** The Apps page moved from `/origins` to `/applications`. Old
  links and bookmarks redirect.

## Email (Kratos courier)

Recovery codes and verification emails are sent by Kratos through
`SMTP_CONNECTION_URI` (+ optional `SMTP_FROM_ADDRESS`, which must be on a
domain your relay has verified). Without them mail goes to a local catch-all
and is never delivered; the "Email me a code" recovery door stays hidden.

- **Self-hosted:** set your own SMTP in `.env`, then recreate `kratos` and
  `backend`.
- **Managed pods (Synap Cloud):** the Control Plane provisions a relay through
  Resend SMTP — a per-pod key that can only send, from the Control Plane's
  domain. **Privacy trade-off:** mail sent through this relay, recovery codes
  included, passes through Resend and is visible to whoever operates the
  Control Plane's Resend account. Setting your own SMTP replaces it, and the
  Control Plane never overrides a courier configured elsewhere.

## Single Operational Path

Synap now uses one controlled execution path for pod lifecycle operations:

- CP-managed pods: Control Plane command -> pod-agent -> canonical callback packet
- Operator-managed pods: `synap` CLI only (no legacy fallback installers)
- Terminal failures emit a structured packet (`phase`, `step`, `correlationId`, `errorSummary`, `logsSnippet`)
- Control Plane auto-creates or reuses a deduped ticket per failure fingerprint

If provisioning/update fails, inspect packet metadata first in pod diagnostics, then follow the linked ticket.

## Data & backups

### Where the data lives (and why it matters)

| Data                             | Where                                                                                                     | Survives `prune --volumes` / `down -v`? |
| -------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Postgres cluster (synap, kratos) | volume `<project>_postgres_data` mounted at `/home/postgres/pgdata` (`PGDATA=/home/postgres/pgdata/data`) | No — that is why dumps exist            |
| Scheduled dumps (hourly)         | `deploy/backups/postgres/<UTC>-auto/<db>.dump` (host directory; older ones are `-daily`)                  | Yes                                     |
| Pre-update / manual dumps        | `deploy/backups/postgres/<UTC>-pre-update/…`                                                              | Yes                                     |
| "This pod has data" marker       | `deploy/state/postgres-initialized` (host directory)                                                      | Yes                                     |
| Files (MinIO)                    | volume `minio_data`; exported to `deploy/backups/postgres/.minio-mirror` and pushed off-host              | No — the off-host snapshot has them     |
| Search (Typesense)               | volume `typesense_data` — rebuilt from Postgres                                                           | No (not backed up)                      |

**2026-10-02 incident.** The volume used to be mounted at `/var/lib/postgresql/data`,
which `timescaledb-ha` does not use. The volume stayed empty and the whole database
lived in the container layer, so one recreate wiped a pod. Four layers now prevent
that — see the header of `pgdata-safety.sh`:

1. `PGDATA` is pinned and the volume is mounted at its parent.
2. Postgres **refuses to start** (exit 78, `FATAL[synap]` in its logs) if that path is
   not a mount, or if `deploy/state/postgres-initialized` exists but the cluster is
   empty. To start blank on purpose: `SYNAP_ALLOW_PG_REINIT=1 docker compose up -d postgres`.
3. Every update/install door (`synap`, `install.sh`, `eve update synap`)
   runs `pgdata-safety.sh guard` first: a cluster still in a container layer is
   dumped, committed to a `pgdata-rescue/*` image, copied onto the volume and
   verified by row counts before anything is recreated. Updates also take a
   verified `pre-update` dump of every database before migrations.
4. `postgres-backup` runs `pgdata-safety.sh loop`: it dumps every database hourly
   (`PG_BACKUP_INTERVAL_SECONDS`, default 3600), keeps the newest `PG_BACKUP_KEEP`
   (6) plus one per day for `PG_BACKUP_KEEP_DAILY` (7) days, sets a dump of an
   emptied pod aside as `SUSPECT` (nothing pruned, nothing pushed, `.alarm`), pushes
   good ones off-host once a repository is set up, runs a restore drill weekly, and
   turns **unhealthy** on no fresh dump or any of `.alarm` / `.push-failed` /
   `.drill-failed`.

### Commands

```bash
./synap backup [label]                         # every database → backups/postgres/<ts>-<label>/ (local only)
./synap backup init                            # create the off-host repository, print the recovery kit ONCE
./synap backup push                            # dump + encrypted snapshot now (the service does it hourly)
./synap backup drill [snapshot]                # restore into a throwaway postgres, compare fingerprints
./synap backup status                          # repository, last runs, alarms (also GET /status/backup)
./synap restore --from-snapshot <id|latest>    # fresh host: .env + state → databases → files → fingerprint
./synap restore deploy/backups/postgres/<dir>  # restore a local dump set (stops writers, pg_restore --clean)
deploy/pgdata-safety.sh layout                 # ok | legacy | absent
docker compose ps postgres-backup              # healthy = a dump newer than 2× the interval exists
```

### Off-host copies (required — the host is a single failure domain)

On-host dumps protect against Docker accidents, not against losing the disk or
the host. Set the target in `deploy/.env`, then run `./synap backup init`:

```bash
BACKUP_REPOSITORY=rest:https://vault.example:8000/my-pod   # or s3:…, b2:bucket:path, /mnt/path
BACKUP_RESTIC_REST_USERNAME=… BACKUP_RESTIC_REST_PASSWORD=…  # or BACKUP_AWS_* / BACKUP_B2_*
BACKUP_HEARTBEAT_URL=https://hc-ping.com/…                  # optional dead-man ping, on success only
```

Each snapshot holds every database dump, the MinIO objects, `.env` and `state/`,
**encrypted on the pod** with a password generated by `init` and shown once in the
recovery kit — keep it in two places you control; Synap never holds it. The pod
only ever adds snapshots (no `forget`/`prune`): give it append-only credentials
(rest-server `--append-only`, or a B2/S3 key without delete + Object Lock) and run
retention where the delete-capable credentials live, e.g.
`restic forget --keep-hourly 24 --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune`.

### Interrupted uploads (object storage)

Large files (a Library video copy, up to 1 GiB) are streamed to storage as a
multipart upload. When the stream fails the pod aborts the upload; when the pod
itself is killed mid-upload (a deploy, an OOM), the parts already sent stay on
the bucket. **The pod does not install a bucket lifecycle rule.** What reaps them:

- **MinIO (the default here):** MinIO removes stale multipart uploads by itself
  (`api stale_uploads_expiry`, 24 h by default) — nothing to do.
- **AWS S3:** add a lifecycle rule `AbortIncompleteMultipartUpload` (e.g. after
  1 day) to the bucket — parts left without it are billed.
- **Cloudflare R2 / other S3-compatible stores:** check the bucket's lifecycle
  settings for incomplete multipart uploads and set one if none applies.

The local storage provider writes a `*.part-<uuid>` temp file beside the target;
one left by a killed pod is not swept automatically.

## Docker Compose profiles

All optional services are gated behind Compose profiles. Enable with `--profile NAME`:

| Profile             | Services                                  | When to use                                              |
| ------------------- | ----------------------------------------- | -------------------------------------------------------- |
| `monitoring`        | dozzle, prometheus, grafana, alertmanager | Full observability stack (logs UI + metrics + alerts)    |
| `canary`            | backend-canary                            | Pre-production image validation (used by `synap update`) |
| `rsshub`            | rsshub, browserless                       | RSS aggregation                                          |
| `cloudflare-tunnel` | cloudflared                               | Expose pod via Cloudflare Tunnel                         |
| `pangolin-tunnel`   | pangolin-tunnel                           | Expose pod via Pangolin                                  |
| `pod-agent`         | pod-agent                                 | Control Plane-managed operations (`--with-pod-agent`)    |

Example:

```bash
docker compose --profile monitoring --profile rsshub up -d
```

Services with `restart: always` (backend, postgres, etc.) always start by default.

## Security defaults

- Secrets in `deploy/.env` are generated during installation. Keep a copy of
  `.env` somewhere safe: the off-host backup includes it, encrypted.
- Caddy terminates TLS with automatically provisioned and renewed certificates.
- Services talk to each other on an internal Docker network. Only Caddy
  publishes ports on all interfaces (80 and 443); every other published port
  is bound to `127.0.0.1`.

To report a vulnerability, see [SECURITY.md](../SECURITY.md).

## Troubleshooting

```bash
synap health              # what is down
synap diagnose            # full diagnostics
synap errors backend 200  # errors in the last 200 lines of the backend log
synap connectivity        # DNS + /health probe for the pod's domain
docker compose ps         # from the deploy directory
```

- **TLS certificate not issued:** check that the domain's DNS record points at
  the host, wait a minute or two, then read `synap logs caddy`.
- **Database connection errors:** `docker compose ps postgres`, then
  `synap restart backend`. If Postgres refuses to start, read "Data & backups"
  above before doing anything else.

## Support

- Documentation: <https://docs.synap.live>
- Issues: <https://github.com/Synap-core/backend/issues>
- Discord: <https://discord.gg/xhRdQ7hG5h>
