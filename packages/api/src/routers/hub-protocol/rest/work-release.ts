/**
 * Hub Protocol REST — GET /work-release: Work › Ship, the release read.
 *
 * The same read as tRPC `workRelease.get` and MCP `synap_get_work_release`
 * (`services/dev-loop/work-release.ts`, folded by `foldWorkRelease`). An agent
 * door: the sessions are read owner-only (`rosterReadFor`), and a
 * workspace-bound key reads only the facts of its own workspace. A key pinned
 * to spaces (a pod app) gets the read narrowed to its grant
 * (`workReleaseReach`): the parts it does not reach say `withheld`.
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
import { WORK_RELEASE_SOURCE_STATES } from "@synap-core/types/work-release";

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
      snapshots: z.enum(WORK_RELEASE_SOURCE_STATES.snapshots),
      sessions: z.enum(WORK_RELEASE_SOURCE_STATES.sessions),
      holders: z.enum(WORK_RELEASE_SOURCE_STATES.holders),
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
    /** Present only when the key's grant narrowed the read. */
    narrowed: z
      .object({
        snapshotSpaces: z.array(z.string()),
        withheld: z.array(z.enum(["snapshots", "sessions", "holders"])),
        reason: z.string(),
      })
      .optional(),
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
      "empty list. A workspace-bound key reads its own workspace's facts. " +
      "A key pinned to spaces (a pod app) reads the snapshots recorded in " +
      "those spaces when it reads `dev` events (`event.dev.read`), the " +
      "sessions its `session` grant reaches, and never the holders: each " +
      "part it does not reach is `withheld` in `sources`, and `narrowed` " +
      "says what was read.",
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
