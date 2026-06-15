## Mental model

Synap is a typed knowledge graph. **Reading is one verb (`synap ask`) — it routes for you.** Writing is where you must pick the right lane: the destination is decided by the **KIND** of knowledge, not by whichever workspace happens to be active.

### Where to write what — the three lanes (decide by KIND)

Ask yourself: _who does this knowledge serve?_ **There is no private AI scratchpad** — structuring knowledge into a real lane IS your job. Never write a `note` (that's the human's raw inbox); always `capture` into a lane.

| If it…                                                                                                                          | Lane                 | Where it goes                                                                            | Governance                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **is about the CURRENT WORK** — domain know-how for the project/task you're on (incl. a domain-specific gotcha/lesson/decision) | **Work** _(default)_ | a `knowledge` entity in the **active workspace** (`synap capture --type …`)              | proposal-gated (it's the user's real data; the workspace IS the domain — Builder ≠ marketing)              |
| **is GLOBAL truth** — a best-practice / runbook / how-to that holds across ALL projects                                         | **Global**           | pod-wide procedural `knowledge_keys` (`synap capture --global --type … [--key ns:slug]`) | reviewed for shared truth                                                                                  |
| **is about the USER** — how they work/talk/decide, their preferences, their life                                                | **User**             | pod-wide `user_observation` (`synap observe write` / `record_observation` tool)          | inferences are **proposed** (you review); explicit "I always X" auto-saves — never model the user silently |

> **Why this matters:** writing to the wrong lane degrades the graph. A gotcha you learned about the **current project** is **Work** (the active workspace — its domain). A best-practice that holds **everywhere** is **Global** (`--global`, pod-wide). A fact about **how the user works** is **User** (pod-wide, inferences proposed). `synap capture` echoes which lane + governance it used; check it.

> **Read the write outcome — it guides your next move (it never blocks you).** Every write (`capture`, `observe`, `create entity`, `create relation`, `note`) reports one of two outcomes (and `--json` carries `"outcome"`):
>
> - **`stored`** → it's **live now**, recallable via `synap ask`.
> - **`proposed`** → queued for the human's review, **like a git PR — not a failure, not a block.** Keep working: compose a whole graph of proposed changes in one session (reference the proposed entities, link them, add more) — they're staged together and go live when the human approves the batch. The only thing to remember: it's _under review_, so don't tell the user it's already applied. (Inferences about the user and writes to real workspaces are gated by design — expected, normal.)

> **Substrate names (tables under the hood):** _semantic_ = `entities` (the `knowledge` profile, workspace-scoped = domain separation), _episodic_ = `knowledge_facts`, _procedural_ = `knowledge_keys` (pod-wide runbooks). `ask` queries across them so you never pick on read.

### Data layers — the graph itself

| Layer         | What it is                                     | When to use                                              |
| ------------- | ---------------------------------------------- | -------------------------------------------------------- |
| **Entities**  | Typed structured nodes (task, person, …)       | Anything worth filtering, sorting, or linking            |
| **Relations** | Typed edges between entities                   | Making the graph traversable                             |
| **Documents** | Long-form markdown attached to an entity       | Meeting notes, research writeups, articles               |
| **Threads**   | Channel conversations, optional entity context | Posting to the user's personal AI channel                |
| **Proposals** | Writes queued for human approval               | Governance for some mutations (not an error — see below) |

### Key profiles for AI use

| Profile slug       | Scope     | Who writes     | Purpose                                                                                                                                                                                                                                       |
| ------------------ | --------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `note`             | pod       | **human only** | The human's raw "dump now, structure later" inbox. **The AI never writes a note** — structuring into a lane is its job; use `capture` instead.                                                                                                |
| `knowledge`        | workspace | AI             | Validated gotchas/lessons/decisions — the **Work lane** (default `synap capture --type`; ek_type/ek_claim/ek_why). DOMAIN = the workspace (a Builder gotcha ≠ a marketing one). Cross-project runbooks go to `knowledge_keys` via `--global`. |
| `user_observation` | pod       | AI only        | Durable user model — habits, communication style, preferences                                                                                                                                                                                 |
| `decision`         | pod       | human + AI     | Architectural decisions with rationale                                                                                                                                                                                                        |
| `research`         | pod       | AI             | Investigation with sources + conclusion                                                                                                                                                                                                       |
| `question`         | pod       | human + AI     | Open inquiry, closed when a decision answers it                                                                                                                                                                                               |
