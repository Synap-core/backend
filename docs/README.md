# Synap Backend — documentation index

**Canonical architecture & platform narrative:** edit **`synap-team-docs/content/team/platform/*.mdx`** (and **[DevOps](/team/devops)**, **[Control plane](/team/control-plane)** for ops). Those pages absorbed the former `synap-backend/docs/*.md` sources that **`import-all.sh`** used to copy into `content/docs/` — **those markdown files were removed** (2026-04-13) once parity was verified with team MDX.

**Still in this folder (pod / operator / code-adjacent):**

| File                                  | Purpose                                               |
| ------------------------------------- | ----------------------------------------------------- |
| **`RSS-SETUP.md`**                    | Self-host RSS ingestion setup                         |
| **`FEED-API.md`**                     | Feed HTTP API for operators / integrators             |
| **`DeliveryService*.md`**             | `DeliveryService` API reference next to code          |
| **`integrations/n8n-integration.md`** | n8n + Docker + webhooks                               |
| **`development/README.md`**           | Short index of dev topics (long guides → team DevOps) |

**Import script:** `synap-team-docs/scripts/import-all.sh` still pulls **`packages/hub-protocol/README.md`** and **`packages/database/MIGRATIONS.md`** into public `content/docs/platform/` — not from `docs/` anymore.

See **`synap-team-docs/docs/DOCUMENTATION_SOURCE_OF_TRUTH.md`**.
