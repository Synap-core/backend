/**
 * Hub Protocol REST — installations, the person's side (installer
 * reconciliation f75fbb48 §3.3–§3.4): what is installed on which of the
 * person's computers, and the governed ask to change it.
 *
 *   GET  /installations           ?computer=me | computerId, capabilityKey → { items }
 *   POST /installations/request   { capabilityKey, action, computer?, version?, sessionId? }
 *                                 → { status: approved | proposed, installationId?, jobId?, reviewUrl? }
 *
 * `computer: "me"` (the default for the request, and a query value for the
 * read) is the computer the caller's key speaks for: the computer's own key,
 * or an agent hosted on it. A scoped key reads per its grant
 * (`installation`); a computer's own key whose grant does not name it still
 * reads what is installed on itself, and nothing else. Otherwise `computerId` names one of the person's
 * computers (a stranger's is 404, no oracle).
 *
 * The request is governed (`installation/request`): a person's ask applies;
 * an agent's install, update or removal is a proposal the person approves.
 * Approval is once per (capability, computer): a verify, or an install of
 * the version already approved (a repair), asks nobody and only queues the
 * job. The computer must have "Installs from the pod" on, and the
 * capability's `placement` must allow it. The rule is `requestInstallation`
 * (services/installations/request-installation.ts), which MCP
 * `synap_request_installation` asks through too.
 *
 * What the computer OBSERVED is never written here: only its own key with
 * `host.runner`, through `/host-jobs/*`.
 */

import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import {
  hasScope,
  httpStatusForTrpcError,
  logger,
  type HubHono,
  type HubVariables,
} from "./_shared.js";
import { ErrorSchema, trpcErrorResponses } from "./_codecs/_openapi.js";
import { jsonGoverned } from "../proposal-response.js";
import { getRequestGrant } from "@synap/database";
import { AccessContext } from "../../../access/index.js";
import {
  GRANT_DOOR_UNSUPPORTED,
  installationsReadableByGrant,
} from "../../../access/grant-door-fence.js";
import {
  INSTALLATION_REQUEST_ACTIONS,
  listComputerOwnInstallations,
  listInstallations,
  loadPersonsComputer,
  resolveCallerComputer,
  type ComputerRef,
} from "../../../services/installations/installations.js";
import { requestInstallation } from "../../../services/installations/request-installation.js";

type C = Context<{ Variables: HubVariables }>;

const InstallationSchema = z
  .object({
    id: z.string(),
    computerId: z.string(),
    computerName: z.string(),
    capabilityKey: z.string(),
    kind: z.enum(["service", "tool"]),
    status: z.enum([
      "planned",
      "installing",
      "installed",
      "updating",
      "removing",
      "removed",
      "failed",
    ]),
    statusDetail: z.string().nullable(),
    desiredState: z.enum(["installed", "removed"]),
    desiredVersion: z.string().nullable(),
    approvedAt: z.string().nullable(),
    observedVersion: z.string().nullable(),
    observedOs: z.string().nullable(),
    observedArch: z.string().nullable(),
    verifiedAt: z.string().nullable(),
    health: z
      .enum(["ok", "degraded", "drifted", "stale", "unknown", "failed"])
      .nullable(),
    healthDetail: z.string().nullable(),
    updatedAt: z.string(),
  })
  .openapi("Installation");

export const InstallationRequestBodySchema = z
  .object({
    capabilityKey: z.string().min(1).max(200),
    action: z.enum(INSTALLATION_REQUEST_ACTIONS),
    /** "me" (default) = the caller's own computer; else a computer id. */
    computer: z.string().min(1).max(200).optional(),
    version: z.string().min(1).max(128).optional(),
    sessionId: z.string().uuid().optional(),
  })
  .strict()
  .openapi("InstallationRequest");

const NOT_A_COMPUTER = {
  code: "NOT_A_COMPUTER",
  error:
    'computer "me" needs a computer\'s own key, or an agent running on that computer. Pass a computer id instead.',
} as const;

function scopeDenied(c: C, scope: "hub-protocol.read" | "hub-protocol.write") {
  if (hasScope((c.get("scopes") as string[] | undefined) ?? [], scope))
    return null;
  return c.json({ error: `Insufficient scope: ${scope} required` }, 403);
}

const callerOf = (c: C) => ({
  userId: c.get("userId") as string,
  agentUserId: (c.get("agentUserId") as string | undefined) ?? null,
});

/** The computer a request names: "me" (the caller's) or one of the person's. */
async function computerFor(
  c: C,
  computer: string | undefined
): Promise<ComputerRef | "not_a_computer" | "not_found"> {
  if (!computer || computer === "me") {
    return (await resolveCallerComputer(callerOf(c))) ?? "not_a_computer";
  }
  return (
    (await loadPersonsComputer(callerOf(c).userId, computer)) ?? "not_found"
  );
}

export function registerInstallationsRoutes(app: HubHono): void {
  // ── POST /installations/request (static, before any /:id) ────────────────
  app.openapi(
    createRoute({
      method: "post",
      path: "/installations/request",
      tags: ["Installations"],
      summary:
        "Ask for a capability on one of your computers: install, update to a version, check or remove. An agent's install, update or removal becomes a proposal",
      request: {
        body: {
          content: {
            "application/json": { schema: InstallationRequestBodySchema },
          },
        },
      },
      responses: {
        ...trpcErrorResponses,
        200: {
          description:
            "Applied (`approved`): the asked state is recorded and the job, when one is due, is queued",
          content: {
            "application/json": {
              schema: z
                .object({
                  status: z.literal("approved"),
                  installationId: z.string(),
                  jobId: z.string().nullable(),
                })
                .openapi("InstallationRequested"),
            },
          },
        },
        202: {
          description:
            "An agent's ask, proposed for the person's approval (`{ status: 'proposed', proposalId, reviewUrl }`)",
          content: {
            "application/json": {
              schema: z
                .object({
                  status: z.literal("proposed"),
                  proposalId: z.string(),
                  reviewUrl: z.string().optional(),
                  message: z.string(),
                })
                .openapi("InstallationRequestProposed"),
            },
          },
        },
        409: {
          description:
            'The computer cannot take it ("Installs from the pod" is off, or its placement refuses it), or nothing is installed to check or remove',
          content: { "application/json": { schema: ErrorSchema } },
        },
      },
    }),
    async (c) => {
      const denied = scopeDenied(c, "hub-protocol.write");
      if (denied) return denied as never;
      const req = c.req.valid("json");
      const { userId, agentUserId } = callerOf(c);
      try {
        const computer = await computerFor(c, req.computer);
        if (computer === "not_a_computer")
          return c.json(NOT_A_COMPUTER, 403) as never;
        if (computer === "not_found")
          return c.json({ error: "Computer not found" }, 404) as never;
        // The one rule (`requestInstallation`), shared with MCP
        // `synap_request_installation`. This door names an installed
        // capability only: adding one from the catalog is the MCP door's.
        const out = await requestInstallation({
          userId,
          agentUserId,
          computer,
          capabilityKey: req.capabilityKey,
          action: req.action,
          version: req.version ?? null,
          ...(req.sessionId ? { sessionId: req.sessionId } : {}),
        });
        if (out.status === "refused")
          return c.json(
            out.code === "DENIED"
              ? { error: out.error }
              : { code: out.code, error: out.error },
            out.httpStatus
          ) as never;
        if (out.status === "proposed")
          return jsonGoverned(c, {
            status: "proposed" as const,
            proposalId: out.proposalId,
            reviewUrl: out.reviewUrl,
            message: out.message,
          }) as never;
        return c.json(
          {
            status: "approved" as const,
            installationId: out.installationId,
            jobId: out.jobId,
          },
          200
        );
      } catch (err) {
        logger.error({ err }, "POST /installations/request failed");
        return c.json(
          { error: "Could not record the request" },
          httpStatusForTrpcError(err)
        ) as never;
      }
    }
  );

  // ── GET /installations ───────────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: "get",
      path: "/installations",
      tags: ["Installations"],
      summary:
        "What is installed on your computers: this computer (`computer=me`), one computer, the computers that have one capability, or all",
      request: {
        query: z.object({
          computer: z.string().optional(),
          capabilityKey: z.string().optional(),
        }),
      },
      responses: {
        ...trpcErrorResponses,
        200: {
          description: "Your computers' installations, health derived at read",
          content: {
            "application/json": {
              schema: z
                .object({ items: z.array(InstallationSchema) })
                .openapi("Installations"),
            },
          },
        },
      },
    }),
    async (c) => {
      const denied = scopeDenied(c, "hub-protocol.read");
      if (denied) return denied as never;
      const { computer, capabilityKey } = c.req.valid("query");
      try {
        // The fence admits every scoped key here (grant-door-fence.ts): a
        // key whose grant does not read `installation` is served only when
        // it is a computer's OWN key, and then only what is on that computer.
        if (!installationsReadableByGrant(getRequestGrant())) {
          const own = await resolveCallerComputer(callerOf(c));
          if (!own || own.id !== callerOf(c).agentUserId)
            return c.json(
              { error: GRANT_DOOR_UNSUPPORTED, code: "GRANT_DOOR_UNSUPPORTED" },
              403
            ) as never;
          if (computer !== "me" && computer !== own.id)
            return c.json(
              {
                code: "OWN_COMPUTER_ONLY",
                error: `This key reads only what is installed on ${own.name}: ask with computer=me.`,
              },
              403
            ) as never;
          const items = await listComputerOwnInstallations(
            own,
            capabilityKey ? { capabilityKey } : {}
          );
          return c.json({ items }, 200);
        }
        let computerId: string | undefined;
        if (computer) {
          const ref = await computerFor(c, computer);
          if (ref === "not_a_computer")
            return c.json(NOT_A_COMPUTER, 403) as never;
          // A stranger's computer reads as empty, never as an error: no oracle.
          if (ref === "not_found") return c.json({ items: [] }, 200);
          computerId = ref.id;
        }
        const items = await listInstallations(
          AccessContext.agent(callerOf(c)),
          {
            ...(computerId ? { computerId } : {}),
            ...(capabilityKey ? { capabilityKey } : {}),
          }
        );
        return c.json({ items }, 200);
      } catch (err) {
        logger.error({ err }, "GET /installations failed");
        return c.json(
          { error: "Could not read your computers' installations" },
          httpStatusForTrpcError(err)
        ) as never;
      }
    }
  );
}
