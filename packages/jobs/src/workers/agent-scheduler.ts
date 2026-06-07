/**
 * Agent Scheduler Worker
 *
 * Cron-triggered worker (every minute) that checks for due `[agent-sched]` entities
 * and executes them by calling the Intelligence Service /v1/chat/completions.
 * Results are stored as `research` entities. Replaces the manual `synap agent tick` CLI approach.
 */

import {
  db,
  eq,
  and,
  like,
  lte,
  sql,
  entities,
  profiles,
  resolveDefaultIntelligenceEndpoint,
} from "@synap/database";
import { createLogger } from "@synap-core/core";
import { randomUUID } from "crypto";

const logger = createLogger({ module: "agent-scheduler" });

export const AGENT_SCHEDULER_QUEUE = "agent-scheduler";

const IS_TIMEOUT_MS = 180_000; // 3 minutes — deep research runs

const PERSONAS: Record<string, string> = {
  researcher:
    "You are a research agent. Investigate the given goal thoroughly using all available tools (web search, URL fetch, memory recall, entity search). Capture findings as you go. When you have a complete synthesis, produce a clear final answer.",
  assistant:
    "You are a helpful assistant. Complete the given task using all available tools. Produce a clear, actionable final answer.",
  developer:
    "You are a software engineering agent. Analyze the task, recall relevant knowledge, reason carefully, and produce a technical conclusion or recommendation.",
};

interface ScheduleProperties {
  goal: string;
  persona: string;
  model: string;
  interval: string;
  intervalMs: number;
  nextRunAt: string;
  lastRunAt?: string;
  enabled: boolean;
}

interface ScheduleEntity {
  id: string;
  name: string;
  workspaceId: string | null;
  userId: string | null;
  properties: Record<string, unknown>;
}

async function callIntelligenceService(
  endpoint: string,
  apiKey: string,
  goal: string,
  persona: string,
  model: string
): Promise<string> {
  const systemPrompt = PERSONAS[persona] ?? PERSONAS["assistant"];

  const body = JSON.stringify({
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: goal },
    ],
    stream: false,
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const res = await fetch(`${endpoint}/v1/chat/completions`, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(IS_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(
      `Intelligence Service returned ${res.status} ${res.statusText}`
    );
  }

  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };

  return json?.choices?.[0]?.message?.content ?? "";
}

export async function handleAgentScheduler(): Promise<void> {
  const now = new Date();

  // Query entities whose name starts with [agent-sched], are enabled, and are due
  const due = (await db
    .select()
    .from(entities)
    .where(
      and(
        like(entities.name, "[agent-sched]%"),
        lte(sql`(${entities.properties}->>'nextRunAt')::timestamptz`, now),
        sql`(${entities.properties}->>'enabled')::boolean = true`
      )
    )
    .limit(20)) as ScheduleEntity[];

  if (due.length === 0) return;

  logger.info({ count: due.length }, "Agent scheduler: found due schedules");

  // Resolve IS endpoint once for the batch
  const { endpoint, apiKey } = await resolveDefaultIntelligenceEndpoint();

  // Look up the research profile ID once
  const researchProfile = await db.query.profiles.findFirst({
    where: eq(profiles.slug, "research"),
    columns: { id: true },
  });

  await Promise.allSettled(
    due.map(async (schedule) => {
      const props = schedule.properties as unknown as ScheduleProperties;
      const { goal, persona, model, intervalMs } = props;

      if (!goal) {
        logger.warn(
          { scheduleId: schedule.id },
          "Agent schedule missing goal — skipping"
        );
        return;
      }

      try {
        logger.debug(
          { scheduleId: schedule.id, goal: goal.slice(0, 80), persona, model },
          "Executing agent schedule"
        );

        const content = await callIntelligenceService(
          endpoint,
          apiKey,
          goal,
          persona ?? "assistant",
          model ?? "synap/advanced"
        );

        if (content && researchProfile) {
          await db.insert(entities).values({
            id: randomUUID(),
            profileId: researchProfile.id,
            name: `Agent run: ${goal.slice(0, 80)}`,
            workspaceId: schedule.workspaceId ?? null,
            userId: schedule.userId ?? null,
            properties: {
              summary: content,
              tags: ["agent-run", persona ?? "assistant"],
              status: "concluded",
            },
            createdAt: new Date(),
            updatedAt: new Date(),
          });
        } else if (content) {
          logger.info(
            { scheduleId: schedule.id, contentLength: content.length },
            "Agent run complete — research profile not found, result not stored"
          );
        }

        // Update nextRunAt and lastRunAt on the schedule entity
        const newProps: ScheduleProperties = {
          ...(props as ScheduleProperties),
          lastRunAt: now.toISOString(),
          nextRunAt: new Date(
            now.getTime() + (intervalMs ?? 3_600_000)
          ).toISOString(),
        };

        await db
          .update(entities)
          .set({
            properties:
              newProps as unknown as (typeof entities.$inferInsert)["properties"],
            updatedAt: new Date(),
          })
          .where(eq(entities.id, schedule.id));

        logger.info(
          { scheduleId: schedule.id, goal: goal.slice(0, 80) },
          "Agent schedule run complete"
        );
      } catch (err) {
        logger.warn(
          { err, scheduleId: schedule.id, goal: goal?.slice(0, 80) },
          "Agent schedule execution failed — continuing"
        );
      }
    })
  );

  logger.info({ total: due.length }, "Agent scheduler run complete");
}
