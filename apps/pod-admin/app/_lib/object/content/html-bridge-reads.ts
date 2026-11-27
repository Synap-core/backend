/**
 * The console's tRPC client as the frame hosts hold it. A frame's reads go
 * through the pod's ONE frame read door (`frame-read-door.ts` →
 * `surfaces.frameRead`), which maps each op to its procedure server-side.
 */

import type { trpc } from "../../../../lib/trpc";

/** The console's vanilla tRPC client (`trpc.useUtils().client`). */
export type BridgeClient = ReturnType<typeof trpc.useUtils>["client"];
