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

import { randomUUID } from "node:crypto";
import {
  getDb,
  messages,
  computeMessageHash,
  skills,
  links,
  eq,
  and,
} from "@synap/database";
import { MessageRole } from "@synap/database/schema";
import { triggerAutoRespond } from "../../../utils/trigger-auto-respond.js";
import type { Executor, RunContext, RunResult } from "@synap/playbooks";

export class IsAgentExecutor implements Executor {
  readonly ref = "is-agent" as const;

  async run(ctx: RunContext): Promise<RunResult> {
    if (!ctx.channelId) {
      return {
        status: "failed",
        error: "is-agent executor requires a channel (runner must create one)",
      };
    }

    const db = await getDb();

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
    // stageless (currentStage null/absent) or no declared stage matches, this
    // section is omitted and the kickoff is exactly `base`.
    // NOTE: stage-scoped-grant ENFORCEMENT (intersecting stage.grants into the
    // resolved capability set) is a deliberate follow-up — here the stage's grant
    // ids are listed ADVISORY only.
    const stage = ctx.currentStage
      ? ctx.stages?.find((s) => s.key === ctx.currentStage)
      : undefined;
    let stageSection = "";
    if (stage) {
      const lines = [`## Current stage: ${stage.name}`];
      if (stage.goal) lines.push(stage.goal);
      if (stage.expectedOutputs?.length) {
        lines.push(
          `Expected outputs: ${stage.expectedOutputs
            .map((o) => o.label)
            .join(", ")}`
        );
      }
      if (stage.suggestedTasks?.length) {
        lines.push(`Suggested tasks: ${stage.suggestedTasks.join(", ")}`);
      }
      if (stage.grants?.length) {
        lines.push(
          `Capabilities available at this stage: ${stage.grants
            .map((g) => g.id)
            .join(", ")}`
        );
      }
      stageSection = `\n\n${lines.join("\n")}`;
    }

    // Layer-2 CONTEXT SKILL — the AI-generated "how to run THIS playbook"
    // instruction, linked to the playbook via a non-grant `documents` edge (kept
    // out of the grantable/runnable set on purpose). Prepended to the kickoff so
    // the agent gets the HOW alongside the goal. Absent ⇒ no prefix. Non-fatal:
    // a lookup failure must never block the run.
    let contextPrefix = "";
    if (ctx.playbookId) {
      try {
        const [ctxSkill] = await db
          .select({ body: skills.body })
          .from(links)
          .innerJoin(skills, eq(skills.id, links.toId))
          .where(
            and(
              eq(links.fromType, "playbook"),
              eq(links.fromId, ctx.playbookId),
              eq(links.linkType, "documents"),
              eq(links.toType, "skill"),
              eq(skills.kind, "instruction")
            )
          )
          .limit(1);
        if (ctxSkill?.body?.trim()) {
          contextPrefix = `## How to run this playbook\n${ctxSkill.body.trim()}\n\n`;
        }
      } catch {
        // best-effort — fall through with no context prefix
      }
    }

    const kickoff = `${contextPrefix}${base}${stageSection}`;

    // Post the resolved goal as a USER message — the persisted kickoff message
    // the IS responds to. Attributed to the run's acting principal.
    const messageId = randomUUID();
    const hash = computeMessageHash(messageId, kickoff);

    await db.insert(messages).values({
      id: messageId,
      channelId: ctx.channelId,
      role: MessageRole.USER,
      content: kickoff,
      userId: ctx.userId,
      previousHash: "",
      hash,
    });

    // CANONICAL IS kickoff — the SAME pg-boss A2AI_TRIGGER path the threads REST
    // route uses (resolveIntelligenceService + getBoss().send), NOT a side-channel
    // websocket broadcast (which would never enqueue the IS → the run would hang
    // in "running" forever). Only THREAD / AGENT_COLLAB channels are IS-eligible.
    const triggered = await triggerAutoRespond({
      channelId: ctx.channelId,
      userMessageId: messageId,
      content: kickoff,
      sourceUserId: ctx.userId,
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
