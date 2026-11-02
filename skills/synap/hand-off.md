## Hand work to an agent on the person's computer

The person says "start this on my devbox", "have my Mac's Claude Code do it", "give this session to Codex". You find the agent, hand it the work through a session, follow the session's room, and report back. You never run their machine yourself: an agent they connected there (`synap worker`, Claude Code, Codex) picks the work up.

**Words.** A _runner_ is the process on a computer that works the sessions handed to one agent (`synap worker`). It is not a pod _worker_ (`synap_list_workers`, `synap_enable_worker`): that is a playbook's trigger turned on for a goal, which starts runs and runs nothing itself (`concepts`). Say "the agent on your Mac", never just "the worker".

**Where work runs.** Each computer takes the work it is for. A pod may hold its own skill naming which of the person's computers takes which work (load it when it exists); follow it over any guess. A runner started with `--protocols work-folder` takes playbook runs only: a code session handed to it is never launched, and it says so in the session's room.

**1. Find it — `synap_list_agents`.** One read: `computers[]` (the person's own) and `agents[]`, each with `computer`, `canTakeYourWork` (else `whyNot`), `live`, `paused`, `lastSeenAt`, and `handOff`: what YOUR hand-off would do right now (`direct`, `asks_you`, `blocked` + `handOffReason`). Ready agents come first.

- **Match the person's words against computer names first** ("my devbox" → the computer named `devbox`, any case), **then agent names and types** ("Codex", "claude-code"). Take the agents on that computer that can take the work.
- **Two or more fit → ask the person** which one, by name ("Claude Code on devbox, or Codex on devbox?"). Never pick for them.
- **None fits → say so.** "I see no agent on a computer called devbox" plus what you do see. Never hand it to a different machine silently.
- **`paused: true` → say it is paused** and that a person must resume it (Settings › Agents). Do not hand it off.
- **`live: false` → say when it was last seen** (`lastSeenAt`) and that it picks the work up the next time it checks in. Hand off only if the person still wants it.
- **Is a runner serving it? Read `servedAt` and `nobodyRuns`.** `nobodyRuns: false` (a recent `servedAt`): a runner serves it now. `nobodyRuns: true`: nothing on that computer runs it now; say so ("the agent on your Mac has not run since <servedAt>") and hand off only if the person wants the run to wait. `nobodyRuns: null`: the pod cannot tell (no runner ever stamped, or an old CLI); say "I cannot tell whether anything runs it; last seen <lastSeenAt>". `live` says only that its key was used.
- **No runner online → recommend waiting, never a second path.** The session shows who holds it (nobody, or the agent stopped) until a runner picks it up. Do not do the same job another way; if the computer must be awake, that is the person's step.
- **`canTakeYourWork: false`** — `whyNot` says why: `not_owned` (another person's agent: it would never see this work), `wrong_reach` (the pod's own agent: it answers in rooms, it never picks work up), `paused`.

**2. Hand it — through a session.** The session's roster is how work reaches an agent.

- New work: `synap_start_session` with a `title`, a one-sentence `goal`, 2–5 `criteria` the person can check, and `agentIds: [agentUserId]`.
- Work in flight ("this session"): `synap_update_session` with `addAgentId: agentUserId`.
- Read the reply. `handOffs[].status` (start) or `handOff.status` (update): `granted` = on the roster now; `proposed` = waiting for the person's approval; `denied` = say the `reason` as given.
- **`asks_you` / `proposed`: the person approves the hand-off first.** Tell them plainly: "approve the hand-off on your phone", with the `reviewUrl` from the reply. It is success, do not retry. Then wait: `synap_get_session` until the agent is on its roster (or `synap_wait_for_answer` if you also asked them something), and go on to step 3.
- **`blocked` / `denied`: say why, in the reason's words.** Never retry it as is. One case the list cannot predict: your own proposal limit ("Agent proposal limit reached") — the reply carries a link to raise it; pass that to the person.

**3. Follow the room.** Everything the agent says lands in the session's room (`session.channelId`). Read it with `synap_get_thread_context { threadId: channelId }`; read the session's outcomes with `synap_get_session`. A `synap worker` on that computer checks for handed sessions about every 30 seconds (never one its own identity started), starts ONE run of Claude Code per session, and **claims** it in the room in one line. Which protocol the run follows depends on the session:

- **Code** — a session that runs no playbook, or one with a `repo`/`repos`/`branch` param or a `pull_request`/`branch`/`code` deliverable. It works on a branch (`devbox/<session>-<slug>`, in a git worktree), never pushes to main, never deploys, and may open a DRAFT pull request. It **asks** with a room message starting `QUESTION:`: kind `update` = you, the orchestrating AI, can answer; kind `question` = a decision only the person can make (the person is notified). It waits up to 30 minutes and takes the FIRST reply posted after its question; no reply: it states its assumption and continues, or stops and says what is blocked.
- **Work-folder** — a playbook run over pod data (a video edit, a CRM list, an interview). It works in a folder of its own (`<work root>/<session id>`), with no git; files every deliverable to the pod and records it on the session's outcomes. It **asks** through a human-owned slot with an ask (what the person sees in Needs you), never a `QUESTION:` line, and waits up to 30 minutes for the answer.
- Either way it **reports** in the room (what it made and where, the first thing to check) and records deliverables against the session's outcomes. It does not close the session; the owner does.
- **Any room message posted after its run ended, by anyone but the agent, wakes it again** in the same conversation (up to 20 times). That is how an answer reaches it after it stopped. So post in the room only what you want it to act on.

Answer a `QUESTION:` of kind `update` yourself with `synap_post_message` to the room. Leave kind `question` to the person, or ask them and relay their answer.

**4. Report back.** Tell the person, in a few lines: which agent on which computer took it, whether it is on the roster or waiting for their approval, what the agent reported (result, branch, commit), and anything it asked that only they can answer. Point them at the session to review and close it.
