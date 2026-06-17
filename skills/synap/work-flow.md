## The work flow — question → research → decision → action

AI-assisted work has a shape. When the user is actually _thinking about something_, it flows through four structural nodes. Each is a first-class entity. None of these are optional "nice-to-have" labels — they're the graph that makes the work _durable_ and transferrable between AIs.

| Stage       | Entity     | What it captures                                         | Typical trigger                                                    |
| ----------- | ---------- | -------------------------------------------------------- | ------------------------------------------------------------------ |
| Inquiry     | `question` | What the user is trying to figure out                    | "I'm wondering about X" / "Should we Y or Z?" / "What's the best…" |
| Exploration | `research` | Investigation: sources consulted, conclusion, confidence | Reading articles, comparing options, summarizing findings          |
| Resolution  | `decision` | What was chosen + rationale + alternatives               | "We decided to…" / "Let's go with…" / "I'm going with…"            |
| Execution   | `task`     | Concrete action items that follow the decision           | "Now I need to…" / "TODO: ship Y by…"                              |

**Link each stage to the next:**

- `question.answeredByDecisionId` → the decision that closed it
- `research.questionId` → the question it investigates
- `decision.projectId` → the project it affects (same for question / research)
- Use `POST /relations type=source` to link research to its sources (articles, websites, documents)

Traversing in either direction gives the user answers like:

- "What am I currently exploring about Project Eve?" → `GET /entities?profileSlug=question&…` filtered by open
- "What decisions have we made on this project?" → filtered by `projectId`
- "What was the research behind this decision?" → reverse-lookup from `decision` via the research entities that reference the same `projectId` and question

### When to create each

**`question` — substantive inquiries only.** The test: _would the user want to find this later?_ "What's the weather" = no, don't create. "Should we use LangGraph or CrewAI?" = yes, create. Casual chitchat never becomes a question.

**`research` — when you investigate.** Any time you go off and read articles / websites / past notes to answer something, that's research. Create the entity upfront (`status: "ongoing"`), link sources as you pull them (`POST /relations type=source`), set `conclusion` when you're done (`status: "concluded"`).

**`decision` — when the user picks a path.** Already covered in the memory-vs-entity section above. Link back to the question it answers (set `question.answeredByDecisionId`).

**`task` — when the decision implies concrete work.** Link with `projectId` if not already inferred.

### Worked example

User: _"I'm trying to figure out whether we should build our own orchestrator or standardize on OpenClaude's. Can you help me think through it?"_

1. Create the question:

   ```json
   POST /api/hub/entities
   { "profileSlug": "question",
     "title": "Build custom orchestrator or use OpenClaude native?",
     "properties": {
       "questionStatus": "exploring",
       "askedAt": "2026-04-20",
       "projectId": "ent_project_eve",
       "description": "Weighing separation-of-concerns vs. out-of-the-box capability."
     } }
   ```

2. As you investigate, create a research entity and link sources:

   ```json
   POST /api/hub/entities
   { "profileSlug": "research",
     "title": "LangGraph vs CrewAI capability survey",
     "properties": {
       "researchStatus": "ongoing",
       "questionId": "ent_question_1",
       "projectId": "ent_project_eve"
     } }

   POST /api/hub/relations
   { "sourceEntityId": "ent_research_1", "targetEntityId": "ent_article_langgraph_docs", "type": "source" }
   ```

3. When you reach a conclusion, update the research:

   ```json
   PATCH /api/hub/entities/ent_research_1
   { "properties": {
       "researchStatus": "concluded",
       "conclusion": "LangGraph separates orchestration brain from UX. CrewAI adds agent abstractions but couples to its runtime.",
       "researchConfidence": "high"
     } }
   ```

4. When the user picks, create a decision linked to the question:

   ```json
   POST /api/hub/entities
   { "profileSlug": "decision",
     "title": "Use LangGraph orchestrator over OpenClaude native",
     "properties": {
       "decisionStatus": "accepted",
       "decidedAt": "2026-04-22",
       "rationale": "Separates Orchestration Brain from UX.",
       "alternatives": "Standardize on OpenClaude's multi-agent logic.",
       "projectId": "ent_project_eve"
     } }

   PATCH /api/hub/entities/ent_question_1
   { "properties": {
       "questionStatus": "answered",
       "answeredByDecisionId": "ent_decision_1"
     } }
   ```

5. Tasks follow as usual, linked to the project.

**The payoff:** six months later, any AI (or the user alone) can reconstruct the reasoning by traversing from the project → question → research → decision → tasks. That's the durability Synap provides on top of chat.

### Creation is silent by default

Don't interrupt the conversation to ask "should I log this as a question?" — just do it and add a one-line trailer at the end of your response:

> (Logged as question on Project Eve. Review: synap://open/proposal/…)

If the creation was auto-approved (entity.create is on the whitelist), there's no proposal; just show a link to the entity:

> (Logged as question → synap://open/entity/ent_question_1)
