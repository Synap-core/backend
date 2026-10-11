## CRM Workspaces — identity, roles, deals

A CRM workspace holds `person` and `company` (identity records), the `lead` and `client` ROLES those identities wear (facets, not entities), and `deal` (the sale). Understand this pattern when proposing lead captures, deal updates, or campaign membership.

**The model (one lifecycle per kind or role):**

- **`person` + `company`** — Identity only, no sales state. Persist across deals.
- **`lead` role** — qualification only. Attach it with `attach_facet` to the person/company; its status is `leadStage`: new, researching, outreach, engaged, qualified, nurturing, converted, disqualified.
- **`deal`** — the sale, and nothing before it. Its one lifecycle is `commercialStage`: draft, proposed, negotiating, won, lost. Linked to person/company via `linked_to_deal`. Open a deal only when a person chose to pursue the lead.
- **`client` role** — attached to the party when a deal is won. Status `clientStatus`: prospect, active, paused, former, churned. An ended relationship is `clientStatus: churned` — never a separate `churned` role.

**AI behavior — lead capture:**

When the user describes a lead (inbound person, prospect, or company lead):

1. Resolve the person/company first (email, domain, url); create only if none matches
2. `attach_facet` the `lead` role with `leadStage: "new"`
3. Do NOT open a deal yet — a deal starts when the person decides to pursue

```json
POST /api/hub/entities
{ "userId": "{userId}", "workspaceId": "{wsId}",
  "profileSlug": "person",
  "title": "Alice Johnson",
  "properties": { "email": "alice@acme.com", "role": "VP Engineering" }
}
// then attach_facet { entityId: "ent_person_alice", facetSlug: "lead", properties: { "leadStage": "new" } }
```

**AI behavior — pursue, then win:**

When the person chooses to pursue: create the `deal` at `commercialStage: "draft"`, link the party with `linked_to_deal`, and set the lead's `leadStage: "converted"`. When a person confirms the deal is won: set `commercialStage: "won"` and `attach_facet` the `client` role on the party with `clientStatus: "active"`. Moving a deal to won or lost is a person's call — propose it, never decide it.

```json
PATCH /api/hub/entities/ent_deal_acme
{ "properties": { "commercialStage": "won" } }
// then attach_facet { entityId: "ent_company_acme", facetSlug: "client", properties: { "clientStatus": "active" } }
```

**AI behavior — campaign membership:**

When the user describes campaign members (segment for outreach, tracking, or automation), use polymorphic `member_of` relations. Members can be persons, companies, or deals:

```json
POST /api/hub/relations
{ "userId": "{userId}",
  "sourceEntityId": "ent_person_alice",
  "targetEntityId": "ent_campaign_enterprise",
  "type": "member_of"
}

// Same relation type, different entity type
POST /api/hub/relations
{ "userId": "{userId}",
  "sourceEntityId": "ent_deal_acme",
  "targetEntityId": "ent_campaign_enterprise",
  "type": "member_of"
}
```

**Property names:**

- `commercialStage` on `deal` (never `dealStage`, `stage`, `crmStatus` or `status` — retired) — draft, proposed, negotiating, won, lost
- `leadStage` on the `lead` facet — new, researching, outreach, engaged, qualified, nurturing, converted, disqualified
- `clientStatus` on the `client` facet — prospect, active, paused, former, churned
- Identities (person, company) carry no sales state

**Why separate identity from state:**

This model enables renewals (new deal linking to existing client), multi-stakeholder deals (multiple `linked_to_deal` relations per deal), campaigns with mixed entity types (persons + companies + deals as members), and clean churn tracking. It matches Synap's core pattern: entities + relations = graph.

## Resolution discipline — resolve BEFORE you create

Extracting people/companies from a digest, an email/DM thread, or notes is a RESOLUTION problem, not a creation problem. Follow this method every time (it is generic — the specific team roster and known aliases are DATA you fetch, never hardcoded):

1. **Search first, once (batched).** Before proposing any person/company, run a SINGLE batched query (`search_unified`, plus `list_entities` if needed) that covers ALL candidate names, handles, emails and aliases at once. Never run one query per candidate — that is a cost failure.
2. **Reuse on match → add an alias.** If a candidate matches an existing entity, reference the existing entity by its real id (e.g. `existingEntityId` on `propose_entity_graph`) and add the newly-seen surface form (a handle, an alternate spelling) to the entity's `aliases` — do NOT create a second `person`/`company`. The `person` profile carries `email`, `discord-handle` and `aliases` for exactly this.
3. **Never placeholder.** Never mint an entity whose identity is unstated — "Not publicly disclosed", "unknown", "TBD", an empty name, or a bare handle with no person behind it. Fold that unstated thing into the description of a related entity instead.
4. **Team is not a contact.** Internal senders — your own side of a `client-comms` thread (the agency's own team) — are NEVER captured as the client's contacts. Only the external party becomes a person/company/deal. Team roster may appear in `orient.teamRoster` — treat as internal.
5. **Connect the graph.** Every entity you propose should attach via at least one relation (person `works_at` company, person `linked_to_deal` deal, …). A name mentioned only in passing, with no relation and no stated identity, is not worth capturing as its own entity.

An extraction that creates a duplicate "Sarah Chen", or a `person` titled "Unknown sender", is a failure — resolve, reuse, and alias instead.
