/**
 * Devices router — "Signed-in apps": the Synap apps (desktop, Relay) a person
 * signed in through the pod's own OAuth server.
 *
 * Each row is a `person_devices` row — one sign-in, one refresh family — made
 * by the one mint door (`services/person-device-token.ts`). The person sees
 * THEIR devices and signs any of them out; the device making the request is
 * marked `current`. Signing out ends the device at once: its access token stops
 * on the next request and its refresh token is dead.
 *
 * Every act is a PERSON's, signed in (a Kratos session or a device token): a
 * key — an agent's, a computer's, a person's own API key — never lists or ends
 * a sign-in. Ownership is read off the loaded row, never off the request.
 * Signing out only takes access away, so it is never a proposal.
 */

import { z } from "zod";
import { personDeviceTokens } from "@synap/database/schema";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "../trpc.js";
import { auditLog } from "../utils/audit-log.js";
import { assertSignedInPerson } from "../utils/signed-in-person.js";
import { assertFreshAuthentication } from "../utils/device-session.js";
import {
  listPersonDevices,
  revokeOwnPersonDevice,
} from "../services/person-device-token.js";

const DEVICES_SIGNED_IN = "Manage your signed-in apps while signed in.";

export const devicesRouter = router({
  /** The person's live devices, newest first; `current` = this request's. */
  list: protectedProcedure.query(async ({ ctx }) => {
    assertSignedInPerson(ctx, DEVICES_SIGNED_IN);
    const current = ctx.session?.device?.id ?? null;
    const devices = await listPersonDevices(ctx.userId);
    return devices.map((d) => ({ ...d, current: d.id === current }));
  }),

  /**
   * Sign one of the person's devices out. An app signing ITSELF out needs
   * nothing more; signing ANOTHER device out from an app needs a recent real
   * sign-in (a stolen token must not be able to sign the person's other
   * devices out), which a browser session always has.
   */
  revoke: protectedProcedure
    .input(z.object({ deviceId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      assertSignedInPerson(ctx, DEVICES_SIGNED_IN);
      if (ctx.session?.device?.id !== input.deviceId) {
        assertFreshAuthentication(ctx);
      }
      const ended = await revokeOwnPersonDevice({
        userId: ctx.userId,
        deviceId: input.deviceId,
      });
      if (!ended) {
        // Not theirs, unknown, or already signed out: one answer for all.
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No signed-in app with this id.",
        });
      }
      void auditLog({
        subjectType: "person_device",
        action: "revoke",
        phase: "completed",
        subjectId: input.deviceId,
        userId: ctx.userId,
        workspaceId: null,
        data: { self: ctx.session?.device?.id === input.deviceId },
      });
      return { status: "revoked" as const };
    }),
});

export const _second = (db: any, t: any) =>
  db.insert(personDeviceTokens).values(t);
