/**
 * Gov-Config Router — the human "change a governance setting" door.
 *
 * `set` / `revoke` write a `governance_rules` / `governance_ceilings` /
 * `config_settings` row DIRECTLY (no proposal — the human IS the approver),
 * routed through the ONE store-write `applyGovConfigChange` (the same function
 * the AI/cron `settings.update` proposal applies). Pod-admin only: changing
 * governance config is a pod-level decision.
 *
 * This is the API surface a future browser/relay "settings" screen calls; it
 * ships with no UI by design (the AI door and the cron recommenders already
 * file `settings.update` proposals for the human to approve).
 */

import { z } from "zod";
import { router, protectedProcedure, assertPodAdmin } from "../trpc.js";
import {
  applyGovConfigChange,
  type GovConfigSpec,
} from "../services/proposals/gov-config.js";

const STORE_ENUM = z.enum([
  "governance_rules",
  "governance_ceilings",
  "config_settings",
]);

const setInput = z.object({
  store: STORE_ENUM,
  principalKind: z.enum(["agent", "any"]).optional(),
  agentUserId: z.string().nullish(),
  scopeKind: z.enum(["pod", "workspace"]).optional(),
  workspaceId: z.string().nullish(),
  targetKind: z.enum(["action", "profile", "capability"]).optional(),
  targetPattern: z.string().optional(),
  targetProfile: z.string().nullish(),
  verdict: z.enum(["auto", "propose"]).optional(),
  axis: z.enum(["daily_write_count", "pending_proposal_cap"]).optional(),
  limitValue: z.number().optional(),
  configScopeKind: z.string().optional(),
  scopeRef: z.string().nullish(),
  capabilityId: z.string().nullish(),
  text: z.string().optional(),
  posture: z.enum(["auto", "propose"]).optional(),
});

export const govConfigRouter = router({
  set: protectedProcedure.input(setInput).mutation(async ({ ctx, input }) => {
    await assertPodAdmin(ctx.userId);
    const { store, ...spec } = input;
    return applyGovConfigChange({
      store,
      op: "set",
      spec: spec as GovConfigSpec,
      createdBy: ctx.userId,
    });
  }),

  revoke: protectedProcedure
    .input(
      z.object({
        store: STORE_ENUM,
        targetId: z.string(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await assertPodAdmin(ctx.userId);
      return applyGovConfigChange({
        store: input.store,
        op: "revoke",
        spec: { targetId: input.targetId },
        createdBy: ctx.userId,
      });
    }),
});
