# Synap Intelligence Layer – V0.5 Status Report

_Last updated: $(date '+%Y-%m-%d %H:%M %Z')_

## 1. Executive Snapshot
- **Release Label:** Intelligence Layer V0.5 (successor to chatbot V0.4)
- **Core Achievement:** Unified LangGraph orchestrator backed by canonical domain services; API, jobs, and tools consume the same contract.
- **System Health:** Build, lint, and targeted test suites pass. Obsolete Initiativ packages fully removed.
- **Focus Areas Completed:** Agent graph, tool registry, domain services, API refactor, knowledge + suggestion services, state reporting.
- **Immediate Next Steps:** Domain-driven note service, semantic search upgrade, observability instrumentation, ensure INNGEST_EVENT_KEY configured in all envs.

## 2. Layered Architecture Overview ("Brain in 3 Systems")
| Layer | Description | Primary Modules |
| --- | --- | --- |
| **Cortex Sensoriel** | Ingress surfaces that capture signals (chat, API, jobs) and apply auth/validation. | `@synap/api` routers (`chat`, `notes`, `suggestions`, etc.), Inngest triggers, CLI/E2E scripts. |
| **Néocortex** | LangGraph agent orchestrator that understands intent, gathers context, plans, executes, and answers. | `packages/ai/src/agent/*` (`graph.ts`, `intent-classifier.ts`, `planner.ts`, `executor.ts`, `responder.ts`), tool registry. |
| **Cerveau Profond** | Deterministic domain services + repositories persisting state and enforcing invariants. | `@synap/domain` services (`conversation`, `event`, `knowledge`, `suggestion`), Drizzle repositories, Cloudflare R2 storage. |

### Request & Action Flow
1. **Ingress:** tRPC router (e.g., `chat.sendMessage`) authenticates, appends user message via `conversationService`.
2. **Orchestration:** `runSynapAgent` executes LangGraph nodes: parse intent (Haiku), gather context (semantic search + memory facts), plan (Sonnet), execute tools, and formulate response.
3. **Tooling:** Executor resolves tools from registry (`createEntity`, `semanticSearch`, `saveFact`), validates parameters via Zod, and routes to domain services/storage.
4. **Persistence & Events:** Domain services append events (`eventService.appendEvent`), store knowledge (`knowledgeService.recordFact`), maintain hash-chained conversations.
5. **Feedback Loop:** Agent state (intent analysis, plan, execution logs) is serialized into conversation metadata; suggestions workers consume events for proactive insights.

## 3. Capability Inventory
| Capability | Status | Details |
| --- | --- | --- |
| Agent Orchestration | ✅ | LangGraph state machine (`parse_intent → gather_context → plan_actions → execute_actions → generate_final_response`). Planner uses Claude Sonnet, classifier/responder use Haiku. |
| Tooling Framework | ✅ | Zod-typed registry exposing schemas to planner and executor. Tools backed by domain services and R2. |
| Super Memory | ✅ (MVP) | `knowledgeService` records facts with deterministic embeddings; semantic search node retrieves facts alongside entities. |
| Conversation Ledger | ✅ | Hash-chained messages with branch support, verification utilities, metadata serialization in API. |
| Event Sourcing | ✅ | TimescaleDB-backed `events_v2`; domain service ensures optimistic locking and audit metadata. |
| Suggestion Engine | ✅ | Inngest `insightPatternDetector` uses `suggestionService` to produce project suggestions and dedupe pending entries. |
| Notes Pipeline | ✅ (v0) | API writes markdown to R2, emits `entity.created`, dual-writes to legacy `content_blocks`; simple substring search for retrieval. |
| Testing | ✅ (targeted) | Vitest domain suites; TypeScript builds for AI and Jobs packages; E2E scripts for conversational flow. |
| Observability | ⚠️ | Console logs present; structured logging/tracing pending. |

## 4. Module Deep Dive
### `@synap/domain`
- **Schemas:** Zod definitions for `ConversationMessage`, `KnowledgeFact`, `Suggestion`, `EventRecord`, etc.
- **Services:**
  - `conversationService`: append/get history, branch management, hash-chain verification.
  - `eventService`: append single/batch events, query streams, fetch correlated events.
  - `knowledgeService`: record facts with embeddings, perform fact search.
  - `suggestionService`: create/list/accept/dismiss suggestions, tag analytics.
- **Purpose:** Single source of truth bridging persistence and consumers; enforces tenant scoping and domain invariants.

### `@synap/api`
- tRPC routers consume domain services; `chat` delegates to `runSynapAgent`, `notes` handles storage/event emission, `suggestions` manages lifecycle, other routers reuse domain contract.
- Ensures no direct repository calls remain (except transitional notes search logic to be migrated into domain layer).

### `@synap/ai`
- LangGraph orchestrator compiled in `graph.ts` and exported as `runSynapAgent`.
- Tools defined under `packages/ai/src/tools/` including `createEntity`, `semanticSearch`, `saveFact`, managed via central registry for planner/executor interoperability.
- Integrates Anthropic SDK and Vercel AI structured outputs via Zod schemas.

### `@synap/jobs`
- Inngest functions (currently `insightPatternDetector`) rely solely on domain services to read/write data.
- Foundation for future "Intuition Layer" asynchronous insights.

### `@synap/storage`
- Cloudflare R2 abstraction with deterministic path builder (`R2Storage.buildPath`) and helpers for uploads/downloads.

### `@synap/database`
- Drizzle schema and repository implementations used internally by domain services (knowledge, suggestion, conversation, event).

## 5. Data, Infra, and Integrations
- **Database:** Neon Postgres with TimescaleDB extension; data partitioned by `userId`. RLS migration to be reintroduced once schema stabilizes.
- **Storage:** Cloudflare R2 for note and asset blobs; legacy duplication into Postgres `content_blocks` for backwards compatibility.
- **Vector Search:** Placeholder deterministic embedding; `pgvector` integration deferred until upgraded embeddings are introduced.
- **LLM Provider:** Anthropic Claude (Haiku + Sonnet). Environment-configurable with planned fallback support.
- **Workers:** Inngest orchestrates scheduled/background jobs (hourly pattern detector).

## 6. Quality & Tooling Status
- `pnpm lint` → ✅
- `pnpm --filter @synap/domain test` → ✅
- `pnpm --filter @synap/ai build` → ✅
- `pnpm --filter @synap/jobs build` → ✅
- E2E Scripts → `scripts/test-conversational-flow.ts`, `scripts/test-conversation.ts` (manual execution validates agent ↔ domain ↔ persistence loop).
- **Ops Tip:** Run `ulimit -n 8192` before local scripts to avoid macOS file descriptor limits (`git status` / tests previously failed with “too many open files”).
- **Inngest Local Dev:** See `LOCAL-INNGEST.md` for running the open-source CLI with defaults (`INNGEST_BASE_URL=http://127.0.0.1:8288`, `INNGEST_EVENT_KEY=dev-local-key`).
- CI Recommendation: incorporate above commands plus forthcoming API contract tests.

## 7. Roadmap & Backlog
1. **Domain Note Service:** Move note creation/search into `@synap/domain`; expose as tool-ready service; replace direct Drizzle usage in router.
2. **Semantic Search Upgrade:** Replace deterministic embeddings with model-generated vectors (OpenAI, Voyage, or local) and enable `pgvector` retrieval in `semanticSearchTool`.
3. **Observability Enhancements:** Introduce structured logging, tracing, and agent step metrics; integrate with centralized logging stack.
4. **Task/Project Domain Services:** Model lifecycle events, expose tool interfaces for planner/executor, and align with event sourcing patterns.
5. **Git Projector Revival:** Reintroduce Git sync as domain service for knowledge versioning and external automation.
6. **Self-Hosting Bundle:** Provide Docker compose for Postgres + API + R2-compatible store + Inngest emulator to aid onboarding.
7. **Security Hardening:** Reinstate Postgres RLS migration, audit domain services for tenant isolation, implement rate limiting on ingress.
8. **Testing Expansion:** Build API contract/E2E coverage (tRPC caller + Playwright). Target 100% coverage on domain/agent logic.
9. **Legacy Cleanup:** Remove dual-write to `content_blocks` when clients migrate; drop unused columns and adapter remnants.

## 8. Risks & Mitigations
- **LLM Availability:** Add retry/backoff and fallback model selection (Anthropic → OpenAI) through central client wrapper.
- **Tenant Isolation:** Enforce `userId` scope in every domain query; RLS to be re-enabled post schema stabilization.
- **Search Quality:** Placeholder embeddings limit recall; prioritize real embeddings before production scale.
- **Observability Gap:** Lack of structured logs/traces complicates debugging; schedule instrumentation as priority.
- **Tool Explosion:** As tools increase, need taxonomy, metadata, and automated registration tests to avoid drift.

## 9. Open Questions
- Preferred provider for production-grade embeddings/vector search?
- Timeline for Git projector reintroduction and required APIs?
- Target SLAs for agent latency and suggestion freshness?
- Frontend contract for new suggested actions metadata (beyond current plan output)?

## 10. Appendix
- **Key Entry Points:**
  - `packages/api/src/routers/chat.ts` – tRPC procedure invoking agent.
  - `packages/ai/src/agent/graph.ts` – LangGraph definition.
  - `packages/domain/src/services/*` – domain contracts.
  - `packages/ai/src/tools/registry.ts` – tool registry and execution helper.
- **Testing Commands:**
  - `pnpm --filter @synap/domain test`
  - `pnpm --filter @synap/ai build`
  - `pnpm --filter @synap/jobs build`
  - `tsx scripts/test-conversational-flow.ts`
- **Environment Requirements:**
  - `DATABASE_URL` (Neon/Timescale)
  - `R2_*` credentials (Cloudflare)
  - `ANTHROPIC_API_KEY`
  - `INNGEST_EVENT_KEY` (for jobs)

---
For clarifications or roadmap adjustments, contact Antoine or the core backend team.
