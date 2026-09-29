# Synap Backend — documentation index

**Canonical architecture & platform narrative:** edit **`synap-team-docs/content/team/platform/*.mdx`** (and **[DevOps](/team/devops)**, **[Control plane](/team/control-plane)** for ops). Those pages absorbed the former `synap-backend/docs/*.md` sources that **`import-all.sh`** used to copy into `content/docs/` — **those markdown files were removed** (2026-04-13) once parity was verified with team MDX.

**Still in this folder (pod / operator / code-adjacent):**

| File                                  | Purpose                                                                             |
| ------------------------------------- | ----------------------------------------------------------------------------------- |
| **`ARCHITECTURE-OVERVIEW.md`**        | **What Synap is** — the public architecture source of truth (the README cites this) |
| **`DEVELOPER.md`**                    | **Building on Synap** — the SDK, MCP, and self-hosting guide                        |
| **`RSS-SETUP.md`**                    | Self-host RSS ingestion setup                                                       |
| **`FEED-API.md`**                     | Feed HTTP API for operators / integrators                                           |
| **`DeliveryService*.md`**             | `DeliveryService` API reference next to code                                        |
| **`integrations/n8n-integration.md`** | n8n + Docker + webhooks                                                             |
| **`development/README.md`**           | Short index of dev topics (long guides → team DevOps)                               |

> ⚠️ **The two files above are the public entry points and must stay true.** The
> root `README.md` claims specific structures (the unit-of-work hierarchy, the
> view types, the auth stack) and every one of them cites a source file. If the
> model changes, update `ARCHITECTURE-OVERVIEW.md` in the same commit — it is
> the SSOT the README, the docs site and the pitch all agree to.

**Import script:** `synap-team-docs/scripts/import-all.sh` still pulls **`packages/hub-protocol/README.md`** and **`packages/database/MIGRATIONS.md`** into public `content/docs/platform/` — not from `docs/` anymore.

See **`synap-team-docs/docs/DOCUMENTATION_SOURCE_OF_TRUTH.md`**.
