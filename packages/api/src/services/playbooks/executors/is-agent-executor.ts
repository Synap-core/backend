/**
 * IsAgentExecutor — the IS-native executor (Phase 3).
 *
 * Unifies the IS call path behind one entry: a Playbook whose `executor` is
 * `is-agent` dispatches the resolved goal into the run's session channel, which
 * is what the IS chat pipeline consumes. The session already carries a channel
 * (created by `runPlaybook` before dispatch), so this executor only needs to
 * POST the goal as the kickoff message.
 *
 * The IS works ASYNCHRONOUSLY in the channel after the kickoff; completion and
 * capture-back happen out-of-band via the Hub `POST /runs/:id/capture` route.
 * So this executor returns `{ status: "running" }` — it does not block on the
 * agent finishing.
 *
 * Design doc: team/platform/playbooks-capability-substrate.mdx (§4.4).
 */

import { insertChannelMessage } from "@synap/database";
import { createLogger } from "@synap-core/core";
import { MessageAuthorType, MessageRole } from "@synap/database/schema";
import { triggerAutoRespond } from "../../../utils/trigger-auto-respond.js";
import { resolveActiveAgentBySlug } from "../../agent-identity-service.js";
import type { Executor, RunContext, RunResult } from "@synap/playbooks";
import {
  loadPlaybookContextSkill,
  renderPlaybookMethod,
} from "../playbook-method.js";

/**
 * The stage section moved to the ONE method renderer (`playbook-method.ts`),
 * which the MCP binding doors share. Re-exported for existing importers.
 */
export { buildStageSection } from "../playbook-method.js";

const logger = createLogger({ module: "is-agent-executor" });

export class IsAgentExecutor implements Executor {
  readonly ref = "is-agent" as const;

  async run(ctx: RunContext): Promise<RunResult> {
    if (!ctx.channelId) {
      return {
        status: "failed",
        error: "is-agent executor requires a channel (runner must create one)",
      };
    }

    // AGENT SELECTOR — resolve the requested agent BEFORE writing anything, so an
    // unknown slug costs no kickoff message in the channel. Absent ⇒ null ⇒
    // triggerAutoRespond's own default ("meta", the orchestrator): the exact
    // pre-existing behaviour. Present-but-unknown ⇒ FAIL the run. Falling back to
    // "meta" here is the one thing this must never do — the user would read a
    // completed run and believe the specialist they named had answered it.
    let agentType: string | null = null;
    const requestedAgent = ctx.agentType?.trim();
    if (requestedAgent) {
      const agent = await resolveActiveAgentBySlug(requestedAgent);
      if (!agent) {
        return {
          status: "failed",
          error: `is-agent executor: unknown agent "${requestedAgent}" — no active agents row with that slug (the IS syncs its roster via POST /api/hub/agents/sync)`,
        };
      }
      agentType = agent.slug;
    }

    // Surface the bound subject so the agent knows WHAT it is working on. The id
    // lets it fetch full details via its tools; the name/profile give immediate
    // context. Omitted entirely when the run has no subject.
    const base = ctx.subjectId
      ? `[Subject: ${ctx.subjectName ?? "entity"}${
          ctx.subjectProfile ? ` · ${ctx.subjectProfile}` : ""
        } · id ${ctx.subjectId}]\n\n${ctx.goal}`
      : ctx.goal;

    // Active-stage section — surfaces the run's current stage so the agent knows
    // WHICH phase it is in and what's expected of it. Additive: when the run is
    // stageless (currentStage null/absent) or no declared stage matches, the
    // section is omitted.
    // NOTE: stage-scoped-grant ENFORCEMENT (intersecting stage.grants into the
    // resolved capability set) is a deliberate follow-up — here the stage's grant
    // ids are listed ADVISORY only.
    const stage = ctx.currentStage
      ? ctx.stages?.find((s) => s.key === ctx.currentStage)
      : undefined;

    // Layer-2 CONTEXT SKILL — the human-approved "how to run THIS playbook"
    // instruction (`loadPlaybookContextSkill`). Prepended so the agent gets the
    // HOW alongside the goal. Absent ⇒ no prefix. Non-fatal: a lookup failure
    // must never block the run.
    let contextSkill: string | null = null;
    if (ctx.playbookId) {
      try {
        contextSkill = await loadPlaybookContextSkill(ctx.playbookId);
      } catch (err) {
        // Logged because this query runs on EVERY playbook run: a persistent
        // failure would silently degrade every run otherwise.
        logger.warn(
          { err, playbookId: ctx.playbookId },
          "is-agent: context skill lookup failed (non-fatal)"
        );
      }
    }

    // THE method renderer, shared with the MCP binding doors.
    const kickoff = renderPlaybookMethod({ contextSkill, body: base, stage });

    // Post the resolved goal as a USER message — the persisted kickoff message
    // the IS responds to. Attributed to the run's acting principal, hence the
    // explicit role/authorType/userId: `insertChannelMessage` defaults to an
    // assistant/BOT/"system" author, which would misattribute the kickoff.
    //
    // No deterministic id: the runner mints a FRESH session, channel and
    // playbook_runs row on every `executeSingleRun` (run-playbook.ts §1/§2/§4),
    // so nothing in scope here is stable across a retry — a derived id would be
    // idempotency theatre. A redelivered run therefore posts a new kickoff into
    // its own new channel, which is the pre-existing behaviour.
    const { messageId } = await insertChannelMessage({
      channelId: ctx.channelId,
      content: kickoff,
      userId: ctx.userId,
      role: MessageRole.USER,
      authorType: MessageAuthorType.HUMAN,
    });
    // Only `undefined` when the insert hit a PK conflict (impossible with the
    // random id above). Fail loudly rather than handing `undefined` to
    // triggerAutoRespond, which would dispatch the IS at a message it can't load.
    if (!messageId) {
      return {
        status: "failed",
        error: "kickoff message insert conflicted — no message id to dispatch",
      };
    }

    // CANONICAL IS kickoff — the SAME pg-boss A2AI_TRIGGER path the threads REST
    // route uses (resolveIntelligenceService + getBoss().send), NOT a side-channel
    // websocket broadcast (which would never enqueue the IS → the run would hang
    // in "running" forever). Only THREAD / AGENT_COLLAB channels are IS-eligible.
    const triggered = await triggerAutoRespond({
      channelId: ctx.channelId,
      userMessageId: messageId,
      content: kickoff,
      sourceUserId: ctx.userId,
      // A resolved slug ⇒ the IS runs the turn as that named persona; else the
      // orchestrator ("meta", the door's own default) — named EXPLICITLY, because
      // this step SUMMONS the agent: a GROUP run room (channelSpec.type GROUP)
      // only wakes for a named agent, and an unnamed kickoff failed the step.
      agentType: agentType ?? "meta",
      // The run's OWN focus session, named rather than left to the door's
      // channel lookup. The IS ends the turn by closing this session's
      // playbook_run (`POST /focus-sessions/:id/complete-run`); this id is the
      // only thing on the wire that names it.
      focusSessionId: ctx.sessionId,
    });
    if (!triggered) {
      return {
        status: "failed",
        error:
          "IS auto-respond could not be triggered (channel not IS-eligible or IS unresolved)",
      };
    }

    return { status: "running", summary: "dispatched to IS in channel" };
  }
}
