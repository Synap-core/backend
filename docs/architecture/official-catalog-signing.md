# Signing Synap's official catalog: the Control Plane contract

> Verified against code on 2026-10-20 (backend@c31e261a). Third-party sources:
> [`../marketplace-source.md`](../marketplace-source.md).

This is the contract the Control Plane builds against so that pods can verify
the official catalog. The pod side is built and runs report-only.

The owner's decisions (2026-10-19):

- Stage S1 now: a signed digest index beside today's endpoints. Synap as "just another source" comes later.
- Two offline root keys (current and standby), compiled into the pod release, sign a statement naming a
  short-lived online catalog key (90 days at most), which signs the index. An operator can override the keys for a
  private mirror; trust on first fetch was rejected.
- On an expired or failed index the pod keeps listing, blocks installs and automatic capability updates, says so in
  one sentence in the console, and never wipes anything.
- `SYNAP_CATALOG_ALLOW_EXPIRED=1` is set in the environment only.
- The founders hold the root keys; the key ceremony has not happened.

**What the pod does today.** It ships with `SYNAP_CATALOG_ROOT_KEYS = []`
(`packages/jobs/src/workers/official-catalog-signature.ts`): it fetches nothing, blocks nothing, and Marketplace ›
Sources says "Synap's catalog isn't signed yet". Once a release carries the roots (or an operator sets keys), every
official catalog sync checks root → keys statement → index, stores the verified digests in
`official_catalog_digests`, and checks every official definition against them before it installs or converges
(`packages/api/src/services/capabilities/official-catalog-trust.ts`). Until `SYNAP_CATALOG_ENFORCE_SIGNATURE=1` a
failed check is only logged and reported.

## 1. Endpoints

Under the catalog base URL (the CP's public origin, the one that serves `/api/marketplace/capabilities`):

| Path                                               | Signed by             | Cap   |
| -------------------------------------------------- | --------------------- | ----- |
| `GET /api/marketplace/synap-catalog-keys.json`     | a root key            | 64 KB |
| `GET /api/marketplace/synap-catalog-keys.json.sig` | —                     | 512 B |
| `GET /api/marketplace/synap-index.json`            | an online catalog key | 2 MB  |
| `GET /api/marketplace/synap-index.json.sig`        | —                     | 512 B |

- Anonymous `GET`, `Accept: application/json`, no cookie or credential. Answer `200` with the file's exact bytes;
  **never a redirect** (the pod refuses one). A `.sig` is the base64 ed25519 signature over the exact bytes of its
  file (surrounding whitespace ignored).
- A file the pod cannot fetch is an outage: the last verified index stays in force until its `expires`.
- Cache for at most a few minutes: the pod reads both every 10 minutes and on "Sync now".

## 2. Keys statement — `synap-catalog-keys.json`

```json
{
  "schemaVersion": 1,
  "version": 7,
  "expires": "2027-04-01T00:00:00Z",
  "keys": [
    {
      "publicKey": "<raw ed25519, base64, 44 chars>",
      "notAfter": "2026-12-20T00:00:00Z"
    },
    { "publicKey": "<next key>", "notAfter": "2027-01-15T00:00:00Z" }
  ]
}
```

The pod (`verifyKeysStatement`) accepts it only when it is signed by **any** root compiled into its release; it is
not past `expires` and `expires` is at most **366 days** ahead; `version` (an integer ≥ 1) is **not lower** than the
last one the pod accepted; and at least one key is usable. A key is usable while `notAfter` is ahead and **at most 90
days** ahead of the moment the pod reads it. A key valid for longer is ignored, so roots must re-sign the statement
at least every ~75 days (keep 2 weeks of slack). 1–8 keys.

## 3. Index — `synap-index.json`

The v1 format of `docs/marketplace-source.md` (same caps: 2 MB, 2000 packages, `expires` at most 31 days ahead,
monotonic) parsed by `officialIndexSchema` (`packages/types/src/marketplace-source/index.ts`):

- `source`: `{ "id": "synap", "name": "Synap", "publicKey": <the online key that signed this file> }`. That key must
  be usable in the current keys statement.
- `expires`: **now + 14 days**, re-signed **daily** and on every publish, retire and unpublish (debounced). Never
  earlier than the last `expires` served. Alert on the CP at 7 days remaining.
- `packages[]`: one per `(kind, slug)`, keyed **as the pod's catalog cache keys it**:

| Field                                                    | Value                                                                                                                                                                              |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`                                                   | `capability`, `template`, `automation`, `skill`, `view` or `cell` (`workspace`/`workflow` accepted as aliases)                                                                     |
| `slug`                                                   | capability: its `key`; packages: the package slug; cell: `<packageSlug>/<cellKey>`. Lowercase `[a-z0-9._-]` (a row that cannot be written so cannot verify — normalize or flag it) |
| `version`                                                | exactly the `version` the CP endpoint serves for that row (cells: the owning package's `version`)                                                                                  |
| `contentHash`                                            | the content digest (§4), 64 lowercase hex                                                                                                                                          |
| `sha256`                                                 | **the same value** as `contentHash` (an index where they differ is refused)                                                                                                        |
| `definitionUrl`                                          | same origin, serving the canonical bytes of §4 (for S2; the pod does not fetch it in S1). E.g. `/api/packages/<slug>/<version>/definition.json`                                    |
| `displayName`, `description`, `icon`, `tags`             | as listed today                                                                                                                                                                    |
| `requiredTier`                                           | the package's tier. Once enforced, the pod's install tier check takes it from here instead of `GET /api/packages/:slug`                                                            |
| `vendor`, `retiredAt`, `replacedBySlug`, `retiredReason` | optional, as today's DTOs carry them                                                                                                                                               |

- **Which rows.** Everything an anonymous pod-facing door serves: every capability key served by
  `GET /api/marketplace/capabilities` **and** by `GET /api/marketplace/capabilities/:key` (public owners with
  `syncByDefault: false` too); every public workspace, workflow, skill and view package at the version
  `GET /api/packages/:slug` serves (an install pinned to another version is refused under enforcement); every cell
  of a public package. Retired rows may be listed with `retiredAt` (the pod never installs a retired row).
- Private packages are not listed (a public file must not reveal them). Consequence below (§7).

## 4. The content digest

`contentHash = sha256( canonicalJSON( D′ ) )`, hex, where:

- `D` is the definition object **exactly as the pod receives it from today's endpoint, read back from the
  database** (jsonb normalizes numbers and key order; the digest must be computed over the stored value, never over
  the publish payload):
  - capability: the card's `definition` from `/api/marketplace/capabilities[/:key]` (the stored
    `definition.capability`);
  - workspace, workflow, skill, view: `package.definition` from `GET /api/packages/:slug[/:version]`;
  - cell: the cell's own entry of the package's `definition.cells[]`.
- `D′` is `D` without its top-level `_meta`, `contentHash` and `sourcePackage`, and, for a cell, without the fields
  `/api/marketplace/cells` adds: `packageSlug`, `packageName`, `author`, `packageVersion`, `installCount`,
  `isVerified`.
- `canonicalJSON` is the CP's existing one (`src/seeds/capability-content-hash.ts`): keys sorted recursively,
  arrays in order, `JSON.stringify` with no whitespace.

So `contentHash` is the full form of what the CP already computes: `capabilityContentHash(capability)` for a
capability and `templateContentHash` of the definition minus `sourcePackage` and `_meta` for a package. Its first 12
hex are the row's `h-` version. Because `_meta` is outside the digest, the pod also refuses a served definition whose
`_meta.slug` is not the listed slug; `serveCatalogRow` keeps `_meta.slug` equal to the row's slug.

**Parity.** Pin one literal on both sides: the pod's `official-catalog-verify.test.ts` hashes
`{"profiles":[{"name":"Deal","slug":"deal"}],"workspaceName":"CRM"}` (from a definition carrying `_meta`) to
`68f8c9908b0cacaed63dd011d3275521e51e663865e882ac800c32f862cbec54`. Add the same literal and digest to a CP test.

## 5. Keys, custody and rotation

- **Algorithm:** ed25519 for every key (the pod verifies with Node's built-in ed25519, `verifyEd25519`). Do not
  reuse the CP's ES256 JWT key (`src/lib/signing-key.ts`): it is a different purpose and is distributed by fetch.
- **Root keys:** two, offline, separate custody by the founders. Both public keys are compiled into
  `SYNAP_CATALOG_ROOT_KEYS`, current first. A statement carries one signature; any compiled root is accepted.
- **Online catalog key:** in the CP's KMS/HSM; listed in the statement with `notAfter` ≤ 90 days.
- **Rotating the online key:** sign a statement listing the current and the next key; switch the index to the next
  key at least 14 days later; drop the old key from the next statement.
- **Rotating a root:** ship the replacement as the standby in a pod release well ahead (a year ahead). Sign
  statements with a root every supported release carries. A compromised root is retired by signing with the
  standby and shipping a release without it.
- **The ceremony:** generate both roots offline, record their fingerprints (first 32 hex of sha256 over the raw
  key), put the public keys in `SYNAP_CATALOG_ROOT_KEYS`, sign the first statement. Serve the files **before** the
  pod release that carries the roots.

## 6. Pod behaviour (what the CP can rely on)

| Situation                                       | Pod                                                                                                                                                         |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No root keys in the release, no operator keys   | Fetches nothing, blocks nothing. Console: "Synap's catalog isn't signed yet."                                                                               |
| Verified                                        | Replaces `official_catalog_digests`; installs and converges what the index vouches for                                                                      |
| File unreachable / 404                          | Last verified index stays in force until its `expires`                                                                                                      |
| Bad signature, refused file, replayed statement | Last verified digests kept (never wiped). Report mode: logged + console sentence. Enforced: installs and automatic updates paused, the catalog stays listed |
| Index expired, no fresh one                     | Same as above; `SYNAP_CATALOG_ALLOW_EXPIRED=1` accepts expired signed files (air-gapped pods)                                                               |
| A definition the index does not vouch for       | Report mode: logged. Enforced: that install or update is refused with the reason                                                                            |

Operator override: `SYNAP_CATALOG_PUBLIC_KEYS` (comma-separated ed25519 keys) replaces the root chain. The index
must then be signed by one of those keys directly, and no keys statement is read. It is logged loudly at boot.
Enforcement ships off (`SYNAP_CATALOG_ENFORCE_SIGNATURE`); its default flips in a later release, once report-only has
run clean.

Reads covered: `marketplace-install.ts` (by cache row and by key, every kind), `cp-template-client.ts`
(`fetchCPCapabilityTemplate`, the door for capability installs, the capability reconcile and connector templates),
`resolve-workspace-template.ts` (falls back to the bundled template), `utils/tier-check.ts`, `routers/cells.ts` and
the Hub REST `POST /cells/install`, the standalone view/skill/automation reconcile, and the after-sync capability
converge (`reconcileChangedCapabilityTemplates`, paused as a whole while a freeze is enforced).

## 7. Open points for the owner and the CP team

- **Private capabilities** reached through the pod's authenticated `/internal/capabilities/:key` door are not in a
  public index, so once enforced they are refused. They need either a per-pod signed statement or an explicit
  exemption.
- **Payload-in installs (RC4)**, where a CP-authenticated client sends the definition itself, are not catalog
  reads and are not checked.
- The **boot** capability reconcile is checked per template (it loads through `fetchCPCapabilityTemplate`) but is
  not paused as a whole by a freeze; only the after-sync converge is.
- The retired `capability-template-sync` worker still writes `capability_template_cache`, which nothing reads.
