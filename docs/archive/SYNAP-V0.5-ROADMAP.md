The goal also with the Architech is that anything can be personalized, announced or updated. Not only the views, the components and pages for the provider user, but also the actions like MCP, but inherent and specified for the ecosystem that the AI can use. So update, projects, add tasks, add something on the list, etc. It also has the whole system where we have the modules and anyone could create its own flow based on them. So for example, like I said, someone could not with a view. And even me, I will create views that are not linked to the chat directly, but linked to normal view with normal actions, etc. This is the extensibility of it with AI, little by little, that will be able to itself propose and generate new capabilities, like I said, actions, automations, analysis, thoughts, etc.# Synap Intelligence Layer – Go-to-Market Roadmap (V0.5)

_Last updated: $(date '+%Y-%m-%d %H:%M %Z')_

## Vision
Deliver the "first magical experience" where a user chats with Synap, sees a concrete action (note creation) executed end-to-end, and trusts the system thanks to semantic intelligence and production-grade safeguards.

## Epic Overview
| Epic | Theme | Goal | Indicative Duration |
| --- | --- | --- | --- |
| 1 | **The First Meaningful Interaction** | Close the loop from chat message to persisted action with clear observability. | 1–2 weeks |
| 2 | **The Semantic Brain** | Give the agent durable memory and semantic recall for higher-order answers. | ~1 week |
| 3 | **The Safety & Reliability Net** | Harden security, error handling, and multi-tenant isolation to reach beta readiness. | ~1 week |

## Epic 1 – The First Meaningful Interaction
**Objective:** User sends "note sur mon idée d'app" and observes a persisted note plus traceable logs across the LangGraph pipeline.

| Priority | Task | Notes | Owner | Definition of Done |
| --- | --- | --- | --- | --- |
| P1 | Refactor `chat.sendMessage` to call `runSynapAgent` | Persist full agent state (plan, execution summaries) in assistant metadata. | Backend | API call triggers agent; metadata visible in DB. |
| P1 | Implement `NoteService` in `@synap/domain` | Methods: `createNote`, `searchNotes`; encapsulate R2 upload + `eventService.appendEvent`. | Backend | Router + tools depend on service; unit tests cover note creation/search. |
| P1 | Update `createEntityTool` to use `NoteService` | Ensure agent actions go through domain layer. | AI | Tool tests updated; planner schema unchanged. |
| P2 | Add structured logging (Pino) | Instrument API router + each LangGraph node (entry/exit, errors). | Platform | Logs show correlation IDs and durations. |

**Milestone:** End-to-end script passes, logs trace every step, and a new note appears with associated event & metadata.

## Epic 2 – The Semantic Brain
**Objective:** Agent answers semantically rich prompts and records persistent "facts" about the user.

| Priority | Task | Notes | Owner | Definition of Done |
| --- | --- | --- | --- | --- |
| P1 | Replace placeholder embeddings with production model | Suggested: `text-embedding-3-small` (OpenAI). Abstract provider for future swaps. | AI | Embedding client with retries/tests; configuration via env vars. | ✅ Embedding client implemented with OpenAI + deterministic fallback + production env guard. |
| P1 | Inngest job for entity embeddings | Trigger on `entity.created/updated`; download from R2, compute embedding, persist in `entity_vectors`. | Jobs | Job deployed; integration test covers happy path + failure retry. | ✅ Worker in place with tests for storage download + indexing. |
| P1 | Update `semanticSearchTool` to use `pgvector` | Query top-k entities by vector similarity + lightweight metadata. | AI | Tool returns semantic results; planner context updated. | ✅ Tool now queries vector service with fallback logging when similarity is unavailable. |
| P2 | Ship "Super Memory" | Ensure `knowledge_facts` table, `saveFactTool`, and planner prompt encourage usage. | Domain/AI | Facts persisted via domain service; agent demo shows fact recall. | ✅ Tool persists via domain service with real embeddings and planner prompt updated. |

**Milestone:** Conversational query retrieves semantically related notes; agent stores and recalls user facts during planning.

## Epic 3 – The Safety & Reliability Net
**Objective:** Ship a beta-ready backend with isolation guarantees and resilient error handling.

| Priority | Task | Notes | Owner | Definition of Done |
| --- | --- | --- | --- | --- |
| P1 | Reinstate Row-Level Security | Reapply migrations; audit domain services for `userId` scoping. | Platform | RLS enabled in Postgres; tests confirm unauthorized access rejected. |
| P1 | Multi-tenant isolation test | Vitest integration simulating users A/B; ensures cross-tenant access fails. | QA | Test suite green; run in CI. |
| P2 | Harden agent execution error handling | Capture tool errors, log via Pino + Sentry, propagate user-friendly response in `generate_final_response`. | AI | Failure scenario test shows graceful degradation + observability. |
| P2 | Expand resilience tests | Cover external dependency outages (LLM, embeddings, R2). | QA | Tests with mocked failures assert retries/fallbacks. |

**Milestone:** System passes security and reliability gates; ready for closed beta users.

## Cross-Cutting Concerns
- **Telemetry:** Add correlation IDs spanning API → LangGraph → tools → domain events.
- **Documentation:** Update developer guides as services/tools evolve; include log/metric references.
- **CI/CD:** Ensure lint, tests, builds, and integration suites run per PR; add environment config validation.

### Near-Term Execution Plan (Connections & Suggestions)
- **Connections API Refactor (Phase C):**
  - Extract `chat.executeAction` and related helpers into `@synap/domain` service layer.
  - Introduce tRPC endpoints `suggestions.list` / `suggestions.execute` aligned with domain service contracts.
  - Add unit tests for planner-to-action flows covering optimistic locking and error propagation.
- **Intuition Layer Surfaces (Phase E):**
  - Define `@synap/ui` placeholder contract for AI inbox; expose JSON schema for frontend consumption.
  - Extend Inngest analytics to emit `suggestion.inspected` events for downstream telemetry.
  - Draft UI component spec (states: pending, accepted, dismissed) and couple with new API endpoints.

## Acceptance Criteria for V0.5 Launch
1. **User Value:** Single API call demonstrates end-to-end note creation with contextual response and stored metadata.
2. **Intelligence:** Semantic queries and user fact recall succeed with realistic embeddings.
3. **Reliability:** Multi-tenant isolation assured; error handling provides graceful responses; logs and (future) Sentry traces capture failures.
4. **Test Coverage:** Domain + orchestration unit tests, integration tests for cross-tenant isolation, happy-path E2E script.
5. **Operational Readiness:** Structured logging in place; runbooks reference new telemetry and fallback behaviors.

## Suggested Timeline
- **Week 1–2:** Epic 1
- **Week 3:** Epic 2
- **Week 4:** Epic 3 (overlaps allowed once Epic 1 milestone achieved)

---
For adjustments or owner assignments, coordinate with Antoine and the core team.
