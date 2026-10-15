# Running a marketplace source

A Synap pod's Marketplace lists packages from **sources**. Synap's own catalog
is built in; a pod admin can add any other source by its address. This page is
for the publisher of such a source: the file format, how to sign it, and what a
pod does — and never does — with it.

Code: format and trust rules `packages/types/src/marketplace-source/`; fetch,
verification and sync `packages/jobs/src/workers/marketplace-source-*.ts`;
install enforcement `packages/api/src/services/capabilities/marketplace-install.ts`
and `market-sources.ts`; admin doors `marketplace.sources.*` in
`packages/api/src/routers/marketplace.ts`.

## What you serve

Two files at one https address (the "source address"):

```
https://packages.example.com/synap-index.json
https://packages.example.com/synap-index.json.sig
```

A person may add either the base address (`https://packages.example.com`) or
the index URL itself (any address ending in `.json`; the signature is that URL
plus `.sig`). Plus one file per package definition, on the **same origin**.

### `synap-index.json` (schema version 1)

```json
{
  "schemaVersion": 1,
  "source": {
    "id": "acme",
    "name": "Acme Labs",
    "homepage": "https://acme.example",
    "publicKey": "q8m0n…base64 of the raw 32-byte ed25519 public key…="
  },
  "expires": "2026-11-13T00:00:00Z",
  "packages": [
    {
      "slug": "crm",
      "kind": "template",
      "version": "h-1f2e3d4c5b6a",
      "displayName": "Acme CRM",
      "description": "Deals, contacts and companies.",
      "icon": "briefcase",
      "tags": ["sales"],
      "definitionUrl": "defs/crm.json",
      "sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      "homepageUrl": "https://acme.example/crm",
      "installUrl": "https://acme.example/crm/install",
      "requiredTier": "pro"
    }
  ]
}
```

| Field                       | Rule                                                                                                                                                                       |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source.id`                 | 2–40 characters, `[a-z0-9-]`, not `synap`. It qualifies every package (`acme/crm`) and must never change once a pod added you.                                             |
| `source.publicKey`          | The raw ed25519 public key (32 bytes), base64. Required unless you are an unsigned showcase.                                                                               |
| `expires`                   | ISO 8601 with offset. After it, pods refuse the index and stop installing from the copy they hold. Re-sign and republish before then (a week or a month ahead is typical). |
| `packages[].kind`           | `capability`, `automation`, `template`, `cell`, `skill` or `view` (`workspace` and `workflow` are read as `template` and `automation`).                                    |
| `packages[].slug`           | Lowercase `[a-z0-9._-]`; a cell is `<package>/<cell>`. One `(kind, slug)` per index.                                                                                       |
| `packages[].version`        | Any string up to 100 characters. A `h-` version is a **content version** and is checked (below).                                                                           |
| `packages[].definitionUrl`  | Relative to the index, or absolute — but always https on the **index's own origin**. A package whose definition lives elsewhere is left out.                               |
| `packages[].sha256`         | Lowercase hex sha256 of the definition file's exact bytes.                                                                                                                 |
| `homepageUrl`, `installUrl` | https only. A showcase listing's Install opens `installUrl`, else `homepageUrl`, in a new tab.                                                                             |
| `icon`                      | A short icon name. Pods never fetch remote images (they would tell you who browses).                                                                                       |

Caps: the index is at most 2 MB and 2000 packages; a signature at most 512
bytes; a definition at most 5 MB. Anything larger is refused, never truncated.

### `synap-index.json.sig`

The base64 ed25519 signature of the index file's **exact bytes** (whitespace
around it is ignored). Change one byte of the index — even reformatting — and
you must sign again.

### Definitions

Each definition is the package body the pod installs — the same shape as a
package published to Synap's catalog for that kind. The pod fetches it at
install time, checks its sha256 against the signed index before reading it,
and, for an `h-` version, recomputes the content version
(`h-` + the first 12 hex of sha256 over the key-sorted JSON of the definition
minus `_meta`, `contentHash`, `sourcePackage` and the apply-request fields —
`packages/api/src/services/applied-package-version.ts`). A mismatch installs
nothing.

## Signing

A small Node script (Node 18+, no dependency):

```js
// sign-index.mjs — node sign-index.mjs keygen | node sign-index.mjs sign
import {
  generateKeyPairSync,
  createPrivateKey,
  createHash,
  sign,
} from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

if (process.argv[2] === "keygen") {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(
    "signing-key.pem",
    privateKey.export({ type: "pkcs8", format: "pem" }),
    { mode: 0o600 }
  );
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  console.log("publicKey:  ", raw.toString("base64"));
  console.log(
    "fingerprint:",
    createHash("sha256")
      .update(raw)
      .digest("hex")
      .slice(0, 32)
      .match(/.{4}/g)
      .join(" ")
  );
} else {
  // 1. fill in each definition's sha256, 2. write the index, 3. sign its exact bytes
  const index = JSON.parse(readFileSync("synap-index.src.json", "utf8"));
  for (const pkg of index.packages) {
    pkg.sha256 = createHash("sha256")
      .update(readFileSync(pkg.definitionUrl))
      .digest("hex");
  }
  const bytes = Buffer.from(JSON.stringify(index, null, 2));
  writeFileSync("synap-index.json", bytes);
  const key = createPrivateKey(readFileSync("signing-key.pem"));
  writeFileSync(
    "synap-index.json.sig",
    sign(null, bytes, key).toString("base64") + "\n"
  );
}
```

Publish the **fingerprint** where the people who add you will look (your site,
your README): when a pod admin adds your source, the console shows the
fingerprint it verified — the first 128 bits of sha256 over the raw key, in
groups of four — and asks them to compare it with yours. Keep the private key
offline; it is the only thing that makes a pod trust an update.

### Changing your key

Sign the new index with the new key and put the new `publicKey` in it. Every
pod that added you stops installing from you (status "key changed —
re-approve") until its admin compares the new fingerprint and approves it, so
announce the change first. An index that names a key it is not signed by is a
bad signature, not a key change: pods keep your last verified copy.

## Trust levels — what a pod admin can choose

| Level                     | Who installs                                                                                                                                                                                                                                                                          | What the pod checks                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Official** (Synap only) | A person; an agent's install becomes a proposal.                                                                                                                                                                                                                                      | Synap's catalog is the pod's configured Control Plane over TLS (see below).                                                                               |
| **Trusted**               | A person, after a preflight that names the code, network reach and connectors a package brings, with an explicit confirm for code and for network reach. An agent is refused — unless the admin turned on agent proposals for this source; then it files a proposal a person reviews. | Signed index under the pinned key, not expired; definition digest and content version.                                                                    |
| **Showcase only**         | Nobody on the pod. Install opens your `installUrl` / `homepageUrl`.                                                                                                                                                                                                                   | The listing only. The pod never fetches a showcase definition. A showcase may be unsigned; if it is signed, the key is pinned and checked like any other. |

Only a person signed in to the Pod Console who administers the pod can add a
source, change its trust, re-approve its key, switch it off or remove it.
Agents and API keys can never do any of these — the pod refuses them.

Updates from your source are never applied automatically. A space or package
installed from you is stamped `acme/<slug>`; template health compares it with
your listing, and bringing it up to date is a person's install.

## What the pod never sends you

Every request a pod makes to your source is an anonymous `GET` with one header
(`Accept: application/json`):

- no cookies, no `Authorization`, no pod key, no relay token, no user identity;
- no redirects followed (a redirect is an error — serve the files directly);
- https only, and definitions only from the index's own origin.

You learn that a pod asked, and nothing about who it is or who uses it.

## Synap's own catalog

Synap's official source still reads the Control Plane's endpoints
(`/api/marketplace/capabilities`, `/api/packages`, `/api/marketplace/cells`)
and is trusted as the configured `CONTROL_PLANE_URL` (default
`https://api.synap.live`) over TLS — `SYNAP_CATALOG_SOURCE=off` switches it
off on the server. The Control Plane should later serve this same signed
`synap-index.json`; the pod then pins Synap's key in code
(`SYNAP_CATALOG_PUBLIC_KEY` in `cp-catalog-sync.ts`, `null` today) and verifies
its own catalog exactly like every other source.
