## Reading

**Start with `ask` — the one routed read door.** It classifies the question and
queries the right substrate(s) for you, returning a glass-box answer (which
substrates answered, which were unavailable, plus the engine's verdict). Reach for
the low-level doors below only when you deliberately want a single substrate or a
specific shape (a graph traversal, a typed-entity filter, an entity's neighborhood).

```
# THE read door — routes across semantic / procedural / episodic, tells you which answered
POST /api/hub/knowledge/ask   body: { query, workspaceId?, limit? }
  → { query, routedTo: [...], primary, answers: [{ substrate, items, status }], degraded, understanding, verdict }
```

Low-level doors (`ask` routes to these — graph-based, not semantic; type filter →
relations → neighborhood):

```
# Keyword search across everything (entities, documents, views, threads)
GET /api/hub/search?query={query}&userId={SYNAP_USER_ID}&workspaceId={id}

# Entities of a specific type (q= is the param for entities endpoint)
GET /api/hub/entities?q={query}&profileSlug={slug}&workspaceId={id}

# Recent entities
GET /api/hub/entities?sort=updatedAt:desc&limit=20&workspaceId={id}

# The full connected neighborhood of an entity (prefer this)
GET /api/hub/entities/{id}/connections?userId={userId}&workspaceId={id}
  → { connections: [{ entityId, entity, label, direction,
                      source: "graph"|"property"|"thread" }],
      counts: { total, graph, structural, threads } }

# BFS traversal (expensive at depth 3+)
GET /api/hub/graph/traverse?entityId={id}&maxDepth=2&workspaceId={id}

# Memory facts (keyword)
GET /api/hub/memory?userId={userId}&query={keywords}
```

**Never claim absence without searching this turn.** Asked "what do you know about X", "is there an X", "anything on X" — you MUST `ask`/`search_unified` for X first (and `list_entities` on the matching profile for "how many / list all X"). Only after a search returns nothing may you say "I didn't find anything matching X" — never assert "X does not exist." A just-created entity is searchable within seconds, so a confident "nothing exists" without a search this turn is a hard failure.

No SQL joins. The graph is the join.
