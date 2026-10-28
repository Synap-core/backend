/**
 * The pod admin's switch for sharing onboarding milestones with the Control
 * Plane (onboarding plan §5, founder OQ3: ON by default, disclosed; pod-admin
 * Settings › Privacy). What is shared: milestone ids, their times and four
 * enum properties — never content, names or text (`@synap/jobs`
 * `onboarding-milestones`). A self-hosted pod sends nothing whatever the
 * switch says (`linked: false`).
 *
 * A PERSON's act: an agent's credential acting for an admin is refused, as
 * every pod policy door refuses it.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  readControlPlaneLink,
  readOnboardingMilestonesSharing,
  setOnboardingMilestonesSharing,
} from "@synap/database";
import { router, podAdminProcedure } from "../trpc.js";
import { isAgentCaller } from "../services/library/agent-door.js";
import type { Context } from "../types/context.js";

function refuseAgentCredential(ctx: Context, act: string): void {
  if (isAgentCaller({ agentUserId: ctx.agentUserId, keyType: ctx.keyType })) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `An agent credential cannot ${act} — sign in as a pod admin.`,
    });
  }
}

export const onboardingMilestonesRouter = router({
  /** The switch, and whether this pod has a Control Plane to share with. */
  get: podAdminProcedure.query(async ({ ctx }) => {
    refuseAgentCredential(ctx, "read the milestone sharing switch");
    return {
      ...(await readOnboardingMilestonesSharing()),
      linked: (await readControlPlaneLink()) !== null,
    };
  }),

  set: podAdminProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      refuseAgentCredential(ctx, "change the milestone sharing switch");
      return {
        ...(await setOnboardingMilestonesSharing({
          enabled: input.enabled,
          changedBy: ctx.userId,
        })),
        linked: (await readControlPlaneLink()) !== null,
      };
    }),
});
