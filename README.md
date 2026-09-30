# Synap

**A sovereign data pod with a governed agent runtime on it.**
**Self-hostable · Bring-your-own-agent · Open source**

Synap is where your agents do real work on records you own — under a review
model you control, in units of work you define.

- **You own the data.** Your pod is your own PostgreSQL. Export it, `pg_dump`
  it, self-host it, or let us run it. No lock-in, because the substrate is the
  public one.
- **Every AI change is governed.** Agents propose; you approve. Some run
  automatically where you've granted a rule — and **destructive, admin, and
  scope-changing writes can never auto-approve, by design**. Either way,
  every one is on the event chain.
- **Bring your own agent.** We never meter your inference. Claude, ChatGPT,
  Cursor, or anything that speaks MCP works against your pod under permissions
  you grant.

**The vision:** you're not just using Synap — you're building a version of
yourself that every AI can understand.

📖 **[Architecture overview](docs/ARCHITECTURE-OVERVIEW.md)** ·
🔌 **[Building on it (SDK)](docs/DEVELOPER.md)**

---

## Two front doors, one building

### 🧑‍💻 For developers — _"Supabase, but the user is the center"_

A config-first backend where **auth, permissions, data model, workflows,
integrations and AI governance are already solved** — you configure, you don't
code. Deploy with Docker, wire in your frontend, ship.

```bash
git clone https://github.com/Synap-core/backend synap && cd synap
curl -fsSL https://raw.githubusercontent.com/Synap-core/backend/main/install.sh | bash
```

The installer pulls pre-built images (no source build), prompts for a domain
and email for TLS, and brings the stack up behind Caddy with automatic HTTPS.
Prerequisites: **Docker** + **Compose v2**, `curl`, `openssl`.

### 🧠 For builders — _"Your AI proposes. You approve."_

A hosted pod in one click. Talk to your AI in natural language — it **proposes**
what to build (a workspace, a workflow, a capability), you **approve**, the
system assembles itself. No auth code. No credentials in prompts. No RLS
policies to forget.

→ **[Get a hosted pod](https://www.synap.live/hosted)**

Both doors lead to the same primitives below.

---

## The mental model: two layers

Synap has two layers, and confusing them is the single most common way to describe the product wrong.

| Layer                | What it is                                            | Is it the feature?      |
| -------------------- | ----------------------------------------------------- | ----------------------- |
| **The data model**   | Kinds, Roles (facets), Views, events.                 | **No — the substrate.** |
| **The unit of work** | Project → Track → Session, + Playbooks & Automations. | **Yes — what you buy.** |

The data model is what makes your pod _queryable_. The unit of work is what
makes it _yours_: **every agent you connect works against the same unit of
work**, in the same channel bound to it, so the work compounds instead of
scattering across private chats.

---

## Layer 1 — The data model (the substrate)

| Layer     | What it is                                                                | Example                                                  |
| --------- | ------------------------------------------------------------------------- | -------------------------------------------------------- |
| **Kind**  | The fundamental noun an entity _is_.                                      | `person`, `task`, `event`, `note`, `article`, `decision` |
| **Role**  | A context the entity _plays_ — a facet, not a second entity.              | `client`, `partner`, `blocker`, `milestone`              |
| **View**  | A projection over the same records. Never a copy.                         | A kanban of tasks with role `blocker`                    |
| **Event** | Every write, append-only, with `requested → approved → validated` phases. | The audit trail, and time travel                         |

**Why it matters, in one sentence:**

> Your pod stores each person **once**. A CRM view reads the `client` role. A
> personal workspace reads the `friend` role. Same record. No sync job. No
> duplication.

That's what "one user, many apps built on top" means at the data layer instead
of on a marketing page.

---

## Layer 2 — The unit of work (the feature)

```
Project    — long-lived intent. Months. A thing you're actually doing.
  │
  ├── Track    — a METHOD running inside one project
  │              ("Business model", "Content", "Build"). A project runs N.
  │
  │   ├── Session  — short-lived, one task type. Filed at a track + stage.
  │   └── Session
  └── Track

Or just a Session on its own — most of them are.
```

- A **Project** is long-lived intent. Progress is **derived** from contained
  work, never a stored percentage.
- A **Track** is a reusable _method_ running inside one project. It **pins the
  definition it started from**, so editing the method never silently rewrites a
  live track's vocabulary.
- A **Session** is a bounded unit of work with a scope and checkpoint you accept
  before it runs. It can be filed at a **track** and a **stage**, or stand on
  its own.

**Honest scope:** tracks and projects are the structure for long-running
engagements, and they enforce their own rules — a session cannot be filed into
another project's track. But a session may be workspace-scoped with no project
at all, and most sessions today are. The hierarchy is where multi-week work
gets a shape; it isn't a requirement for using the pod.

**Repeatability** sits on top: a session that works becomes a **Playbook**
(a template for one kind of work, or a method a project runs as a track), and
an **Automation** binds a playbook to a trigger — `event`, `cron`, `webhook`,
or `manual`. Do it once, run it forever — still governed.

**The collaboration claim:** a session gets a **channel** — a linked room where
humans and agents work the same goal together, with artifacts and proposals
visible in-band rather than locked in a private transcript. This is the
differentiator: not "an AI that answers you," but a place where several agents
and you work the same records, and you stay in the approval seat.

> Full detail: **[Architecture overview](docs/ARCHITECTURE-OVERVIEW.md)**.

---

## The flow that ties it together

1. You describe a goal. A **session** opens with a scope and checkpoint you accept.
2. Your agent works. When it wants to write, it emits a **proposal**.
3. You approve — a typed **entity** is created with a **kind** and **roles**.
4. A **view** you already have (or the agent proposes) renders it.
5. When the session works, the agent proposes promoting it to a **playbook**.
6. Bind that playbook to a trigger — now it's an **automation**.
7. It runs without you — still governed, still on the event chain.
8. Everything above is a **workspace** you can clone, share, or publish.

Nothing skipped. Nothing hidden.

---

## Governance (why you can trust an agent with your data)

- **Every AI mutation is governed.** Most arrive as proposals you approve. Some
  run automatically where you've granted a rule — and **destructive, admin, and
  scope-changing writes can never auto-approve, by design.** Either way, every
  one is on the event chain.
- **Scoped, reviewable, reversible.** See what changed, why, and undo it.
- **The event chain is append-only** — the history _is_ the audit trail.
- **Credentials live in a governed capability layer**, not in your prompts.

This is the "git PR for your data" idea — and it's why an AI that would ship
an auth bug to production can't do that here.

---

## What's in the box

Every primitive is available today via **SDK, CLI, MCP, tRPC and the Hub
Protocol REST API** — the same operations through several doors.

|                        |                                                                                                                                                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **🗂 Typed entities**   | Built-in kinds (person, task, event, note, article, decision, research…), custom kinds, JSONB properties validated against schema, optimistic locking, full provenance.                                     |
| **🔗 Knowledge graph** | Typed relations, BFS traversal, property↔relation bridge, graph views.                                                                                                                                      |
| **📸 Event sourcing**  | Append-only event chain on a TimescaleDB-backed Postgres, `requested → approved → validated` phases, causation & correlation IDs.                                                                           |
| **✅ Proposals**       | AI writes are governed: consequential ones arrive as proposals you review, and the rest follow a rule you set. Deletes, admin changes, and scope changes can never auto-apply.                              |
| **🎨 View types**      | Sheet · Table · List · Grid · Gallery · Kanban · Matrix · Masonry · Calendar · Gantt · Timeline · Graph · Flow · Map · Branch tree · Bento · Whiteboard — 17 implemented projections over the same records. |
| **⚙️ Automations**     | DAG flows with 23 node types, and `event` / `cron` / `webhook` / `manual` triggers.                                                                                                                         |
| **📚 Playbooks**       | Sessions saved as reusable templates. Run it once, run it forever.                                                                                                                                          |
| **🧩 Capabilities**    | Credentialed tools an agent can call, gated by proposals.                                                                                                                                                   |
| **🤖 Agent-native**    | MCP-first, Bring-Your-Own-Agent, per-agent identity + RBAC.                                                                                                                                                 |
| **🔐 Auth & access**   | Ory Kratos + Hydra (OAuth2/OIDC) for identity, plus a **central access layer** — every scoped table declares its visibility rule in one registry, and every read and write is gated through it.             |
| **⚡ Real-time**       | Socket.IO events, Yjs collaborative rooms.                                                                                                                                                                  |
| **🔍 Search**          | Typesense full-text, plus pgvector embeddings behind a feature flag.                                                                                                                                        |

---

## 🚀 Self-host

**Requirements:** Docker with Compose v2, `curl`, `openssl`, and a domain
pointing at the host.

```bash
git clone https://github.com/Synap-core/backend synap
cd synap
curl -fsSL https://raw.githubusercontent.com/Synap-core/backend/main/install.sh | bash
```

The installer writes a `docker-compose.yml` next to your install dir, brings up
Postgres, Kratos/Hydra, MinIO, Typesense, and the backend behind **Caddy** with
**automatic HTTPS**. Logs and status are standard `docker compose` commands.

## ☁️ Or skip the ops — get a hosted pod

One click. One payment. Your pod is provisioned, secured, backed up, and
updated by us. Same code, same primitives, same self-host escape hatch whenever
you want it.

→ **[synap.live/hosted](https://www.synap.live/hosted)**

---

## Build on it

Synap is deliberately **a backend first**. Build your own app on your pod:

```bash
npm i @synap-core/sdk
```

```ts
import { createSynapClient } from "@synap-core/sdk";

const synap = createSynapClient({
  podUrl: "https://pod.example.com",
  apiKey: process.env.SYNAP_API_KEY,
  workspaceId: "ws_...",
});

const entities = await synap.entities.list.query({ limit: 20 });
```

MIT, published, fully typed tRPC. Bring your own agent over MCP:

```bash
npm install -g @synap-core/cli
synap init
synap connect --target=claude-code
```

→ **[Full developer guide](docs/DEVELOPER.md)**

---

## Architecture (the honest version)

```
┌────────────────────────────────────────────────────────────────┐
│                     Control Plane (CP)                          │
│  Hono · Drizzle · Stripe · Nango · pg-boss · Redis              │
│  Pod provisioning, billing, auth, marketplace, webhooks         │
└────────────────────────────┬───────────────────────────────────┘
                             │ ES256 JWT
        ┌────────────────────┼────────────────────┐
        ▼                    ▼                    ▼
┌──────────────────┐ ┌────────────────┐ ┌───────────────────────┐
│  Browser/Desktop │ │   synap-app    │ │  Intelligence Service │
│  Electron · Web  │ │  Hub OS · CRM  │ │  Orchestrator + MCP   │
└─────────┬────────┘ └───────┬────────┘ └───────────┬───────────┘
          │                  │                      │
          └──────────────────┼──────────────────────┘
                             ▼
              ┌────────────────────────────────────┐
              │          synap-backend (Pod)        │
              │   Hono · tRPC · Drizzle · Postgres  │
              │   Hub Protocol · pg-boss workers    │
              │   Typesense · pgvector · Yjs · WS   │
              └────────────────────────────────────┘
                             │
                    ┌────────▼─────────┐
                    │   @synap-core/cli│
                    │  Connect an agent│
                    └──────────────────┘
```

**Data flow:** Event Sourcing + CQRS. Writes emit events; entities, documents
and views are materialized projections; side-effects run through pg-boss
workers. **Storage:** PostgreSQL + TimescaleDB (events), Typesense (search),
pgvector (embeddings), MinIO (files).

---

## Who this is for

**You'll love Synap if you're…**

- A **developer** tired of rebuilding auth, permissions, workflows, and
  integrations for every project. You want personalization to be configuration,
  not code.
- A **builder** shipping with AI, who wants an AI that _proposes_ rather than
  one that YOLOs writes straight to production.
- A **founder or operator** who wants their CRM, notes, calendar, and next side
  project to share one source of truth about the humans in their life.
- Anyone who believes the **user should be the center of their software**, not a
  row in someone else's database.

**Synap is probably not for you if…** you want a hosted multi-tenant BaaS today
and don't care about data ownership, or you want a no-code visual builder with
no config files. Try Firebase or Bubble.

---

## Community

- 💬 **[Discord](https://discord.gg/xhRdQ7hG5h)** — where builders share
  workspaces, playbooks, and capabilities
- 🐦 **[X / Twitter](https://x.com/synapOSI)** — build in public
- 📬 **[Substack](https://substack.com/@antoineservant)** — the user-centric web movement
- 🐙 **[GitHub Discussions](https://github.com/Synap-core/backend/discussions)** — technical Q&A

Ecosystem contributions welcome. If you build a workspace template, a
capability, or a playbook worth sharing, PR it into
`awesome-synap`.

---

## License

MIT. Take it, run it, fork it, host it, build on it. If it powers something
real for you, tell us — that's the only payment we care about at this altitude.

---

**Built by [@antoine](https://substack.com/@antoineservant) and a growing community.**
One founder, one honest system, one movement — the user is the center.
