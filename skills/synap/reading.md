## Reading

**Start with `ask` — the one routed read door.** It classifies the question and
queries the right substrate(s) for you, returning a glass-box answer (which
substrates answered, which were unavailable, plus the engine's verdict). Reach for
the low-level doors below only when you deliberately want a single substrate or a
specific shape (a graph traversal, a typed-entity filter, an entity's neighborhood).

```
# THE read door — routes across semantic / procedural / episodic / library, tells you which answered
POST /api/hub/knowledge/ask   body: { query, workspaceId?, limit? }
  → { query, routedTo: [...], primary, answers: [{ substrate, items, status }], degraded, understanding, verdict }
```

A link the person kept is in their Library: `ask` finds it (a `library` block — title, source URL, a snippet of what was read, who read it; `degraded: ["library"]` means the Library could not be read, never "nothing kept"). To read any URL use the `read_webpage` intent (builtin `web.read`).

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

**Narrow a list: `filters` and `includeFacets`.** `synap_get_entities`, Hub `GET /entities` and `GET /users/{id}/entities` share one grammar. `filters` is an array (on REST, its JSON in the query string) of `{field, operator, value}`, ANDed, at most 10. `field` is `title`, `preview`, `type`, `createdAt`, `updatedAt` or `properties.<slug>`; `operator` is `equals`, `not_equals`, `contains`, `not_contains`, `in`, `not_in`, `greater_than`, `greater_than_or_equal`, `less_than`, `less_than_or_equal`, `is_empty` or `is_not_empty`. A `properties.<slug>` clause needs `profileSlug` naming a kind that declares the property. An unknown or secret property, a malformed filter or too many clauses is an error, never an ignored filter. A filter only narrows what you already read. `includeFacets: true` adds each row's role facets (`facetSlugs`, and `facets` with overlay properties and status). Example: `synap_get_entities {profileSlug: "deal", filters: [{field: "properties.stage", operator: "equals", value: "won"}]}`.
