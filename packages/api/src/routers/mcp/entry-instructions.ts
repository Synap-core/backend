/**
 * The MCP `instructions` for an ENTRY key (V1 D4) — the reflexes, worded for
 * the 9 tools that key lists.
 *
 * `skills/synap/reflexes.md` stays the canonical reflexes for every other
 * door (legacy and builder keys, the IS baseline, the CP connector). It names
 * tools an entry key cannot see (`remember_fact`, the track tools,
 * `evaluate_session`, `set_*_focus`, `list_profiles`, `list_capabilities`), and
 * an agent told to call a tool it is not listed will either fail or guess. So
 * an entry key gets this shorter text instead: the same loop, entry tools only,
 * plus the one way to reach the rest (`load_skill('tools:<group>')`).
 *
 * Pinned by `instructions-entry.test.ts`: every tool stem named here is an
 * entry tool (derived from `tools.list()` and `ENTRY_TOOLS`), the group list is
 * the live one, and the text fits the same budget as the full reflexes.
 */

import {
  BUILDER_REF,
  TOOL_GROUP_NAMES,
  toolGroupRef,
} from "./tool-profiles.js";

export const ENTRY_REFLEX_PROSE = [
  "The user's Synap pod: source of truth for their life, work and people. Tool names below are stems; your door may prefix them (`synap_ask`, `pod__ask`).",
  "",
  "1. **Recall first.** Before answering about the user's world or creating, `ask` (prevents duplicates).",
  "2. **Capture after.** A durable fact, decision, person, task: `capture`. No private scratchpad.",
  "3. **Orient once.** `orient`: pending review (raise first), open sessions, kinds, actions.",
  "4. **Work in a session.** `start_session` or resume (playbook `templateId`); 2–5 `criteria`; advance `currentStage` with `update_session`; person-only: `owner:'human'` slot + `blockedReason` + `ask` (confirm/choose with 1 `recommended`/form/act/provide), then `wait_for_answer`; post progress, questions and results in its room (`post_message` to `session.channelId`); your own chat may repeat them; `complete_session` when done.",
  "5. **`proposed` is success**, queued for review. Keep working; never retry.",
  `6. **More tools on demand.** This key lists the essentials. For more, \`load_skill\` a group: ${TOOL_GROUP_NAMES.map((g) => `\`${toolGroupRef(g)}\``).join(", ")}, or \`${BUILDER_REF}\` for all. They appear after you reconnect.`,
  "",
  "Depth via `load_skill`: `system/synap/concepts`, `focus-sessions`, `from-intent` (new area), `writes`, `catalog`.",
].join("\n");
