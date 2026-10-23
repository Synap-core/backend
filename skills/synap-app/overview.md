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
  needed, fetches the release bundle, checks it against the release manifest's
  sha256 and runs `synap install`); see the backend's `deploy/README.md`. It
  also checks the manifest's signature: by default
  (`SYNAP_RELEASE_VERIFY=warn`) it only warns and carries on when the signature
  is missing or does not verify; `SYNAP_RELEASE_VERIFY=enforce` refuses.
- **Managed (paid):** sign up at synap.live and provision a pod.

You can develop the base app with **no pod at all** using its mock mode
(`NEXT_PUBLIC_BASE_MOCK_MODE=true`).

## Honest scope

Building on the user's OWN pod is fully supported today. Building a **multi-tenant
commercial app** where *other* people connect *their* pods is **not yet supported**
— per-app data scoping is still being built. If the user asks for that, say so;
don't architect around a capability that isn't there.
