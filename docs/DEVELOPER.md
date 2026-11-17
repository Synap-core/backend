# Building on Synap

Synap ships a browser app and a CLI, but it is deliberately a **backend first**.
If you want your own app — a CRM, a portal, an internal tool — the public
TypeScript SDK is the front door.

> **Install:** `npm i @synap-core/sdk`
> MIT · published to the public npm registry · typed tRPC client for your pod.

This doc shows the minimum real integration. For the product's architecture and
the data model it sits on, read [`ARCHITECTURE-OVERVIEW.md`](./ARCHITECTURE-OVERVIEW.md)
first.

---

## 1. The one that works: the public SDK

`@synap-core/sdk` is the supported way to build a third-party app against a
Synap pod.

```bash
npm i @synap-core/sdk
```

It is a thin, **fully-typed tRPC client** over the pod's API — every router is
available with compile-time autocomplete.

```ts
import { createSynapClient } from "@synap-core/sdk";

const synap = createSynapClient({
  podUrl: "https://pod.example.com", // base URL, no trailing slash, no /trpc
  sessionToken: process.env.SYNAP_SESSION_TOKEN, // an Ory Kratos session token
  workspaceId: "ws_...", // scopes every request to one workspace
});

// Typed calls with autocomplete across every router
const entities = await synap.entities.list.query({ limit: 20 });
const workspace = await synap.workspaces.get.query({ id: "<workspace uuid>" }); // `id` is required (a uuid)
```

**Auth, in order of preference:**

| Option         | Header                    | Use for                                                                                                                                                                                                                           |
| -------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessionToken` | `x-session-token`         | **Preferred** — Ory Kratos session token from a Kratos API (native) login flow. For CLI tools, mobile, extensions.                                                                                                                |
| `apiKey`       | `Authorization: Bearer …` | Only the local-mode token of a desktop pod. A pod refuses hub and user API keys (`synap_hub_…`, `synap_user_…`) on `/trpc`, and the client throws if given one: use `@synap-core/hub-rest-client` against `/api/hub/*` for those. |
| _(neither)_    | cookie                    | Falls back to cookie-based Kratos session auth.                                                                                                                                                                                   |

**Getting a `sessionToken`.** The pod runs Ory Kratos behind its own domain at
`<podUrl>/.ory/kratos/public/` (see `deploy/Caddyfile`). Run a Kratos **native
(API) login flow** against it: create a flow
(`GET <podUrl>/.ory/kratos/public/self-service/login/api`), then submit it with
the method your pod enables (for a password identity: `method: "password"`,
`identifier`, `password`). The answer carries `session_token`; pass it as
`sessionToken` (the SDK sends it as `x-session-token`). Expired tokens answer
`401`: log in again. The desktop browser creates its flow through the
`/browser` endpoint instead (`browser/electron/main/connection/connection-manager.ts`,
"the /api suffix path is not universally supported"): if the `/api` route is
refused on your proxy, that is the fallback. For a headless agent, a hub API key
over `@synap-core/hub-rest-client` needs no login at all.

**No pod yet?** `@synap-core/sdk/testing` ships a mock pod
(`createMockPod()`, `createMockAuthServer()`): point the client at its URL and
run your code with no Kratos and no database. Its doors and options are listed in
the SDK README.

Pass `onAuthError` to handle a `401` gracefully — the client rewrites the pod's
plain-JSON auth error into a proper tRPC error so your query rejects cleanly
instead of crashing on a parse error.

### Public shares and forms

`@synap-core/sdk/public` is a separate, **credential-less** client for the pod's
public doors — published shares and guest form submissions. It never sends an
`Authorization`, `Cookie`, or session header (`credentials: 'omit'`), and
imports nothing from the authenticated client.

```ts
import { createPublicClient } from "@synap-core/sdk/public";

const pub = createPublicClient({ podUrl: "https://pod.example.com" });
const share = await pub.readShare(token); // a published entity
const form = await pub.getForm(token); // a form's fields + ticket
await pub.submitForm(token, { fields, ticket: form.data.ticket });
```

Note: public form submissions answer `202` to _everything_ (to avoid leaking
which tokens exist), so use the `idempotencyKey` option when you need
at-most-once semantics.

### Beyond the SDK

The full surface is also available over the **Hub Protocol** REST API and via
**MCP** for agents. The SDK is the nicest door, not the only one.

---

## 2. Bring your own agent (MCP)

Any MCP-capable agent (Claude Code, Cursor, ChatGPT, …) connects to your pod
with a scoped key. From your terminal:

```bash
npm install -g @synap-core/cli
synap init                                  # point the CLI at your pod
synap connect --target=claude-code          # or: cursor · raycast · claude-desktop
```

The agent then works against the same records you do, with the same proposal
gate. Switching agents never loses context — the data is in your pod, not in
the model.

---

## 3. Self-hosting a pod

Synap is open source and self-hostable. On a Linux host with a domain
pointing at it, the installer pulls the latest stable release (pre-built
Docker images, no source build) and starts the stack behind Caddy with
automatic HTTPS:

```bash
curl -fsSL https://github.com/synap-core/backend/releases/download/channel-stable/install.sh \
  | sudo bash -s -- --domain pod.example.com --email you@example.com
```

It installs Docker if needed. To try a pod on your own machine instead, run
`./synap install --domain localhost` from a clone of the repository, which
builds from source. Both paths, and the first-admin step, are in
[`deploy/README.md`](../deploy/README.md).

Your pod is a real PostgreSQL database. Export it with `pg_dump` whenever you
like — the data is yours.

For the full self-host guide (domains, backups, upgrades, hardening), see
[`deploy/README.md`](../deploy/README.md).

---

## Where things live

- **`@synap-core/sdk`** — the public SDK (this page).
- **Hub Protocol** — the REST API agents and integrations call.
- **MCP** — the tool surface for bring-your-own agents.
- **tRPC** — the typed client the SDK wraps.

The accessibility layer (`packages/api/src/access/`) is the single place scoping
and visibility are decided — every read and write respects it, whether it came
from the SDK, the CLI, an agent, or the browser.
