# @synap-core/auth-bootstrap

Zero-dependency auth bootstrap for [Synap](https://synap.live) data pods. The shared home of the two
credential flows, used by both `@synap-core/sdk` (tRPC) and `@synap/hub-rest-client` (REST).

- **`handshake()`** → a Kratos **session token** — the credential the tRPC SDK consumes as `sessionToken`.
- **`setupAgent()`** → a Hub Protocol **API key** — the credential the REST client consumes as `apiKey`.

Native `fetch` only — runs in Node ≥ 18, browsers, Deno, Bun, and edge runtimes.

## Session token (for the tRPC SDK)

```typescript
import { fetchHandshakeJwt, handshake } from "@synap-core/auth-bootstrap";
import { createSynapClient } from "@synap-core/sdk";

// 1. (managed pods) get a CP-signed handshake JWT — skip for self-hosted issuers
const handshakeToken = await fetchHandshakeJwt({
  cpUrl: "https://api.synap.live",
  cpToken: "<cp-session-token>",
  podUrl: "https://your-pod.synap.live",
});

// 2. exchange it for a pod session token
const { sessionToken, expiresAt } = await handshake({
  podUrl: "https://your-pod.synap.live",
  handshakeToken,
});

// 3. authenticate the SDK
const synap = createSynapClient({
  podUrl: "https://your-pod.synap.live",
  sessionToken,
  workspaceId: "ws_...",
});
```

`@synap-core/sdk/auth` ships `createAuthedClient()` that wraps steps 2–3 in one call.

## API key (for the REST client)

```typescript
import { checkPodHealth, setupAgent } from "@synap-core/auth-bootstrap";

if ((await checkPodHealth("https://your-pod.synap.live")).healthy) {
  const { hubApiKey, workspaceId } = await setupAgent(
    "https://your-pod.synap.live",
    process.env.PROVISIONING_TOKEN!,
    "my-agent"
  );
}
```

## Security

- Tokens are **never persisted** by this package — it returns them; storage is the caller's job. Treat a
  session token like a password (in-memory or an HttpOnly cookie, never `localStorage`).
- Tokens are **never logged** and never attached to thrown errors (`AuthBootstrapError.body` is the
  backend's error JSON only).
- Every credential-bearing call validates `podUrl` via `assertValidPodUrl` (https-only by default,
  no embedded credentials) — `podUrl` is attacker-influenceable in multi-tenant/portal contexts.
- Stateless: no auto-refresh. On a 401, re-`handshake()` with a fresh JWT.
