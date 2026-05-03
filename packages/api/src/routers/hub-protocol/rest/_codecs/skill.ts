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
    workspaceId: z.string().nullable().optional(),
    createdAt: z.union([z.string(), z.date()]).optional(),
    updatedAt: z.union([z.string(), z.date()]).optional(),
  })
  .passthrough()
  .openapi("Skill");

/** GET /skills/getSkills query. */
export const GetSkillsQuerySchema = z
  .object({
    userId: z.string().optional(),
    workspaceId: z.string().optional(),
    status: SkillStatusSchema.optional(),
  })
  .openapi("GetSkillsQuery");

/** GET /skills/getSkill query. */
export const GetSkillQuerySchema = z
  .object({
    userId: z.string().optional(),
    skillId: z.string(),
  })
  .openapi("GetSkillQuery");

/** POST /skills/createSkill request body. */
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
