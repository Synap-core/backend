/**
 * Hub Protocol REST — /orient
 *
 * The canonical lens-map endpoint for agent session bootstrap: workspaces +
 * projects + a profile sample + identity + optional teamRoster. A thin wrapper
 * over the shared `discover()` service (the ONE place that shapes orient
 * output). The CLI `synap orient` renders this DTO verbatim; the MCP
 * `synap_orient` tool calls the same service in-process.
 *
 *   ?detail=full   — workspace descriptions + full onboarding + per-ws profiles
 *   ?scope=a,b,c   — restrict to workspaces|projects|profiles
 *   ?workspaceId=  — pin to one workspace
 *   ?projectId=    — pin to one project
 *   ?statusOf=a,b  — where each id stands (`startHere.statusOf`)
 *   ?include=x,y   — what each of those answers carries beyond its status
 *                    (`STATUS_OF_INCLUDES`: moves, history, links, rollup,
 *                    signals); an unknown part is refused
 */

import { z } from "@hono/zod-openapi";

import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  getCaller,
  hasScope,
  logger,
  type HubHono,
  httpStatusForTrpcError,
} from "./_shared.js";
import {
  discover,
  WorkspaceNotAccessibleError,
  type DiscoverScope,
} from "../../../services/discover/discover.js";
import { getRequestGrant } from "@synap/database";
import {
  sessionHolderReadable,
  statusOfReach,
} from "../../../access/grant-door-fence.js";
import {
  narrowStatusOfAnswer,
  narrowStatusOfInclude,
  STATUS_OF_WITHHELD_REASON,
} from "../../../services/status/status-of-narrowed.js";
import {
  STATUS_OF_WORK_WITHHELD_FIELDS,
  STATUS_OF_WORK_WITHHELD_REASON,
} from "../../../services/status/status-of-narrowed-work.js";
import { readableWorkProposalIds } from "../../../services/status/status-of-narrowed-proposals.js";
import {
  readStatusOf,
  STATUS_OF_INCLUDES,
  STATUS_OF_MAX,
  statusOfIncludeInput,
  statusOfInput,
} from "../../../services/status/status-read.js";

export function registerOrientRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "get",
    path: "/orient",
    tags: ["System"],
    summary: "Lens map — workspaces, projects, profile sample, identity",
    description:
      "Canonical session-bootstrap orientation. Returns the user's workspaces " +
      "(operational domains), projects (cross-cutting initiatives), a profile " +
      "sample, and identity. Pass ?detail=full for descriptions + full " +
      "onboarding + per-workspace profiles.",
    responses: {
      200: {
        description: "Lens map",
        schema: z.record(z.string(), z.unknown()),
      },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  registerOpenApi(app, {
    method: "get",
    path: "/status-of",
    tags: ["System"],
    summary: "Where each id stands, per subject (narrowed for scoped keys)",
    description:
      "?ids=a,b (at most 10) and ?include=moves,history,... answer where each " +
      "thing, goal, session or run stands, through the same reader as " +
      "`GET /orient?statusOf=`. Every id is read through the floors that AND " +
      "the key's grant: an id it cannot read answers `unknown`, as one that " +
      "does not exist. A key that does not read every subject unbounded " +
      "(a pod app pinned to spaces) is answered the status, `moves`, " +
      "`history` and a floored projection of `work` (the sessions its grant " +
      "reads; a gate's proposal only when it may read it); `withheld` names " +
      "the parts and fields left out.",
    responses: {
      200: {
        description: "One answer per id",
        schema: z.record(z.string(), z.unknown()),
      },
      400: { description: "Bad request", schema: ErrorSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.get("/status-of", async (c) => {
    const scopes = c.get("scopes") as string[];
    if (!hasScope(scopes, "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }
    const split = (v: string | undefined) =>
      v
        ? [
            ...new Set(
              v
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
            ),
          ]
        : undefined;
    const ids = statusOfInput.safeParse(split(c.req.query("ids")));
    if (!ids.success || !ids.data?.length) {
      return c.json(
        { error: `ids takes 1 to ${STATUS_OF_MAX} comma-separated ids.` },
        400
      );
    }
    const include = statusOfIncludeInput.safeParse(
      split(c.req.query("include"))
    );
    if (!include.success) {
      return c.json(
        {
          error: `include takes some of: ${STATUS_OF_INCLUDES.join(", ")}.`,
        },
        400
      );
    }
    const userId = c.get("userId") as string;
    const whole = statusOfReach(getRequestGrant()).whole;
    const asked = include.data ?? [];
    const narrowed = whole ? null : narrowStatusOfInclude(asked);
    try {
      const answers = await readStatusOf(userId, ids.data, {
        include: narrowed ? narrowed.include : asked,
        viewer: {
          agentUserId: (c.get("agentUserId") as string | undefined) ?? null,
          roster: false,
        },
      });
      if (!narrowed) return c.json({ statusOf: answers });
      const grant = getRequestGrant();
      const workAsked = narrowed.include.includes("work");
      const ctx = {
        holderReadable: sessionHolderReadable(grant),
        readableProposalIds: workAsked
          ? await readableWorkProposalIds(userId, answers)
          : new Set<string>(),
      };
      return c.json({
        statusOf: answers.map((a) => narrowStatusOfAnswer(a, ctx)),
        withheld: {
          parts: narrowed.withheld,
          reason: STATUS_OF_WITHHELD_REASON,
          ...(workAsked
            ? {
                work: {
                  fields: STATUS_OF_WORK_WITHHELD_FIELDS,
                  reason: STATUS_OF_WORK_WITHHELD_REASON,
                },
              }
            : {}),
        },
      });
    } catch (err) {
      logger.error({ err, userId }, "GET /status-of failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err)
      );
    }
  });

  app.get("/orient", async (c) => {
    const scopes = c.get("scopes") as string[];
    if (!hasScope(scopes, "hub-protocol.read")) {
      return c.json(
        { error: "Insufficient scope: hub-protocol.read required" },
        403
      );
    }

    const userId = c.get("userId") as string;
    const detail = c.req.query("detail") === "full" ? "full" : "light";
    const workspaceId = c.req.query("workspaceId") || undefined;
    const projectId = c.req.query("projectId") || undefined;
    const explain = c.req.query("explain") === "true";
    const statusOfParam = c.req.query("statusOf");
    const statusOf = statusOfInput.safeParse(
      statusOfParam
        ? statusOfParam
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined
    );
    if (!statusOf.success) {
      return c.json(
        { error: `statusOf takes at most ${STATUS_OF_MAX} ids.` },
        400
      );
    }
    const includeParam = c.req.query("include");
    const include = statusOfIncludeInput.safeParse(
      includeParam
        ? [
            ...new Set(
              includeParam
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
            ),
          ]
        : undefined
    );
    if (!include.success) {
      return c.json(
        {
          error: `include takes some of: ${STATUS_OF_INCLUDES.join(", ")}.`,
        },
        400
      );
    }
    const scopeParam = c.req.query("scope");
    const scope = scopeParam
      ? (scopeParam
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean) as DiscoverScope[])
      : undefined;

    try {
      const caller = await getCaller(c);
      const result = await discover({
        caller,
        userId,
        agentUserId: (c.get("agentUserId") as string | undefined) ?? null,
        authScopes: scopes,
        detail,
        scope,
        workspaceId,
        projectId,
        ...(statusOf.data?.length ? { statusOf: statusOf.data } : {}),
        ...(include.data?.length ? { statusOfInclude: include.data } : {}),
        explain,
      });
      return c.json(result);
    } catch (err) {
      // A pinned ?workspaceId= the caller can't see is a REQUEST fault, not a
      // pod fault — 500 would misreport it (and retry logic would hammer a
      // request that can never succeed). 403 covers both "no such workspace"
      // and "not yours" on purpose: see WorkspaceNotAccessibleError.
      if (err instanceof WorkspaceNotAccessibleError) {
        logger.warn(
          { userId, workspaceId: err.workspaceId },
          "GET /orient pinned an inaccessible workspace"
        );
        return c.json({ error: err.message }, 403);
      }
      logger.error({ err, userId }, "GET /orient failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err)
      );
    }
  });
}
