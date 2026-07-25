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
  openclaw:
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
| nothing yet, wants a full app fast | scaffold the base app | `creating-the-base-app.md`, `install-commands.md` |
| a server / script / CLI (no browser) | SDK with a session token or API key | `using-the-sdk.md` |

Both paths use the same underlying packages; only the amount of scaffolding differs.

## The packages (all published under `@synap-core/*`)

- `@synap-core/sdk` — typed tRPC client. `createSynapClient({ podUrl, ... })`. **The one you almost always want.**
- `@synap-core/react` — React/TanStack-Query bindings (`SynapProvider`, hooks).
- `@synap-core/sdk-realtime` — Socket.IO presence/live-updates (`createRealtimeClient`).
- `@synap-core/auth` — sign-in orchestration (Synap Cloud + pod handshake), framework-agnostic.
- `@synap-core/auth-bootstrap` — zero-dep server helpers (`setupAgent`, `handshake`) for machine clients.

Pin `@^1.0.0` on `sdk`/`react` so you never resolve an old, abandoned `0.x`.

## The three rules that trip people up

1. **A write can come back `"proposed"` — that is SUCCESS, not an error.** It means
   the change is queued for the pod owner's review (like a PR). Surface the review,
   don't retry. Full contract: `governance.md`.
2. **The pod URL has no `/trpc` suffix and no trailing slash.** The SDK appends `/trpc`.
3. **Non-browser clients (server/CLI/mobile) authenticate with a token or API key**,
   never a cookie. Browser apps use the Synap Cloud sign-in flow (`@synap-core/auth`).

## Get a pod to build against

- **Self-host (free):** `git clone` the backend, `docker compose up -d` (run its
  `install.sh` to generate secrets). Pod answers on `:4000`.
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

```bash
npx create-synap-app my-app
```

Creates a Next.js + HeroUI project from the base template, with the SDK, auth,
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

# auth (browser sign-in) or auth-bootstrap (server credential bootstrap)
npm install @synap-core/auth        # or @synap-core/auth-bootstrap
```

Pin `@^1.0.0` on `sdk`/`react`. **Do not** install unpinned `@synap-core/sdk` —
older `0.x` versions on the registry are a different, abandoned package.

## Get this knowledge into your AI coding tool

```bash
# add the app-creation skill (this skill) to a connected AI tool
synap skills get synap-app

# or wire a tool end-to-end (skills + MCP), any target
synap connect --target=cursor        # or claude, openclaw, …
```

Alternatively, the scaffolded project ships an `AGENTS.md` at its root — most AI
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

---

# Creating the base app

The base app is an opinionated, batteries-included starter: **Next.js 16 (App
Router) + React 19 + HeroUI + Tailwind**, with auth (incl. TOTP), an app shell
(tabs + slide-in right panel), a Cmd+K command palette, a realtime bridge, and a
mock mode — all pre-wired. You add your screens; the plumbing is done.

## Scaffold it

```bash
npx create-synap-app my-app
cd my-app
cp .env.example .env.local   # fill in your pod / control-plane URLs
pnpm dev                     # http://localhost:3010
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

`/login` → Synap Cloud sign-in (email + password or magic link) → optional TOTP →
pod picker → handshake → session stored → `/home`. Self-hosted pods fall back to
the pod's own Kratos at `/login?mode=kratos`. You don't build this; you theme it.

---

# Governance — `"proposed"` is success, not an error

This is the single most important thing to get right when writing code that
mutates a Synap pod.

## The contract

Every mutation (`entities.create`, `entities.update`, `relations.create`, …)
resolves to one of three outcomes, decided **by the pod**, not by your app:

| Outcome | Meaning | What your code should do |
|---|---|---|
| `approved` | applied immediately | proceed |
| `proposed` | queued for the pod owner's review (like a PR) | **surface the review — do NOT treat as failure, do NOT retry** |
| `denied` | the principal may not do this | show why; do not retry blindly |

## Why it matters for your code

- **Never treat `proposed` as an error.** It is the normal, healthy path for any
  write that governance decides a human should see first. Retrying a `proposed`
  write creates duplicates.
- **Never `try/catch` a `proposed` as if it threw.** It's a successful response
  with a status, not an exception.
- **Surface the review link/id** so the user can approve it. An unreviewed
  proposal is not yet in the graph — it won't show up in reads until approved.

## Pattern

```ts
const res = await synap.entities.create.mutate(input);
switch (res.status) {
  case "approved": /* it's live */ break;
  case "proposed": /* tell the user: "queued for review" + show res.proposalId */ break;
  case "denied":   /* show res.reason; don't retry */ break;
}
```

## Idempotency

If you must retry a create after a network error, pass an idempotency key where
the API accepts one — a `proposed` write that you retry without one will
duplicate on approval. When unsure, read back before re-creating.
