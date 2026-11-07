## Asks: how to ask the person (full shapes)

An `ask` is HOW the person answers a human-owned slot or a question: one tap instead of typing. The tools carry it as one loose object (`mode` plus the fields below); the pod checks it strictly and refuses a wrong shape with the field that failed and nothing filed. Fields are shared by every mode; a field that does not belong to the mode is ignored by the card.

**Shared (any mode):** `risk` (`high|medium|low`: how much is at stake), `stakes` (`routine` default | `commitment`: deploy, spend, publish, delete, anything irreversible; a relayed answer then waits for the person's own tap), `urgency` (`today` default | `whenever`; it can only lower the priority), `answerBy` (ISO-8601 with offset, `2026-11-05T17:00:00Z`, at most 40 chars; due within the hour it breaks through Focus), `consequence` (one line, at most 200 chars: what the answer DOES), `reversible` (boolean; omit when unknown), `dedupeKey` (your own handle, at most 120 chars: asking again with the same key UPDATES your open ask), `lookedAt` (up to 8 `{kind, id}`, kind `entity|document|view|automation|playbook`: what you read before asking; refs the person cannot see are refused, titles you send are ignored).

**confirm** (yes/no): `{mode:'confirm', prompt (at most 500 chars, IS the question), yes?, no?}`; `yes` / `no` are `{label (<=80), description (<=140, what that answer does), recommended}`; at most ONE recommended.

**choose** (1-8 `options`): `{mode:'choose', options:[{label (<=80), value? (<=500), description? (<=140, the consequence), recommended? (at most ONE), caution? (<=60 chars, one fact to weigh, e.g. 'Skips 1,284 tests'), icon?, media?, followUp?}], allowOther?}`. The person may always answer in their own words unless `allowOther: false` (only for a choice code reads as a value).
- `followUp` (one level only; a follow-up option opening its own is refused): `{prompt (<=120), options: 2-4 of {label, value?, description?, caution?, icon?, media?, recommended?}}`.
- `media`: `{kind: 'image'|'video'|'audio', ref: {url: http(s)} | {assetId: uuid} | {entityId: uuid}, alt? (<=200)}`.

**form** (small FLAT form; credential field types such as password, token, api key are refused: use `provide`): `{mode:'form', form:{fields:[{key, label, type, required?, help?, constraints?:{enum?, min?, max?, pattern?}}] (1-20), title?, note?}}`.

**act** (a thing to DO in the world; they answer 'I did this'): `{mode:'act', url? (http(s)), steps? (up to 7, each <=200 chars)}`. Never for a decision.

**provide** (handed over through the vault; you receive a reference, never the secret): `{mode:'provide', provide: {kind:'connection', service} | {kind:'file', accept?: up to 10 types} | {kind:'secret', name}}`.

**Which mode.** A DECISION is `confirm` or `choose`. When you have a view mark exactly ONE answer `recommended`: their pick vs your recommendation is recorded, and every answered confirm/choose files a `decision` entity. `ask: null` clears a stored ask.

**Examples.**
- `{"mode":"choose","options":[{"label":"Ship now","recommended":true,"description":"Publishes today"},{"label":"Wait a week"}]}`
- `{"mode":"confirm","prompt":"Publish the post today?","yes":{"description":"Goes live at 9:00","recommended":true},"no":{"description":"Stays a draft"},"stakes":"commitment"}`
- `{"mode":"choose","options":[{"label":"Deploy","followUp":{"prompt":"Which environment?","options":[{"label":"staging"},{"label":"production","caution":"Live users"}]}},{"label":"Not yet"}]}`
- `{"mode":"provide","provide":{"kind":"secret","name":"STRIPE_KEY"}}`

Where asks go: an `owner:'human'` slot on `start_session` / `update_session` (and on playbook stages), `synap_ask_person` for one question, `synap_post_message` with kind `question` + `slotLabel`. How answers come back and how to wait: `system/synap/focus-sessions`.
