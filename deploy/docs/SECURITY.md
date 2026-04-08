# CP↔Pod Security Model

This document describes how the Synap Control Plane (CP) and Data Pods authenticate
each other, what each measure protects against, and how to operate the system safely.

## Overview

All Control Plane → Pod communication uses **ES256 asymmetric JWTs** (ECDSA P-256).
There is **no shared secret** between the CP and pods.

```
Control Plane                              Pod
─────────────                              ───
CP_EC_PRIVATE_KEY (secret, CP-only)
      │
      ▼
  sign JWT  ──── Bearer <token> ──────►  verify JWT
                                             │
                                             ▼
                           /.well-known/jwks.json (public, from CONTROL_PLANE_URL)
```

The pod holds no credentials from the CP. Compromising a pod does not compromise
the signing authority.

## Measures in Place

### 1. ES256 Asymmetric Signing (ECDSA P-256)

**What it protects against**: Forged JWTs. An attacker cannot create a valid CP JWT
without the EC private key, which never leaves the Control Plane.

**Implementation**:

- CP: `synap-control-plane-api/src/lib/signing-key.ts` — `signCpJwt()` uses
  `CP_EC_PRIVATE_KEY` (PEM PKCS#8 EC key).
- Pod: `packages/api/src/utils/jwks-client.ts` — `verifyCpJwt()` fetches the public
  key from `{CONTROL_PLANE_URL}/.well-known/jwks.json` and verifies the signature.
- JWKS cache TTL: 24 hours. Last-known-good fallback: 48 hours (protects against
  temporary CP unavailability during verification).

### 2. CONTROL_PLANE_URL is env-var only — never from JWT claims

**What it protects against**: JWKS endpoint substitution. An attacker crafting a JWT
with `controlPlaneUrl: "attacker.com"` would cause the pod to fetch the JWKS from an
attacker-controlled server and accept forged JWTs.

**Implementation**: All callers of `verifyCpJwt()` pass `config.server.controlPlaneUrl`
(from the `CONTROL_PLANE_URL` environment variable). The JWT payload is never used to
determine which JWKS endpoint to query. The JWT claim may only be stored for display
purposes after the JWT has already been verified.

**Operational requirement**: `CONTROL_PLANE_URL` must be set in the pod's `.env` before
any provisioning operation. Managed pods have this set at deploy time by the CP
provisioning flow.

### 3. JTI (JWT ID) Replay Prevention

**What it protects against**: Token replay. If a valid provisioning JWT is intercepted
(e.g. via a man-in-the-middle on a misconfigured network), the attacker cannot re-use it
after it has been consumed once.

**Implementation**:

- CP side (`signCpJwt()`): every JWT gets a unique `jti: crypto.randomUUID()` field.
- Pod side (`verifyCpJwt()`): after signature/expiry verification, the `jti` is checked
  against an in-memory LRU set (`usedJtis`). If the `jti` has been seen before, the
  token is rejected with a `warn` log entry.
- LRU bounds: max 500 entries, 15-minute TTL per entry, 5-minute sweep interval.
- Backward compatibility: tokens without a `jti` are accepted but trigger a warning log.
  This covers older CP versions during a rolling upgrade. Once all pods are on a version
  that logs the warning, the CP can make `jti` required.

### 4. Issuer Verification

**What it protects against**: Cross-service token reuse. JWTs issued for other purposes
(e.g. user session tokens) are rejected.

**Implementation**: `verifyCpJwt()` always passes `issuer: "synap-control-plane"` to
`jwt.verify()`. Tokens without this issuer fail verification.

### 5. Token Type Claims

**What it protects against**: Cross-endpoint token reuse within the CP JWT space. A
provisioning JWT cannot be replayed against the entity-share endpoint and vice versa.

**Implementation**: Each endpoint checks `payload.type` after signature verification:

- `/api/hub/setup/agent`: requires `type === "agent_setup" | "addon_activate"`
- `/api/hub/entity-share/deliver`: requires `type === "entity-share-deliver"`
- `/api/hub/sync/setup-peer` (via `verifyCpAuth`): requires `type === "sync-setup"`
- `workspaces.acceptInviteViaCp`: requires `type === "invite-accept"`

### 6. Short Token Expiry

**What it protects against**: Limits the window of opportunity if a token is leaked.

**Implementation**: Provisioning tokens are signed with `expiresIn: "10m"` (10 minutes)
by default. The `exp` claim is verified by `jwt.verify()` automatically.

## Pod Agent Security (pod-agent/server.js)

The Pod Agent (port 4002) also uses ES256 JWT verification but discovers the JWKS URL
from a per-request `X-JWKS-URL` header (not from a config file, since the agent has no
database). This is intentional: the agent runs before the main backend and cannot read
`config.server.controlPlaneUrl`.

The agent enforces its own nonce replay protection (`usedNonces` map) independent of
the main API's JTI cache.

**Note**: The `X-JWKS-URL` header must start with `https://` — plain HTTP JWKS URLs are
rejected. Ensure the CP always passes `https://` JWKS URLs to the agent.

## JWKS Key Rotation Procedure

The CP can rotate its EC signing key without any pod configuration changes:

1. Generate a new EC key pair on the CP:
   ```sh
   openssl ecparam -name prime256v1 -genkey -noout | \
     openssl pkcs8 -topk8 -nocrypt -outform PEM > new-cp-key.pem
   ```
2. Update `CP_EC_PRIVATE_KEY` on the Control Plane and restart/redeploy.
3. The `/.well-known/jwks.json` endpoint now serves the new public key.
4. Pods pick up the new key automatically within **24 hours** (JWKS cache TTL).
   If immediate propagation is needed, restart the backend containers on each pod.
5. Any in-flight tokens signed with the old key will fail verification after the pods
   refresh their JWKS cache. Issue new tokens after rotation.

## What is NOT in Use

- `CONTROL_PLANE_JWT_SECRET` — this variable was previously documented but is not used
  anywhere in the codebase. CP↔Pod auth is asymmetric (no shared secret). This variable
  has been removed from `docker-compose.yml`.
- HS256 / symmetric JWT signing — never used for CP↔Pod auth.
- Pod→CP authentication — pods do not currently authenticate outbound calls to the CP
  (e.g. invite email relay). These calls are fire-and-forget notifications, not
  privileged operations.

## Environment Variables Summary

| Variable                       | Required                  | Purpose                                                 |
| ------------------------------ | ------------------------- | ------------------------------------------------------- |
| `CONTROL_PLANE_URL`            | Yes (managed pods)        | Base URL used to fetch JWKS and send CP notifications   |
| `PROVISIONING_TOKEN`           | Yes (self-hosted)         | Static bearer token for self-hosted agent setup (no CP) |
| `SYNAP_SERVICE_ENCRYPTION_KEY` | Yes (CP provisioning)     | Encrypts Hub API keys at rest                           |
| `VAULT_SERVER_KEY`             | Yes (add-on provisioning) | Encrypts add-on bootstrap credentials at rest           |
