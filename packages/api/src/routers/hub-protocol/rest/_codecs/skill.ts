/**
 * Skill Wire Codecs — agent skills (typed code modules).
 */

import { z } from "@hono/zod-openapi";

export const SkillStatusSchema = z
  .enum(["active", "inactive", "error", "all"])
  .openapi("SkillStatus");

export const SkillCategorySchema = z
  .enum(["action", "context", "utility", "custom"])
  .openapi("SkillCategory");

/** Wire shape of a skill row. */
export const WireSkillSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable().optional(),
    code: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    category: SkillCategorySchema.optional(),
    status: z.enum(["active", "inactive", "error"]).optional(),
    approved: z.boolean().optional(),
    workspaceId: z.string().nullable().optional(),
    createdAt: z.union([z.string(), z.date()]).optional(),
    updatedAt: z.union([z.string(), z.date()]).optional(),
  })
  .passthrough()
  .openapi("Skill");

/** GET /agent-skills/executable query (executable skills, skills table). */
export const GetSkillsQuerySchema = z
  .object({
    userId: z.string().optional(),
    workspaceId: z.string().optional(),
    status: SkillStatusSchema.optional(),
    /** When "true", return only approved skills (agent-tool loader filter). */
    approved: z.enum(["true", "false"]).optional(),
  })
  .openapi("GetSkillsQuery");

/** Legacy query codec (kept for back-compat; executable GET-by-id now uses a path param). */
export const GetSkillQuerySchema = z
  .object({
    userId: z.string().optional(),
    skillId: z.string(),
  })
  .openapi("GetSkillQuery");

/** POST /agent-skills/executable request body (create an executable skill). */
export const CreateSkillRequestSchema = z
  .object({
    userId: z.string(),
    name: z.string(),
    description: z.string().optional(),
    code: z.string(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    category: SkillCategorySchema.optional(),
    workspaceId: z.string().optional(),
  })
  .openapi("CreateSkillRequest");
