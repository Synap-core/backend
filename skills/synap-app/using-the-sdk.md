# Using the SDK

## Vanilla / TypeScript / server / CLI — `@synap-core/sdk`

```ts
import { createSynapClient } from "@synap-core/sdk";

const synap = createSynapClient({
  podUrl: "https://pod.example.com", // NO trailing slash, NO /trpc suffix
  sessionToken: process.env.SYNAP_SESSION_TOKEN, // see auth below
  workspaceId: process.env.SYNAP_WORKSPACE_ID ?? "",
  onAuthError: () => {/* 401: sign in again */},
});

// It's a typed tRPC client — full autocomplete over every router.
const me = await synap.users.me.query();
const entities = await synap.entities.list.query({ /* filter */ });
const result = await synap.entities.create.mutate({ /* ... */ });
// result.status may be "proposed" — that is success. See governance.md.
```

### Auth modes (pick ONE)
- **`sessionToken`** — an Ory Kratos session token from a Kratos API (native)
  login flow, sent as `X-Session-Token`. The normal choice for servers, scripts,
  CLIs and mobile.
- **cookie fallback** — omit both; the client sends the ambient Kratos cookie
  (`credentials: "include"`). Browser only.
- **`apiKey`** — only the local-mode token of a desktop pod, sent as
  `Authorization: Bearer`. `/trpc` refuses hub and user API keys
  (`synap_hub_…`, `synap_user_…`), and `createSynapClient` throws if you pass
  one. For an API key, use `@synap-core/hub-rest-client` (below).

Other options: `extraHeaders`, and `onAuthError({ status, message })`, called on a
401 (it also turns the pod's plain-JSON 401 body into a clean tRPC error).

To mint an API key for a machine client, `setupAgent(podUrl, provisioningToken,
agentType)` from `@synap-core/hub-rest-client` returns `{ hubApiKey, agentUserId,
workspaceId }`. That key works with the REST client and the realtime client, not
with `/trpc`.

## React — `@synap-core/react`

```tsx
import { SynapProvider, useSynap, useEntities } from "@synap-core/react";

function App() {
  return (
    <SynapProvider podUrl={podUrl} sessionToken={token} workspaceId={ws}>
      <Dashboard />
    </SynapProvider>
  );
}

function Dashboard() {
  const { data } = useEntities("note", { limit: 20 }); // thin data hook
  const create = useSynap.entities.create.useMutation(); // raw tRPC hooks
  // …
}
```

`useSynap` is the tRPC React hook tree itself — write
`useSynap.entities.list.useQuery(…)`, **not** `useSynap().entities…`: calling it
returns `undefined` at runtime (some package docs still show the call form).

`SynapProvider` takes every `createSynapClient` option (incl. `sessionToken` and
`onAuthError`) plus an optional `queryClient` to share an existing TanStack Query
client. Exports: `SynapProvider`, `useSynapContext` (`{ podUrl, workspaceId }`),
`useSynap`, the data hooks `useEntity`, `useEntities`, `useLinks`, `useView`,
and the `RouterInputs` / `RouterOutputs` types. React 18 or 19 is a peer
dependency — the package does not bundle its own.

## Realtime — `@synap-core/sdk-realtime`

```ts
import { createRealtimeClient } from "@synap-core/sdk-realtime";

const rt = createRealtimeClient({
  url: podUrl,            // pod base URL; the client adds the /presence namespace
  workspaceId,
  sessionToken,           // a Kratos session token…
  userId,                 // …and the identity id it belongs to (both required)
  // or, as a service account: apiKey (scope realtime:observe), no userId
  onInvalidate: (event) => {
    // entity/relation changed — refetch, e.g.
    queryClient.invalidateQueries({ queryKey: ["entities"] });
  },
});

rt.connect();   // nothing connects until you call this
// … later
rt.disconnect();
```

- Callbacks (all options, no subscribe methods): `onInvalidate` (the
  entity/relation-changing subset), `onEvent` (every known event, `{ name, data }`),
  `onConnect`, `onDisconnect(reason)`, `onError(error)`.
- The returned client has `connect()`, `disconnect()`, and read-only `connected`
  and `state` (`"idle" | "connecting" | "connected" | "disconnected"`).
- `SYNAP_EVENT_NAMES` lists the forwarded events; `ENTITY_INVALIDATING_EVENTS` is
  the subset behind `onInvalidate`.
- Websocket-only transport (credentials never ride a long-poll URL), and
  `connect()` throws on a non-TLS URL unless you pass `allowInsecure: true`
  (localhost dev only).

**Version note.** `@synap-core/sdk-realtime@0.1.0` (the current npm release) sends
every credential as `auth.token`. The pod reads `{ userId, token, workspaceId }`
for a user and `{ apiKey, workspaceId }` for a service account, so on 0.1.0 a
session token works only when you also pass `userId`, and an `apiKey` is always
refused. The fix — correct handshake keys, plus an up-front throw for no
credential, both credentials, or `sessionToken` without `userId` — lands in the
first release after 0.1.0. Until then, authenticate realtime with
`sessionToken` + `userId`.

## Two transports, on purpose
- `@synap-core/sdk` (tRPC) — for apps signed in as a user. Typed, React hooks.
- `@synap-core/hub-rest-client` (REST against `/api/hub/*`, zero-dep) — for
  agents/CLIs/scripts holding an API key. `new HubRestClient({ podUrl, apiKey,
  workspaceId })`. Carries agent verbs the tRPC surface has no first-class path
  for (`ask`, `orient`, `discover`).

## Keep types fresh
The SDK is typed by `@synap-core/api-types`, generated from the pod's live router.
If the pod adds a procedure and you don't see it, bump `@synap-core/api-types`.
