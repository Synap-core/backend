# Synap Backend – State Report (V0.5)

_Last updated: 2025-11-07 04:10 CET_

## 1. Executive Summary
- **Three-Layer Brain:** Clear separation between ingress surfaces, LangGraph orchestration, and deterministic domain services.
- **Agentic Core:** LangGraph state machine drives intent parsing, context enrichment, planning, tool execution, and response generation using Anthropic models.
- **Canonical Domain Layer:** `@synap/domain` concentrates schemas and services for conversations, events, knowledge, and suggestions; all consumers depend on this contract.
- **Legacy Cleanup:** All `@initiativ/*` packages and tsconfig references removed; API routes now call domain services directly.
- **Quality Gates:** Linting, builds, and targeted tests green across AI, jobs, and domain packages.

## 2. Layered Architecture Overview
| Layer | Role | Key Components |
| --- | --- | --- |
| **Cortex Sensoriel** (Ingress) | Capture requests and events from chat, API, or jobs | `@synap/api` tRPC routers, Inngest triggers, CLI scripts |
| **Néocortex** (Orchestration) | Reason over intent, plan workflows, decide tools | LangGraph graph (`parse_intent → gather_context → plan_actions → execute_actions → generate_final_response`) |
| **Cerveau Profond** (Execution) | Enforce invariants, persist data, interact with storage | Domain services + repositories (`conversation`, `event`, `knowledge`, `suggestion`), Cloudflare R2, TimescaleDB |

### Request Flow
1. **Ingress:** Routers such as `chat.sendMessage` or `notes.create` validate input, enforce auth, and append initial conversation events.
2. **Orchestration:** `runSynapAgent` executes the LangGraph. Intent classification (Haiku) feeds context retrieval (semantic search + super memory). Planner (Sonnet) proposes tool calls; executor runs them sequentially; responder crafts the final reply.
3. **Execution:** Tools call domain services which wrap repositories (Drizzle) and storage (R2). Side effects are stored as events and knowledge facts with associated metadata.
4. **Feedback:** Agent metadata (intent analysis, plan, execution logs) is stored alongside messages. Jobs and dashboards consume events for proactive suggestions and analytics.

## 3. Capability Matrix
| Capability | Current State | Notes |
| --- | --- | --- |
| Event sourcing | TimescaleDB hypertable (`events_v2`) with optimistic locking and structured metadata | Accessed via `eventService` | 
| Conversation graph | Hash-chained log with branching support and verification utilities | `conversationService` mediates access |
| Agent orchestration | LangGraph + Anthropic Haiku/Sonnet; tool registry for domain and storage actions | Tools `createEntity`, `semanticSearch`, `saveFact` |
| Super memory | `knowledgeService` records and retrieves facts; semantic search includes memory facts | Embeddings deterministic placeholder pending upgrade |
| Suggestions | Inngest worker detects patterns and creates actionable suggestions | `suggestionService` handles lifecycle |
| Notes pipeline | API writes Markdown to R2, emits `entity.created`, indexes note metadata | Search currently substring on title/preview |
| Storage | Cloudflare R2 access via `@synap/storage`; dual-write to legacy `content_blocks` for compatibility | Planned removal after clients migrate |
| Jobs & automation | Inngest functions use domain services exclusively; no direct DB access | `insightPatternDetector` main worker |

## 4. Module Breakdown
### Domain Layer Contract (`@synap/domain`)
- Zod schemas for `ConversationMessage`, `KnowledgeFact`, `Suggestion`, `EventRecord`, etc.
- Pure service interfaces (`conversationService`, `eventService`, `knowledgeService`, `suggestionService`) encapsulate business rules and repository wiring.
- Provides the single source of truth connecting databases/storage with any consumer (API, LangGraph, jobs, future frontends).

### API Layer (`@synap/api`)
- Hono-based tRPC routers:
  - `chat`: delegates dialogue to `runSynapAgent`, persists responses, serialises agent metadata.
  - `notes`: uploads Markdown to R2, emits events, provides simple search.
  - `suggestions`: surfaces AI suggestions via domain service.
  - Additional routers (`events`, `capture`, etc.) operate on the domain contract.
- Uses canonical types from `@synap/domain` to ensure consistency across transports.

### AI Layer (`@synap/ai`)
- LangGraph implementation (`synapAgentGraph`), intent classifier, planner, executor, and responder modules.
- Tool registry centralises schema exposure via Zod and runtime validation for planner/executor.
- Exposes `runSynapAgent` as the entrypoint for APIs, scripts, and tests.

### Jobs Layer (`@synap/jobs`)
- Inngest worker functions leveraging domain services.
- `insightPatternDetector` analyses events/notes to craft proactive project suggestions.
- Designed for future intuition layers (autonomous background insights).

### Persistence (`@synap/database`)
- Drizzle schemas for events, knowledge facts, conversation messages, suggestions, entities, etc.
- Repository functions remain internal; external consumers rely on domain services.

### Storage (`@synap/storage`)
- Cloudflare R2 helper with upload/download/delete, presigned URLs, and path builders.

## 5. Data & Infrastructure Footprint
- **Database:** Neon Postgres with TimescaleDB extension; multi-tenant via `userId`. RLS migration staged for reintroduction once models stabilise.
- **Storage:** Cloudflare R2 for binary/markdown assets; synchronous dual-write to Postgres `content_blocks` pending deprecation.
- **Workers:** Inngest for cron and event-driven tasks; future pipeline for intuition layer.
- **LLM Provider:** Anthropic Claude (Haiku for intent/responses, Sonnet for planning). Configurable via environment variables.

## 6. Quality Gates & Tooling
- `pnpm lint` → ✅ (no outstanding errors).
- `pnpm --filter @synap/domain test` → ✅ (Vitest suites for domain services and invariants).
- `pnpm --filter @synap/ai build` & `pnpm --filter @synap/jobs build` → ✅ (type safety across agent and jobs packages).
- E2E smoke scripts (`scripts/test-conversational-flow.ts`, `scripts/test-conversation.ts`) validate agent ↔ domain ↔ persistence loop.
- Shared root `tsconfig.json` enforces ES2022 target, strict typing, and consistent module resolution.

## 7. Observability & Operations
- Agent executor/responder log key transitions; TODO: replace console logs with structured logger + tracing spans.
- Inngest monitoring provides job telemetry; integrate with central logging stack next.
- `conversationService.verifyHashChain` enables audit of conversation tamper-proof chain.
- Future work: metrics around R2 latency, LLM token usage, and tool success rates.

## 8. Backlog & Next Steps
1. **Note Service Migration:** Move note creation/search logic into `@synap/domain` and let API router call the service.
2. **Task/Project Domain:** Model entities/tasks/projects with dedicated services; expose orchestrator-friendly tooling.
3. **Git Projector:** Reintroduce Git sync as a domain-driven service for knowledge versioning.
4. **Self-Hosting Bundle:** Provide Docker compose for Postgres + API + R2-compatible storage.
5. **Observability Upgrade:** Adopt structured logger, request tracing, and agent step telemetry.
6. **Semantic Search 2.0:** Replace deterministic embeddings with model-generated vectors; integrate `pgvector` retrieval.
7. **Testing Expansion:** Add API contract tests (e.g., TRPC caller / Supertest), integrate E2E scripts into CI.
8. **Legacy Cleanup:** Remove dual-write to `content_blocks` after clients migrate; drop unused columns.

## 9. Risk Register
- **External LLM Dependence:** Need retries, circuit breakers, and configurable model fallbacks to handle Anthropic outages.
- **Tenant Isolation:** Ensure every data access path enforces `userId` scoping; re-enable Postgres RLS when schema finalised.
- **Search Quality:** Current substring search is minimal; must improve before scale or rely on vector search.
- **Embedding Placeholder:** Deterministic hashing is temporary; real embedding service required for high-quality recall.

## 10. Recent Changes
- Removed all Initiativ packages, adapters, and tsconfig references.
- Refactored notes router to use domain services + direct R2 storage.
- Centralised types and business logic into `@synap/domain`.
- Updated LangGraph agent, tool registry, and jobs to depend solely on domain layer.
- Generated this comprehensive state report for team alignment.

---
For roadmap updates or questions, contact Antoine / core backend team.
