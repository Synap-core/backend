# Rotate the pod field-encryption key (`SYNAP_FIELD_KEYS`)

The pod encrypts the secrets it must read back at rest with the ONE Synap
envelope (`@synap-core/field-crypto`, the same package the control plane and the
intelligence service use): `senc:1:<kid>:<iv>:<ciphertext>:<tag>`, AES-256-GCM,
bound by AAD to its row and cell (`synap/pod/<table>.<column>/<rowId>`). The
cells are listed once, in `packages/database/src/utils/encrypted-columns.ts`
(`ENCRYPTED_COLUMNS`):

| Cell                                          | Holds                                                                           | Pre-keyring format (kid `legacy` / `plaintext`)     |
| --------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------- |
| `intelligence_services.api_key`               | the key the pod presents to each intelligence service                           | JSON `{e,i,t}` under `SYNAP_SERVICE_ENCRYPTION_KEY` |
| `ai_providers.encrypted_api_key`              | pod-wide AI provider keys                                                       | same                                                |
| `ai_provider_credentials.encrypted_api_key`   | per-user / per-workspace provider keys                                          | same                                                |
| `secrets.encrypted_data` (+ `iv`, `auth_tag`) | server-mode vault secrets (connectors, service configs)                         | base64 + iv + tag under `VAULT_SERVER_KEY`          |
| `sync_peers.auth_token`                       | the shared token of each sync peer                                              | plaintext                                           |
| `pod_settings.federation_oidc_client_secret`  | the CP-pushed OIDC client secret (`settings.federationOidcClient.clientSecret`) | plaintext                                           |

- `SYNAP_FIELD_KEYS="knew:<base64 32B>,kold:<base64 32B>"` is an ordered
  keyring. The **first** key encrypts, **every** key decrypts.
- `SYNAP_SERVICE_ENCRYPTION_KEY` and `VAULT_SERVER_KEY` are the pre-envelope
  keys (audit label `legacy`). Once `SYNAP_FIELD_KEYS` is set they only
  decrypt. **`VAULT_SERVER_KEY` stays even after its rows are swept**: it also
  keys the password-reuse fingerprints (`fingerprintPassword`, an HMAC, not
  encryption).
- `SYNAP_FIELD_ALLOW_LEGACY_PLAINTEXT` (default `true`) lets a read accept a
  value that was never encrypted. Turn it off once the audit shows 0
  `plaintext` rows.
- With `SYNAP_FIELD_KEYS` unset the pod writes every cell in its pre-keyring
  format: deploying the code changes nothing until the key is set.

Commands (in the backend container):

- `node dist/scripts/field-crypto.js audit` counts values per kid / `legacy` /
  `plaintext` (SELECT-only, counts only). Exit 0 = every value is under the
  current kid; 2 = values remain.
- `node dist/scripts/field-crypto.js reencrypt [--dry-run] [--batch=N]`
  rewrites every value not under the current kid (batched, compare-and-set).

**Never print key material.** Keys go to files created under `umask 077` and
reach `.env` through `synap config set --from-file` (never argv). Do not `cat`
the key files or `.env`, do not run `synap config get … --reveal`,
`docker compose config` or `printenv`; never paste a key into a chat, a ticket
or a transcript.

## Prerequisites

1. The deployed backend image contains the keyring (`dist/scripts/field-crypto.js`
   exists: `synap exec backend ls dist/scripts/`).
2. `deploy/docker-compose.yml` passes `SYNAP_FIELD_KEYS` and
   `SYNAP_FIELD_ALLOW_LEGACY_PLAINTEXT` to the backend services (the
   `x-backend-env` block).
3. **The installer's Kratos render reads the OIDC client through
   `field-crypto.js federation-oidc-client`** (not by `psql` on
   `pod_settings`). An older `synap` would render the encrypted secret into
   Kratos and break "Sign in with Synap Cloud" on the next render. Check:
   `grep -c 'federation-oidc-client' ./synap` must be ≥ 1.

## Choose the mode first

| Mode         | When                                   | What happens                                                                                             |
| ------------ | -------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| **Routine**  | the old key is NOT known to be exposed | the old key stays in the ring (decrypt-only) until the audit shows no value under it, then it is removed |
| **Exposure** | the old key IS exposed                 | same steps, back to back. The old key decrypts every DB backup taken before — see "After an exposure"    |

The first run of this runbook is the move off the two legacy keys: there is no
old `SYNAP_FIELD_KEYS` kid, and step 7 has nothing to remove (the legacy keys
stay, see above).

## Steps (on the pod host, in the pod's install directory)

### 1. Work in a private scratch directory

```bash
umask 077
WORK=$(mktemp -d)
cp deploy/.env "$WORK/env.backup"
```

### 2. Generate the new key

Pick a new kid: short, never derived from the key, never `legacy` or
`plaintext` (e.g. `k2026a`, then `k2026b`, …).

```bash
NEW_KID=k2026a
openssl rand -base64 32 > "$WORK/new.key"
test "$(base64 -d < "$WORK/new.key" | wc -c)" -eq 32 && echo "new key ok"
```

### 3. Put it FIRST in the ring, without printing it

This writes a `KEY=VALUE` file holding the new ring (new entry first, every
existing entry after it) and hands it to the config door, which validates it
and keeps a `.env.bak.<ts>`. Only kids are printed.

```bash
NEW_KID="$NEW_KID" NEW="$WORK/new.key" OUT="$WORK/ring.env" python3 - <<'PY'
import os
kid = os.environ["NEW_KID"]
key = open(os.environ["NEW"]).read().strip()
old = []
for line in open("deploy/.env"):
    if line.startswith("SYNAP_FIELD_KEYS="):
        old = [e for e in line.split("=", 1)[1].strip().strip('"').split(",") if e.strip()]
if any(e.split(":", 1)[0] == kid for e in old):
    raise SystemExit(f"kid {kid} is already in the ring; nothing written")
ring = ",".join([f"{kid}:{key}"] + old)
open(os.environ["OUT"], "w").write(f"SYNAP_FIELD_KEYS={ring}\n")
print("ring will be:", [e.split(":", 1)[0] for e in ring.split(",")])
PY
./synap config set --from-file "$WORK/ring.env"
```

### 4. Recreate the backend services

```bash
./synap apply
./synap logs backend 2>&1 | tail -50 | grep -i "field-crypto\|SYNAP_FIELD_KEYS"
```

An invalid ring (a key that is not 32 bytes, a bad, duplicated or reserved kid)
fails the first encrypt/decrypt with `INVALID_KEYRING`, naming the position or
kid, never the value — step 5 surfaces it immediately.

### 5. Audit: the baseline

```bash
./synap exec backend node dist/scripts/field-crypto.js audit
```

One line per cell: `total=… <kid>=… legacy=… plaintext=… not-current=…`, then
`current kid: <NEW_KID>; values not under it: N`. New writes land under
`<NEW_KID>` from now on.

### 6. Re-encrypt

```bash
./synap exec backend node dist/scripts/field-crypto.js reencrypt --dry-run
./synap exec backend node dist/scripts/field-crypto.js reencrypt
```

Per cell: `scanned / rewritten / skipped-concurrent / failed`. A
`skipped-concurrent` row changed while it was being rewritten; run it again. A
`failed row <id>: <code>` names the row and the reason, never a value:

- `DECRYPT_FAILED` on a `legacy` value: it was written under a different
  `SYNAP_SERVICE_ENCRYPTION_KEY` / `VAULT_SERVER_KEY`. The secret is lost:
  re-mint it at its source (re-provision the intelligence service, re-enter the
  provider key, reconnect the connector), then the next sweep is clean.
- `UNKNOWN_KID`: a value under a kid no longer in the ring, or a legacy value
  whose legacy key is missing from `.env`. Put the key back.
- `NOT_AN_ENVELOPE`: plaintext while `SYNAP_FIELD_ALLOW_LEGACY_PLAINTEXT=false`.
  Turn the flag back on for the sweep.

### 7. Gate: the audit must show 0, then remove the old key

```bash
./synap exec backend node dist/scripts/field-crypto.js audit; echo "exit=$?"
```

Exit 0 (`values not under it: 0`) is the ONLY condition for removing an old
`SYNAP_FIELD_KEYS` entry. Exit 2 means values remain: repeat step 6.

Drop the old `kid:key` entry the step 3 way (a script that reads
`deploy/.env`, writes `SYNAP_FIELD_KEYS=<ring without it>` to a 0600 file,
prints kids only), `./synap config set --from-file` it, then `./synap apply`
and audit again (expect exit 0).

Do **not** remove `SYNAP_SERVICE_ENCRYPTION_KEY` or `VAULT_SERVER_KEY`: backups
taken before the sweep need them, and `VAULT_SERVER_KEY` keys the password
fingerprints.

### 8. Turn off legacy plaintext

When the audit shows `plaintext=0` in every cell (step 6 encrypts plaintext
rows too):

```bash
printf 'SYNAP_FIELD_ALLOW_LEGACY_PLAINTEXT=false\n' > "$WORK/flag.env"
./synap config set --from-file "$WORK/flag.env" && ./synap apply
```

From then on a non-encrypted stored secret throws instead of being used.

### 9. Archive the removed key, then clean up

Pod backups taken before step 7 still hold values under the removed key, and
`deploy/.env.bak.*` files written by the config door hold it too. Keep the
removed key in the secrets archive (SOPS, D10) for the backup retention period,
then delete it there; shred the `.env.bak.*` files that carry it once the new
ring is verified.

```bash
shred -u "$WORK"/* 2>/dev/null || rm -f "$WORK"/*; rmdir "$WORK"
```

## After an exposure

Re-encrypting protects the database from now on. It does NOT protect copies
made before: anyone holding the exposed key and an older dump or backup can
read the secrets in it. If such a copy may exist, rotate the protected secrets
at their source too (intelligence-service keys, provider keys, connector
tokens, sync peer tokens — re-pair the peer — and the OIDC client secret —
re-run the CP's oidc-config push).
