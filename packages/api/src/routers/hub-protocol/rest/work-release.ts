/**
 * Hub Protocol REST — GET /work-release: Work › Ship, the release read.
 *
 * The same read as tRPC `workRelease.get` and MCP `synap_get_work_release`
 * (`services/dev-loop/work-release.ts`, folded by `foldWorkRelease`). An agent
 * door: the sessions are read owner-only (`rosterReadFor`), and a
 * workspace-bound key reads only the facts of its own workspace.
 */

import { z } from "@hono/zod-openapi";

import { ErrorSchema } from "./_codecs/_openapi.js";
import { registerOpenApi } from "./_codecs/_register.js";
import {
  confineWorkspaceOrForbidden,
  hasScope,
  httpStatusForTrpcError,
  logger,
  resolveActingContext,
  type HubHono,
} from "./_shared.js";
import { readWorkRelease } from "../../../services/dev-loop/work-release.js";

const BlockRefWireSchema = z.union([
  z.object({
    kind: z.literal("pr"),
    repo: z.string(),
    number: z.number(),
  }),
  z.object({ kind: z.literal("main"), repo: z.string() }),
]);

/** `WorkReleaseRead` (`@synap-core/types/work-release`). */
const WorkReleaseWireSchema = z
  .object({
    generatedAt: z.string(),
    sources: z.object({
      snapshots: z.enum(["ok", "stale", "missing"]),
      sessions: z.enum(["ok", "unavailable"]),
      holders: z.enum(["ok", "unavailable"]),
    }),
    /** Per repo: main health, what is live, when it was observed. */
    repos: z.array(z.object({}).passthrough()),
    /** Per PR: stage, verdict, fold, session, holder, blockedBy. */
    prs: z.array(z.object({}).passthrough()),
    blockers: z.array(
      z
        .object({
          ref: BlockRefWireSchema,
          waiting: z.number(),
          waitingPrs: z.number(),
          waitingMains: z.number(),
          reason: z.string().nullable(),
        })
        .passthrough()
    ),
  })
  .openapi("WorkRelease");

export function registerWorkReleaseRoutes(app: HubHono): void {
  registerOpenApi(app, {
    method: "get",
    path: "/work-release",
    tags: ["FocusSessions"],
    summary: "Work › Ship: can I release, and what blocks it",
    description:
      "The release read (`services/dev-loop/work-release.ts`): the newest " +
      "`dev.repo_snapshot` per repo (posted by the devbox producer), each " +
      "PR's stage on the road to main (working, checks, ready, on_main), " +
      "its check verdict (own red vs red inherited from main), its fold " +
      "(draft, negctl, dependabot, stale), the session holding it and " +
      "whether that session is working now, and the blockers ranked by how " +
      "much waits behind them transitively. `sources` says which read was " +
      "stale, missing or failed: a failed read is `unavailable`, never an " +
      "empty list. A workspace-bound key reads its own workspace's facts.",
    responses: {
      200: { description: "Work release", schema: WorkReleaseWireSchema },
      403: { description: "Forbidden", schema: ErrorSchema },
      500: { description: "Internal error", schema: ErrorSchema },
    },
  });

  app.get("/work-release", async (c) => {
    if (!hasScope(c.get("scopes") as string[], "hub-protocol.read")) {
      return c.json({ error: "Missing scope: hub-protocol.read" }, 403);
    }
    const confined = confineWorkspaceOrForbidden(c, undefined);
    if (!confined.ok) return c.json({ error: confined.error }, 403);
    const acting = await resolveActingContext(c, {});
    if (!acting.ok) return c.json({ error: acting.error }, acting.status);
    try {
      const read = await readWorkRelease({
        userId: acting.userId,
        // An agent door reads sessions owner-only (decision C v1).
        roster: false,
        // A bound key reads its own workspace; an unbound one, pod-wide.
        ...(confined.workspaceId ? { lens: confined.workspaceId } : {}),
      });
      return c.json(read, 200);
    } catch (err) {
      logger.error({ err }, "GET /work-release failed");
      return c.json(
        { error: err instanceof Error ? err.message : "Unknown error" },
        httpStatusForTrpcError(err)
      );
    }
  });
}
