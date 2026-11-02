/**
 * The ONE read door of `server_faults` (0392), behind the pod-admin floor: a
 * fault's cause names tables, routes and code paths of the whole pod, so only
 * the pod's owner and admins read it. Called by Hub `GET /api/hub/errors/:errorId`
 * and tRPC `system.listServerFaults` / `system.getServerFault` (pod admin).
 */

import { TRPCError } from "@trpc/server";
import {
  db,
  listServerFaults,
  readServerFault,
  type ServerFault,
} from "@synap/database";
import { isPodAdmin } from "../../utils/workspace-role.js";

export const SERVER_FAULTS_FORBIDDEN_MESSAGE =
  "Server errors are pod-wide: only the pod's owner and admins can read their causes.";

async function assertCanRead(userId: string): Promise<void> {
  if (!(await isPodAdmin(userId))) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: SERVER_FAULTS_FORBIDDEN_MESSAGE,
    });
  }
}

/** One fault for a pod admin; NOT_FOUND when none is stored under that id. */
export async function readServerFaultForCaller(
  userId: string,
  errorId: string
): Promise<ServerFault> {
  await assertCanRead(userId);
  const row = await readServerFault(db, errorId);
  if (!row) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `No server error is stored under ${errorId}. Faults are kept 30 days.`,
    });
  }
  return row;
}

/** The most recent faults for a pod admin, newest first. */
export async function listServerFaultsForCaller(
  userId: string,
  opts: { limit?: number; before?: Date } = {}
): Promise<ServerFault[]> {
  await assertCanRead(userId);
  return listServerFaults(db, opts);
}
