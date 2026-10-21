# Authentication and federation

> Verified against code on 2026-10-20 (backend@cc4b2d81).

A pod authenticates its own users. An external account service (Synap's
hosted control plane is one) can help a person reach a pod, but it never holds
a pod session and never decides pod membership. A self-hosted pod works with
no account service at all.

## Who owns what

| Domain          | Owns                                                                                                    | Does not own                            |
| --------------- | ------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| Account service | its accounts, passwords, recovery, invitations, a ledger of related pods                                | pod sessions, pod users, pod membership |
| Pod             | local users, Kratos identities and sessions, memberships, workspaces, projects, trusted-issuer approval | account-service user ids or pod records |

## Credentials a pod accepts

| Caller                         | Credential                                                                   | Checked by                                                     |
| ------------------------------ | ---------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Browser, apps                  | Kratos session: cookie `ory_kratos_session` or header `X-Session-Token`      | `orySessionMiddleware` (`packages/auth/src/ory-middleware.ts`) |
| Agents, CLI, integrations      | API key, `Authorization: Bearer`                                             | [api-keys.md](api-keys.md)                                     |
| Intelligence Service, one turn | bearer token the pod signed for that turn                                    | Hub auth middleware ([hub-protocol.md](hub-protocol.md))       |
| Desktop local mode             | the fixed `LOCAL_AUTH_TOKEN` (bearer or `x-local-token`); Kratos is not used | `orySessionMiddleware` local-mode branch                       |

An origin approved as an external application must send `X-Session-Token` on
every request; it never falls back to an ambient pod cookie.

The tRPC context (`packages/api/src/context.ts`) takes the identity the
middleware established; procedures read `ctx.userId`. Agent keys and human
sessions stay separate: an agent key never authenticates a human action, and a
human session never bypasses proposal governance for an agent.

## Sign-in paths

**Direct pod sign-in.** Every pod has its own Kratos login and recovery. This
is the self-hosted path and the path that keeps working when an account
service is down. Password self-registration is off: people join through an
owner invitation or through the account service.

**Federated sign-in (Kratos OIDC provider `cp`).** The pod's Kratos is
configured with an OIDC provider named `cp` that points at the account
service's OAuth issuer. The claim mapper `kratos/oidc.cp.jsonnet` maps the
verified id token to the identity traits (`email`, `name`) and copies the
claims the registration gate needs into `metadata_public.synap_cp`.
`apps/api/src/webhooks/kratos-registration-gate.ts` runs as two Kratos hooks:

- `POST /gate` (pre-persist, can interrupt): a federated user gets a pod account
  on first sign-in only if the signed claims say they own this pod, their email
  is verified, and the pod has no different human owner yet. Everyone else is
  refused with `POD_ACCESS_REQUIRED`; a password sign-up is refused with
  `SELF_REGISTRATION_DISABLED`.
- `POST /complete` (post-persist): seeds the owner through the same door as
  `/api/federation/bootstrap`.

`GET /api/federation/discovery` tells a client whether federated sign-in is
available: the pod must have a configured OIDC issuer and that issuer must be
an approved trusted issuer. A failed read answers 503, never "unavailable".
`deploy/verify-federated-signin.sh` smoke-tests the server-side hops.

Google and GitHub OIDC mappers also ship in `kratos/`.

## Trusted issuers

An external service can vouch for facts about a person only after a pod owner
approves it as a trusted issuer (`trusted_issuers`,
`packages/database/src/schema/trusted-issuers.ts`; administration in
`packages/api/src/routers/trusted-issuers.ts`). Lifecycle: `pending`, then
`approved` or `rejected`; an approved issuer can be `revoked`. A pod trusts no
issuer by default.

Capabilities are a ceiling, never a global grant; the pod still checks every
target workspace or project:

| Capability            | Allows                                                        |
| --------------------- | ------------------------------------------------------------- |
| `identity:link-user`  | link a directly authenticated local user to an issuer subject |
| `membership:grant`    | request one exact workspace or project membership             |
| `source-config:write` | create source configuration for a linked, authorised user     |
| `auth:exchange-user`  | kept as stored data; the exchange route it gated was removed  |
| `membership:activate` | deprecated; use `membership:grant`                            |

The pod stores only generic records (`packages/database/src/schema/federation.ts`):
`federated_identity_links` (one opaque issuer subject to one local user),
`issuer_identity_link_receipts` (one-time proof that a browser had a direct pod
session), `federated_access_receipts` (idempotency of membership commands),
`federated_assertion_receipts` (single-use assertion ids), and the
`federated_application_connections` tables for approved cross-origin apps. It
stores no account-service user id, no external pod id, and no provider URL as an
authentication default.

## Assertion contract

Federation routes accept short-lived ES256 JWTs with an exact canonical HTTPS
`iss`, the pod's canonical `aud`, `iat`, `exp` and a non-empty `jti`:

1. the issuer must be approved and hold the capability the route needs;
2. its JWKS is resolved safely: HTTPS only, public addresses only, DNS-pinned,
   bounded response, no environment fallback (`packages/api/src/utils/issuer-url-safety.ts`,
   `jwks-client.ts`);
3. signature, issuer, audience, lifetime and purpose claims are verified;
4. `(issuer, jti)` is consumed atomically in `federated_assertion_receipts`
   before any mutation (`federated-assertion-receipt-service.ts`); the in-process
   replay cache is only an optimisation;
5. the local operation runs only if the subject is linked and the pod's own
   membership checks pass.

## Federation routes

`apps/api/src/routers/federation.ts`, mounted at `/api/federation`:

| Route                                   | Caller                            | Purpose                                                             |
| --------------------------------------- | --------------------------------- | ------------------------------------------------------------------- |
| `GET /discovery`                        | browser                           | is federated sign-in available                                      |
| `POST /identity-links`                  | browser with a direct pod session | link an issuer subject to the local user, return a one-time receipt |
| `POST /identity-links/consume`          | issuer, server to server          | consume the receipt, get the pod's access projection                |
| `POST /access-grants`                   | approved issuer                   | apply one exact workspace or project membership                     |
| `POST /bootstrap`                       | installer                         | create the first local owner of a fresh pod                         |
| `/application-connections/requests/...` | external application              | request and complete an approved cross-origin connection            |

**Adding an existing pod to an account** never sends the pod session to the
account service: the account service issues an identity-link assertion, the
browser posts it with its direct pod session to `/identity-links`, the pod
returns a one-time receipt, and the account service consumes it server to
server.

**First-owner bootstrap.** A fresh pod has no owner and no trusted issuer.
`POST /api/federation/bootstrap` takes an installer-provided secret in
`X-Pod-Bootstrap-Token` plus an assertion with purpose
`initial-owner-bootstrap`. The secret authorises only the first-owner
operation; it is not a user credential and cannot create a second owner. The
route is rate-limited. Self-hosted pods can create their first owner locally
instead.

## Recovery and invitations

- Password recovery belongs to whoever owns the credential: pod-local recovery
  uses the pod's Kratos flow; account-service recovery is the account
  service's.
- Invitations created inside the pod work without any account service. An
  account service can deliver its own invitations and then send a
  `membership:grant` access-grant naming one workspace or project.

## Operational connections are separate

The optional pod agent (`deploy/pod-agent/`) receives signed update, restore
and diagnostics commands from an operations service. Enabling it does not
approve an issuer for sign-in or grant membership. Marketplace, billing and
Intelligence Service settings are operational configuration and are never
consulted for identity or membership.

## Debugging a 401

- Is `ory_kratos_session` sent (or `X-Session-Token` set) for the pod's domain?
- Is the session still valid in Kratos (`/sessions/whoami`)?
- For an external application origin, is `X-Session-Token` sent on every
  request?
- For federated sign-in, what does `GET /api/federation/discovery` say?

## History

- Until 2026-07 a pod and the control plane were joined by a handshake bridge
  (`/api/handshake`, `/pods/handshake`, `/api/provision/connect`,
  `seed-trust`, `seed-admin`). The provision routes now answer with a
  retirement response; the handshake routes are gone.
- 2026-10-11: `POST /api/federation/exchange` and the Hub's
  `POST /auth/exchange` were deleted. Both tried to mint a Kratos session
  through an admin route that Kratos v1.3.1 does not have, so neither ever
  worked. Federated sign-in goes through the Kratos OIDC provider `cp`. The
  tripwire `no-kratos-admin-session-mint` keeps the mint from coming back.
