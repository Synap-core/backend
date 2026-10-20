---
name: synap-app
description: >
  Use this skill when the user wants to BUILD THEIR OWN APP on top of Synap — a
  personal project or a product — using Synap as the backend (auth, typed data
  API, realtime). Two paths: add the SDK (@synap-core/sdk) to an existing app,
  or scaffold the opinionated Next.js + HeroUI base app (npx create-synap-app).
  Triggers: "build an app on Synap", "use Synap as my backend", "scaffold a
  Synap project", "add the Synap SDK", "connect my app to my pod",
  "npx create-synap-app". NOT the `synap` skill (capture/recall in a pod) nor
  `synap-ui` (views inside the pod's own UI) — this is about writing app CODE.
metadata:
  synap:
    requires:
      env: []
    optional_env: [SYNAP_POD_URL, SYNAP_WORKSPACE_ID]
    primaryEnv: null
    homepage: https://synap.live
    capabilities: [sdk, scaffold, auth, realtime]
    os: [macos, linux, windows]
    userInvocable: true
---

# Building an app on Synap

Synap is a sovereign data pod with a complete, typed API. You build an app on it
the same way you'd build on any backend — except the backend is the user's own
pod, and **every write is governed** (see `governance.md`).

## Decide the path first

| The user has… | Do this | Read |
|---|---|---|
| an existing app (any framework) | add the SDK | `using-the-sdk.md`, `install-commands.md` |
| nothing yet, wants a full app fast | scaffold the base app (scaffolder not published yet) | `creating-the-base-app.md`, `install-commands.md` |
| a server / script / CLI (no browser) | SDK with a session token, or the REST client with an API key | `using-the-sdk.md` |

Both paths use the same underlying packages; only the amount of scaffolding differs.

## The packages (all published under `@synap-core/*`)

- `@synap-core/sdk` — typed tRPC client. `createSynapClient({ podUrl, ... })`. **The one you almost always want.**
- `@synap-core/react` — React/TanStack-Query bindings (`SynapProvider`, hooks).
- `@synap-core/sdk-realtime` — Socket.IO "something changed" events (`createRealtimeClient`).
- `@synap-core/hub-rest-client` — zero-dep REST client for API-key holders (`HubRestClient`, `setupAgent`).

Do not install `@synap-core/auth`: that package was retired, and its last npm
release signs in through a pod route that no longer exists.

Pin `@^1.0.0` on `sdk`/`react` so you never resolve an old, abandoned `0.x`.

## The three rules that trip people up

1. **A write can come back `"proposed"` — that is SUCCESS, not an error.** It means
   the change is queued for the pod owner's review (like a PR). Surface the review,
   don't retry. Full contract: `governance.md`.
2. **The pod URL has no `/trpc` suffix and no trailing slash.** The SDK appends `/trpc`.
3. **Non-browser clients (server/CLI/mobile) authenticate with a session token or
   an API key**, never a cookie. An API key only works on the REST client and
   realtime, not on the tRPC SDK. Browser apps use the Kratos session cookie.

## Get a pod to build against

- **Self-host (free):** run the backend's `install.sh` (it installs Docker if
  needed, fetches a signed release bundle and runs `synap install`); see the
  backend's `deploy/README.md`.
- **Managed (paid):** sign up at synap.live and provision a pod.

You can develop the base app with **no pod at all** using its mock mode
(`NEXT_PUBLIC_BASE_MOCK_MODE=true`).

## Honest scope

Building on the user's OWN pod is fully supported today. Building a **multi-tenant
commercial app** where *other* people connect *their* pods is **not yet supported**
— per-app data scoping is still being built. If the user asks for that, say so;
don't architect around a capability that isn't there.

---

# Install & scaffold commands

## Scaffold a full app (recommended for a fresh start)

> **Not published yet.** The scaffolder (`@synap-core/create-synap-app`) is not
> on npm and the base template is not public, so `npx` returns 404 today. Use the
> SDK path below until a release exists.

Once published:

```bash
npx @synap-core/create-synap-app my-app
```

It creates a Next.js + HeroUI project from the base template, with the SDK, auth,
app shell, command palette, realtime, and mock mode pre-wired. It also drops an
`AGENTS.md` into the project so your AI coding tool knows how to work with it.

## Add the SDK to an existing app

```bash
# npm
npm install @synap-core/sdk@^1.0.0

# with React bindings
npm install @synap-core/sdk@^1.0.0 @synap-core/react@^1.0.0

# realtime
npm install @synap-core/sdk-realtime

# REST client for API-key holders (agents, scripts); also has setupAgent()
npm install @synap-core/hub-rest-client
```

Do not install `@synap-core/auth` (retired; its last release calls a removed pod
route) or `@synap-core/auth-bootstrap` (not published).

Pin `@^1.0.0` on `sdk`/`react`. **Do not** install unpinned `@synap-core/sdk` —
older `0.x` versions on the registry are a different, abandoned package.

## Get this knowledge into your AI coding tool

```bash
# print this skill from your pod's skill knowledge base
synap skill get synap-app

# or wire a tool end-to-end (skills + MCP)
synap connect --target=cursor        # or claude-code, claude-desktop, codex, …
```

Once the scaffolder is published, the scaffolded project ships an `AGENTS.md` at its root — most AI
coding tools read it automatically, so a freshly-scaffolded app teaches the AI
how to build on it with zero extra setup.

## Verify an install actually works

Publishing bugs have shipped uninstallable Synap packages before. After adding a
package, confirm it resolves in a clean directory:

```bash
mkdir /tmp/synap-check && cd /tmp/synap-check && npm init -y
npm install @synap-core/sdk@^1.0.0
node -e "console.log(typeof require('@synap-core/sdk').createSynapClient)"  # → function
```

---

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

---

# Creating the base app

The base app is an opinionated, batteries-included starter: **Next.js 16 (App
Router) + React 19 + HeroUI + Tailwind**, with auth (incl. TOTP), an app shell
(tabs + slide-in right panel), a Cmd+K command palette, a realtime bridge, and a
mock mode — all pre-wired. You add your screens; the plumbing is done.

## Scaffold it

> **Not published yet.** `@synap-core/create-synap-app` is not on npm and the
> base template is not public, so this does not work today. Until a release
> exists, build on the SDK directly (`using-the-sdk.md`). The rest of this page
> describes the template as it will ship.

```bash
npx @synap-core/create-synap-app my-app
cd my-app                    # the scaffolder seeds .env.local from env.example;
                             # fill in your pod / control-plane URLs
pnpm install && pnpm dev     # http://localhost:3010
```

Develop with **no pod** by setting `NEXT_PUBLIC_BASE_MOCK_MODE=true`.

## What's where

```
app/
  layout.tsx        Root layout → ClientProviders (client-only, see below)
  ClientProviders   Loads the provider tree with { ssr: false } (REQUIRED — see rule 1)
  providers.tsx     The real provider stack (auth, tRPC, realtime, palette)
  (app)/home        Your home screen — replace this
  login/ onboarding First-run + auth screens
lib/
  registerAll.ts    Boot hook — registers cells/views (override in your app)
  auth.ts mockMode  Session + mock helpers
components/layout/
  AppShell          Root layout primitive — pass your sidebar as `leftNav`
```

## Four rules that keep the build green (all Next 16 / Turbopack specifics)

1. **The provider tree must load client-only.** `app/ClientProviders.tsx` does
   `dynamic(() => import("./providers"), { ssr: false })`. base's provider tree
   pulls a dep that touches `window` at module scope, which crashes a server
   render. base is a client app shell — there is nothing to server-render — so
   this is correct, not a hack. Keep it.
2. **`config.matcher` in `middleware.ts` must be an inline literal**, not a value
   read from a helper — Next's static analyzer can't parse an expression there.
3. **In `globals.css`, `@import` must come before the `@tailwind` directives.**
   Turbopack enforces the CSS spec strictly.
4. **Build with Turbopack (the default) — do NOT pass `--webpack`.** In Next 16
   the legacy `--webpack` flag silently produces nothing (exit 0, no output). If
   you add a webpack alias, port it to `turbopack.resolveAlias` in `next.config.ts`.

## Deriving your own app

1. Rename the namespaced storage keys (`base:session`, `base-workspace`, …) so
   two Synap apps don't share state in one browser. The README lists every key.
2. Replace `app/(app)/home/page.tsx` with your dashboard.
3. Pass your sidebar: `<AppShell leftNav={<MySidebar />}>`.
4. Register app-specific Cmd+K commands with `useRegisterCommand([...])`.
5. Register only the cells you need in `lib/registerAll.ts` (a lean template
   registers fewer than the full set).

## Auth flow (already wired)

`/login` → Synap Cloud sign-in → optional TOTP → pod picker → session stored →
`/home`. A pod can also be signed into directly through its own Kratos (the
login screen's manual-login step). You don't build this; you theme it.

---

# Governance — `"proposed"` is success, not an error

This is the single most important thing to get right when writing code that
mutates a Synap pod.

## The contract

Every governed mutation (`entities.create`, `entities.update`, `relations.create`, …)
has one of three outcomes, decided **by the pod**, not by your app:

| Outcome | How it arrives | What your code should do |
|---|---|---|
| applied | resolves with the procedure's own status (`"created"`, `"updated"`, …) | proceed |
| proposed | resolves with `status: "proposed"`, `proposalId`, `reviewUrl`, `message` — queued for the pod owner's review (like a PR) | **surface the review — do NOT treat as failure, do NOT retry** |
| denied | **rejects** with a tRPC `FORBIDDEN` error whose message is the reason | show why; do not retry blindly |

## Why it matters for your code

- **Never treat `proposed` as an error.** It is the normal, healthy path for any
  write that governance decides a human should see first. Retrying a `proposed`
  write creates duplicates.
- **A `proposed` result does not throw.** It is a successful response with a
  status; only a denial throws.
- **Surface the review link/id** so the user can approve it. An unreviewed
  proposal is not yet in the graph — it won't show up in reads until approved.

## Pattern

```ts
import { TRPCClientError } from "@trpc/client";

try {
  const res = await synap.entities.create.mutate(input);
  if (res.status === "proposed") {
    // tell the user "queued for review"; link res.reviewUrl / res.proposalId.
    // res.entity is null — nothing exists until the proposal is approved.
  } else {
    // "created": res.id / res.entity are live
  }
} catch (err) {
  if (err instanceof TRPCClientError && err.data?.code === "FORBIDDEN") {
    // denied: show err.message; don't retry
  } else throw err;
}
```

## Idempotency

`entities.create` takes no idempotency key. The pod dedups some repeats on its
own — an identical agent-authored retry within a short window, and creates that
match an existing entity by identity (a stable `externalId`, or identifying
properties) — but neither covers every case. Never resend a `proposed` write,
and when unsure, read back before re-creating.
