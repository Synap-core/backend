/**
 * Hub Protocol REST — the device door, terminal side (MACHINE-IDENTITY-PLAN
 * W2 §4, RFC 8628). Both routes are UNAUTHENTICATED by design (the terminal has
 * no credential yet — that is what it is asking for) and listed in the hub
 * auth skip list and the idempotency skip list (they return one-shot secrets).
 * Creation is budgeted per IP at the pod edge (rate class `device_auth`).
 *
 *   POST /setup/device        {clientName, hostname, platform?, agents?}
 *     → 200 {device_code, user_code, verification_uri,
 *            verification_uri_complete, expires_in: 600, interval: 5}
 *   POST /setup/device/token  {device_code}  (JSON or form; `grant_type`
 *                              `urn:ietf:params:oauth:grant-type:device_code`
 *                              accepted and ignored)
 *     → 400 {error: authorization_pending|slow_down|access_denied|
 *            expired_token|invalid_grant, error_description, interval?}
 *     → 200 once {access_token, token_type, expires_in, computer, agents}
 *
 * The person's side (review + decision) is tRPC: `apiKeys.getDeviceRequest`,
 * `apiKeys.decideDeviceRequest`.
 */

import { z } from "zod";
import { logger, type HubHono, httpStatusForTrpcError } from "./_shared.js";
import { SURFACE_AGENT_TYPES } from "./setup.js";
import { toPodAdminOrigin } from "../../../utils/pod-admin-origin.js";
import {
  DEVICE_MAX_AGENTS,
  collectDeviceToken,
  createDeviceRequest,
  type DeviceTokenError,
} from "../../../services/machine-connect.js";

const CreateBody = z.object({
  clientName: z.string().trim().min(1).max(80),
  hostname: z.string().trim().min(1).max(253),
  platform: z.string().trim().max(40).optional(),
  agents: z
    .array(z.enum(SURFACE_AGENT_TYPES))
    .max(DEVICE_MAX_AGENTS)
    .optional(),
});

/** Human words for each RFC 8628 error (`error_description`). */
const ERROR_DESCRIPTIONS = {
  authorization_pending: "Waiting for you to approve this computer.",
  slow_down: "Polling too fast — wait the interval before asking again.",
  access_denied: "The request was denied.",
  expired_token: "This request expired or was already used. Start again.",
  invalid_grant: "Unknown device code.",
} as const satisfies Record<DeviceTokenError, string>;

async function readBody(c: {
  req: {
    header: (n: string) => string | undefined;
    json: () => Promise<unknown>;
    parseBody: () => Promise<Record<string, unknown>>;
  };
}): Promise<Record<string, unknown> | null> {
  const type = c.req.header("content-type") ?? "";
  try {
    if (type.includes("application/x-www-form-urlencoded"))
      return await c.req.parseBody();
    const body = await c.req.json();
    return body && typeof body === "object"
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function clientIp(c: { req: { header: (n: string) => string | undefined } }) {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    null
  );
}

export function registerDeviceRoutes(app: HubHono): void {
  // Static paths, both — registered before any `/setup/:param` route.
  app.post("/setup/device/token", async (c) => {
    const body = await readBody(c);
    const deviceCode =
      body && typeof body.device_code === "string" ? body.device_code : "";
    if (!deviceCode)
      return c.json(
        {
          error: "invalid_request",
          error_description: "device_code is required.",
        },
        400
      );
    try {
      const result = await collectDeviceToken({ deviceCode });
      c.header("Cache-Control", "no-store");
      if (result.ok) return c.json(result.body, 200);
      return c.json(
        {
          error: result.error,
          error_description: ERROR_DESCRIPTIONS[result.error],
          ...(result.interval ? { interval: result.interval } : {}),
        },
        400
      );
    } catch (err) {
      logger.error({ err }, "setup/device/token: collection failed");
      return c.json(
        {
          error: "server_error",
          error_description:
            "The computer could not be connected. Run the command again.",
        },
        httpStatusForTrpcError(err) as never
      );
    }
  });

  app.post("/setup/device", async (c) => {
    const parsed = CreateBody.safeParse(await readBody(c));
    if (!parsed.success)
      return c.json(
        {
          error: "invalid_request",
          error_description: parsed.error.issues
            .map((i) => `${i.path.join(".") || "body"}: ${i.message}`)
            .join("; "),
        },
        400
      );
    const origin = process.env.PUBLIC_URL || new URL(c.req.url).origin;
    try {
      const res = await createDeviceRequest({
        clientName: parsed.data.clientName,
        hostname: parsed.data.hostname,
        platform: parsed.data.platform ?? null,
        agents: parsed.data.agents ?? [],
        requesterIp: clientIp(c),
        userAgent: c.req.header("user-agent") ?? null,
        podAdminOrigin: toPodAdminOrigin(origin),
      });
      c.header("Cache-Control", "no-store");
      return c.json(res, 200);
    } catch (err) {
      logger.error({ err }, "setup/device: create failed");
      return c.json(
        {
          error: "server_error",
          error_description: "Could not start the request.",
        },
        httpStatusForTrpcError(err) as never
      );
    }
  });
}
