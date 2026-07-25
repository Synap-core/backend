# Using the SDK

## Vanilla / TypeScript / server / CLI — `@synap-core/sdk`

```ts
import { createSynapClient } from "@synap-core/sdk";

const synap = createSynapClient({
  podUrl: "https://pod.example.com", // NO trailing slash, NO /trpc suffix
  apiKey: process.env.SYNAP_API_KEY, // or sessionToken (see auth below)
  workspaceId: process.env.SYNAP_WORKSPACE_ID ?? "",
});

// It's a typed tRPC client — full autocomplete over every router.
const me = await synap.users.me.query();
const entities = await synap.entities.list.query({ /* filter */ });
const result = await synap.entities.create.mutate({ /* ... */ });
// result may be { status: "proposed", ... } — that is success. See governance.md.
```

### Auth modes (pick ONE)
- **`apiKey`** — a Bearer key generated in the workspace's developer settings.
  Best for servers, scripts, CLIs.
- **`sessionToken`** — an Ory Kratos session token, sent as `X-Session-Token`.
  Best for non-browser clients that completed a sign-in.
- **cookie fallback** — omit both; the client uses the ambient Kratos cookie.
  Browser, same-origin only.

For machine clients that need to bootstrap a credential, use
`@synap-core/auth-bootstrap` (`setupAgent(provisioningToken)` → API key,
`handshake(jwt)` → session token). Zero-dependency, safe in edge/serverless.

## React — `@synap-core/react`

```tsx
import { SynapProvider, useSynapContext } from "@synap-core/react";

function App() {
  return (
    <SynapProvider podUrl={podUrl} sessionToken={token} workspaceId={ws}>
      <Dashboard />
    </SynapProvider>
  );
}
```

`SynapProvider` honours every `createSynapClient` option, incl. `sessionToken`
and `onAuthError` (a 401 handler). `react` is a peer of your app's React — it
does not bundle its own.

## Realtime — `@synap-core/sdk-realtime`

```ts
import { createRealtimeClient } from "@synap-core/sdk-realtime";

const rt = createRealtimeClient({ podUrl, sessionToken });
const stop = rt.onInvalidate((target) => {
  // e.g. refetch the affected query
});
```

Websocket-only transport (credentials never ride a long-poll URL) and it refuses
to send credentials over non-TLS unless you explicitly pass `allowInsecure`.

## Two transports, on purpose
- `@synap-core/sdk` (tRPC) — for apps. Typed, hooks, realtime.
- `@synap-core/hub-rest-client` (REST, zero-dep) — for agents/CLIs/scripts. Carries
  agent verbs the tRPC surface has no first-class path for (`ask`, `orient`,
  `discover`). Use it when you want a dependency-free REST client, not a full app.

## Keep types fresh
The SDK is typed by `@synap-core/api-types`, generated from the pod's live router.
If the pod adds a procedure and you don't see it, bump `@synap-core/api-types`.
