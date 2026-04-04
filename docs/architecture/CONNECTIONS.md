# Synap Connection Architecture

> **Canonical reference — updated 2026-03-05**
> Covers every connection a Data Pod can have: who initiates, what it carries, how it authenticates, and what to implement to add a new one.

---

## Quick Map

```
                        ┌─────────────────────────────────┐
                        │       Synap Control Plane        │
                        │       (api.synap.live)           │
                        │  – user accounts & auth          │
                        │  – billing (Stripe)              │
                        │  – pod provisioning (Hetzner)    │
                        │  – DNS management (Cloudflare)   │
                        └───────────────┬─────────────────┘
                                        │
                              CP → Pod (ES256 JWT push)
                              provision / tier updates
                                        │
                   ┌────────────────────▼──────────────────────┐
                   │              Data Pod                      │
                   │    (pod-abc123.synap.live / self-hosted)   │
                   │                                            │
                   │  – tRPC API (entities, views, channels…)   │
                   │  – Kratos auth (sessions)                  │
                   │  – PostgreSQL + MinIO + Typesense          │
                   │  – Hub Protocol (write gateway for AI)     │
                   └──┬──────────────────────────┬─────────────┘
                      │                          │
            Client → Pod                Intelligence Hub → Pod
            (tRPC / REST)               (Hub Protocol REST)
                      │                          │
          ┌───────────┴──────┐     ┌─────────────┴────────────┐
          │  Any Frontend    │     │   Intelligence Hub        │
          │  (Browser / Web) │     │  (hub.synap.live /        │
          │                  │     │   self-hosted)            │
          │  – Browser (Electron)  │  – AI agents & tools      │
          │  – Web App (Next.js)   │  – LLM orchestration      │
          │  – Third-party app     │  – streaming responses    │
          └──────────────────┘     └──────────────────────────┘
```

---

## The Five Connection Types

### 1. Control Plane → Data Pod (CP-push)

**Direction**: CP → Pod only. The pod never calls the CP at runtime.

**What it carries**:

- Provision credentials (hub URL + API key)
- Subscription tier (so the pod can gate features locally)
- Email credentials (Resend API key, from address, app URL) for invite emails
- Control Plane URL itself (for JWKS fetch)

**Auth mechanism**: ES256 JWT signed with the CP's private key (`CP_EC_PRIVATE_KEY`). The pod fetches the corresponding public key from `GET {controlPlaneUrl}/.well-known/jwks.json` and verifies locally. The pod never needs the private key — it cannot forge tokens.

**Key endpoints**:
| Endpoint | Who calls it | Purpose |
|---|---|---|
| `POST {podUrl}/api/provision/connect` | CP | Push provision JWT (type `provision` or `tier_update`) |
| `POST {podUrl}/api/handshake` | Browser (relays JWT from CP) | Cross-domain login |

**JWT payload**:

```jsonc
{
  "type": "provision", // or "tier_update" for lightweight tier-only push
  "podId": "abc123",
  "controlPlaneUrl": "https://api.synap.live",
  "intelligenceHubUrl": "https://hub.synap.live", // provision only
  "intelligenceHubApiKey": "sk-hub-…", // provision only
  "tier": "pro",
  "resendApiKey": "re_…",
  "resendFromEmail": "noreply@synap.live",
  "appUrl": "https://app.synap.live",
  "iat": 1234567890,
  "exp": 1234568190,
  "iss": "synap-control-plane",
}
```

**Stored on pod**: `workspace.settings.controlPlane` (JSONB, no migration needed):

```jsonc
{
  "url": "https://api.synap.live",
  "podId": "abc123",
  "tier": "pro",
  "resendApiKey": "re_…",
  "resendFromEmail": "noreply@synap.live",
  "appUrl": "https://app.synap.live",
  "connectedAt": "2026-03-05T12:00:00Z",
}
```

**When it happens**:

- Initial provisioning (new subscription checkout)
- Manual reprovision (user clicks "Connect" in Browser settings)
- Subscription tier change (webhook → `pushTierToPods()`)
- Intelligence activation (user enables intelligence in settings)

**Self-hosted pods**: `CONTROL_PLANE_URL` is empty. No CP connection. Tier defaults to `solo`, no tier gates enforced.

---

### 2. Client → Data Pod (tRPC / REST)

**Direction**: Client → Pod only.

**What it carries**: All user-facing data operations — entities, views, channels, documents, workspaces, proposals, etc.

**Auth mechanism**: Kratos session cookie (or Bearer token for API keys). Issued by the pod's own Kratos instance.

**How a client connects**:

1. User sets the pod URL (Browser: auto-configured after CP provision; Web app: user enters `https://pod.synap.live`)
2. Client calls `POST {podUrl}/api/handshake?token={cpJwt}` → gets a Kratos session cookie
3. All subsequent tRPC calls use that cookie at `{podUrl}/trpc/…`

**Key facts**:

- The pod does **not** know which frontend is talking to it — any client that presents a valid session is accepted
- CORS is configured on the pod to allow any origin (all requests are credentialed)
- The Browser (Electron) talks to the pod via `window.synap.api.*` IPC → same tRPC under the hood
- Third-party frontends can connect the same way by obtaining a session (via Kratos flows or API keys)

**Self-hosted users** skip the CP handshake entirely — they create a Kratos account directly on the pod.

---

### 3. Intelligence Hub → Data Pod (Hub Protocol)

**Direction**: Intelligence Hub → Pod only (for writes). Pod → Hub (for triggering AI runs).

**What it carries**:

- Entity creation/update/delete (AI-authored)
- Document creation/update
- View creation/update
- Channel message persistence
- Relation creation
- Profile and property definition management

**Auth mechanism**: Hub Protocol API key (`HUB_PROTOCOL_API_KEY`). This key is generated on the pod during provisioning and stored in the pod's database. The pod auto-brands all requests with `source: "intelligence"` so they can't be spoofed by regular users.

**Key endpoints on the pod**:

- `{podUrl}/api/hub/*` — all Hub Protocol REST operations (entities, documents, threads, search, memory, etc.)
- `POST {podUrl}/api/hub/memory` — session-scoped memory operations
- `POST {podUrl}/api/hub/memory/search` — memory search

**Key endpoints on the hub**:

- `POST {hubUrl}/api/chat/stream` — SSE streaming response (pod calls this when user sends a message)
- `GET {hubUrl}/admin/…` — admin operations (called by CP only)

**Governance**: The Hub Protocol has a permission gate (`checkPermissionOrPropose`). By default, AI writes create proposals that the user approves. Auto-approved operations are whitelisted: `search.*`, `memory.recall`, `entity.read`, `document.read`, `view.create`, `profile.create/update`.

**Where it's registered**: The intelligence service is a row in the `intelligence_services` table. `workspace.settings.intelligenceServiceId = "synap-hub"` activates it. The pod's `resolveIntelligenceService()` picks it up for routing.

---

### 4. Data Pod → Intelligence Hub (AI trigger)

**Direction**: Pod → Hub (fire-and-forget SSE stream reader).

**When**: A message is sent in an `ai_thread` or `branch` channel → backend calls `POST {hubUrl}/api/chat/stream`.

**Auth**: Bearer token = the hub API key stored in `intelligence_services.apiKey` (encrypted at rest, decrypted by `resolveServiceKey()`).

**What it sends**:

```json
{
  "query": "user message text",
  "threadId": "channel-uuid",
  "agentUserId": "agent-uuid",
  "dataPodUrl": "https://pod.synap.live",
  "dataPodApiKey": "hub-protocol-api-key",
  "workspaceId": "workspace-uuid"
}
```

The `dataPodApiKey` is how the Hub calls back into the pod (Hub Protocol). The hub uses it to read context and write results.

---

### 5. Browser / Web App → Control Plane (account & billing)

**Direction**: Client → CP only.

**What it carries**: Account management, subscription, pod list, intelligence provision requests.

**Auth mechanism**: Better Auth session cookie (issued by CP's own auth). The Browser stores the CP session in Electron's session store and passes it with all CP requests.

**Key endpoints the Browser calls**:
| CP Endpoint | Purpose |
|---|---|
| `POST /auth/*` | Login, registration, OAuth |
| `GET /pods` | List user's pods |
| `POST /pods` | Create a new (self-hosted) pod record |
| `POST /pods/handshake` | Get a JWT to log into a pod |
| `POST /intelligence/provision/:podId` | Activate intelligence on a pod |
| `POST /intelligence/revoke/:podId` | Deactivate intelligence |
| `GET /intelligence/provision/status/:podId` | Check provision status |
| `POST /billing/checkout` | Start Stripe checkout |
| `GET /billing/subscription` | Current subscription info |
| `GET /.well-known/jwks.json` | Public key for JWT verification |

---

## Pod Lifecycle

```
User subscribes (Stripe checkout)
        │
        ▼
CP creates pod record (pending)
        │
        ▼
Trigger.dev job runs:
  – Hetzner VPS created
  – cloud-init installs Docker + Synap
  – DNS A record created (Cloudflare)
  – SSL via Caddy
        │
        ▼
Pod boots, registers with CP
(GET /pods/:id/config — pod polls until CP marks it ready)
        │
        ▼
User opens Browser → sees pod ready
        │
        ▼
Browser calls POST /pods/handshake → JWT
Browser POSTs JWT to {podUrl}/api/handshake → Kratos session
        │
        ▼
User is logged in to pod
        │
        ▼
User activates intelligence →
  POST /intelligence/provision/:podId (CP)
    – Hub creates API key for pod
    – CP signs provision JWT (ES256)
    – CP pushes JWT to POST {podUrl}/api/provision/connect
    – Pod stores hub credentials in intelligence_services table
    – Pod activates intelligenceServiceId in workspace settings
        │
        ▼
All AI messages now route to the Hub
```

---

## Tier Gating (How the Pod Enforces Subscription Limits)

The pod reads tier from **local storage** — no CP call at runtime:

```
workspace.settings.controlPlane.tier  →  requireTier() middleware
```

The CP pushes updates via `pushTierToPods()`:

- On subscription created → tier included in initial provision JWT
- On subscription updated (upgrade/downgrade) → `pushTierToPods(userId, newTier)`
- On subscription deleted → `pushTierToPods(userId, "solo")`

Cache TTL: 5 minutes in-process. DB re-read on cache miss.

**Self-hosted**: No `CONTROL_PLANE_URL` → all tier checks pass (no enforcement).

---

## Email (Workspace Invites)

Invite emails are sent **directly from the pod** via Resend — no CP relay:

```
User invites teammate
        │
        ▼
workspaces.createInvite tRPC
        │
        ▼
Read resendApiKey from workspace.settings.controlPlane.resendApiKey
(injected by CP during provisioning)
        │
        ▼
POST https://api.resend.com/emails
```

**Self-hosted**: No `resendApiKey` → invite created in DB but no email sent. Operator should configure their own email service.

---

## Connection Matrix

| From              | To                     | Auth                                               | Direction | Purpose                          |
| ----------------- | ---------------------- | -------------------------------------------------- | --------- | -------------------------------- |
| Browser / Web App | Control Plane          | Better Auth cookie                                 | → CP      | Account, billing, pod management |
| Browser / Web App | Data Pod               | Kratos session cookie                              | → Pod     | All data operations              |
| Browser           | Data Pod (first login) | ES256 JWT from CP                                  | → Pod     | Cross-domain auth (handshake)    |
| Control Plane     | Data Pod               | ES256 JWT (signed by CP, verified by pod via JWKS) | CP →      | Provision, tier updates          |
| Data Pod          | Intelligence Hub       | Bearer API key                                     | Pod →     | Trigger AI chat stream           |
| Intelligence Hub  | Data Pod               | Bearer Hub Protocol API key                        | Hub →     | Hub Protocol writes/reads        |

**Notable absence**: Pod → Control Plane. The pod **never** calls the CP at runtime. All sync is CP-push.

---

## Adding a New Connection Type

To add a new external service that can read/write data on the pod:

### Option A — Hub Protocol (recommended for AI/agent services)

1. The service authenticates with a Hub Protocol API key (created during onboarding)
2. All reads/writes go through `{pod}/api/hub/*` REST endpoints
3. The governance layer (`checkPermissionOrPropose`) automatically applies — writes are proposals until whitelisted
4. Register the service in `intelligence_services` table with `serviceId`, `webhookUrl`, and encrypted `apiKey`
5. The service shows up in the Intelligence app's Agents tab automatically via `useAgentServices()`

### Option B — tRPC with API Key (for non-AI integrations)

1. User creates an API key in Settings → API Keys (`POST {pod}/trpc/apiKeys.create`)
2. External service calls `{pod}/trpc/…` with `Authorization: Bearer {apiKey}`
3. Standard RBAC applies (API keys inherit a role scoped to the issuing user's workspace)

### Option C — Custom REST route (for webhooks / external platform events)

1. Add a Hono route to `apps/api/src/index.ts` (keep it outside tRPC for webhook-style auth)
2. Authenticate with a pre-shared secret or signed payload (HMAC-SHA256)
3. Route to the appropriate service layer (`channelsService`, `entityService`, etc.)
4. Do **not** write to the DB directly — go through service layer so events are emitted

---

## Key Files Reference

| Concern                      | File                                                                    |
| ---------------------------- | ----------------------------------------------------------------------- |
| CP JWT signing               | `synap-control-plane-api/src/lib/signing-key.ts`                        |
| CP JWKS endpoint             | `synap-control-plane-api/src/index.ts` (`/.well-known/jwks.json`)       |
| CP intelligence provision    | `synap-control-plane-api/src/routes/intelligence-provision.ts`          |
| CP tier push on sub change   | `synap-control-plane-api/src/routes/webhooks.ts` (`pushTierToPods`)     |
| Pod provision handler        | `synap-backend/apps/api/src/routers/provision.ts`                       |
| Pod JWT verification (JWKS)  | `synap-backend/packages/api/src/utils/jwks-client.ts`                   |
| Pod tier check               | `synap-backend/packages/api/src/utils/tier-check.ts`                    |
| Pod handshake (login)        | `synap-backend/apps/api/src/index.ts` (`/api/handshake`)                |
| Hub Protocol router          | `synap-backend/packages/api/src/routers/hub-protocol/index.ts`          |
| Intelligence service routing | `synap-backend/packages/api/src/utils/intelligence-routing.ts`          |
| Chat → Hub trigger           | `synap-backend/packages/api/src/routers/chat.ts`                        |
| Workspace invite email       | `synap-backend/packages/api/src/routers/workspaces.ts` (`createInvite`) |

---

## Environment Variables Reference

### Control Plane

| Variable                        | Required | Purpose                                                                                                                                       |
| ------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `CP_EC_PRIVATE_KEY`             | ✅       | ES256 private key for signing JWTs. Generate: `openssl ecparam -name prime256v1 -genkey -noout \| openssl pkcs8 -topk8 -nocrypt -outform PEM` |
| `BETTER_AUTH_URL`               | ✅       | CP's own URL — included in provision JWTs as `controlPlaneUrl`                                                                                |
| `RESEND_API_KEY`                | ✅       | Injected into provision JWTs so pods can send invite emails directly                                                                          |
| `INTELLIGENCE_HUB_URL`          | ✅       | Injected into provision JWTs                                                                                                                  |
| `INTELLIGENCE_HUB_INTERNAL_KEY` | ✅       | Used to call Hub admin endpoints (not sent to pods)                                                                                           |

### Data Pod

| Variable               | Required   | Purpose                                                                      |
| ---------------------- | ---------- | ---------------------------------------------------------------------------- |
| `CONTROL_PLANE_URL`    | Cloud only | CP URL for JWKS fetch. Empty = self-hosted (no tier enforcement, no CP JWTs) |
| `HUB_PROTOCOL_API_KEY` | Auto       | Generated during provisioning, stored in DB. Not needed in `.env`            |

**Removed (no longer exist)**:

- ~~`CONTROL_PLANE_JWT_SECRET`~~ — replaced by ES256 JWKS
- ~~`CONTROL_PLANE_INTERNAL_KEY`~~ — Pod→CP calls eliminated
- ~~`PLATFORM_JWT_SECRET`~~ (CP) — replaced by `CP_EC_PRIVATE_KEY`
- ~~`SYNAP_POD_INTERNAL_KEY`~~ (CP) — Pod→CP calls eliminated
