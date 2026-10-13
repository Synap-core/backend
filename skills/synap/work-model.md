## Work model — how work is shaped on a pod

Load this before you plan, start or run work, or author a process. The long form is the pod document "The Synap work model" (36878a70-6cbb-4122-8bfa-288fdbd65218); the words are in `concepts`.

### Why

A process is the life of a **thing**, not a script. A lead, a post or a feature has ONE status. Boards, workers, sessions, goals and history read that status or move it through ONE door. So "when a post enters Review, run the review" is one rule, "how many leads reached Qualified this month" is a count, and a person and an agent can work the same thing without overwriting each other. Before, each playbook kept its own stages and status field, and the same fact lived in three places.

### The nouns

| Noun                 | What it is                                                                          | Not                                  |
| -------------------- | ----------------------------------------------------------------------------------- | ------------------------------------ |
| **Project**          | a commitment, and a lens across spaces                                              | a method, a domain                   |
| **Track** (optional) | a LASTING intent in one project: direction, instructions, goal; it turns workers on | a list of stages; it never completes |
| **Thing**            | any entity: one kind, maybe roles, one status per kind or role                      | a second entity for a hat            |
| **Session**          | the unit of work that closes: goal, criteria, room; one thing or a batch            | a "run" because it follows a method  |

Not nouns (nobody manages them as objects): a **pipeline** is a view of a lifecycle; a **worker** is configuration (a method + a trigger + a size); a **method** is a playbook a session may follow; a **check** is a recurring verification.

How they relate: a project files things; each kind or role declares one **lifecycle** (its status list); its **pipeline** is computed (columns = the options in order); a status change fires **workers**, which start **sessions** carrying the project, the track and their **targets**; a session moves each thing's status through the door. **Hand-off is a role:** a won deal makes the party a client (attach the role); nothing is copied.

### Three tenses of a thing

- **Past = history.** Every status change is one transition event: from, to, who, which session, why.
- **Present = status.** One value per kind or role, in its own column.
- **Future = agenda.** Tasks and events linked to the thing, with an owner. _(Planned, wave 4.)_

### Five categories

Every lifecycle option has one fixed category: `open · active · paused · done · lost`. Names are free; rules read the category. An agent moving a thing into `done` or `lost` proposes by default; an option marked `humanOnly` is never set by an agent. A space may ADD options; it never renames, removes or recategorises one.

### The one door

Every status change — your call, a board drag, a method's step, a sync — goes through `moveStatus`. As an agent: a kind's status = `update_entity` with the lifecycle property set to the new value AND, over MCP, `expectedStatus` = the status you saw (the in-app `update_entity` has no `expectedStatus` yet; the door still checks the lifecycle); a role's status = `update_facet` `status` where your tools list it (the in-app agent; MCP has no role-status tool yet).

- `conflict` (with the current status) is normal: someone moved it; re-read and decide again. A person's move always wins.
- `proposed` is success (a done/lost move, or governance said review).
- A refusal naming the valid options means the value is not in the declared lifecycle: pick one of them.
  Never invent a status, never keep your own stage field.

### Session size

- **Per thing** when each item needs its own thinking: a post, a feature, a deal in negotiation.
- **Per batch** when items are interchangeable: one session for "find 10 leads today" or "today's follow-ups".
- A session's **step is its subject's status**: move the thing, the step follows.
- **Set the subject.** A session about one thing names it: `subjectEntityId` on `start_session`, or on `update_session` the moment the thing exists (a batch names its things as targets). A session on no thing shows on the homes as "No thing yet · attach one", outside every pipeline.
- Following a method does not turn your session into a run; it stays your work and still shows in the method's runs.
- **Targets get a result each**: a worker session holds its things as targets. Your own move of a target marks it `done`; someone else's move marks it `skipped`; targets left at close are `skipped`. Put the outcome on each thing, not only in a summary.

### Workers

A worker is a playbook **activator**, declared on the method and owned by the lifecycle: `on` = `created` · `enters_status` (+ `status`) · `count` (+ `status`, `min`: once N things wait) · `schedule` (+ `cron`) · `manual`; `size` = `per_thing` · `per_moment` (a count or schedule is always per batch); `mode` = `propose` (default) · `run`; `maxPendingApprovals` throttles it. It compiles into a governed rule the owner can pause; it fires once per thing per transition. A track or project **turns it on** for its scope; installs turn it on space-wide. Authoring: `processes`.

### Tracks

A track holds an owner, a direction, instructions, the workers it turns on, and a goal (stated, or measured as transitions into `done`). It has no stages and never completes: pause or archive it. Work in it = `start_session` + `trackId`. A thing may count for two tracks. Solo users may never need one: workers can run space-wide. Legacy: `start_stage_session` and `add_track_stage` serve old tracks started from a method; never `advance_track` without the user.

### The homes: what each space makes, what is moving

Home, a space and a project read the work through two reads (the same answer every app shows):

- `lifecycle.home` (Hub `GET /api/hub/lifecycle/home?projectId=`): every space you see with its intent and, per kind it produces, the pipeline in one line, needs-you, being-worked and one headline thing.
- `lifecycle.moving` (Hub `GET /api/hub/lifecycle/moving?workspaceId=&projectId=&limit=`): the things with open work on them, the work under each (asks you first), and `unattached`, the open sessions on no thing.

Read them to answer "what is going on" before you list sessions one by one.

### A kind's dashboard

A kind with a lifecycle has its own page: the board, Needs you, the sessions on its things. To give it a custom Dashboard ("make this my Posts dashboard"), `create_cell` a frame over the bridge's intent reads (`lifecycle.board`, `lifecycle.throughput`, `attention.needsYou`, `attention.count`, `sessions.list`), then `promote_cell_to_renderer` with `slot: "dashboard"` (the `entity-profile` content kind). Recipe: `synap-ui`; params and shapes: `viewframe-cells`.

### Rules of thumb

1. Find the thing before creating one: resolve identity, then attach a role — never a twin.
2. Status changes go through the door, with `expectedStatus`.
3. Never invent a status or a second status field; the lifecycle is declared on the profile (`list_profiles`).
4. Size the session from the work: per thing or per batch.
5. Results go on the things, not only in prose.
6. `proposed` is success. Commitments (publish, send, sign, spend) are a person's call.

### Applied: content (Content OS)

- Thing = a **post**. Lifecycle `post-status`: Idea (open) · Briefed · Scripted · In Draft · Review · Scheduled (active) · Published (done) · Archived (lost, human-only).
- Nothing publishes itself: a move to Published is a proposal the person approves on the preview.
- Pipeline = the Posts board, filtered by project or campaign.
- Workers: **Draft** (per thing, enters Briefed) · **Review prep** (per thing, enters Review, ends by proposing the publish date) · **Ideas** (per batch, weekly, creates posts at Idea). Today the catalog ships them as Produce Content (enters Briefed), Repurpose (enters Published) and Plan Next Content (weekly, off by default).
- "The next posts" = read the pipeline: gaps per pillar, posts waiting per status.

### Applied: leads and deals (CRM)

- **Lead** = a role for qualification only, `leadStage`: new · researching · outreach (open) · engaged · qualified · nurturing (active) · converted (done) · disqualified (lost, human-only).
- **Deal** = the sale, `commercialStage`, created only at hand-off. A **won** deal attaches the client role to the party.
- A Cal.com booking makes the attendee a lead at `engaged` and records the call as an event; it never creates a deal and never moves a lead backwards.

### Point another AI here

Every door can load this: `load_skill system/synap/work-model`. To make a space carry it, put a one-line pointer in the space brief (`update_space_brief`, `purpose` or `framing`, 240 characters each): in-app agents and worker sessions read the brief every turn, MCP agents when they `orient`. To steer a session in flight, post the pointer in its room. A document attached to a session reaches an agent as a title only, so it does not teach.
