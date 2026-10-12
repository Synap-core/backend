## Writing titles and knowledge

Every write receipt runs the title rubric and returns `titleLint` when a title
breaks it. The title is stored as you sent it — **rewrite it** (update the
title) instead of leaving it. The pod never shortens a title for you, and over
200 characters it refuses the write.

### Title rules (every kind, every pod)

1. **One complete phrase, 80 characters at most** (aim for 40–70; a question
   may take 110). If it does not fit, rewrite it — never cut it, never end it
   with "…".
2. **Name the lasting thing, not the event.** No SHIPPED, LIVE, FIXED, DONE,
   VERIFIED, CORRECTION, no emoji. Status goes in a status property; the date
   is already on the record.
3. **No machinery in the title:** no hashes, ids, file paths, line numbers,
   markdown, URLs. They go in the body as evidence.
4. **Do not repeat the kind** ("Lesson:", "Decision:", "Caution:", "Finding:").
   The kind and `knowledgeForm` already say it.
5. **Plain words.** A code is allowed only when the pod's glossary has it;
   plan codes (T1, D3, W4, Wave A) are replaced by words.
6. **Same language as the body.**
7. **Search before you create** (`synap_ask`) and keep a title stable on
   update. A superseded decision gets a title that says what replaced it.
8. **Never empty, never a placeholder** ("Untitled", "Test", a URL, the first
   words of a transcript).

| Kind | Title shape | Example |
| --- | --- | --- |
| Knowledge | The claim as a short sentence | Space skills are linked by the brief, not by a row |
| Decision | What was decided, as a fact | Connection data lives in one package: @synap-core/integrations |
| Question | A real question ending in ? | Should Grida replace or complement the tldraw whiteboard? |
| Task | Verb + object (+ who/when) | Send signed agreement to Harbor Goods |
| Research | Subject + what was assessed | Excalidraw evaluated as a Synap capability |
| Issue | The problem as a statement | Capture reads the URL but never feeds it to the structurer |
| Note | What it is about | Farm-to-Client Market — idea brief |
| Work session | The outcome, short | Frontend package consolidation: 4 layer packages |
| Run | Run name + instance | Daily client briefing — 12 Oct |
| Report | Scope + period | Builder weekly report — week of 5 Oct |

### What counts as knowledge

Knowledge is something that will **still be true and useful in three months**,
whenever it was learned. It takes one `knowledgeForm`:

- `fact` — how something works.
- `caution` — a pitfall and how to avoid it.
- `convention` — how we do things here.

The full sentence goes in `ek_claim`; the title is its short handle, never the
claim cut off. Everything else goes elsewhere:

| It is really… | File it as |
| --- | --- |
| progress, "shipped", "verified", "done" | the session's outcome or report — not a lasting entity |
| a choice that was made | `decision` |
| an open bug or problem | `issue` |
| a plan, an idea, a hypothesis | `note` (or `question` if it is one) |
| steps to follow | a skill |
| a fact about an outside tool, vendor or market | `research` |

When unsure, ask: "will this still help someone in three months, and is it a
fact, a pitfall or a rule?" If not, it is not knowledge.
