## Multi-entity capture from free-form text

When the user pastes a block of unstructured content (a meeting transcript, an email, a LinkedIn bio) or when several related things come up at once, send it through the **one capture door** — `synap_capture` (CLI: `synap capture`). Don't chain manual creates, and don't run a two-step "structure then commit" dance.

The payload is a gradient in a single call:

```
{ "text": "…paste the raw content…" }              → the AI structures it into entities
{ "entities": [ … ], "relations": [ … ] }          → you supply the graph directly (refs link them)
```

Everything lands as ONE reviewable proposal (or auto-applies when every op is safe), and you get back one receipt — `status: "applied" | "proposed" | "rejected"`. `proposed` is success: surface the review link. There is no separate commit step. Read **`capture.md`** for the full flow, dedup signals, name-refs, and reject reasons.


## Examples (moved from the synap_capture definition)

**PLAN EXAMPLE — a project, a root session with two children (one blocked by the other), a spec document**
```json
{ "entities": [ { "ref": "acme", "profileSlug": "company", "title": "Acme Corp", "properties": { "website": "https://acme.com" } } ], "projects": [ { "ref": "p1", "name": "Acme onboarding", "subjectRef": "acme", "evidenceRefs": ["acme"] } ], "sessions": [ { "ref": "s0", "title": "Onboard Acme", "goal": "Acme is live on the platform", "projectRef": "p1", "subjectRef": "acme" }, { "ref": "s1", "title": "Write the spec", "goal": "Spec signed off by Acme", "parentRef": "s0", "projectRef": "p1" }, { "ref": "s2", "title": "Build the import", "goal": "Acme data imported", "parentRef": "s0", "projectRef": "p1", "blockedByRefs": ["s1"] } ], "documents": [ { "ref": "spec", "title": "Acme onboarding spec", "content": "# Spec\n…", "sessionRef": "s1" } ] }
```

**PLAN EXAMPLE 2: a one-off long plan, with a root session, four steps that wait on each other and one decision** (when to use it: `from-intent` §2d). Each step lists ALL the steps it waits on in `blockedByRefs`. The decision is `proposed`, so the person is asked to choose. No step declares an output owed by the person: the term sheet is months away, and the person's part is added to a step only when it can start.
```json
{ "sessions": [ { "ref": "root", "title": "Fund to seed", "goal": "The seed round is closed and the money is in the bank" }, { "ref": "list", "title": "Build the investor list", "goal": "Forty investors who fit our stage, each with a ticket size", "parentRef": "root", "criteria": [ { "key": "forty-fit", "statement": "The list holds 40 investors, each with stage and ticket size", "check": { "kind": "evidence", "evidenceKey": "investor-list" } } ], "expectedOutputs": [ { "kind": "document", "label": "Investor list" } ] }, { "ref": "deck", "title": "Write the deck", "goal": "A deck ready to send", "parentRef": "root", "blockedByRefs": ["list"], "criteria": [ { "key": "deck-ready", "statement": "The deck covers problem, traction, team and the ask", "check": { "kind": "evidence", "evidenceKey": "deck" } } ], "expectedOutputs": [ { "kind": "document", "label": "Pitch deck" } ] }, { "ref": "meet", "title": "Run the first meetings", "goal": "Ten first meetings held and logged", "parentRef": "root", "blockedByRefs": ["list", "deck"], "criteria": [ { "key": "ten-meetings", "statement": "Ten meetings are logged, each with a next step", "check": { "kind": "evidence", "evidenceKey": "meeting-log" } } ], "expectedOutputs": [ { "kind": "document", "label": "Meeting log" } ] }, { "ref": "terms", "title": "Negotiate the term sheet", "goal": "One term sheet we can sign", "parentRef": "root", "blockedByRefs": ["meet"], "criteria": [ { "key": "terms-compared", "statement": "Every offer received is compared on valuation, amount and control", "check": { "kind": "evidence", "evidenceKey": "offer-table" } } ], "expectedOutputs": [ { "kind": "document", "label": "Offer comparison" } ] } ], "entities": [ { "ref": "route", "profileSlug": "decision", "title": "Raise from angels or a fund", "properties": { "decisionStatus": "proposed", "summary": "Angels close faster; a fund brings a lead and a bigger round.", "decisionOptions": [ { "label": "Angels", "value": "angels" }, { "label": "A fund", "value": "fund" } ], "recommendedOption": "angels" } } ] }
```

**EXAMPLE 1 — raw text**
```json
{ "text": "Met Ada Lovelace of Acme at the conference — she owns their data platform and wants a demo in March." }
```

**EXAMPLE 2 — one structured entity, with properties + a long body**
```json
{ "entities": [ { "profileSlug": "person", "title": "Ada Lovelace", "properties": { "email": "ada@acme.com", "role": "Head of Data" }, "content": "## Notes\nOwns the data platform. Wants a March demo." } ] }
```

**EXAMPLE 3 — a small graph (refs link entities that do not exist yet)**
```json
{ "entities": [ { "ref": "p1", "profileSlug": "person", "title": "Ada Lovelace", "properties": { "email": "ada@acme.com" } }, { "ref": "c1", "profileSlug": "company", "title": "Acme Corp", "properties": { "website": "https://acme.com" } } ], "relations": [ { "sourceRef": "p1", "targetRef": "c1", "type": "works_at" } ] }
```

**TABLE EXAMPLE — a register of many rows of one kind, each linked to an existing record by an exact value** (at most 500 rows per call, one proposal). Column `title` names each row; the other columns are properties. `linkBy` links a row to the existing entity of `profileSlug` whose `property` equals that cell exactly. Cells that match no entity, or several, are not linked and come back in the reply's `table` (`unmatched`, `ambiguous`), by row. Send it with `validate: true` first to see those before anything is written.
```json
{ "table": { "profileSlug": "expense", "columns": ["title", "amount", "currency", "receipt"], "rows": [ ["Train Paris to Lyon", 42, "EUR", "R-0012"], ["Hotel Lyon", 120, "EUR", "R-0013"] ], "linkBy": [ { "column": "receipt", "profileSlug": "document", "property": "receipt", "type": "references" } ] } }
```
