# Rotate the Ory secrets (`KRATOS_SECRETS_COOKIE`, `KRATOS_SECRETS_CIPHER`)

(Hydra left pods on 2026-10-15; `ORY_HYDRA_SECRETS_SYSTEM` is a retired key that
`synap update` drops from `.env`, keeping a backup.)

Each of these `deploy/.env` keys is an **ordered, comma-separated list**:

```
KRATOS_SECRETS_COOKIE=<newest>,<older>,<oldest>
```

The **first** item signs or encrypts everything new. **Every** item still verifies or
decrypts. A single value, which is what every pod has today, is a one-item list, so
nothing changes until you rotate.

**Never print a secret.** The commands below keep values in shell variables and pipe
them into `synap config set --stdin`. They print lengths only. Do not `cat .env`, run
`docker compose config` or `docker inspect`, or paste a value anywhere.

## What was verified, and where

| Fact                                                                                                                                   | Source                                                                                                                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kratos v1.3.1 `secrets.cookie` / `secrets.cipher` and Hydra v2.3.0 `secrets.system` are arrays: first item encrypts, all items decrypt | Kratos `embedx/config.schema.json@v1.3.1`; Hydra `spec/config.json@v2.3.0`; ory.com Kratos and Hydra secret-rotation guides                                                                                      |
| An env value for an array key that is **not valid JSON** is split as CSV, on commas, with no trimming                                  | `ory/x@v0.0.660` `configx/koanf_env.go` (`StringSlice` → `castx.ToStringSlice` → `encoding/csv`). Kratos v1.3.1 pins x v0.0.660 and Hydra v2.3.0 pins x v0.0.675; `castx` is identical at v0.0.660 and at master |
| Pods ran the comma form for an array key in production                                                                                 | `SELFSERVICE_ALLOWED_RETURN_URLS` in `deploy/docker-compose.yml` (Kratos service), until 2026-10-20, when kratos.yml became its only source                                                                     |
| Item rules                                                                                                                             | cookie: each ≥ 16 chars, **no duplicates** (`uniqueItems`). cipher: each **exactly 32 chars**, ≥ 1 item. Hydra system: each ≥ 16 chars                                                                           |
| The backend only checks these keys are non-empty (`apps/api/src/startup-hooks.ts`, `packages/core/src/config.ts`), so a list passes    | source                                                                                                                                                                                                           |

**Not verified on a running pod yet.** Run this runbook once on a lab pod before
using it on a live pod (founder checklist).

Two traps follow from the CSV rule. A value that happens to be valid JSON (for
example all digits) is not split. Spaces after a comma become part of the secret.
The `token` type in `deploy/env.schema` already refuses whitespace and quotes, and
the generators below emit hex that always contains a letter in practice. Never add
spaces.

## How long the old secret must stay

| Key                     | What the old item still protects                           | Remove it when                                                                                                                                       |
| ----------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KRATOS_SECRETS_COOKIE` | session cookies issued before the rotation                 | after `session.lifespan` has elapsed (**720h = 30 days**, in the installer's `kratos.yml`), or right away if you accept that everyone signs in again |
| `KRATOS_SECRETS_CIPHER` | OIDC provider tokens Kratos stored encrypted on identities | **keep it indefinitely.** Kratos does not re-encrypt, and a stored token only moves to the new key when that user signs in again with that provider  |

The env schema marks these keys `immutable`, so every change needs `--force`. That is
on purpose: dropping an item too early is data loss.

## Steps (on the pod host, in the deploy directory, e.g. `/opt/synap/deploy`)

### 1. Private shell

```bash
umask 077
cd /opt/synap/deploy
```

### 2. Prepend a new item (one key at a time)

```bash
# Kratos cookie: 48 hex chars
OLD=$(synap config get KRATOS_SECRETS_COOKIE --reveal)
printf 'KRATOS_SECRETS_COOKIE=%s,%s\n' "$(openssl rand -hex 24)" "$OLD" \
  | synap config set --force --stdin
unset OLD

# Kratos cipher: EXACTLY 32 chars, so hex 16
OLD=$(synap config get KRATOS_SECRETS_CIPHER --reveal)
printf 'KRATOS_SECRETS_CIPHER=%s,%s\n' "$(openssl rand -hex 16)" "$OLD" \
  | synap config set --force --stdin
unset OLD

```

The config door writes a `.env.bak.<timestamp>` before each change. That backup holds
the previous list.

### 3. Check the shape (prints item lengths only)

```bash
for k in KRATOS_SECRETS_COOKIE KRATOS_SECRETS_CIPHER; do
  printf '%s: ' "$k"
  synap config get "$k" --reveal | awk -F, '{for (i=1;i<=NF;i++) printf "%d ", length($i); print ""}'
done
# Expect: cookie 48 + older lengths; cipher 32 32 ….
```

### 4. Recreate the services that read them

```bash
synap apply                                      # validates .env, recreates what changed
docker compose ps kratos backend                 # all Up / healthy
curl -fsS http://127.0.0.1:4433/health/ready && echo kratos ok
```

### 5. Prove both keys work

- In a browser that was **already signed in** before step 4, reload pod-admin. You
  are still signed in, which shows the old cookie item still verifies.
- Sign out and sign in again. That works, which shows the new item signs.
- If an OIDC provider is configured (Google, GitHub or CP), sign in through it once.
- If any of these fails: restore the newest `.env.bak.<timestamp>` with
  `synap config set --force --stdin` (the same pipe, with the previous list), then
  run `synap apply` again.

### 6. Later: drop the old cookie item (after 30 days)

```bash
CUR=$(synap config get KRATOS_SECRETS_COOKIE --reveal)
printf 'KRATOS_SECRETS_COOKIE=%s\n' "${CUR%%,*}" | synap config set --force --stdin
unset CUR
synap apply
```

Never do this for the cipher (see the table above).

## Hard cut (the old value is exposed)

For the cookie, set the new value **alone** (no `,old`). Every session ends and users
sign in again. That is the point.

The cipher items cannot be hard-cut without losing the data they encrypt.
Rotate as above to stop new data using the exposed key, then treat the remaining
exposure as a data-at-rest exposure of what they protect. That decision belongs to the
founder.
