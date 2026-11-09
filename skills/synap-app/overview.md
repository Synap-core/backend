# Building an app on Synap

## Apps are views of pod state

Model first, UI second. An app built on the pod never hard-codes a status, a status order, a stage or step list, or a status colour: it reads them from `flow.of` (the kind's lifecycle in order, the playbook stage that owns each status, the things in each with who works them and their next step; tRPC `flow.of`, Hub `GET /api/hub/flow`, MCP `synap_get_flow`), and moving work is a pod write (status move, session or playbook action), never app-local state. For any new use case, consolidate the operation first (workspace, kinds, lifecycles, relations, linked playbooks), then draw the UI as a representation of it. Load `rules/apps-are-views-of-pod-state` (founder, 6 Nov 2026).

## Pod-native first (founder, 9 Nov 2026)

A tailored UI over the person's pod is built IN the pod first: views, bento
dashboards, cells, and HTML pages bound as a kind's renderer, shown on the
desktop (load `system/synap-ui/skill`; cells: `system/synap/viewframe-cells`).
Build a standalone site or app only when the person asks for one.

Synap is a sovereign data pod with a complete, typed API. You build an app on it
the same way you'd build on any backend — except the backend is the user's own
pod, and **every write is governed** (see `governance.md`).

## Decide the path first

| The user has… | Do this | Read |
|---|---|---|
| a screen over their pod data (a dashboard, a board, a kind's page) | no app: a view, bento or cell in the pod | `system/synap-ui/skill` |
| an existing app (any framework) | add the SDK | `using-the-sdk.md`, `install-commands.md` |
| a server app people sign in to with their own pod | `@synap-core/sdk/connect` (`createPodAppAuth`, SDK 1.3+) | the SDK's own `AGENTS.md` (`node_modules/@synap-core/sdk/AGENTS.md`) |
| an app on their own pod, with its own key | `synap app init`, then `synap app connect` | `install-commands.md` |
| nothing yet, wants a full app fast | a Next.js app on shadcn + Tailwind v4, plus the SDK. A public starter is decided but not published yet; the HeroUI base app is retired | `using-the-sdk.md` |
| a server / script / CLI (no browser) | SDK with a session token, or the REST client with an API key | `using-the-sdk.md` |

Every path uses the same packages; only the amount of scaffolding differs.

## The packages (all published under `@synap-core/*`)

- `@synap-core/sdk` — typed tRPC client. `createSynapClient({ podUrl, ... })`. **The one you almost always want.** Subpaths: `@synap-core/sdk/connect` (server-only pod-app sign-in, `createPodAppAuth`), `@synap-core/sdk/public` (a public site, no credentials), `@synap-core/sdk/testing` (a mock pod).
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
  (`SYNAP_RELEASE_VERIFY=enforce`) it refuses a release whose signature is
  missing or does not verify; `SYNAP_RELEASE_VERIFY=warn` only warns.
- **Managed (paid):** sign up at synap.live and provision a pod.

## Where the app shows

- On the desktop Home, the person keeps your site under **Your apps** (they pin
  it or keep it as a tool).
- A space can open on your site: its start page (`settings.layout.primarySurface`,
  set by the space's template, or by `synap_set_start_page { workspaceId, url,
  podAppClientId }`) is `{ kind: "url", url, podApp: { clientId } }`,
  `clientId` being the app's client metadata URL. The desktop then opens the site
  with this pod's address, so the app starts the pod's own sign-in. It grants the
  site nothing.

## Honest scope

- **The person's own pod**: fully supported.
- **An app other people use with THEIR pods**: supported through
  `@synap-core/sdk/connect`. Each person connects their own pod and approves what
  the app asks for. Such an app acts as its own agent there: its writes come back
  as proposals the person reviews (`proposed` is success). Only Synap's own apps
  act as the person.
- **Not built yet, do not promise them**: an app the person approved acting as
  them (decided, not built) and a public app starter (decided, not published).
  If the user asks, say so; don't architect around a capability that isn't there.
