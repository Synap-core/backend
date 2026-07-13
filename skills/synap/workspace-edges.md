## Workspace edges — how a domain LIVES IN THE GRAPH

A workspace is never an island. Before you create one (or reason about an existing one), map its **edges**: what it consumes, what it provides, what it triggers, what subject it shares, what spans it. Domains are wired together by a small, fixed taxonomy — and each edge type maps to a specific substrate. Knowing the taxonomy is what lets you reason about a new domain's _position_ instead of dropping it in disconnected.

> The two graphs are orthogonal. This is the **data-flow graph** (what reads/writes/triggers what) — the one we model. The **org graph** (who owns/operates a domain) is workspace membership only. "Comms contains Marketing" is org; the _data_ edge is "Marketing **consumes** Comms' brand." Keep them separate so a team reorg never rewires the data graph.

## The four edge types (and their substrate)

| Edge                    | Meaning                                          | Direction | Substrate                                                     | Example                                               |
| ----------------------- | ------------------------------------------------ | --------- | ------------------------------------------------------------- | ----------------------------------------------------- |
| **Provides / Consumes** | a domain _reads_ another's data (read redirect)  | A ← B     | `defaultSources` / `sourceRoles` on the consuming workspace   | Content **consumes** Comms' voice/ICP                 |
| **Triggers**            | an event in A causes _work written_ into B       | A ⇒ B     | automation + `resolveWorkspacePlacement` (run-in-A → write-B) | a `client` facet in CRM ⇒ an engagement in Operations |
| **Shares subject**      | the same atom wears a different facet per domain | A ⟷ B     | `entity_facets` (one entity, per-domain roles)                | one company is `lead` in CRM, `client` in Ops         |
| **Spans**               | a time-bound initiative crosses domains          | A—B—C     | `projects` (a cross-cutting lens)                             | one campaign spans Marketing + Content + Social       |

Read the whole graph as: **Provides/Consumes** = the read wiring · **Triggers** = the write/event wiring · **Shares subject** = shared identity · **Spans** = shared initiative.

## Reason about position BEFORE you create

When `workspace-design.md`'s rule says "yes, this is a domain," don't stop at creating it — place it in the graph:

1. **What does it consume?** Which existing domains' data does it read? Those become its `defaultSources` (provides/consumes edges).
2. **What does it provide?** Which domains will read _its_ output? (Declared on the consumer's side, but know the answer.)
3. **What does it trigger — and what triggers it?** Which facet/event in a neighbor should spin up work here, or here into a neighbor? That's the automation + placement wiring (Wave 2 processor behavior).
4. **What subject does it share?** Which atoms already exist elsewhere that this domain will confer a new facet on? (Resolve identity first, `attach_facet` — never a duplicate.)
5. **What projects span it?** Which cross-cutting initiatives will pull its data alongside other domains'?

A domain that consumes nothing and provides nothing is a smell — re-check the decision rule; it may be a facet or a project after all.

## Declaring provides/consumes on an existing workspace

Edges used to be settable only at template-authoring time or through the tRPC UI. The agnostic door for setting them on a live workspace is the governed MCP/Hub tool **`declare_workspace_source`** (equivalently `synap_update_workspace`): it sets `defaultSources` / `sourceRoles` on an existing workspace so the generic edge-resolver can redirect its reads to the providing domain.

- Use it when a domain should start reading another's data (e.g. point Marketing at Comms for brand/ICP).
- It is a **governed write** — a `"proposed"` response is normal, not an error (see `writes.md`).
- Setting the edge is what makes cross-workspace reads resolve generically, instead of each domain re-deriving its sources by hand.

## The reference wiring (worked example)

The 6-domain reference enterprise, read as edges:

- **Communication** owns voice/narrative/ICP/assets — _provides_ → Marketing, Content.
- **Content** owns asset/carousel/video — _consumes_ Comms; _provides_ → Social, Marketing.
- **Marketing** owns campaign/funnel — _consumes_ Comms + Content; _provides_ brief → Social; ⇒ _triggers_ leads → CRM.
- **Social** owns channel/post/schedule — _consumes_ Content + Marketing; _provides_ signals → Marketing/CRM.
- **CRM** owns person/company, confers `lead`/`client` — _consumes_ Social signals; `client` facet ⇒ _triggers_ → Operations.
- **Operations** owns engagement/contract/deliverable — _consumes_ CRM; delivery proof ⇒ _feeds_ → Content/Marketing.

Every arrow above is one of the four edge types. That is the whole model: name the arrows, pick the substrate, wire it — then the domain is a citizen of the graph, not an island.
