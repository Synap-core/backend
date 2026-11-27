/**
 * Hub Protocol REST — a computer describes itself (devices plan 767a5978 §3,
 * P1; decision 78fc3fa1).
 *
 *   POST /computers/me/report  { manifest? } → { device: DeviceReportAck }
 *
 * The runner sends its device manifest (v1, `@synap-core/types/
 * device-manifest`) right after `synap login` and whenever it starts; the
 * pod stores it on the computer's device and moves its report time. The same
 * manifest also rides every `POST /host-jobs/lease`, but that door needs
 * "Installs from the pod" (`host.runner`): this one is every computer's.
 *
 * WHO MAY CALL: a COMPUTER (`users.agent_type = 'machine'`, the device-flow
 * key) of its own person, on a device session that is not stale, holding
 * `hub-protocol.write` (every computer key holds it). Any other key — a
 * person's, an agent's (even one hosted on the computer), an app's — is
 * refused `NOT_A_COMPUTER` before a row is read. It writes ONE row: the
 * calling computer's own device; no body field names another.
 *
 * ANSWERS: 200 with what was recorded (`manifest`: accepted, absent, or
 * refused with the field that failed in `error`; a refused manifest keeps
 * the last good one); 503 when the pod could not record the report.
 */

import { and, db, eq } from "@synap/database";
import { users } from "@synap/database/schema";
import { MACHINE_AGENT_TYPE } from "@synap-core/types/agents";
import { z } from "@hono/zod-openapi";
import { hasScope, refuseStaleDeviceSession, type HubHono } from "./_shared.js";
import { registerOpenApi } from "./_codecs/_register.js";
import { ErrorSchema } from "./_codecs/_openapi.js";
import { recordDeviceReport } from "../../../services/fleet/devices.js";

/** What the pod recorded of one report (`DeviceReportAck`). */
export const DeviceReportAckSchema = z
  .object({
    recorded: z.boolean(),
    deviceId: z.string().nullable(),
    manifest: z.enum(["accepted", "absent", "refused"]),
    error: z.string().optional(),
  })
  .openapi("DeviceReportAck");

const ReportBodySchema = z
  .object({
    /** The device manifest v1; checked by the registry, not here. */
    manifest: z.unknown().optional(),
    /**
     * Which process reports (`waker`, `worker`, `host`, `login`; a-z, 0-9,
     * dashes): its capabilities are kept apart from the other processes'.
     * Absent or malformed: `runner`.
     */
    reporter: z.string().optional(),
  })
  .openapi("ComputerReportBody");

type Refusal = {
  ok: false;
  status: 401 | 403;
  code: string;
  error: string;
};

/**
 * The calling key's own computer, or the refusal: a computer principal of
 * its own person, holding `hub-protocol.write`. Every other principal is
 * `NOT_A_COMPUTER` (403).
 */
export async function resolveComputerSelf(c: {
  get: (k: "scopes" | "agentUserId" | "userId") => unknown;
}): Promise<{ ok: true; machineUserId: string } | Refusal> {
  const scopes = (c.get("scopes") as string[] | undefined) ?? [];
  if (!hasScope(scopes, "hub-protocol.write"))
    return {
      ok: false,
      status: 403,
      code: "SCOPE_REQUIRED",
      error: "Insufficient scope: hub-protocol.write required",
    };
  const agentUserId = c.get("agentUserId") as string | undefined;
  const userId = c.get("userId") as string | undefined;
  if (!userId)
    return {
      ok: false,
      status: 401,
      code: "UNAUTHORIZED",
      error: "Unauthorized",
    };
  const [machine] = agentUserId
    ? await db
        .select({ id: users.id, owner: users.createdByUserId })
        .from(users)
        .where(
          and(
            eq(users.id, agentUserId),
            eq(users.agentType, MACHINE_AGENT_TYPE)
          )
        )
        .limit(1)
    : [];
  if (!machine || !machine.owner || machine.owner !== userId)
    return {
      ok: false,
      status: 403,
      code: "NOT_A_COMPUTER",
      error: "Only a connected computer's own key reports what it is.",
    };
  return { ok: true, machineUserId: machine.id };
}

export function registerComputerReportRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "post",
    path: "/computers/me/report",
    tags: ["Computers"],
    summary: "A computer reports what it is (its device manifest)",
    description:
      "A connected computer's own key only (the device-flow key). Merges `manifest` (the device manifest v1, optional) into the computer's device, section by section, and moves its report time. `reporter` names the process (its capabilities are kept apart from the other processes' and expire 30 minutes after its last report). A manifest the pod cannot read is answered `manifest: \"refused\"` with the field in `error`, and the last good one is kept.",
    request: { body: ReportBodySchema },
    responses: {
      200: {
        description: "What was recorded",
        schema: z.object({ device: DeviceReportAckSchema }),
      },
      400: { description: "The body is not JSON", schema: ErrorSchema },
      401: { description: "Unauthorized", schema: ErrorSchema },
      403: {
        description: "Not this computer's own key, or no hub-protocol.write",
        schema: ErrorSchema,
      },
      503: { description: "The report was not recorded", schema: ErrorSchema },
    },
  });
  app.post("/computers/me/report", async (c) => {
    const stale = refuseStaleDeviceSession(c);
    if (stale) return stale;
    const who = await resolveComputerSelf(c);
    if (!who.ok) return c.json({ code: who.code, error: who.error }, who.status);
    let body: unknown = {};
    const text = await c.req.text();
    if (text.trim() !== "") {
      try {
        body = JSON.parse(text);
      } catch {
        return c.json(
          { code: "BAD_REQUEST", error: "body is not valid JSON" },
          400
        );
      }
    }
    const fields =
      body && typeof body === "object"
        ? (body as { manifest?: unknown; reporter?: unknown })
        : {};
    const device = await recordDeviceReport({
      machineUserId: who.machineUserId,
      manifest: fields.manifest,
      reporter:
        typeof fields.reporter === "string" ? fields.reporter : undefined,
    });
    if (!device.recorded)
      return c.json(
        {
          code: "NOT_RECORDED",
          error: device.error ?? "The report was not recorded.",
          device,
        },
        503
      );
    return c.json({ device }, 200);
  });
}
