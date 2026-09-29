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
  apiKey: process.env.SYNAP_API_KEY, // a scoped key you issued
  workspaceId: "ws_...", // scopes every request to one workspace
});

// Typed calls with autocomplete across every router
const entities = await synap.entities.list.query({ limit: 20 });
const workspace = await synap.workspaces.get.query();
```

**Auth, in order of preference:**

| Option         | Header                    | Use for                                                                                                            |
| -------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `sessionToken` | `x-session-token`         | **Preferred** — Ory Kratos session token, e.g. from `/api/federation/exchange`. For CLI tools, mobile, extensions. |
| `apiKey`       | `Authorization: Bearer …` | Scoped API key from your workspace developer settings.                                                             |
| _(neither)_    | cookie                    | Falls back to cookie-based Kratos session auth.                                                                    |

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
synap connect --target=claude-code          # or: cursor · raycast · openclaw · claude-desktop
```

The agent then works against the same records you do, with the same proposal
gate. Switching agents never loses context — the data is in your pod, not in
the model.

---

## 3. Self-hosting a pod

Synap is open source and self-hostable. The real, supported one-line install
pulls pre-built Docker images (no source build required):

```bash
curl -fsSL https://raw.githubusercontent.com/Synap-core/backend/main/install.sh | bash
```

The installer prompts for a **domain** and an **email** (for TLS), writes a
`docker-compose.yml` next to the install dir, and brings up the stack via
Caddy with automatic HTTPS. Prerequisites: **Docker** with **Compose v2**,
`curl`, and `openssl`.

Your pod is a real PostgreSQL database. Export it with `pg_dump` whenever you
like — the data is yours.

For the full self-host guide (domains, backups, upgrades, hardening), see
[`docs/README.md`](./README.md).

---

## Where things live

- **`@synap-core/sdk`** — the public SDK (this page).
- **Hub Protocol** — the REST API agents and integrations call.
- **MCP** — the tool surface for bring-your-own agents.
- **tRPC** — the typed client the SDK wraps.

The accessibility layer (`packages/api/src/access/`) is the single place scoping
and visibility are decided — every read and write respects it, whether it came
from the SDK, the CLI, an agent, or the browser.
