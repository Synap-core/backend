/**
 * `POST /setup/device` — the body the terminal sends (MACHINE-IDENTITY-PLAN
 * W2; 0395 adds `seat`, `seatId`, `rows`, `held`). Its own light module so the
 * wire contract is tested without the database. Every 0395 field is optional:
 * today's CLI sends none and still pairs; zod strips unknown keys, so an older
 * pod ignores them.
 */
import { z } from "zod";
import {
  SURFACE_HARNESS_SLUGS,
  isAgentRoleSlug,
  isValidSeat,
} from "@synap-core/types/agents";
import { DEVICE_MAX_AGENTS } from "@synap-core/types/device";

export const DeviceCreateBody = z.object({
  clientName: z.string().trim().min(1).max(80),
  hostname: z.string().trim().min(1).max(253),
  platform: z.string().trim().max(40).optional(),
  agents: z
    .array(z.enum(SURFACE_HARNESS_SLUGS))
    .max(DEVICE_MAX_AGENTS)
    .optional(),
  // 0395 — every field optional, so today's CLI keeps working.
  seat: z
    .string()
    .trim()
    .refine(isValidSeat, "an OS user name, without a colon or a space")
    .optional(),
  seatId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{16,128}$/, "a hex or base64url id")
    .optional(),
  rows: z
    .array(
      z.object({
        agentType: z.enum(SURFACE_HARNESS_SLUGS),
        role: z
          .string()
          .refine(isAgentRoleSlug, "a job slug: a-z, 0-9 and dashes")
          .nullish(),
        roleLabel: z.string().trim().min(1).max(80).nullish(),
      })
    )
    .max(DEVICE_MAX_AGENTS)
    .optional(),
  held: z
    .array(
      z.object({
        keyId: z.string().uuid(),
        agentUserId: z.string().min(1).max(64).nullish(),
      })
    )
    .max(32)
    .optional(),
});
