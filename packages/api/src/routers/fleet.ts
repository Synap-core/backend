/**
 * Fleet router — the Devices page (devices plan 767a5978 §4, P1; decision
 * 78fc3fa1). "Devices" is the product word; `fleet` is the namespace because
 * the `devices` router already names the signed-in apps (`person_devices`).
 *
 * Read-only in P1. A person reads their own devices and the shared devices
 * of their spaces, through the access layer (the `devices` rule in
 * `access/registry.ts`), the same owner floor as `machines.list`. Status is
 * the read verdict `deriveDeviceStatus` (online, offline, degraded, unknown),
 * never stored.
 *
 *   fleet.list({ includeRetired? }) → { devices: FleetDeviceNode[] }
 *     the tree: each device under the one it runs on (host → VM →
 *     container); a device whose parent the reader cannot see is a root.
 *   fleet.get({ id }) → FleetDeviceDetail (with the whole manifest), or
 *     NOT_FOUND for a device the reader cannot see.
 */

import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, protectedProcedure } from "../trpc.js";
import { AccessContext } from "../access/index.js";
import {
  getFleetDevice,
  readFleetTree,
} from "../services/fleet/devices.js";

export const fleetRouter = router({
  list: protectedProcedure
    .input(z.object({ includeRetired: z.boolean().optional() }).optional())
    .query(async ({ ctx, input }) => ({
      devices: await readFleetTree(AccessContext.from(ctx), {
        includeRetired: input?.includeRetired === true,
      }),
    })),

  get: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const device = await getFleetDevice(AccessContext.from(ctx), input.id);
      if (!device)
        throw new TRPCError({ code: "NOT_FOUND", message: "No such device." });
      return device;
    }),
});
