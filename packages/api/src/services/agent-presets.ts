/**
 * PRESETS per agent (B6, plan v2 §4): a stored, named way an agent runs for a
 * purpose (a role: reviewer, video editor). Prior art: Raycast presets, Zed
 * ACP agent servers. Roles START as presets (decision 5e7c77dc); a role that
 * needs its own grants is its own agent.
 *
 * A preset is a row of `agent_configs` (0390), the one store for per-agent
 * configuration: `prompt_append` holds its instructions, `model_override` and
 * `provider_override` its DEFAULT model and provider (what a run used stays a
 * per-run fact, 0389), `skill_slugs` the skills it loads. Its harness and its
 * computer are the agent's own row (`agent_type`, `host_user_id`), never
 * stored again, so the command that opens it is the harness's launch template
 * rendered by the pod (`resolveAgentLaunch`), with the preset's model.
 *
 * Who: reading is the agent's owner (the person, or any of their agent keys,
 * the worker included) or a pod admin. Writing is the person's act, like the
 * agent's governance and assignment doors; the route refuses agent credentials
 * before it calls here. A computer (`machine`) takes no preset.
 */

import { z } from "zod";
import { and, asc, db as defaultDb, eq, isNotNull } from "@synap/database";
import { agentConfigs, users } from "@synap/database/schema";
import {
  MACHINE_AGENT_TYPE,
  MODEL_PROVIDERS,
  parseReportedModel,
  resolveAgentLaunch,
  type AgentLaunchRef,
  type ModelProviderSlug,
} from "@synap-core/types/agents";
import { SKILL_SLUG_PATTERN } from "./skills/skill-authoring.js";

type Db = typeof defaultDb;

/** A preset's key: a short slug, unique per agent. */
export const PRESET_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** The longest instructions a preset keeps. */
export const PRESET_INSTRUCTIONS_MAX = 8000;
/** The most skills one preset loads. */
export const PRESET_SKILLS_MAX = 20;

/** Providers a preset may default to: a listed one, never the `other` bucket. */
const PRESET_PROVIDERS = MODEL_PROVIDERS.map((p) => p.slug).filter(
  (s) => s !== "other"
) as [ModelProviderSlug, ...ModelProviderSlug[]];

export const AgentPresetBodySchema = z
  .object({
    label: z.string().trim().min(1).max(80),
    instructions: z.string().max(PRESET_INSTRUCTIONS_MAX).nullable().optional(),
    model: z
      .string()
      .nullable()
      .optional()
      .refine(
        (m) =>
          m == null || m.trim() === "" || parseReportedModel(m) === m.trim(),
        {
          message:
            "model must be a model id as the harness names it (e.g. claude-opus-5-5): letters, digits and . _ : / @ [ ] -",
        }
      ),
    provider: z.enum(PRESET_PROVIDERS).nullable().optional(),
    skills: z
      .array(
        z
          .string()
          .regex(
            SKILL_SLUG_PATTERN,
            "each skill is a slug, e.g. 'system/synap/capture'"
          )
      )
      .max(PRESET_SKILLS_MAX)
      .optional(),
  })
  .strict();
export type AgentPresetBody = z.infer<typeof AgentPresetBodySchema>;

export interface AgentPreset {
  key: string;
  label: string;
  instructions: string | null;
  model: string | null;
  provider: string | null;
  skills: string[];
  /** The command that opens the agent with this preset's model, or null. */
  open: AgentLaunchRef | null;
  updatedAt: string;
}

/** Why a preset call was refused, as the route's status and code. */
export class AgentPresetError extends Error {
  constructor(
    readonly status: 400 | 403 | 404,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

interface PresetAgent {
  id: string;
  agentType: string | null;
  createdByUserId: string | null;
}

async function loadAgent(db: Db, agentUserId: string): Promise<PresetAgent> {
  const [agent] = await db
    .select({
      id: users.id,
      agentType: users.agentType,
      createdByUserId: users.createdByUserId,
    })
    .from(users)
    .where(and(eq(users.id, agentUserId), eq(users.userType, "agent")))
    .limit(1);
  if (!agent) throw new AgentPresetError(404, "NOT_FOUND", "Agent not found");
  return agent;
}

function assertOwner(
  agent: PresetAgent,
  callerId: string,
  callerIsPodAdmin: boolean,
  verb: "read" | "change"
): void {
  if (agent.createdByUserId === callerId || callerIsPodAdmin) return;
  throw new AgentPresetError(
    403,
    "NOT_OWNER",
    `Only the agent's owner or a pod admin can ${verb} its presets`
  );
}

function toPreset(
  agentType: string | null,
  row: typeof agentConfigs.$inferSelect
): AgentPreset {
  return {
    key: row.presetKey!,
    label: row.presetLabel ?? row.presetKey!,
    instructions: row.promptAppend,
    model: row.modelOverride,
    provider: row.providerOverride,
    skills: row.skillSlugs,
    open: resolveAgentLaunch({ agentType, model: row.modelOverride }),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** An agent's presets, by key. */
export async function listAgentPresets(input: {
  agentUserId: string;
  callerId: string;
  callerIsPodAdmin: boolean;
  db?: Db;
}): Promise<AgentPreset[]> {
  const db = input.db ?? defaultDb;
  const agent = await loadAgent(db, input.agentUserId);
  assertOwner(agent, input.callerId, input.callerIsPodAdmin, "read");
  const rows = await db
    .select()
    .from(agentConfigs)
    .where(
      and(eq(agentConfigs.userId, agent.id), isNotNull(agentConfigs.presetKey))
    )
    .orderBy(asc(agentConfigs.presetKey));
  return rows.map((r) => toPreset(agent.agentType, r));
}

/** Create or replace one preset (the whole preset: an omitted field clears). */
export async function putAgentPreset(input: {
  agentUserId: string;
  presetKey: string;
  body: AgentPresetBody;
  callerId: string;
  callerIsPodAdmin: boolean;
  db?: Db;
}): Promise<AgentPreset> {
  const db = input.db ?? defaultDb;
  if (!PRESET_KEY_PATTERN.test(input.presetKey)) {
    throw new AgentPresetError(
      400,
      "INVALID_PRESET_KEY",
      "A preset key is a lowercase slug of up to 40 characters, e.g. 'reviewer'"
    );
  }
  const agent = await loadAgent(db, input.agentUserId);
  assertOwner(agent, input.callerId, input.callerIsPodAdmin, "change");
  if (agent.agentType === MACHINE_AGENT_TYPE || !agent.agentType) {
    throw new AgentPresetError(
      400,
      "NOT_A_HARNESS",
      "A computer takes no preset: give the preset to an agent that runs on it"
    );
  }
  const fields = {
    presetLabel: input.body.label,
    promptAppend: input.body.instructions?.trim() || null,
    modelOverride: input.body.model?.trim() || null,
    providerOverride: input.body.provider ?? null,
    skillSlugs: [...new Set(input.body.skills ?? [])],
    updatedAt: new Date(),
  };
  const [row] = await db
    .insert(agentConfigs)
    .values({
      userId: agent.id,
      workspaceId: null,
      agentType: agent.agentType,
      presetKey: input.presetKey,
      ...fields,
    })
    .onConflictDoUpdate({
      target: [agentConfigs.userId, agentConfigs.presetKey],
      targetWhere: isNotNull(agentConfigs.presetKey),
      set: fields,
    })
    .returning();
  return toPreset(agent.agentType, row!);
}

/** Remove one preset; false when the agent had none by that key. */
export async function deleteAgentPreset(input: {
  agentUserId: string;
  presetKey: string;
  callerId: string;
  callerIsPodAdmin: boolean;
  db?: Db;
}): Promise<boolean> {
  const db = input.db ?? defaultDb;
  const agent = await loadAgent(db, input.agentUserId);
  assertOwner(agent, input.callerId, input.callerIsPodAdmin, "change");
  const gone = await db
    .delete(agentConfigs)
    .where(
      and(
        eq(agentConfigs.userId, agent.id),
        eq(agentConfigs.presetKey, input.presetKey)
      )
    )
    .returning({ id: agentConfigs.id });
  return gone.length > 0;
}
