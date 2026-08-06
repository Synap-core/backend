## Worked examples

### Example 1 — "Remind me to send the proposal to Acme on Friday"

1. Search for the Acme entity: `GET /entities?q=Acme&profileSlug=company` → got `ent_acme`
2. Search for an existing task: `GET /entities?q=proposal&profileSlug=task&workspaceId=…` → none
3. Create the task with links:

   ```json
   POST /api/hub/entities
   { "userId": "{userId}", "workspaceId": "{wsId}",
     "profileSlug": "task",
     "title": "Send proposal to Acme",
     "properties": {
       "status": "todo", "priority": "high",
       "dueDate": "2026-04-24"
     }
   }
   ```

4. Link to Acme (Acme is not an entity_id property on task — use Way 2):

   ```json
   POST /api/hub/relations
   { "userId": "{userId}",
     "sourceEntityId": "ent_new_task",
     "targetEntityId": "ent_acme",
     "type": "related_to" }
   ```

5. Confirm: "Task created and linked to Acme, due Friday."

### Example 2 — "Who's Sarah at Acme?"

1. Search person: `GET /entities?q=Sarah&profileSlug=person` → `ent_sarah`
2. Pull her connections: `GET /entities/ent_sarah/connections` → company=Acme, 3 recent emails, 1 meeting
3. Answer from the returned data, not from your own context.

### Example 3 — "Save this article for later: https://…"

1. Search for existing bookmark: `GET /entities?q=<url>&profileSlug=article` → none
2. Create an article entity:

   ```json
   POST /api/hub/entities
   { "userId": "{userId}", "workspaceId": "{wsId}",
     "profileSlug": "article",
     "title": "<page title>",
     "properties": { "url": "<url>", "domain": "<host>" }
   }
   ```

3. If the user said why ("interesting for the onboarding project"), also create a relation to that project — never drop the reason as a plain comment, turn it into a link.

### Example 4 — "Write up a strategic plan for the Q3 launch"

You are authoring this text yourself — it is not a file you have. Don't create
a `file`/`document`-kind entity and stuff the Markdown into it.

1. Search for an existing plan: `GET /entities?q=Q3 launch&profileSlug=knowledge&workspaceId=…` → none
2. Create a CONTENT-kind entity carrying the plan as `content` (the doc auto-materializes):

   ```json
   POST /api/hub/entities
   { "userId": "{userId}", "workspaceId": "{wsId}",
     "profileSlug": "knowledge",
     "title": "Q3 launch strategic plan",
     "properties": { "knowledgeForm": "insight" },
     "content": "# Q3 Launch Plan\n\n## Goals\n…\n\n## Timeline\n…"
   }
   ```

3. Link it to the relevant project: `POST /api/hub/relations` `{ sourceEntityId: "ent_new_plan", targetEntityId: "ent_project_q3", type: "related_to" }`.
4. Confirm: "Plan captured and linked to Q3 launch." No upload, no `file` entity, no separate `synap_create_document` call.
