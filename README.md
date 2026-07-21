# Synap

**The first backend that needs zero code changes to be personalized —**  
**because the user is the center, not the app.**

Sovereign data pod · Bring-your-own-agent · Config-first · Self-hostable

[Website](https://www.synap.live) · [Documentation](https://www.synap.live/docs) · [Hosted (one-click)](https://www.synap.live/hosted) · [Discord](https://discord.gg/xhRdQ7hG5h) · [X](https://x.com/synap)

---

## Why Synap exists

The web has spent 20 years building apps that own users' data.
Every new SaaS = a new silo, a new login, a new copy of you.

Synap flips the picture. **Your data lives in a pod you own.** Apps — CRMs, note tools, project managers, AI agents — plug **into your pod**, not the other way around. Same person entity powers your CRM, your personal life workspace, and your next side project. No duplication. No sync jobs. No vendor holding your context hostage.

For the developer, this means a backend where **auth, permissions, data model, workflows, integrations and AI governance are already solved** — you configure, you don't code. For the builder using AI to ship a product, it means the AI **physically cannot ship the security mistakes** vibe-coded apps are bleeding from today — because every mutation goes through a proposal you approve, and every credential lives inside a governed capability layer.

One product. Two front doors. Same building.

---

### 🛠 Developer door — _"Supabase, but the user is the center"_

You get a config-first backend with entities, relations, views, event sourcing, automations, capabilities, real-time collaboration and MCP-native agent integration — all declarative. Deploy with Docker, wire in your frontend, ship.

```bash
git clone https://github.com/Synap-core/backend synap && cd synap
docker compose up -d
# → http://localhost:4000
```

Jump to [Self-host in 5 minutes ↓](#-self-host-in-5-minutes)

### 🧠 Builder door — _"Your AI prope. You approve."_

You get a hosted pod in one click, one payment. Talk to your AI in natural language — it **proposes** what to build (a workspace, a workflow, a new capability), you **approve**, the system assembles itself. No auth code. No leaked secrets. No RLS policies to forget.

→ [Get a hosted pod](https://www.synap.live/hosted)

Both doors lead to the same primitives below.

---

## The mental model: the Possibility Ladder

Synap is designed so **every rung stands alone AND creates the possibility of the next**. You never lose work — you compound it.

```
Session      →   a focused unit of work with a goal + checkpoints
   │
   ▼
Playbook     →   save the session shape as a reusable template
   │
   ▼
Automation   →   bind the playbook to an event trigger
                 ("when this entity gains that role, run this playbook")
   │
   ▼
Capability   →   let the automation reach beyond the pod
                 (browser, terminal, Google Workspace, any API —
                  credentials stored on the pod, governed by proposals)
   │
   ▼
Workspace    →   compose entities + views + automations + capabilities
                 into what a user perceives as "an app"
```

The AI's job is to **propose the next rung** — never to skip levels, never to act without you seeing it first. Every mutation flows through the proposal system and is recorded in the event chain. That's the whole trust model in one sentence.

---

## The data model: Atoms, Kinds & Roles

This is what makes user-centric actually work at the data layer — and it's the piece nobody else in the BaaS space ships.

| Layer          | What it is                                                                                                                                                                         | Example                                                           |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| **Atom**       | The base unit of data on the pod — typed, versioned, event-sourced.                                                                                                                | `"Anna Martin"`, `2026-09-14`, `€1,200`                           |
| **Entity**     | A composed unit with **one Kind** + **zero or more Roles**.                                                                                                                        | _Anna_ — kind: `person`, roles: `client`, `friend`                |
| **Kind**       | The fundamental noun the entity _is_. 17 built-in (person, task, event, note, company, project, decision, question, research, deal, article, bookmark, file…) plus any you define. | `person`, `task`, `event`                                         |
| **Role**       | A context the entity _plays_. Same entity, many roles, no duplication.                                                                                                             | `client`, `partner`, `deadline`, `blocker`, `milestone`           |
| **View**       | Renders entities filtered by kind + role. 16 types: table, kanban, calendar, graph, bento…                                                                                         | A kanban of tasks with role `blocker`                             |
| **Workspace**  | Composes entities + views + automations + capabilities into an experience.                                                                                                         | Your CRM. Your personal OS. Your side project.                    |
| **Automation** | Event-triggered ascent up the ladder.                                                                                                                                              | _When a person gains role_ `client` _→ run playbook_ `onboarding` |

**Why this matters, in one sentence:**

> Your pod stores each person **once**. Your CRM sees the `client` role. Your personal life workspace sees the `friend` role. Same entity. No sync. No duplication.

That's what "one user, many apps built on top" means at the data layer instead of on a marketing page.

---

## What's in the box

Every primitive below is available today via CLI, MCP, tRPC, and the Hub Protocol REST API — same operations, three surfaces.

|                         |                                                                                                                                                                         |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **🗂 Typed entities**    | 17 built-in kinds, custom kinds per workspace, JSONB properties validated against schema, optimistic locking, full provenance (who/what/when/why).                      |
| **🔗 Knowledge graph**  | Typed relations with BFS traversal, property↔relation bridge, polymorphic edges, graph views with force/hierarchical/circular layouts.                                  |
| **📸 Event sourcing**   | TimescaleDB hypertable, append-only, 3-phase flow (`requested → validated → completed`), causation & correlation IDs, 25+ operational event types.                      |
| **✅ Proposal system**  | Every AI mutation goes through a proposal. You see it, approve or reject it, get full audit trail. No black-box writes.                                                 |
| **🎨 16 view types**    | Table · List · Kanban · Grid · Gallery · Matrix · Feed · Calendar · Flow · Bento · Branch tree · Whiteboard · +4 deferred. Bento dashboards compose views inside views. |
| **⚙️ Automations**      | 12 node types, DAG flow, event / cron / webhook / manual triggers, chain-depth protection.                                                                              |
| **📚 Playbooks**        | Sessions saved as reusable templates. Any workflow you run once can become one you run forever.                                                                         |
| **🧩 Capabilities**     | Configure once, use anywhere: browser, terminal, computer control, Google Workspace, any REST/GraphQL API. Credentials stored on the pod, gated by proposals.           |
| **🔌 39+ integrations** | Nango-powered OAuth: Google (Calendar, Contacts, Mail), GitHub, Notion, Linear, Slack, HubSpot… Auto-sync with change detection.                                        |
| **🤖 Agent-native**     | MCP-first design, 13 AI surfaces supported, Bring-Your-Own-Agent (Claude, GPT, local models), per-agent identity + RBAC.                                                |
| **🔐 Enterprise auth**  | Ory Kratos + Hydra, OAuth2/OIDC, RBAC with 9-step permission ladder.                                                                                                    |
| **⚡ Real-time**        | Socket.IO events, Yjs collaborative rooms, live views across surfaces.                                                                                                  |
| **🔍 Search**           | Typesense semantic + full-text, pgvector embeddings.                                                                                                                    |

---

## The one flow that ties it all together

1. You open a chat with your agent. You describe a goal.
2. The agent creates a **session** and, when it wants to write, emits a **proposal**.
3. You approve — an **entity** is created, given a **kind** and one or more **roles**.
4. A **view** you already have (or one the agent proposes) renders it immediately.
5. The agent suggests turning the session into a **playbook** — you approve.
6. It suggests binding the playbook to a trigger — _"when a person gains role_ `prospect`_, run this"_ — you approve. Now it's an **automation**.
7. The automation needs to reach Google. The agent proposes a **capability** with a scoped credential. You approve the install. The capability is now usable by any future automation or workspace.
8. Everything above is one **workspace**. You can clone it, share it, or build a marketplace of them.

Nothing was skipped. Nothing was hidden. You climbed the Possibility Ladder one rung at a time.

---

## 🚀 Self-host in 5 minutes

**Requirements:** Linux server (Debian/Ubuntu 22.04+), 4 GB RAM, Docker + Docker Compose, a domain (optional but recommended for SSL).

```bash
# 1. Clone
git clone https://github.com/Synap-core/backend synap
cd synap

# 2. Configure
cp .env.example .env
$EDITOR .env    # set SYNAP_DOMAIN, secrets, AI provider keys

# 3. Launch
docker compose up -d

# 4. Verify
docker compose ps
curl http://localhost:4000/health

# 5. Connect a client
npm install -g @synap-core/cli
synap init
synap connect claude   # or gpt, cursor, raycast, etc.
```

Then either open `http://localhost:4000` or head to `https://your-domain` if you set up SSL.

**Full self-host guide:** `[docs/deploy/self-host.md](./docs/deploy/self-host.md)` — automated SSL, backups, upgrades, hardening, troubleshooting.

## ☁️ Or skip the ops — get a hosted pod

One click. One payment. Your pod is provisioned, secured, backed up, and updated by us. Same code, same primitives, same self-host escape hatch whenever you want it.

→ **[synap.live/hosted](https://www.synap.live/hosted)**

---

## Architecture (the honest version)

```
┌────────────────────────────────────────────────────────────────┐
│                     Control Plane (CP)                          │
│  Hono · Drizzle · Stripe · Nango · pg-boss · Redis              │
│  Pod provisioning, billing, auth, marketplace, webhooks         │
└────────────────────────────┬───────────────────────────────────┘
                             │ ES256 JWT
        ┌────────────────────┼────────────────────────┐
        ▼                    ▼                        ▼
┌──────────────────┐ ┌────────────────┐ ┌───────────────────────┐
│  Browser/Desktop │ │   synap-app    │ │  Intelligence Service │
│  Electron · Web  │ │  Hub OS · CRM  │ │  Hono · LangChain     │
│                  │ │  Studio · …    │ │  Orchestrator + MCP   │
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
                    │   Eve CLI        │
                    │   Self-host tool │
                    └──────────────────┘
```

**Data flow:** Event Sourcing + CQRS. Writes emit events; entities, documents, and views are materialized projections; side-effects run through pg-boss workers. **Storage:** PostgreSQL + TimescaleDB (events), Typesense (search), pgvector (embeddings).

Full docs: `[docs/architecture.md](./docs/architecture.md)`

---

## Documentation

- 📖 **[Getting started](./docs/getting-started.md)** — first 10 minutes
- 🧭 **[Concepts](./docs/concepts/)** — Atoms, Kinds, Roles, Views, Workspaces, Automations
- 🪜 **[The Possibility Ladder](./docs/concepts/possibility-ladder.md)**
- 🏗 **[Architecture deep dive](./docs/architecture.md)**
- 🔌 **[Hub Protocol API reference](./docs/api/hub-protocol.md)**
- 🤖 **[Bring your own agent](./docs/agents/byoa.md)** — MCP, credentials, RBAC
- 🚢 **[Self-host guide](./docs/deploy/self-host.md)**
- 🧩 **[Building capabilities](./docs/capabilities/authoring.md)**
- 🛡 **[Security & governance](./docs/security.md)**

---

## Who this is for

**You'll love Synap if you're…**

- A **developer** tired of rebuilding auth, RLS, workflows, and integrations for every project. You want a backend where personalization is configuration, not code.
- A **builder** using AI to ship products, and you're aware that 58% of vibe-coded apps have critical vulnerabilities. You want an AI that proposes, not one that YOLOs writes.
- A **founder or operator** who wants their CRM, their notes, their calendar, and their next side project to share one source of truth about the humans in their life.
- Anyone who believes the **user should be the center of their software**, not a row in someone else's database.

**Synap is probably not for you if…** you need a hosted mobile-first BaaS today and don't care about data ownership, or you want a no-code visual builder with no config files. Try Firebase or Bubble.

---

## Community

- 💬 **[Discord](https://discord.gg/xhRdQ7hG5h)** — where builders share workspaces, playbooks, and capabilities
- 🐦 **[X / Twitter](https://x.com/synap)** — daily build-in-public
- 📬 **[Substack](https://synap.substack.com)** — the user-centric web movement
- 🐙 **[GitHub Discussions](https://github.com/Synap-core/backend/discussions)** — technical Q&A

Ecosystem contributions welcome. If you build a workspace template, a capability, or a playbook worth sharing, PR it into `[awesome-synap](https://github.com/Synap-core/awesome-synap)`.

---

## Contributing

We're a small, opinionated team building this in the open. Read `[CONTRIBUTING.md](./CONTRIBUTING.md)` before opening a PR. The fastest way to help right now:

1. Self-host it, break it, tell us where it broke.
2. Ship a workspace template or capability.
3. Write about it — every honest post moves the movement forward.

---

## License

MIT. Take it, run it, fork it, host it, build on it. If it powers something real for you, tell us — that's the only payment we care about at this altitude.

---

**Built by [@antoine](https://x.com/antoine) and a growing community.**
One founder, one honest system, one movement — the user is the center.
