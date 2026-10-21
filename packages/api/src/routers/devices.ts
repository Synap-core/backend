/**
 * Devices router — "Signed-in devices": the Synap apps (desktop, Relay) a
 * person signed in through the pod's own OAuth server (join plan target A).
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
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  router,
  protectedProcedure,
  credentialProcedure,
} from "../trpc.js";
import { auditLog } from "../utils/audit-log.js";
import { assertSignedInPerson } from "../utils/signed-in-person.js";
import { checkPermissionOrPropose } from "../utils/permission-check.js";
import {
  listPersonDevices,
  revokeOwnPersonDevice,
} from "../services/person-device-token.js";

const DEVICES_SIGNED_IN = "Manage your signed-in devices while signed in.";

export const devicesRouter = router({
  /** The person's live devices, newest first; `current` = this request's. */
  list: protectedProcedure.query(async ({ ctx }) => {
    assertSignedInPerson(ctx, DEVICES_SIGNED_IN);
    const current = ctx.session?.device?.id ?? null;
    const devices = await listPersonDevices(ctx.userId);
    return devices.map((d) => ({ ...d, current: d.id === current }));
  }),

  /** Sign one of the person's devices out (this one included). */
  revoke: credentialProcedure
    .input(z.object({ deviceId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      assertSignedInPerson(ctx, DEVICES_SIGNED_IN);
      const perm = await checkPermissionOrPropose({
        userId: ctx.userId,
        subjectType: "apiKey",
        action: "delete",
        data: { personDeviceId: input.deviceId },
      });
      if ("denied" in perm && perm.denied)
        throw new TRPCError({ code: "FORBIDDEN", message: perm.reason });
      if ("proposalId" in perm)
        return { status: "proposed" as const, proposalId: perm.proposalId };

      const ended = await revokeOwnPersonDevice({
        userId: ctx.userId,
        deviceId: input.deviceId,
      });
      if (!ended) {
        // Not theirs, unknown, or already signed out: one answer for all.
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "No signed-in device with this id.",
        });
      }
      void auditLog({
        subjectType: "apiKey",
        action: "revoke",
        phase: "completed",
        subjectId: input.deviceId,
        userId: ctx.userId,
        workspaceId: null,
        data: { kind: "person_device_revoke" },
      });
      return { status: "revoked" as const };
    }),
});
