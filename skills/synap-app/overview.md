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
