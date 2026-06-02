/**
 * Hermes Trigger Worker
 *
 * Cron worker (every 60s). Multi-phase agentic pipeline for devplane_feature entities.
 *
 * Phases (worker dispatches each automatically):
 *   gathering_context → planning → [human: plan_ready] → executing → verifying → [human: awaiting_review]
 *   debugging → verifying (retry loop)
 *
 * Human gates: plan_ready, awaiting_review
 * Terminal states: done, error
 *
 * Skips entirely if HERMES_TRIGGER_URL is not set.
 */

import { db, entities, eq, and } from "@synap/database";
import { relations as entityRelations } from "@synap/database/schema";
import { sql } from "drizzle-orm";
import { createLogger } from "@synap-core/core";

const logger = createLogger({ module: "hermes-trigger-worker" });

export const HERMES_TRIGGER_QUEUE = "hermes-trigger";

// Hermes handles entity-only phases (no file system access required).
// Code execution phases (executing / verifying / debugging) are handled
// by the Eve CodexFeaturePoller daemon via T3 Code + Codex.
type AgentPhase = "gathering_context" | "planning";

const PHASE_TIMEOUTS_MS: Record<AgentPhase, number> = {
  gathering_context: 5 * 60 * 1000,
  planning: 8 * 60 * 1000,
};

function buildSystemPrompt(
  phase: AgentPhase,
  featureId: string,
  channelId?: string
): string {
  const channelLine = channelId
    ? `Feature channel ID: ${channelId} — post a message when done using synap_post_message({ channelId: "${channelId}", content: "…" }).`
    : "";

  const update = (props: Record<string, string>) =>
    `synap_entity_update({ entityId: "${featureId}", properties: ${JSON.stringify(props, null, 2)} })`;

  switch (phase) {
    case "gathering_context":
      return [
        "You are a software developer enriching a feature specification before planning.",
        `Feature entity ID: ${featureId}`,
        channelLine,
        "",
        "Tasks:",
        "1. Read this feature and all linked app/package context via Synap MCP tools.",
        "2. Enrich the spec: write a clear description, acceptance criteria (bullet list), and technical notes.",
        "3. Identify which packages/files are likely affected.",
        "",
        "When done call:",
        update({
          description: "<improved description>",
          acceptance_criteria: "<- criterion 1\\n- criterion 2>",
          technical_notes: "<relevant technical details>",
          agent_status: "planning",
        }),
      ]
        .filter(Boolean)
        .join("\n");

    case "planning":
      return [
        "You are a software developer writing an implementation plan for a feature.",
        `Feature entity ID: ${featureId}`,
        channelLine,
        "",
        "Tasks:",
        "1. Read the enriched spec: description, acceptance_criteria, technical_notes from the entity properties.",
        "2. Write a clear step-by-step implementation plan with concrete deliverables per step.",
        "",
        "When done:",
        channelId ? `1. Post a plan summary to the feature channel.` : "",
        `${channelId ? "2" : "1"}. Call: ${update({ plan: "<# Implementation Plan\\n\\n## Steps\\n1. …>", agent_status: "plan_ready" })}`,
      ]
        .filter(Boolean)
        .join("\n");
  }
}

function buildUserMessage(
  phase: AgentPhase,
  feature: { title?: string | null; properties: unknown },
  appInfo: {
    title?: string | null;
    repoUrl?: unknown;
    techStack?: unknown;
  } | null
): string {
  const props = (feature.properties ?? {}) as Record<string, unknown>;
  const lines: string[] = [`## Feature: ${feature.title ?? "Untitled"}`];

  if (props.featureStatus) lines.push(`Status: ${props.featureStatus}`);
  if (props.priority) lines.push(`Priority: ${props.priority}`);

  if (appInfo) {
    lines.push("", `### Linked App: ${appInfo.title ?? ""}`);
    if (appInfo.repoUrl) lines.push(`- Repo: ${appInfo.repoUrl}`);
    if (appInfo.techStack) {
      const stack = Array.isArray(appInfo.techStack)
        ? appInfo.techStack.join(", ")
        : String(appInfo.techStack);
      lines.push(`- Stack: ${stack}`);
    }
  }

  if (phase === "gathering_context") {
    const prompt =
      (props.task_prompt as string | undefined) ??
      (props.description as string | undefined);
    if (prompt) lines.push("", `### Goal`, "", prompt);
  }

  if (phase === "planning" && props.description) {
    lines.push("", `### Description`, "", String(props.description));
  }
  if (phase === "planning" && props.acceptance_criteria) {
    lines.push(
      "",
      `### Acceptance Criteria`,
      "",
      String(props.acceptance_criteria)
    );
  }
  if (phase === "planning" && props.technical_notes) {
    lines.push("", `### Technical Notes`, "", String(props.technical_notes));
  }

  return lines.join("\n");
}

export async function handleHermesTrigger(): Promise<void> {
  const hermesUrl = process.env.HERMES_TRIGGER_URL?.replace(/\/$/, "");
  if (!hermesUrl) return;

  const hermesKey = process.env.HERMES_TRIGGER_KEY ?? "";

  // ── 1. Timeout detection: dispatched too long → error ─────────────────────
  const dispatchedFeatures = await db
    .select()
    .from(entities)
    .where(
      and(
        eq(entities.type, "devplane_feature"),
        sql`${entities.properties}->>'agent_status' = 'dispatched'`,
        sql`${entities.properties}->>'dispatched_at' IS NOT NULL`,
        // Only time out Hermes phases — code phases are timed out by the Eve CodexFeaturePoller
        sql`${entities.properties}->>'agent_phase' = ANY(ARRAY['gathering_context','planning']::text[])`
      )
    )
    .limit(20);

  for (const feature of dispatchedFeatures) {
    const props = (feature.properties ?? {}) as Record<string, unknown>;
    const phase = props.agent_phase as AgentPhase | undefined;
    const dispatchedAt = props.dispatched_at as string | undefined;
    if (!phase || !dispatchedAt) continue;

    const timeoutMs = PHASE_TIMEOUTS_MS[phase] ?? 15 * 60 * 1000;
    const age = Date.now() - new Date(dispatchedAt).getTime();
    if (age > timeoutMs) {
      await db
        .update(entities)
        .set({
          properties: sql`${entities.properties} || ${JSON.stringify({ agent_status: "error", error_reason: `${phase}_timeout` })}::jsonb`,
          updatedAt: new Date(),
        })
        .where(eq(entities.id, feature.id));
      logger.warn(
        { featureId: feature.id, phase, ageMin: Math.round(age / 60000) },
        "Phase timed out"
      );
    }
  }

  // ── 2. Dispatch features ready for each phase ──────────────────────────────
  const readyFeatures = await db
    .select()
    .from(entities)
    .where(
      and(
        eq(entities.type, "devplane_feature"),
        sql`${entities.properties}->>'agent_status' = ANY(ARRAY['gathering_context','planning']::text[])`
      )
    )
    .limit(5);

  if (readyFeatures.length === 0) {
    logger.debug("No features awaiting dispatch");
    return;
  }

  logger.info(
    { count: readyFeatures.length },
    "Dispatching features to Hermes"
  );

  for (const feature of readyFeatures) {
    const props = (feature.properties ?? {}) as Record<string, unknown>;
    const phase = props.agent_status as AgentPhase;

    try {
      // Load related app
      const [rel] = await db
        .select({ targetEntityId: entityRelations.targetEntityId })
        .from(entityRelations)
        .where(
          and(
            eq(entityRelations.sourceEntityId, feature.id),
            eq(entityRelations.type, "belongs_to")
          )
        )
        .limit(1);

      let appInfo: {
        title?: string | null;
        repoUrl?: unknown;
        techStack?: unknown;
      } | null = null;
      if (rel?.targetEntityId) {
        const [app] = await db
          .select()
          .from(entities)
          .where(eq(entities.id, rel.targetEntityId))
          .limit(1);
        if (app) {
          const p = (app.properties ?? {}) as Record<string, unknown>;
          appInfo = {
            title: app.title,
            repoUrl: p.repoUrl,
            techStack: p.techStack,
          };
        }
      }

      const channelId = props.entityChannelId as string | undefined;
      const systemPrompt = buildSystemPrompt(phase, feature.id, channelId);
      const userMessage = buildUserMessage(phase, feature, appInfo);

      // Mark dispatched before firing so cron doesn't double-dispatch
      await db
        .update(entities)
        .set({
          properties: sql`${entities.properties} || ${JSON.stringify({
            agent_status: "dispatched",
            agent_phase: phase,
            dispatched_at: new Date().toISOString(),
          })}::jsonb`,
          updatedAt: new Date(),
        })
        .where(eq(entities.id, feature.id));

      // Fire-and-forget — Hermes runs async and updates status via MCP when done
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);

      fetch(`${hermesUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(hermesKey ? { Authorization: `Bearer ${hermesKey}` } : {}),
        },
        body: JSON.stringify({
          model: "default",
          stream: false,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage },
          ],
        }),
        signal: controller.signal,
      })
        .then(() => clearTimeout(timeout))
        .catch((err) => {
          clearTimeout(timeout);
          // AbortError after 8s is expected — Hermes keeps running on its side
          if ((err as Error)?.name !== "AbortError") {
            logger.warn(
              { featureId: feature.id, phase, err },
              "Hermes POST failed"
            );
          }
        });

      logger.info(
        { featureId: feature.id, phase, title: feature.title },
        "Feature dispatched"
      );
    } catch (err) {
      logger.error(
        { featureId: feature.id, phase, err },
        "Failed to dispatch feature"
      );
    }
  }
}
