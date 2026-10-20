# Where agent writes land: graph placement and the agent's workspace focus

> Verified against code on 2026-10-20 (backend@c31e261a). Condensed from the
> workspace placement and agent focus plan (ratified 2026-07-27), removed from
> the repository on 2026-10-20.

- **Status:** Accepted 2026-07-27. Layer 1 and the advisory half of Layer 2 are
  built; the enforced read scope is deferred.

## Context

An agent's `import.graph` of leads landed pod-wide (`workspaceId: null`)
instead of in the CRM space, so the members who work leads could not see them.
Two causes: the graph producers (`import.graph`, `capture.graph`) passed the
workspace straight through and never asked the placement door, and an agent
identity had no notion of "the space I am working in".

## Decisions

1. **D1. Layer 1 plus advisory Layer 2 now.**
   - _Layer 1, routing:_ when a graph write has no workspace, the producers call
     the placement door (`resolveWorkspacePlacement`: explicit, ontology,
     context, relational, AI tie-break, default) from the graph's profile slugs
     and materialize each operation in the resolved space.
   - _Layer 2, advisory focus:_ an agent can be told "use CRM until I say
     otherwise". The focus is the default for writes that name no workspace.
     It never refuses a call and an explicit per-call workspace always wins.
2. **D2.** The focus is stored on the agent identity, not on a key (keys
   rotate), with a per-agent mode: `advisory` (default) or `enforced` (later).
3. **D3.** When the enforced read scope is built, identity dedup keeps a
   pod-wide "does this exist" match door, so a scoped agent does not create a
   second person or company that exists outside its focus.
4. **Runtime focus (founder addition).** The focus is read live at request time
   from `users.agentMetadata.focusWorkspaceId` (JSONB, no migration), set and
   cleared by an MCP tool.

Precedence for a write: explicit workspace or the agent's live focus, then the
ontology-resolved space, then the membership fallback.

## State on 2026-10-20

- Placement for graphs: `packages/database/src/services/workspace-resolution-service.ts`
  (shared by `submitCaptureGraph` and `ImportOrchestrator.resolveGraphPlacement`).
- Focus: `users.agentMetadata.focusWorkspaceId`
  (`packages/database/src/schema/users.ts`), read by
  `getAgentFocusWorkspaceId` (`packages/api/src/services/agent-identity-service.ts`),
  applied in `packages/api/src/routers/mcp/adapter.ts` and
  `packages/api/src/routers/mcp/handlers/shared.ts`; MCP tool
  `synap_set_workspace_focus`. A project sibling exists
  (`synap_set_project_focus`, `agentMetadata` project focus).
- Not built: the enforced mode and its pod-wide match door (D2, D3).
