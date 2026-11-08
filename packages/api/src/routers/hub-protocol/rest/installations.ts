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
 * capability's `placement` must allow it.
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
import {
  checkPermissionOrPropose,
  proposedMessageFor,
} from "../../../utils/permission-check.js";
import { getRequestGrant } from "@synap/database";
import { AccessContext } from "../../../access/index.js";
import {
  GRANT_DOOR_UNSUPPORTED,
  installationsReadableByGrant,
} from "../../../access/grant-door-fence.js";
import {
  applyInstallationRequest,
  installRefusal,
  INSTALLATION_REQUEST_ACTIONS,
  InstallationRequestError,
  listComputerOwnInstallations,
  listInstallations,
  loadInstallableCapability,
  loadLiveInstallation,
  loadPersonsComputer,
  reconcileInstallation,
  requestNeedsApproval,
  resolveCallerComputer,
  type ComputerRef,
} from "../../../services/installations/installations.js";

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

        const capability = await loadInstallableCapability(req.capabilityKey);
        if (!capability)
          return c.json(
            {
              code: "NOT_INSTALLABLE",
              error: `${req.capabilityKey} is not a capability this pod can install on a computer.`,
            },
            404
          ) as never;
        const live = await loadLiveInstallation(
          computer.id,
          capability.capabilityKey
        );

        if (req.action === "verify") {
          if (!live || live.status !== "installed")
            return c.json(
              {
                code: "NOT_INSTALLED",
                error: `${req.capabilityKey} is not installed on ${computer.name}.`,
              },
              409
            ) as never;
          const jobId = await reconcileInstallation(live, { kind: "verify" });
          return c.json(
            { status: "approved" as const, installationId: live.id, jobId },
            200
          );
        }
        if (req.action === "remove" && !live)
          return c.json(
            {
              code: "NOT_INSTALLED",
              error: `${req.capabilityKey} is not installed on ${computer.name}.`,
            },
            409
          ) as never;
        if (req.action !== "remove") {
          const refusal = installRefusal(capability, computer);
          if (refusal)
            return c.json(
              { code: "CANNOT_INSTALL", error: refusal },
              409
            ) as never;
        }

        // Approved once for this pair at this version: a repair asks nobody.
        if (!requestNeedsApproval(live, req) && live) {
          const jobId = await reconcileInstallation(live, {
            kind:
              live.status === "installed" || live.status === "failed"
                ? "install"
                : undefined,
          });
          return c.json(
            { status: "approved" as const, installationId: live.id, jobId },
            200
          );
        }

        const perm = await checkPermissionOrPropose({
          userId,
          agentUserId: agentUserId ?? undefined,
          workspaceId: null,
          subjectType: "installation",
          action: "request",
          // Filed for the person even when the agent's key grant does not
          // name it: approval is the person's, and an agent always proposes
          // (reconciliation f75fbb48 §3.4.1, founder 2026-11-07; decision
          // 168f34db §2). The AI preset excludes installation.request, so
          // without this an agent's ask would be refused, never filed.
          proposeBeyondGrant: true,
          ...(req.sessionId ? { sessionId: req.sessionId } : {}),
          reasoning:
            req.action === "remove"
              ? `Remove ${req.capabilityKey} from ${computer.name}: its removal steps run on that computer.`
              : live
                ? `Change ${req.capabilityKey} on ${computer.name} to version ${req.version ?? "latest"}: its install steps run again on that computer.`
                : `Install ${req.capabilityKey} on ${computer.name}: its install steps run on that computer, then it is checked.`,
          data: {
            id: computer.id,
            computerId: computer.id,
            computerName: computer.name,
            capabilityKey: capability.capabilityKey,
            kind: capability.kind,
            action: req.action,
            ...(req.version ? { version: req.version } : {}),
          },
        });
        if ("denied" in perm && perm.denied)
          return c.json(
            { error: perm.reason ?? "Not permitted" },
            403
          ) as never;
        if ("proposalId" in perm && perm.proposalId) {
          return jsonGoverned(c, {
            status: "proposed" as const,
            proposalId: perm.proposalId,
            reviewUrl: perm.reviewUrl,
            message: proposedMessageFor(
              perm.proposalType,
              "Proposed: the computer acts on it once the person approves it."
            ),
          }) as never;
        }
        const out = await applyInstallationRequest({
          computer,
          capability,
          action: req.action,
          version: req.version ?? null,
          approverId: userId,
        });
        return c.json(
          {
            status: "approved" as const,
            installationId: out.installation.id,
            jobId: out.jobId,
          },
          200
        );
      } catch (err) {
        if (err instanceof InstallationRequestError)
          return c.json(
            { code: err.code, error: "Nothing is installed to remove." },
            409
          ) as never;
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
