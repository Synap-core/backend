## CRM Workspaces — 4-Entity Model

Some workspaces use a CRM data structure with four entities: `person` and `company` (identity records), `deal` (pipeline record), and `client` (post-win relationship marker). Understand this pattern when proposing lead captures, deal updates, or campaign membership.

**The model:**

- **`person` + `company`** — Identity only, no sales state. Persist across deals.
- **`deal`** — Pipeline record with `dealStage` property (lead, contacted, qualifying, proposal, negotiating, won, lost, inactive). Represents what people often call a "lead" (when stage=lead). Linked to person/company via `linked_to_deal` relation.
- **`client`** — Post-win relationship marker. Created automatically when deal transitions to stage=won. Status: active, paused, or churned. Linked via `is_client` (party → client) and `produced_by_deal` (deal → client).
- **`journey`** — Documents anchored to a deal (not a person). Linked via `has_journey`.

**AI behavior — lead capture:**

When the user describes a lead (inbound person, prospect, or company lead), propose the full bundle:

1. Create `person` entity (if not exists) with email, role, company name
2. Create `company` entity (if not exists)
3. Create `deal` entity with `dealStage: "lead"` and `estimatedValue` (if known)
4. Create `linked_to_deal` relation connecting person/company to deal

Never create a person with a sales-state flag. The deal is the lead container.

```json
POST /api/hub/entities
{ "userId": "{userId}", "workspaceId": "{wsId}",
  "profileSlug": "person",
  "title": "Alice Johnson",
  "properties": { "email": "alice@acme.com", "role": "VP Engineering" }
}

POST /api/hub/entities
{ "userId": "{userId}", "workspaceId": "{wsId}",
  "profileSlug": "deal",
  "title": "Acme prospect",
  "properties": { "dealStage": "lead", "estimatedValue": 50000 }
}

POST /api/hub/relations
{ "userId": "{userId}",
  "sourceEntityId": "ent_person_alice",
  "targetEntityId": "ent_deal_acme",
  "type": "linked_to_deal"
}
```

**AI behavior — moving deals to won:**

When a deal transitions to `dealStage: "won"`, also propose client creation if not yet linked:

```json
PATCH /api/hub/entities/ent_deal_acme
{ "properties": { "dealStage": "won" } }

POST /api/hub/entities
{ "userId": "{userId}", "workspaceId": "{wsId}",
  "profileSlug": "client",
  "title": "Acme (active)",
  "properties": { "clientStatus": "active" }
}

POST /api/hub/relations
{ "userId": "{userId}",
  "sourceEntityId": "ent_person_alice",
  "targetEntityId": "ent_client_acme",
  "type": "is_client"
}

POST /api/hub/relations
{ "userId": "{userId}",
  "sourceEntityId": "ent_deal_acme",
  "targetEntityId": "ent_client_acme",
  "type": "produced_by_deal"
}
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

- `dealStage` (not `crmStatus` or `status`) — values: lead, contacted, qualifying, proposal, negotiating, won, lost, inactive
- `clientStatus` (post-win only) — values: active, paused, churned
- Identities (person, company) carry no sales state

**Why separate identity from state:**

This model enables renewals (new deal linking to existing client), multi-stakeholder deals (multiple `linked_to_deal` relations per deal), campaigns with mixed entity types (persons + companies + deals as members), and clean churn tracking. It matches Synap's core pattern: entities + relations = graph.
